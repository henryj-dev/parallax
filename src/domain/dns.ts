import { BlockList, isIP } from "node:net";

export const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT"] as const;
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

export function createDesiredRecord(id: string, input: unknown): DesiredRecord {
  const issues: string[] = [];
  const value = asObject(input);
  const recordId = validateRecordId(id);
  const typeValue = typeof value.type === "string" ? value.type.toUpperCase() : "";
  if (!RECORD_TYPES.some((candidate) => candidate === typeValue)) {
    issues.push("type must be one of A, AAAA, CNAME or TXT");
  }

  const name = typeof value.name === "string" ? value.name.trim().toLowerCase() : "";
  if (!isValidRecordName(name)) issues.push("name must be @ or a valid relative DNS name");

  let content = typeof value.content === "string" ? value.content.trim() : "";
  if (typeValue === "A" && isIP(content) !== 4) issues.push("A content must be a valid IPv4 address");
  if (typeValue === "AAAA" && isIP(content) !== 6) issues.push("AAAA content must be a valid IPv6 address");
  if (typeValue === "CNAME" && !isValidHostname(content)) issues.push("CNAME content must be a valid hostname");
  if (typeValue === "TXT" && (content.length === 0 || content.length > 4096)) {
    issues.push("TXT content must contain between 1 and 4096 characters");
  }

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
