import type { ProviderAdapter } from "../application/ports.ts";
import { canBeProxied, effectiveExternalTtl, type DesiredRecord, type RecordType } from "../domain/dns.ts";
import type { ProviderRecord, ReconcileOperation } from "../domain/reconciliation.ts";
import { ownershipComment, readOwnershipComment } from "./ownership.ts";

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
          content: normalizeContent(record.type, record.content),
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
export class ZoneNotFoundError extends Error {}

/** Raised when the token can edit DNS but is not allowed to look zones up. */
export class ZoneLookupForbiddenError extends Error {}

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
    // Distinct from "not found" because the operator's next step differs: grant
    // the permission, rather than check which account holds the domain.
    throw new ZoneLookupForbiddenError(`this token cannot look up zones. Grant it Zone -> Zone -> Read, or the zone id for ${name} cannot be found automatically`);
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
  return {
    name: record.name === "@" ? zone : `${record.name}.${zone}`,
    type: record.type,
    content: record.content,
    ttl: effectiveExternalTtl(record),
    ...(record.proxied === undefined ? {} : { proxied: record.proxied }),
    comment: ownershipComment(target, record.id, ownershipSecret),
  };
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
  return type === "CNAME" ? content.toLowerCase().replace(/\.$/, "") : content;
}

function asCloudflareRecord(value: unknown): CloudflareRecord | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.type !== "string" || typeof value.content !== "string" || typeof value.ttl !== "number") return undefined;
  const record: CloudflareRecord = { id: value.id, name: value.name, type: value.type, content: value.content, ttl: value.ttl };
  if (typeof value.proxied === "boolean") record.proxied = value.proxied;
  if (typeof value.comment === "string") record.comment = value.comment;
  return record;
}

function isSupportedType(value: string): value is RecordType {
  return value === "A" || value === "AAAA" || value === "CNAME" || value === "TXT";
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
