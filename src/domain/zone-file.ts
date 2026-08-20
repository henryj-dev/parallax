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

  for (const raw of text.split(/\n/u)) {
    const stripped = stripComment(raw);
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

function uniqueId(used: Set<string>, name: string, type: string): string {
  const base = `${name === "@" ? "apex" : name}-${type.toLowerCase()}`.replace(/[^a-z0-9_-]+/gu, "-").slice(0, 60);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

export type { RecordType };
