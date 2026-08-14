import { BlockList, isIP } from "node:net";

/**
 * Every record type Parallax will hold in a desired state.
 *
 * `content` carries the record's RDATA in presentation format -- the same text
 * a zone file would put after the type. That is what CoreDNS writes verbatim
 * and what PowerDNS stores, so a type is supported here as soon as its RDATA
 * can be validated; providers that model part of it as a separate field, as
 * Cloudflare does with MX priority, split and rejoin it in their adapter.
 *
 * Left out on purpose: SOA, and the DNSSEC records. Those describe the zone's
 * authority rather than its contents, every provider generates and signs them
 * itself, and a control plane that published its own would be overwriting the
 * provider's answer to a question it did not ask.
 */
export const RECORD_TYPES = [
  "A", "AAAA", "CAA", "CERT", "CNAME", "DNAME", "HINFO", "HTTPS", "MX", "NAPTR",
  "NS", "OPENPGPKEY", "PTR", "SMIMEA", "SRV", "SSHFP", "SVCB", "TLSA", "TXT", "URI",
] as const;
/** The only views Parallax can reconcile; every provider target is `<zone>/<view>`. */
export const PROVIDER_VIEWS = ["external", "internal"] as const;
export const CLOUDFLARE_AUTO_TTL = 1;
export const CLOUDFLARE_AUTO_TTL_SECONDS = 300;
export const CLOUDFLARE_DNS_ONLY_MIN_TTL = 60;
export const CLOUDFLARE_MAX_TTL = 86_400;

export type RecordType = (typeof RECORD_TYPES)[number];

/**
 * Whether a proxy can stand in front of this record type.
 *
 * Cloudflare answers with `proxied` on every record it returns, including the
 * types it cannot proxy, so this is also the test for whether that field means
 * anything on a record that came back from a provider.
 */
export function canBeProxied(type: string): boolean {
  return type === "A" || type === "AAAA" || type === "CNAME";
}
export type ProviderView = (typeof PROVIDER_VIEWS)[number];

export interface DesiredRecord {
  id: string;
  name: string;
  type: RecordType;
  content: string;
  ttl: number;
  proxied?: boolean;
  /** Explicit operator acknowledgement required before publishing a non-global address externally. */
  acknowledgeNonGlobalIp?: boolean;
}

export interface DnsView {
  name: string;
  records: DesiredRecord[];
}

export interface Zone {
  name: string;
  revision: number;
  views: DnsView[];
  createdAt: string;
  updatedAt: string;
}

/** A point-in-time, immutable copy of a zone's desired state. */
export type ZoneRevision = Zone;

/**
 * Every kind of change the audit trail records.
 *
 * Copies of this list live where they cannot import it: a CHECK constraint in
 * the migrations and a label map in the portal. Adding an action here without
 * adding it there produced a control plane that wrote a value its own database
 * refused. A test compares them against this list, so the copies stay copies.
 */
export const AUDIT_ACTIONS = [
  "zone.created",
  "zone.deleted",
  "record.upserted",
  "record.deleted",
  "desired.replaced",
  "desired.restored",
  "records.adopted",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  /**
   * How many records this revision added, removed and changed. Derived from the
   * snapshots the entry already carries rather than stored beside them, so
   * history written before these existed reports them too -- which is the
   * history somebody is reading when they want to know what happened.
   */
  added?: number;
  removed?: number;
  changed?: number;
  id: number;
  zone: string;
  revision: number;
  action: AuditAction;
  actor: string;
  at: string;
  detail: Record<string, unknown>;
}

export class DomainValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "DomainValidationError";
    this.issues = issues;
  }
}

const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** RFC 8552 underscored names (`_dmarc`, `_acme-challenge`, `sel._domainkey`). */
const UNDERSCORED_LABEL = /^_(?!-)[a-z0-9-]{1,62}(?<!-)$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,35}$/;

export function normalizeZoneName(value: string): string {
  const zone = value.trim().toLowerCase().replace(/\.$/, "");
  const labels = zone.split(".");
  if (zone.length > 253 || labels.length < 2 || labels.some((label) => !DNS_LABEL.test(label))) {
    throw new DomainValidationError(["zone must be a valid fully-qualified domain name"]);
  }
  return zone;
}

/** Accepts only views Parallax can reconcile, so unroutable views can never be stored. */
export function validateViewName(value: string): ProviderView {
  const view = value.trim().toLowerCase();
  if (!PROVIDER_VIEWS.some((candidate) => candidate === view)) {
    throw new DomainValidationError([`view must be one of ${PROVIDER_VIEWS.join(" or ")}`]);
  }
  return view as ProviderView;
}

/**
 * Reads a view name from durable state. Snapshots written before views were
 * restricted may still carry other identifiers; they stay readable so an
 * operator can remove them instead of losing access to the whole zone.
 */
export function readPersistedViewName(value: string): string {
  const view = value.trim().toLowerCase();
  if (!IDENTIFIER.test(view)) {
    throw new DomainValidationError(["view must contain only lowercase letters, digits, _ or -"]);
  }
  return view;
}

export function isProviderView(value: string): value is ProviderView {
  return PROVIDER_VIEWS.some((candidate) => candidate === value);
}

export function validateRecordId(value: string): string {
  const id = value.trim();
  if (!IDENTIFIER.test(id)) {
    // The bound is the ownership marker's: a provider comment cannot exceed 100
    // characters, and the id is what varies inside it. Rejecting here means a
    // record cannot be created that only fails later, at the provider.
    throw new DomainValidationError([
      "record id must be 1 to 36 lowercase letters, digits, _ or -, and must start with a letter or digit",
    ]);
  }
  return id;
}

/**
 * The shape of each type's RDATA, as presentation format writes it.
 *
 * Checked here rather than left to the provider: a record that only fails at
 * apply is one an operator saved, walked away from, and finds broken later,
 * possibly against a zone that is already half published.
 *
 * `undefined` means the content is acceptable; a string is what is wrong with
 * it. Anything not listed is rejected by the type check before reaching here.
 */
function validateRecordContent(type: string, content: string): string | undefined {
  const fields = content.split(/\s+/u).filter((field) => field.length > 0);
  const quoted = [...content.matchAll(/"(?:[^"\\]|\\.)*"/gu)];
  switch (type) {
    case "A":
      return isIP(content) === 4 ? undefined : "A content must be a valid IPv4 address";
    case "AAAA":
      return isIP(content) === 6 ? undefined : "AAAA content must be a valid IPv6 address";
    case "CNAME": case "DNAME": case "NS": case "PTR":
      return isValidHostname(content) ? undefined : `${type} content must be a valid hostname`;
    case "TXT":
      return content.length >= 1 && content.length <= 4096
        ? undefined : "TXT content must contain between 1 and 4096 characters";
    case "MX":
      // `10 mail.example.com` -- preference first, exactly as a zone file has it.
      return fields.length === 2 && isUnsigned(fields[0], 16) && isValidHostname(fields[1] as string)
        ? undefined : "MX content must be a preference and a hostname, as in `10 mail.example.com`";
    case "SRV":
      return fields.length === 4 && isUnsigned(fields[0], 16) && isUnsigned(fields[1], 16)
        && isUnsigned(fields[2], 16) && (fields[3] === "." || isValidHostname(fields[3] as string))
        ? undefined : "SRV content must be priority, weight, port and target, as in `10 5 443 host.example.com`";
    case "CAA":
      // `0 issue "letsencrypt.org"` -- the value is a quoted character-string.
      return fields.length >= 3 && isUnsigned(fields[0], 8) && /^[a-z][a-z0-9]*$/u.test(fields[1] ?? "")
        && quoted.length === 1 && content.endsWith('"')
        ? undefined : 'CAA content must be a flag, a tag and a quoted value, as in `0 issue "letsencrypt.org"`';
    case "TLSA": case "SMIMEA":
      return fields.length === 4 && fields.slice(0, 3).every((field) => isUnsigned(field, 8))
        && isHex(fields[3] as string)
        ? undefined : `${type} content must be three numbers and hexadecimal data, as in \`3 1 1 ab12…\``;
    case "SSHFP":
      return fields.length === 3 && isUnsigned(fields[0], 8) && isUnsigned(fields[1], 8) && isHex(fields[2] as string)
        ? undefined : "SSHFP content must be an algorithm, a type and hexadecimal data, as in `4 2 ab12…`";
    case "NAPTR":
      return fields.length >= 6 && isUnsigned(fields[0], 16) && isUnsigned(fields[1], 16) && quoted.length === 3
        ? undefined : 'NAPTR content must be two numbers, three quoted strings and a replacement, as in `100 10 "s" "SIP+D2U" "" _sip._udp.example.com`';
    case "URI":
      return fields.length >= 3 && isUnsigned(fields[0], 16) && isUnsigned(fields[1], 16) && quoted.length === 1
        ? undefined : 'URI content must be a priority, a weight and a quoted target, as in `10 1 "https://example.com/"`';
    case "SVCB": case "HTTPS":
      // Priority 0 is the alias form, which takes a target and no parameters.
      return fields.length >= 2 && isUnsigned(fields[0], 16)
        && (fields[1] === "." || isValidHostname(fields[1] as string))
        ? undefined : `${type} content must be a priority and a target, as in \`1 . alpn=h2,h3\``;
    case "CERT":
      return fields.length === 4 && isUnsigned(fields[0], 16) && isUnsigned(fields[1], 16)
        && isUnsigned(fields[2], 8) && isBase64(fields[3] as string)
        ? undefined : "CERT content must be a type, a key tag, an algorithm and base64 data";
    case "OPENPGPKEY":
      return isBase64(content) ? undefined : "OPENPGPKEY content must be base64 data";
    case "HINFO":
      return quoted.length === 2 ? undefined : 'HINFO content must be two quoted strings, as in `"Intel" "Linux"`';
    default:
      return undefined;
  }
}

function isUnsigned(value: string | undefined, bits: number): boolean {
  if (value === undefined || !/^\d{1,5}$/u.test(value)) return false;
  return Number(value) <= 2 ** bits - 1;
}

function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/iu.test(value);
}

function isBase64(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value);
}

export function createDesiredRecord(id: string, input: unknown): DesiredRecord {
  const issues: string[] = [];
  const value = asObject(input);
  const recordId = validateRecordId(id);
  const typeValue = typeof value.type === "string" ? value.type.toUpperCase() : "";
  if (!RECORD_TYPES.some((candidate) => candidate === typeValue)) {
    issues.push(`type must be one of ${RECORD_TYPES.join(", ")}`);
  }

  const name = typeof value.name === "string" ? value.name.trim().toLowerCase() : "";
  if (!isValidRecordName(name)) issues.push("name must be @ or a valid relative DNS name");

  let content = typeof value.content === "string" ? value.content.trim() : "";
  const contentIssue = validateRecordContent(typeValue, content);
  if (contentIssue) issues.push(contentIssue);

  const requestedTtl = value.ttl;
  const hasValidTtl = typeof requestedTtl === "number"
    && Number.isInteger(requestedTtl)
    && requestedTtl >= 1
    && requestedTtl <= 2_147_483_647;
  if (!hasValidTtl) issues.push("ttl must be an integer between 1 and 2147483647");
  // Cloudflare forces Auto on proxied address and CNAME records, but the request
  // still has to carry a TTL this control plane would accept on its own.
  const usesCloudflareAutoTtl = value.proxied === true && canBeProxied(typeValue);
  const ttl = usesCloudflareAutoTtl && hasValidTtl ? CLOUDFLARE_AUTO_TTL : requestedTtl;

  if (value.proxied !== undefined && typeof value.proxied !== "boolean") {
    issues.push("proxied must be a boolean");
  }
  if (value.proxied !== undefined && !canBeProxied(typeValue)) {
    issues.push("proxied is supported only for A, AAAA and CNAME records");
  }
  if (value.acknowledgeNonGlobalIp !== undefined && typeof value.acknowledgeNonGlobalIp !== "boolean") {
    issues.push("acknowledgeNonGlobalIp must be a boolean");
  }
  if (value.acknowledgeNonGlobalIp !== undefined && !["A", "AAAA"].includes(typeValue)) {
    issues.push("acknowledgeNonGlobalIp is supported only for A and AAAA records");
  }

  if (issues.length > 0) throw new DomainValidationError(issues);
  if (typeValue === "CNAME") content = content.toLowerCase().replace(/\.$/, "");
  if (typeValue === "AAAA") content = new URL(`http://[${content}]/`).hostname.slice(1, -1);
  const record: DesiredRecord = {
    id: recordId,
    name,
    type: typeValue as RecordType,
    content,
    ttl: ttl as number,
  };
  if (value.proxied !== undefined) record.proxied = value.proxied as boolean;
  if (value.acknowledgeNonGlobalIp !== undefined) record.acknowledgeNonGlobalIp = value.acknowledgeNonGlobalIp as boolean;
  return record;
}

const NON_GLOBAL_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_GLOBAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001:2::", 48],
  ["2001:db8::", 32], ["2001:10::", 28], ["2001:20::", 28], ["2002::", 16],
  ["3fff::", 20], ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) NON_GLOBAL_ADDRESSES.addSubnet(network, prefix, "ipv6");

export function isGlobalUnicastAddress(value: string): boolean {
  const family = isIP(value);
  return family !== 0 && !NON_GLOBAL_ADDRESSES.check(value, family === 4 ? "ipv4" : "ipv6");
}

export function validateExternalRecords(records: DesiredRecord[]): void {
  const issues = records
    .filter((record) => (record.type === "A" || record.type === "AAAA")
      && !isGlobalUnicastAddress(record.content)
      && record.acknowledgeNonGlobalIp !== true)
    .map((record) => `external ${record.type} record ${record.id} publishes non-global address ${record.content}; set acknowledgeNonGlobalIp to true after reviewing the exposure`);
  for (const record of records) {
    const ttl = effectiveExternalTtl(record);
    if (record.proxied !== true && ttl !== CLOUDFLARE_AUTO_TTL
      && (ttl < CLOUDFLARE_DNS_ONLY_MIN_TTL || ttl > CLOUDFLARE_MAX_TTL)) {
      issues.push(`external DNS-only record ${record.id} ttl must be Auto (1) or between 60 and 86400 seconds`);
    }
  }
  if (issues.length > 0) throw new DomainValidationError(issues);
}

/** Cloudflare represents Auto TTL as `1` and forces it for proxied address/CNAME records. */
export function effectiveExternalTtl(record: Pick<DesiredRecord, "type" | "ttl" | "proxied">): number {
  return record.proxied === true && (record.type === "A" || record.type === "AAAA" || record.type === "CNAME")
    ? CLOUDFLARE_AUTO_TTL
    : record.ttl;
}

/** CoreDNS needs a concrete duration when it inherits Cloudflare's Auto TTL sentinel. */
export function concreteDnsTtl(ttl: number): number {
  return ttl === CLOUDFLARE_AUTO_TTL ? CLOUDFLARE_AUTO_TTL_SECONDS : ttl;
}

/** Validates Cloudflare external records and returns a normalized copy safe to persist or reconcile. */
export function normalizeExternalRecords(records: DesiredRecord[]): DesiredRecord[] {
  validateExternalRecords(records);
  return records.map((record) => {
    const ttl = effectiveExternalTtl(record);
    return ttl === record.ttl ? { ...record } : { ...record, ttl };
  });
}

function asObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new DomainValidationError(["request body must be an object"]);
  }
  return input as Record<string, unknown>;
}

function isValidLabel(label: string): boolean {
  return DNS_LABEL.test(label) || UNDERSCORED_LABEL.test(label);
}

function isValidRecordName(name: string): boolean {
  if (name === "@" || name === "*") return true;
  const normalized = name.startsWith("*.") ? name.slice(2) : name;
  return normalized.length <= 253 && normalized.split(".").every(isValidLabel);
}

function isValidHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  return hostname.length > 0 && hostname.length <= 253 && hostname.split(".").every(isValidLabel);
}
