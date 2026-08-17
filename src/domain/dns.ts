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
 * Left out on purpose: SOA, and the DNSSEC records a signer produces for the zone
 * it is signing -- `RRSIG`, `NSEC`, `NSEC3`. Those describe the zone's own
 * authority, every provider generates them itself, and publishing our own would
 * overwrite the provider's answer to a question we did not ask.
 *
 * `DS` and `DNSKEY` are here despite being DNSSEC records, because they are not
 * that. A `DS` sits in the *parent* and delegates to a signed child, which is an
 * operator's decision about somebody else's zone; `DNSKEY` is offered by
 * providers for the same kind of hand-managed case. Excluding them as "DNSSEC"
 * confused what a signer emits with what a delegation needs.
 */
export const RECORD_TYPES = [
  "A", "AAAA", "CAA", "CERT", "CNAME", "DNAME", "DNSKEY", "DS", "HINFO", "HTTPS",
  "LOC", "MX", "NAPTR", "NS", "OPENPGPKEY", "PTR", "SMIMEA", "SRV", "SSHFP",
  "SVCB", "TLSA", "TXT", "URI",
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
  /** Set by adoption when a provider service claims this name; never by an operator. */
  managedBy?: ManagedByService;
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
  "provider.apply.started",
  "provider.apply.completed",
  "provider.apply.failed",
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
/**
 * Reject bytes and tokens that can change the structure of a CoreDNS zone file
 * rather than describe one RDATA value.
 *
 * TXT is serialized as quoted character-strings by the adapter, so a semicolon
 * there remains data. Other record types are written in presentation form and
 * cannot safely contain record terminators, multiline delimiters or directives.
 */
export function zoneFileContentIssue(type: string, content: string): string | undefined {
  if (/[\u0000-\u001f\u007f]/u.test(content)) {
    return `${type || "record"} content must not contain control characters`;
  }
  if (type !== "TXT" && /[;()]/u.test(content)) {
    return `${type || "record"} content must not contain zone-file structural characters`;
  }
  if (type !== "TXT" && /(?:^|\s)\$[a-z][a-z0-9_-]*/iu.test(content)) {
    return `${type || "record"} content must not contain zone-file directives`;
  }
  return undefined;
}

/** Defense in depth for adapters called without `createDesiredRecord`. */
export function assertZoneFileSafeContent(type: string, content: string): void {
  const issue = zoneFileContentIssue(type, content);
  if (issue) throw new DomainValidationError([issue]);
}

function validateRecordContent(type: string, content: string): string | undefined {
  const unsafe = zoneFileContentIssue(type, content);
  if (unsafe) return unsafe;
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
    case "DS":
      // The parent's pointer at a signed child: which key, signed how, digested how.
      return fields.length === 4 && isUnsigned(fields[0], 16) && isUnsigned(fields[1], 8)
        && isUnsigned(fields[2], 8) && isHex(fields[3] as string)
        && hasDigestLengthFor(fields[2] as string, fields[3] as string)
        ? undefined
        : "DS content must be a key tag, an algorithm, a digest type and a digest of that type's length, as in `12345 8 2 <64 hex characters>`";
    case "DNSKEY":
      return fields.length === 4 && isUnsigned(fields[0], 16) && isUnsigned(fields[1], 8)
        && isUnsigned(fields[2], 8) && isBase64(fields[3] as string)
        ? undefined : "DNSKEY content must be flags, a protocol, an algorithm and base64 key data, as in `257 3 13 mdss…`";
    case "LOC":
      return isValidLocation(fields)
        ? undefined
        : "LOC content must be a latitude, a longitude and an altitude, as in `51 30 12.748 N 0 7 39.611 W 0.00m`";
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

/**
 * `d1 [m1 [s1]] N|S  d2 [m2 [s2]] E|W  alt[m] [size[m] [hp[m] [vp[m]]]]`
 *
 * Read by walking to each hemisphere letter rather than by counting fields,
 * because the minutes and seconds are optional on either side independently --
 * a pattern that would need four alternatives to write as one expression, and
 * that is exactly where such an expression stops being checkable by eye.
 */
function isValidLocation(fields: readonly string[]): boolean {
  const northSouth = fields.findIndex((field) => /^[NS]$/iu.test(field));
  const eastWest = fields.findIndex((field) => /^[EW]$/iu.test(field));
  if (northSouth < 1 || northSouth > 3) return false;
  if (eastWest <= northSouth || eastWest - northSouth > 4) return false;
  const angle = (parts: readonly string[], limit: number): boolean =>
    parts.length >= 1 && parts.length <= 3
    && isBoundedNumber(parts[0], 0, limit) && (parts[1] === undefined || isBoundedNumber(parts[1], 0, 59))
    && (parts[2] === undefined || isBoundedNumber(parts[2], 0, 59.999));
  if (!angle(fields.slice(0, northSouth), 90)) return false;
  if (!angle(fields.slice(northSouth + 1, eastWest), 180)) return false;
  const rest = fields.slice(eastWest + 1);
  // Altitude is required; size and the two precisions have defaults.
  return rest.length >= 1 && rest.length <= 4
    && rest.every((value) => isBoundedNumber(value.replace(/m$/iu, ""), -100_000, 42_849_672.95));
}

function isBoundedNumber(value: string | undefined, low: number, high: number): boolean {
  if (value === undefined || !/^-?\d+(?:\.\d+)?$/u.test(value)) return false;
  const parsed = Number(value);
  return parsed >= low && parsed <= high;
}

/**
 * A digest whose length contradicts its digest type is not a record a resolver
 * will read -- measured: `dig` refuses to parse the answer and reports the
 * message as malformed, so the name simply stops resolving. The provider
 * accepts it, the plan converges, and nothing says what happened.
 *
 * Types this does not know are left alone: the registry gains entries, and
 * refusing a digest because this list is old would be the opposite mistake.
 */
const DIGEST_BYTES: Readonly<Record<string, number>> = { "1": 20, "2": 32, "3": 32, "4": 48 };

function hasDigestLengthFor(digestType: string, digest: string): boolean {
  const expected = DIGEST_BYTES[digestType];
  return expected === undefined || digest.length === expected * 2;
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

/**
 * A record the provider created and still owns.
 *
 * These arrive through adoption like any other, but they are not descriptions of
 * where something is -- they are the provider's own bookkeeping for a name it
 * serves itself. Editing or deleting one through here changes DNS without
 * changing what created it, so the binding breaks and the record comes back.
 */
/**
 * A provider service that publishes a name it serves itself.
 *
 * Cloudflare's own table does not show these as the CNAME they are stored as.
 * It shows `Worker` or `R2` and the name of the worker or bucket behind them,
 * because that is what the record is: the DNS value is an implementation
 * detail of a binding made somewhere else, and reading it as a target invites
 * an operator to point it at something better, which is the one edit that
 * breaks the binding without changing what made it.
 *
 * Nothing in a DNS record says which service made it -- the API's type list is
 * the 21 real types and its response carries no marker -- so this is read from
 * the service that owns the binding and stored on the record. Adoption is what
 * writes it, and re-adopting is what corrects it.
 */
export const MANAGING_SERVICES = ["worker", "r2"] as const;

export type ManagingService = (typeof MANAGING_SERVICES)[number];

/** What the provider's own table shows in the type column for each service. */
export const MANAGING_SERVICE_LABELS: Readonly<Record<ManagingService, string>> = { worker: "Worker", r2: "R2" };

export interface ManagedByService {
  readonly service: ManagingService;
  /** The worker script or bucket this record stands for. */
  readonly resource: string;
}

/**
 * What a reader of the record means by its type: `Worker` and `R2` where a
 * service owns the name, and the DNS type everywhere else.
 */
export function recordTypeLabel(record: Pick<DesiredRecord, "type"> & { readonly managedBy?: ManagedByService }): string {
  return record.managedBy ? MANAGING_SERVICE_LABELS[record.managedBy.service] : record.type;
}

/** What the record points at, named as the thing that owns it where one does. */
export function recordContentLabel(record: Pick<DesiredRecord, "content"> & { readonly managedBy?: ManagedByService }): string {
  return record.managedBy ? record.managedBy.resource : record.content;
}

/** A worker script or bucket name, as the services that own them allow. */
const SERVICE_RESOURCE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

/**
 * Reads a service binding off stored or adopted state.
 *
 * `undefined` means the record names no service; anything present but
 * malformed is refused rather than dropped, because a dropped binding is a
 * record that silently becomes editable.
 */
export function readManagedByService(value: unknown): ManagedByService | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DomainValidationError(["managedBy must be an object"]);
  }
  const input = value as Record<string, unknown>;
  const service = typeof input.service === "string" ? input.service.toLowerCase() : "";
  if (!MANAGING_SERVICES.some((candidate) => candidate === service)) {
    throw new DomainValidationError([`managedBy.service must be one of ${MANAGING_SERVICES.join(", ")}`]);
  }
  const resource = typeof input.resource === "string" ? input.resource.trim() : "";
  if (!SERVICE_RESOURCE.test(resource)) {
    throw new DomainValidationError(["managedBy.resource must be the name of a worker or bucket"]);
  }
  return { service: service as ManagingService, resource };
}

export interface ProviderManagement {
  /** Said back to whoever tried to change it. */
  readonly reason: string;
  /**
   * True when the address cannot be reached by anyone, so no view can answer it
   * usefully and the public answer is the only real one.
   */
  readonly originless: boolean;
}

/**
 * The addresses the provider documents for originless setups: it puts one in a
 * proxied record to mean "this name exists and I serve it myself". The packet is
 * intercepted at the edge and never sent, which is why the address is one that
 * is reserved and reachable by nobody.
 *
 * Deliberately these two exact addresses rather than the blocks they belong to.
 * `192.0.2.0/24` is documentation space (RFC 5737) and `2001:db8::/32` likewise
 * (RFC 3849) -- both are perfectly ordinary things to find in a test fixture or
 * an example zone, and treating every address in them as a placeholder would
 * quietly stop answering records that mean exactly what they say. The pair named
 * here is the pair the provider's own documentation names.
 */
const ORIGINLESS_V4: readonly string[] = ["192.0.2.0"];

/** Hostnames whose records a provider service owns, though the value still works. */
const MANAGED_CNAME_SUFFIXES: readonly string[] = [".r2.dev"];

export function providerManagement(record: {
  readonly type: RecordType;
  readonly content: string;
  readonly managedBy?: ManagedByService;
}): ProviderManagement | undefined {
  const content = record.content.trim();
  // Read rather than trusted, though `createDesiredRecord` has already refused
  // anything else: this is also the portal's rule, and the two are compared
  // against each other. A binding one of them can read and the other cannot is
  // a row the page offers to edit and the server refuses to save.
  if (record.managedBy && MANAGING_SERVICES.some((service) => service === record.managedBy?.service)
    && record.managedBy.resource) {
    // The name resolves and answers -- the service is the origin -- so the
    // internal view can inherit it. What it cannot do is describe it, which is
    // why the whole row is closed rather than only its external half.
    return {
      reason: `${MANAGING_SERVICE_LABELS[record.managedBy.service]} ${record.managedBy.resource} serves this name and owns this record`,
      originless: false,
    };
  }
  if (record.type === "A" && isOriginlessV4(content)) {
    return { reason: "the provider serves this name itself and keeps a reserved placeholder address here", originless: true };
  }
  if (record.type === "AAAA" && isOriginlessV6(content)) {
    return { reason: "the provider serves this name itself and keeps a reserved placeholder address here", originless: true };
  }
  if (record.type === "CNAME") {
    const target = content.replace(/\.$/u, "").toLowerCase();
    if (MANAGED_CNAME_SUFFIXES.some((suffix) => target.endsWith(suffix))) {
      // The value is a real hostname that resolves, so it is served as stored;
      // only changing it here is refused, because what created it would not know.
      return { reason: `the provider service at ${target} owns this record`, originless: false };
    }
  }
  return undefined;
}

function isOriginlessV4(content: string): boolean {
  return ORIGINLESS_V4.includes(content);
}

/**
 * `100::` written any of the ways it can be written. Unlike the IPv4 side this
 * is matched by value rather than by text, because the same address has many
 * spellings and a provider that writes it differently tomorrow would otherwise
 * stop being recognized.
 */
function isOriginlessV6(content: string): boolean {
  const groups = ipv6Groups(content.toLowerCase());
  if (!groups) return false;
  return groups[0] === 0x0100 && groups.slice(1).every((group) => group === 0);
}

/** Expands an address to its eight groups, or `undefined` if it is not one. */
function ipv6Groups(text: string): number[] | undefined {
  if (text.includes(".")) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const filled = halves.length === 2 ? Array.from({ length: 8 - head.length - tail.length }, () => "0") : [];
  if (filled.length < 0) return undefined;
  const groups = [...head, ...filled, ...tail];
  if (groups.length !== 8) return undefined;
  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/u.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return parsed.some(Number.isNaN) ? undefined : parsed;
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
  // Read here rather than only where adoption writes it, because every stored
  // record is rebuilt through this function: a field this dropped would be a
  // lock that survives until the next restart and then quietly does not.
  let managedBy: ManagedByService | undefined;
  try {
    managedBy = readManagedByService(value.managedBy);
  } catch (error) {
    if (!(error instanceof DomainValidationError)) throw error;
    issues.push(...error.issues);
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
  if (managedBy) record.managedBy = managedBy;
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
