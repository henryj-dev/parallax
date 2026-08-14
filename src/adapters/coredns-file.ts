import type { ProviderAdapter } from "../application/ports.ts";
import { RECORD_TYPES, type DesiredRecord, type RecordType } from "../domain/dns.ts";
import type { ProviderRecord, ReconcileOperation } from "../domain/reconciliation.ts";
import { ownershipComment, readOwnershipComment } from "./ownership.ts";

export interface CoreDnsFileOperations {
  read(path: string): Promise<string | undefined>;
  /** Implementations should replace the file atomically (temporary file + rename). */
  write(path: string, contents: string): Promise<void>;
  /** Optional command/hook used to reload CoreDNS after a successful write. */
  reload?(target: string, path: string): Promise<void>;
}

export interface CoreDnsFileAdapterOptions {
  files: CoreDnsFileOperations;
  pathForTarget(target: string): string;
  ownershipSecret: string;
}

interface ParsedLine {
  lineIndex: number;
  record: ProviderRecord;
  ownership?: { recordId: string };
}

/** Provider-compatible adapter for CoreDNS's RFC 1035 file plugin. */
export class CoreDnsFileAdapter implements ProviderAdapter {
  readonly #files: CoreDnsFileOperations;
  readonly #pathForTarget: (target: string) => string;
  readonly #ownershipSecret: string;

  constructor(options: CoreDnsFileAdapterOptions) {
    this.#files = options.files;
    this.#pathForTarget = options.pathForTarget;
    this.#ownershipSecret = options.ownershipSecret;
    ownershipComment("validation/target", "validation", this.#ownershipSecret);
  }

  async list(target: string): Promise<ProviderRecord[]> {
    const path = this.#pathForTarget(target);
    const contents = await this.#files.read(path) ?? "";
    return parseDocument(contents, target, this.#ownershipSecret).map((line) => line.record);
  }

  async apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> {
    const path = this.#pathForTarget(target);
    const zone = zoneFromTarget(target);
    const original = await this.#files.read(path) ?? "";
    const lines = original.length === 0 ? [`$ORIGIN ${zone}.`] : original.replace(/\n$/, "").split("\n");
    if (operation.kind === "create") {
      lines.push(formatRecord(target, operation.desired, this.#ownershipSecret));
    } else {
      if (operation.kind === "delete" && !operation.actual.managed) throw new Error(`refusing to delete unmanaged CoreDNS record ${operation.providerId}`);
      const parsed = parseDocument(lines.join("\n"), target, this.#ownershipSecret);
      const existing = parsed.find((line) => line.record.providerId === operation.providerId && line.record.managed);
      if (!existing) throw new Error(`managed CoreDNS record ${operation.providerId} does not exist`);
      if (operation.kind === "update") lines[existing.lineIndex] = formatRecord(target, operation.desired, this.#ownershipSecret);
      else lines.splice(existing.lineIndex, 1);
    }
    const nextContents = advanceZoneSerial(`${lines.join("\n")}\n`, zone);
    await this.#files.write(path, nextContents);
    await this.#files.reload?.(target, path);
  }
}

const RECORD_CLASSES = new Set(["IN", "CS", "CH", "HS"]);

/**
 * Reads every resource record in an RFC 1035 zone file, including the common
 * forms that omit the TTL (inheriting `$TTL`) or the owner name (inheriting the
 * previous record's owner). A record line that cannot be understood is an error
 * rather than an absent record: treating it as absent would let reconciliation
 * append a second RRset value next to an answer it never saw.
 */
function parseDocument(contents: string, target: string, ownershipSecret: string): ParsedLine[] {
  const result: ParsedLine[] = [];
  const zone = zoneFromTarget(target);
  const lines = contents.split("\n");
  let defaultTtl: number | undefined;
  let lastOwner = "@";

  for (const logical of readLogicalRecords(lines)) {
    const directive = /^\$(TTL|ORIGIN|INCLUDE)\b\s*(\S*)/i.exec(logical.text.trim());
    if (directive) {
      if (directive[1]?.toUpperCase() === "TTL") defaultTtl = parseTtl(directive[2] ?? "");
      continue;
    }

    const fields = readRecordFields(logical, lastOwner, defaultTtl);
    if (!fields) {
      throw new Error(`CoreDNS zone file line ${logical.startLine + 1} is not a record this adapter understands`);
    }
    lastOwner = fields.owner;
    if (!isManagedType(fields.type)) continue;
    const content = parseContent(fields.type, fields.rdata);
    if (content === undefined) {
      throw new Error(`CoreDNS zone file line ${logical.startLine + 1} has ${fields.type} data this adapter cannot read`);
    }

    const ownership = readOwnershipComment(logical.comment?.trim(), ownershipSecret, target);
    const managed = ownership !== undefined;
    const lineNumber = logical.startLine + 1;
    result.push({
      lineIndex: logical.startLine,
      ...(ownership ? { ownership } : {}),
      record: {
        id: managed ? ownership.recordId : `line-${lineNumber}`,
        providerId: managed ? `managed:${ownership.recordId}` : `line:${lineNumber}`,
        managed,
        name: normalizeOwner(fields.owner, zone),
        type: fields.type,
        content,
        ttl: fields.ttl,
      },
    });
  }
  return result;
}

interface LogicalRecord {
  startLine: number;
  text: string;
  comment?: string;
  /** The record omitted its owner name and inherits the previous one. */
  inheritsOwner: boolean;
}

/** Groups physical lines into records, joining RFC 1035 parenthesized continuations. */
function readLogicalRecords(lines: string[]): LogicalRecord[] {
  const records: LogicalRecord[] = [];
  let open: (LogicalRecord & { depth: number }) | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const split = splitRecordAndComment(raw);
    if (!open && split.record.trim().length === 0) continue;
    if (open) {
      open.text += ` ${split.record.trim()}`;
      if (split.comment !== undefined) open.comment = `${open.comment ?? ""} ${split.comment}`;
    } else {
      open = {
        startLine: index,
        text: split.record.trim(),
        inheritsOwner: /^[ \t]/.test(raw),
        depth: 0,
        ...(split.comment !== undefined ? { comment: split.comment } : {}),
      };
    }
    open.depth += parenthesisDelta(split.record);
    if (open.depth > 0) continue;
    const { depth: _depth, ...completed } = open;
    records.push(completed);
    open = undefined;
  }
  if (open) {
    const { depth: _depth, ...completed } = open;
    records.push(completed);
  }
  return records;
}

function parenthesisDelta(text: string): number {
  let delta = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === "(") delta += 1;
    else if (!quoted && character === ")") delta -= 1;
  }
  return delta;
}

interface RecordFields {
  owner: string;
  ttl: number;
  type: string;
  rdata: string;
}

/** Reads `[owner] [ttl] [class] type rdata`, where TTL and class are optional and order-independent. */
function readRecordFields(logical: LogicalRecord, previousOwner: string, defaultTtl: number | undefined): RecordFields | undefined {
  const text = logical.text.replace(/[()]/g, " ");
  const tokens = readTokens(text);
  let index = 0;
  let owner = previousOwner;
  if (!logical.inheritsOwner) {
    const first = tokens[index];
    if (!first) return undefined;
    owner = first.value;
    index += 1;
  }

  let ttl: number | undefined;
  for (let field = 0; field < 2; field += 1) {
    const token = tokens[index];
    if (!token || token.quoted) break;
    if (ttl === undefined && /^\d+$/.test(token.value)) {
      ttl = parseTtl(token.value);
      if (ttl === undefined) return undefined;
      index += 1;
      continue;
    }
    if (RECORD_CLASSES.has(token.value.toUpperCase())) {
      index += 1;
      continue;
    }
    break;
  }

  const typeToken = tokens[index];
  if (!typeToken || typeToken.quoted) return undefined;
  const effectiveTtl = ttl ?? defaultTtl;
  if (effectiveTtl === undefined) return undefined;
  const rdata = text.slice(typeToken.end).trim();
  if (rdata.length === 0) return undefined;
  return { owner, ttl: effectiveTtl, type: typeToken.value.toUpperCase(), rdata };
}

function readTokens(text: string): Array<{ value: string; end: number; quoted: boolean }> {
  const tokens: Array<{ value: string; end: number; quoted: boolean }> = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index] ?? "")) {
      index += 1;
      continue;
    }
    const start = index;
    const quoted = text[index] === '"';
    if (quoted) {
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const character = text[index] ?? "";
        index += 1;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') break;
      }
    } else {
      while (index < text.length && !/\s/.test(text[index] ?? "")) index += 1;
    }
    tokens.push({ value: quoted ? text.slice(start + 1, Math.max(start + 1, index - 1)) : text.slice(start, index), end: index, quoted });
  }
  return tokens;
}

function parseTtl(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const ttl = Number(value);
  return Number.isSafeInteger(ttl) && ttl >= 0 && ttl <= 2_147_483_647 ? ttl : undefined;
}

function isManagedType(value: string): value is RecordType {
  return RECORD_TYPES.some((candidate) => candidate === value);
}

/**
 * Where each type's RDATA carries a hostname, counted in whitespace-separated
 * fields.
 *
 * A zone file reads a name without a trailing dot as relative to the origin, so
 * writing `10 mail.example.com` into example.com's file publishes an MX for
 * `mail.example.com.example.com`. The name has to be made absolute on the way
 * out and relative again on the way back, and only in the field that holds one.
 */
const HOSTNAME_FIELD: Readonly<Record<string, number>> = {
  CNAME: 0, DNAME: 0, NS: 0, PTR: 0, MX: 1, SRV: 3, SVCB: 1, HTTPS: 1, NAPTR: 5,
};

function withAbsoluteHostname(type: string, content: string, absolute: boolean): string {
  const index = HOSTNAME_FIELD[type];
  if (index === undefined) return content;
  const fields = content.split(/(\s+)/u);
  // Every second entry is a separator, so the nth field sits at 2n.
  const position = index * 2;
  const field = fields[position];
  if (field === undefined || field === ".") return content;
  fields[position] = absolute ? `${field.replace(/\.$/u, "")}.` : field.replace(/\.$/u, "");
  return fields.join("");
}

function formatRecord(target: string, record: DesiredRecord, ownershipSecret: string): string {
  const content = record.type === "TXT"
    ? quoteDnsText(record.content)
    : withAbsoluteHostname(record.type, record.content, true);
  return `${record.name} ${record.ttl} IN ${record.type} ${content} ; ${ownershipComment(target, record.id, ownershipSecret)}`;
}

function parseContent(type: RecordType, raw: string): string | undefined {
  if (type === "TXT") {
    return parseDnsText(raw);
  }
  return withAbsoluteHostname(type, type === "CNAME" ? raw.toLowerCase() : raw, false);
}

function splitRecordAndComment(line: string): { record: string; comment?: string } {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ";" && !quoted) {
      return { record: line.slice(0, index), comment: line.slice(index + 1) };
    }
  }
  return { record: line };
}

function quoteDnsText(value: string): string {
  return splitDnsText(value).map(quoteDnsCharacterString).join(" ");
}

function quoteDnsCharacterString(value: string): string {
  let result = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"' || character === "\\") result += `\\${character}`;
    else if (code < 32 || code === 127) result += `\\${code.toString().padStart(3, "0")}`;
    else result += character;
  }
  return `${result}"`;
}

/** RFC 1035 character-strings carry at most 255 octets, not 255 code points. */
function splitDnsText(value: string): string[] {
  if (value.length === 0) return [""];
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (chunkBytes + characterBytes > 255) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function parseDnsText(raw: string): string | undefined {
  let index = 0;
  let result = "";
  const skipSpace = (): void => { while (/\s/.test(raw[index] ?? "")) index += 1; };
  skipSpace();
  while (index < raw.length) {
    if (raw[index] !== '"') return undefined;
    index += 1;
    let closed = false;
    while (index < raw.length) {
      const character = raw[index];
      if (character === '"') {
        index += 1;
        closed = true;
        break;
      }
      if (character !== "\\") {
        result += character;
        index += 1;
        continue;
      }
      index += 1;
      const decimal = raw.slice(index, index + 3);
      if (/^\d{3}$/.test(decimal)) {
        const code = Number(decimal);
        if (code > 255) return undefined;
        result += String.fromCharCode(code);
        index += 3;
      } else if (index < raw.length) {
        result += raw[index];
        index += 1;
      } else return undefined;
    }
    if (!closed) return undefined;
    skipSpace();
  }
  return result;
}

function normalizeOwner(owner: string, zone: string): string {
  const normalized = owner.toLowerCase().replace(/\.$/, "");
  if (normalized === "@" || normalized === zone) return "@";
  const suffix = `.${zone}`;
  return normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : normalized;
}

function advanceZoneSerial(contents: string, zone: string): string {
  const soa = findSoaSerial(contents);
  if (soa) {
    if (soa.value >= 0xffff_ffff) throw new Error(`CoreDNS SOA serial is exhausted for ${zone}`);
    let result = `${contents.slice(0, soa.start)}${soa.value + 1}${contents.slice(soa.end)}`;
    if (!hasNameServer(result, zone)) result = appendLine(result, `@ 3600 IN NS ns1.${zone}.`);
    return ensureTrailingNewline(result);
  }

  const authority = [
    `@ 3600 IN SOA ns1.${zone}. hostmaster.${zone}. 1 3600 600 604800 300`,
    `@ 3600 IN NS ns1.${zone}.`,
  ];
  const originPattern = /^\s*\$ORIGIN\s+\S+\s*(?:;[^\n]*)?\n/im;
  const origin = originPattern.exec(contents);
  if (origin?.index !== undefined) {
    const insertAt = origin.index + origin[0].length;
    return ensureTrailingNewline(`${contents.slice(0, insertAt)}${authority.join("\n")}\n${contents.slice(insertAt)}`);
  }
  return ensureTrailingNewline(`$ORIGIN ${zone}.\n${authority.join("\n")}\n${contents}`);
}

interface MasterToken {
  value: string;
  start: number;
  end: number;
  quoted: boolean;
}

function findSoaSerial(contents: string): { value: number; start: number; end: number } | undefined {
  const tokens = tokenizeMasterFile(contents);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.quoted || token.value.toUpperCase() !== "SOA") continue;
    const serial = tokens[index + 3];
    if (!serial || serial.quoted || !/^\d+$/.test(serial.value)) continue;
    const value = Number(serial.value);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error("CoreDNS SOA serial must be an unsigned 32-bit integer");
    }
    return { value, start: serial.start, end: serial.end };
  }
  return undefined;
}

function tokenizeMasterFile(contents: string): MasterToken[] {
  const tokens: MasterToken[] = [];
  let index = 0;
  while (index < contents.length) {
    const character = contents[index] ?? "";
    if (/\s/.test(character) || character === "(" || character === ")") {
      index += 1;
      continue;
    }
    if (character === ";") {
      const newline = contents.indexOf("\n", index);
      index = newline < 0 ? contents.length : newline + 1;
      continue;
    }
    const start = index;
    if (character === '"') {
      index += 1;
      let escaped = false;
      while (index < contents.length) {
        const current = contents[index] ?? "";
        index += 1;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') break;
      }
      tokens.push({ value: contents.slice(start + 1, Math.max(start + 1, index - 1)), start, end: index, quoted: true });
      continue;
    }
    while (index < contents.length) {
      const current = contents[index] ?? "";
      if (/\s/.test(current) || current === "(" || current === ")" || current === ";") break;
      index += 1;
    }
    tokens.push({ value: contents.slice(start, index), start, end: index, quoted: false });
  }
  return tokens;
}

function hasNameServer(contents: string, zone: string): boolean {
  const escapedZone = zone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:@|${escapedZone}\\.?)\\s+(?:\\d+\\s+)?(?:IN\\s+)?NS\\s+`, "im").test(contents)
    || /^\s+\d+\s+(?:IN\s+)?NS\s+/im.test(contents);
}

function appendLine(contents: string, line: string): string {
  return `${contents.replace(/\n*$/, "")}\n${line}\n`;
}

function ensureTrailingNewline(contents: string): string {
  return `${contents.replace(/\n*$/, "")}\n`;
}

function zoneFromTarget(target: string): string {
  const separator = target.lastIndexOf("/");
  const zone = (separator < 0 ? target : target.slice(0, separator)).trim().toLowerCase().replace(/\.$/, "");
  if (!zone || !zone.includes(".")) throw new Error(`invalid provider target ${target}`);
  return zone;
}
