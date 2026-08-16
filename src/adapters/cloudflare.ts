import { ProviderConstraintError } from "../application/ports.ts";
import type { ProviderAdapter } from "../application/ports.ts";
import { RECORD_TYPES, canBeProxied, effectiveExternalTtl, type DesiredRecord, type RecordType } from "../domain/dns.ts";
import type { ProviderRecord, ReconcileOperation } from "../domain/reconciliation.ts";
import { MAX_RECORD_ID_LENGTH, MAX_MARKER_LENGTH, ownershipComment, readOwnershipComment } from "./ownership.ts";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CloudflareProviderAdapterOptions {
  token: string;
  zoneId: string;
  fetch?: Fetch;
  apiBaseUrl?: string;
  timeoutMs?: number;
  maxPages?: number;
  ownershipSecret: string;
}

interface CloudflareRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  /** Cloudflare keeps the leading number of MX, SRV and URI RDATA here. */
  priority?: number;
  proxied?: boolean;
  comment?: string;
}

/** Cloudflare DNS adapter. Ownership is explicit and scoped to each `zone/view` target. */
export class CloudflareProviderAdapter implements ProviderAdapter {
  readonly #token: string;
  readonly #zoneId: string;
  readonly #fetch: Fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxPages: number;
  readonly #ownershipSecret: string;

  constructor(options: CloudflareProviderAdapterOptions) {
    if (!options.token.trim()) throw new Error("Cloudflare API token is required");
    if (!options.zoneId.trim()) throw new Error("Cloudflare zone id is required");
    this.#token = options.token;
    this.#zoneId = options.zoneId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.apiBaseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, "Cloudflare timeout");
    this.#maxPages = positiveInteger(options.maxPages ?? 100, "Cloudflare page limit");
    this.#ownershipSecret = options.ownershipSecret;
    ownershipComment("validation/target", "validation", this.#ownershipSecret);
  }

  async list(target: string): Promise<ProviderRecord[]> {
    const zone = zoneFromTarget(target);
    const result: ProviderRecord[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const payload = await this.#request("GET", `/zones/${encodeURIComponent(this.#zoneId)}/dns_records?per_page=100&page=${page}`);
      const records = Array.isArray(payload.result) ? payload.result : [];
      for (const value of records) {
        const record = asCloudflareRecord(value);
        if (!record || !isSupportedType(record.type)) continue;
        const name = relativeName(record.name, zone);
        if (name === undefined) continue;
        const ownership = readOwnershipComment(record.comment, this.#ownershipSecret, target);
        const managed = ownership !== undefined;
        const mapped: ProviderRecord = {
          id: managed ? ownership.recordId : record.id,
          providerId: record.id,
          managed,
          name,
          type: record.type,
          content: joinPriority(record.type, normalizeContent(record.type, record.content), record.priority),
          ttl: effectiveExternalTtl(record as Pick<DesiredRecord, "type" | "ttl" | "proxied">),
        };
        // Cloudflare reports `proxied` on every type, including the ones it
        // cannot proxy. Carrying `proxied: false` on a TXT record would be a
        // value this control plane refuses to describe, so it is dropped where
        // it has no meaning rather than at every reader.
        if (record.proxied !== undefined && canBeProxied(record.type)) mapped.proxied = record.proxied;
        result.push(mapped);
      }
      const info = isObject(payload.result_info) ? payload.result_info : undefined;
      totalPages = typeof info?.total_pages === "number" ? info.total_pages : 1;
      if (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > this.#maxPages) {
        throw new Error(`Cloudflare API pagination exceeds the configured limit of ${this.#maxPages}`);
      }
      page += 1;
    } while (page <= totalPages);
    return result;
  }

  async apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> {
    const zone = zoneFromTarget(target);
    if (operation.kind === "create") {
      await this.#request("POST", `/zones/${encodeURIComponent(this.#zoneId)}/dns_records`, recordBody(target, zone, operation.desired, this.#ownershipSecret));
      return;
    }
    const id = encodeURIComponent(operation.providerId);
    if (operation.kind === "update") {
      await this.#assertOwned(target, operation.providerId);
      await this.#request("PATCH", `/zones/${encodeURIComponent(this.#zoneId)}/dns_records/${id}`, recordBody(target, zone, operation.desired, this.#ownershipSecret));
      return;
    }
    if (!operation.actual.managed) throw new Error(`refusing to delete unmanaged Cloudflare record ${operation.providerId}`);
    if (operation.actual.providerId !== operation.providerId) throw new Error("Cloudflare delete provider id does not match the actual record");
    await this.#assertOwned(target, operation.providerId);
    await this.#request("DELETE", `/zones/${encodeURIComponent(this.#zoneId)}/dns_records/${id}`);
  }

  async #assertOwned(target: string, providerId: string): Promise<void> {
    const payload = await this.#request("GET", `/zones/${encodeURIComponent(this.#zoneId)}/dns_records/${encodeURIComponent(providerId)}`);
    const record = asCloudflareRecord(payload.result);
    if (!record || !readOwnershipComment(record.comment, this.#ownershipSecret, target)) {
      throw new Error(`Cloudflare record ${providerId} is not owned by target ${target}`);
    }
  }

  async #request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`Cloudflare API transport failure: ${redact(error instanceof Error ? error.message : String(error), this.#token)}`);
    }
    const payload = await readJson(response);
    if (!response.ok || payload.success !== true) {
      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      const codes = errors.flatMap((error) => isObject(error) && (typeof error.code === "number" || typeof error.code === "string") ? [String(error.code)] : []);
      throw new Error(`Cloudflare API request failed (HTTP ${response.status}${codes.length > 0 ? `; codes ${codes.join(",")}` : ""})`);
    }
    return payload;
  }
}

/** Raised when the account holds no zone by that name, or the token cannot see it. */
export class ZoneNotFoundError extends Error {
  override readonly name = "ZoneNotFoundError";
}

/** Raised when the token can edit DNS but is not allowed to look zones up. */
export class ZoneLookupForbiddenError extends Error {
  override readonly name = "ZoneLookupForbiddenError";
}

export interface ResolveZoneIdOptions {
  readonly name: string;
  readonly token: string;
  readonly fetch?: Fetch;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

/**
 * Finds a zone's id from its name, so an operator binds a domain by typing the
 * domain rather than copying an identifier out of a dashboard.
 *
 * This is the one call Parallax makes outside `dns_records`, and it needs a
 * permission the rest of the adapter does not: `Zone → Zone → Read`. It runs
 * only when a binding is created -- the id is stored and every later read and
 * write uses that -- so the extra permission is never exercised by an apply.
 */
export async function resolveZoneId(options: ResolveZoneIdOptions): Promise<string> {
  const name = options.name.trim().toLowerCase();
  if (!name) throw new Error("a zone name is required to look up its id");
  const token = options.token;
  if (!token.trim()) throw new Error("Cloudflare API token is required");
  const baseUrl = (options.apiBaseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  const request = options.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    // `per_page=2` so a second match is visible rather than silently taking the
    // first of an ambiguous answer.
    response = await request(`${baseUrl}/zones?name=${encodeURIComponent(name)}&per_page=2`, {
      signal: AbortSignal.timeout(positiveInteger(options.timeoutMs ?? 15_000, "Cloudflare timeout")),
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new Error(`Cloudflare API transport failure: ${redact(error instanceof Error ? error.message : String(error), token)}`);
  }

  const payload = await readJson(response);
  if (response.status === 403) {
    // Cloudflare uses the same status for a token it rejects and one that is
    // valid but lacks Zone Read. Do not claim to distinguish those cases when
    // the response does not provide trustworthy evidence for doing so.
    throw new ZoneLookupForbiddenError(`this token is invalid or cannot look up zones. Verify it, then grant Zone -> Zone -> Read so the zone id for ${name} can be found automatically`);
  }
  if (!response.ok || payload.success !== true) {
    throw new Error(`Cloudflare API request failed while looking up ${name} (HTTP ${response.status})`);
  }

  const matches = (Array.isArray(payload.result) ? payload.result : [])
    .filter(isObject)
    .filter((zone) => typeof zone.name === "string" && zone.name.toLowerCase() === name)
    .flatMap((zone) => (typeof zone.id === "string" && zone.id ? [zone.id] : []));
  if (matches.length === 0) {
    throw new ZoneNotFoundError(`no Cloudflare zone named ${name} is visible to this token`);
  }
  if (matches.length > 1) {
    throw new Error(`Cloudflare returned ${matches.length} zones named ${name}; the binding would be ambiguous`);
  }
  return matches[0]!;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function recordBody(target: string, zone: string, record: DesiredRecord, ownershipSecret: string): Record<string, unknown> {
  const { content, priority } = splitPriority(record.type, record.content);
  return {
    name: record.name === "@" ? zone : `${record.name}.${zone}`,
    type: record.type,
    content,
    ...(priority === undefined ? {} : { priority }),
    ttl: effectiveExternalTtl(record),
    ...(record.proxied === undefined ? {} : { proxied: record.proxied }),
    comment: cloudflareComment(target, record, ownershipSecret),
  };
}

/**
 * Cloudflare caps a record comment at 100 characters, and refuses the write
 * rather than truncating. Checked here, where the limit is, so a record too
 * long only for Cloudflare still publishes to providers that store the marker
 * in a column with no length.
 */
function cloudflareComment(target: string, record: DesiredRecord, ownershipSecret: string): string {
  const comment = ownershipComment(target, record.id, ownershipSecret);
  if (comment.length > MAX_MARKER_LENGTH) {
    throw new ProviderConstraintError(
      `Cloudflare allows ${MAX_MARKER_LENGTH} characters in a record comment, and the ownership marker for record ${record.id} needs ${comment.length}. Shorten the record id to at most ${MAX_RECORD_ID_LENGTH} characters.`,
    );
  }
  return comment;
}

function zoneFromTarget(target: string): string {
  const separator = target.lastIndexOf("/");
  const zone = (separator < 0 ? target : target.slice(0, separator)).trim().toLowerCase().replace(/\.$/, "");
  if (!zone || !zone.includes(".")) throw new Error(`invalid provider target ${target}`);
  return zone;
}

function relativeName(name: string, zone: string): string | undefined {
  const normalized = name.toLowerCase().replace(/\.$/, "");
  if (normalized === zone) return "@";
  const suffix = `.${zone}`;
  return normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : undefined;
}

function normalizeContent(type: RecordType, content: string): string {
  if (type === "CNAME") return content.toLowerCase().replace(/\.$/, "");
  return type === "TXT" ? readTxtPresentation(content) : content;
}

/**
 * Reads the value out of a TXT record as Cloudflare returns it.
 *
 * A TXT record is one or more quoted character-strings, split at 255 characters
 * by every provider whether or not the operator wrote it that way, and
 * Cloudflare hands back that presentation form. The desired state holds the
 * value itself, unquoted, because that is what each provider needs to be given
 * and what a reader of the record means by its content.
 *
 * Two things went wrong without this. The internal view stored the quotes as
 * part of the value and PowerDNS quoted that again, so an internal resolver
 * answered a string beginning with `"` where the public one answered SPF. And a
 * TXT record Parallax created would have come back quoted, differed from the
 * desired state on every comparison, and proposed the same update forever.
 */
function readTxtPresentation(content: string): string {
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

function asCloudflareRecord(value: unknown): CloudflareRecord | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.type !== "string" || typeof value.content !== "string" || typeof value.ttl !== "number") return undefined;
  const record: CloudflareRecord = { id: value.id, name: value.name, type: value.type, content: value.content, ttl: value.ttl };
  if (typeof value.priority === "number") record.priority = value.priority;
  if (typeof value.proxied === "boolean") record.proxied = value.proxied;
  if (typeof value.comment === "string") record.comment = value.comment;
  return record;
}

function isSupportedType(value: string): value is RecordType {
  return RECORD_TYPES.some((candidate) => candidate === value);
}

/**
 * Types whose presentation format opens with a number that Cloudflare keeps in
 * its own `priority` field instead of in `content`.
 *
 * Cloudflare has been moving these toward presentation format, so the reader
 * accepts either: it prepends the priority only when the content does not
 * already start with one. The writer always splits, which both forms accept.
 */
function hasSeparatePriority(type: string): boolean {
  return type === "MX" || type === "SRV" || type === "URI";
}

/**
 * How many whitespace-separated fields the complete presentation form has, for
 * the three types Cloudflare keeps a priority out of `content` for.
 *
 * Counting is the only way to tell whether the priority is already there. The
 * previous test -- does the content begin with a number -- is right for `MX`,
 * whose content is a hostname, and wrong for the other two: an `SRV` content
 * begins with its weight and a `URI` content with its own, so the leading digit
 * that was read as "the priority is present" was a different number entirely.
 * The priority was then dropped, and adopting an `SRV` from Cloudflare failed
 * validation with a content one field short.
 */
const COMPLETE_FIELDS: Readonly<Record<string, number>> = { MX: 2, SRV: 4, URI: 3 };

function joinPriority(type: string, content: string, priority: number | undefined): string {
  if (!hasSeparatePriority(type) || priority === undefined) return content;
  const complete = COMPLETE_FIELDS[type];
  if (complete === undefined) return content;
  const fields = content.trim().split(/\s+/u).filter((field) => field !== "").length;
  return fields === complete - 1 ? `${priority} ${content}` : content;
}

/** Splits the leading priority back out, for the field Cloudflare expects it in. */
function splitPriority(type: string, content: string): { content: string; priority?: number } {
  if (!hasSeparatePriority(type)) return { content };
  const match = /^(\d+)\s+(.*)$/su.exec(content);
  return match ? { content: match[2] as string, priority: Number(match[1]) } : { content };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redact(message: string, token: string): string {
  return message.replaceAll(token, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
