import { createDesiredRecord, type DesiredRecord, type RecordType } from "./dns.ts";

/**
 * Presentation-format zone files, the same RDATA the desired state already
 * stores. Import rebuilds records through `createDesiredRecord` so a file that
 * cannot be stored is refused here rather than later on apply.
 */

export function parseZoneFile(text: string, origin: string): DesiredRecord[] {
  const apex = origin.replace(/\.$/u, "").toLowerCase();
  let currentOrigin = apex;
  let defaultTtl = 300;
  const records: DesiredRecord[] = [];
  const used = new Set<string>();
  let lastOwner = "@";

  for (const stripped of logicalLines(text)) {
    const line = stripped.trim();
    if (line.length === 0) continue;
    if (line.startsWith("$ORIGIN")) {
      const value = line.slice("$ORIGIN".length).trim().replace(/\.$/u, "").toLowerCase();
      if (!value) throw new Error("zone file $ORIGIN needs a name");
      currentOrigin = value === "@" ? apex : value.endsWith(`.${apex}`) || value === apex ? value : `${value}.${apex}`;
      continue;
    }
    if (line.startsWith("$TTL")) {
      const value = Number(line.slice("$TTL".length).trim());
      if (!Number.isInteger(value) || value < 1) throw new Error("zone file $TTL must be a positive integer");
      defaultTtl = value;
      continue;
    }
    const tokens = tokenize(line);
    if (tokens.length < 2) throw new Error(`zone file line is not a record: ${line}`);
    let index = 0;
    // A line that begins with whitespace continues the previous owner. Tokenizing
    // already dropped that space, so the only signal is the raw indent.
    const ownerOmitted = /^\s/u.test(stripped);
    let owner = ownerOmitted ? lastOwner : (tokens[index++] as string);
    if (!ownerOmitted) lastOwner = owner;
    let ttl = defaultTtl;
    if (/^\d+$/u.test(tokens[index] ?? "")) {
      ttl = Number(tokens[index++]);
    }
    if ((tokens[index] ?? "").toUpperCase() === "IN") index += 1;
    const type = (tokens[index++] ?? "").toUpperCase();
    let content = tokens.slice(index).join(" ").trim();
    if (!type || content.length === 0) throw new Error(`zone file line is not a record: ${line}`);
    // SOA and signer-produced records are not stored desired state. A BIND file
    // that carries them still imports the rest.
    if (SKIPPED_ZONE_TYPES.has(type)) continue;
    if (type === "TXT") content = unquoteTxt(content);
    const name = relativeOwner(owner, currentOrigin, apex);
    const id = uniqueId(used, name, type);
    records.push(createDesiredRecord(id, { name, type, content, ttl }));
  }
  return records;
}

export function formatZoneFile(origin: string, records: readonly DesiredRecord[]): string {
  const apex = origin.replace(/\.$/u, "").toLowerCase();
  const lines = [`$ORIGIN ${apex}.`];
  for (const record of records) {
    const owner = record.name === "@" ? "@" : `${record.name}.${apex}.`;
    lines.push(`${owner} ${record.ttl} IN ${record.type} ${presentationContent(record)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The file's physical lines, joined where parentheses continue a record.
 *
 * BIND wraps anything long this way -- a DNSKEY's base64, a DMARC TXT split
 * across two quoted strings, an SOA's five numbers -- and it is the ordinary
 * output of `dig axfr` and `named-compilezone`, not an exotic dialect. Without
 * this, importing a zone file exported from a real nameserver failed on the
 * first wrapped record, and the message named the wrong cause: the parentheses
 * reached `zoneFileContentIssue`, which refuses them as zone-file structure
 * inside RDATA.
 *
 * The leading whitespace of the *first* physical line is preserved, because
 * that is what says the owner name was omitted and the previous one continues.
 */
function* logicalLines(text: string): Generator<string> {
  let pending: string | undefined;
  let depth = 0;
  for (const raw of text.split(/\n/u)) {
    const stripped = stripComment(raw);
    const { text: withoutParens, depth: next } = removeGroupingParens(stripped, depth);
    if (depth === 0) pending = withoutParens;
    // Continuations are appended with a space: a token cannot span a line, and
    // the tokenizer collapses runs of whitespace anyway.
    else pending = `${pending ?? ""} ${withoutParens.trim()}`;
    depth = next;
    if (depth > 0) continue;
    yield pending ?? "";
    pending = undefined;
  }
  if (depth > 0) throw new Error("zone file has an unclosed parenthesis");
}

/**
 * Drops the parentheses that group a record across lines, and reports the depth
 * left open. Only outside quotes: a TXT value may legitimately contain either.
 */
function removeGroupingParens(line: string, startDepth: number): { text: string; depth: number } {
  let depth = startDepth;
  let quoted = false;
  let out = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (char === "\\" && quoted) {
      out += char + (line[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "(") { depth += 1; continue; }
    else if (!quoted && char === ")") {
      depth -= 1;
      if (depth < 0) throw new Error("zone file has an unmatched closing parenthesis");
      continue;
    }
    out += char;
  }
  return { text: out, depth };
}

function stripComment(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && quoted) { index += 1; continue; }
    if (char === '"') quoted = !quoted;
    else if (char === ";" && !quoted) return line.slice(0, index);
  }
  return line;
}

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && quoted) {
      current += line[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char !== undefined && !quoted && /\s/u.test(char)) {
      if (current.length > 0) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quoted) throw new Error("zone file has an unterminated quoted string");
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function relativeOwner(owner: string, currentOrigin: string, apex: string): string {
  const absolute = owner === "@"
    ? currentOrigin
    : owner.endsWith(".")
      ? owner.slice(0, -1).toLowerCase()
      : `${owner.toLowerCase()}.${currentOrigin}`;
  if (absolute === apex) return "@";
  if (absolute.endsWith(`.${apex}`)) return absolute.slice(0, -(apex.length + 1));
  throw new Error(`zone file owner ${owner} is outside ${apex}`);
}

const SKIPPED_ZONE_TYPES = new Set(["SOA", "RRSIG", "NSEC", "NSEC3", "OPT"]);

function presentationContent(record: DesiredRecord): string {
  if (record.type === "TXT") return quoteTxt(record.content);
  return record.content;
}

function quoteTxt(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function unquoteTxt(content: string): string {
  if (!content.startsWith('"')) return content;
  let value = "";
  let index = 0;
  while (index < content.length) {
    if (content[index] !== '"') { index += 1; continue; }
    index += 1;
    while (index < content.length && content[index] !== '"') {
      if (content[index] === "\\" && index + 1 < content.length) {
        value += content[index + 1];
        index += 2;
      } else {
        value += content[index];
        index += 1;
      }
    }
    index += 1;
  }
  return value;
}

/**
 * `validateRecordId` accepts 1 to 36 characters of `[a-z0-9_-]`, starting with a
 * letter or a digit. This has to produce something inside that, and it did not.
 *
 * Two ways it failed, both on files a real nameserver writes. An underscored
 * owner -- `_dmarc`, `_acme-challenge`, `sel._domainkey`, which the domain
 * accepts as names -- produced an id beginning with `_`. And the length was cut
 * to 60 when the ceiling is 36, so any name long enough simply would not
 * import. Both surfaced as the record id's own error message, which names a
 * rule about ids and says nothing about the file being read.
 */
const MAX_GENERATED_ID_LENGTH = 36;

function uniqueId(used: Set<string>, name: string, type: string): string {
  const base = `${name === "@" ? "apex" : name}-${type.toLowerCase()}`
    .replace(/[^a-z0-9_-]+/gu, "-")
    // The first character has to be a letter or a digit; an owner may begin
    // with an underscore, and `record` keeps an id that would otherwise be
    // empty from being one.
    .replace(/^[_-]+/u, "") || "record";
  const trimmed = base.slice(0, MAX_GENERATED_ID_LENGTH);
  let candidate = trimmed;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `-${suffix}`;
    candidate = `${trimmed.slice(0, MAX_GENERATED_ID_LENGTH - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

export type { RecordType };
