import { ProviderConstraintError } from "../application/ports.ts";
import type { ProviderAdapter } from "../application/ports.ts";
import { RECORD_TYPES, canonicalizeRecordContent, type DesiredRecord, type RecordType } from "../domain/dns.ts";
import type { ProviderRecord, ReconcileOperation } from "../domain/reconciliation.ts";
import { ownershipComment, readOwnershipComment } from "./ownership.ts";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface Ns1ProviderAdapterOptions {
  apiKey: string;
  fetch?: Fetch;
  apiBaseUrl?: string;
  timeoutMs?: number;
  ownershipSecret: string;
}

interface Ns1Record {
  id: string;
  domain: string;
  type: string;
  ttl: number;
  answers: { answer: string[] }[];
  meta?: Record<string, unknown>;
}

/**
 * NS1 DNS adapter. Ownership lives in record `meta.parallax`, the free-text
 * field this provider offers the way Cloudflare offers a comment.
 */
export class Ns1ProviderAdapter implements ProviderAdapter {
  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #ownershipSecret: string;

  constructor(options: Ns1ProviderAdapterOptions) {
    if (!options.apiKey.trim()) throw new Error("NS1 API key is required");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.apiBaseUrl ?? "https://api.nsone.net/v1").replace(/\/$/, "");
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, "NS1 timeout");
    this.#ownershipSecret = options.ownershipSecret;
    ownershipComment("validation/target", "validation", this.#ownershipSecret);
  }

  async list(target: string): Promise<ProviderRecord[]> {
    const zone = zoneFromTarget(target);
    const payload = await this.#request("GET", `/zones/${encodeURIComponent(zone)}`);
    const records = Array.isArray(payload.records) ? payload.records : [];
    const result: ProviderRecord[] = [];
    for (const value of records) {
      const record = asNs1Record(value);
      if (!record) {
        const type = isObject(value) && typeof value.type === "string" ? value.type : "";
        if (isSupportedType(type)) {
          const id = isObject(value) && typeof value.id === "string" ? value.id : type;
          throw new Error(`NS1 record ${id} (${type}) has no usable RDATA`);
        }
        continue;
      }
      if (!isSupportedType(record.type)) continue;
      const name = relativeName(record.domain, zone);
      if (name === undefined) continue;
      const content = answersToContent(record.type, record.answers);
      if (content === undefined) {
        throw new Error(`NS1 record ${record.id} (${record.type}) has no usable RDATA`);
      }
      const marker = typeof record.meta?.parallax === "string" ? record.meta.parallax : undefined;
      const ownership = readOwnershipComment(marker, this.#ownershipSecret, target);
      const managed = ownership !== undefined;
      result.push({
        id: managed ? ownership.recordId : record.id,
        providerId: record.id,
        managed,
        name,
        type: record.type,
        content: canonicalizeRecordContent(record.type, content),
        ttl: record.ttl,
      });
    }
    return result;
  }

  async apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> {
    const zone = zoneFromTarget(target);
    if (operation.kind === "create") {
      const path = recordPath(zone, operation.desired);
      await this.#request("PUT", path, recordBody(target, zone, operation.desired, this.#ownershipSecret));
      return;
    }
    if (operation.kind === "update") {
      await this.#assertOwned(target, zone, operation.desired, operation.providerId);
      await this.#request("POST", recordPath(zone, operation.desired), recordBody(target, zone, operation.desired, this.#ownershipSecret));
      return;
    }
    if (!operation.actual.managed) throw new Error(`refusing to delete unmanaged NS1 record ${operation.providerId}`);
    if (operation.actual.providerId !== operation.providerId) throw new Error("NS1 delete provider id does not match the actual record");
    await this.#assertOwned(target, zone, operation.actual, operation.providerId);
    await this.#request("DELETE", recordPath(zone, operation.actual));
  }

  async #assertOwned(target: string, zone: string, record: Pick<DesiredRecord, "name" | "type">, providerId: string): Promise<void> {
    const payload = await this.#request("GET", recordPath(zone, record));
    const live = asNs1Record(payload);
    if (!live || live.id !== providerId) {
      throw new Error(`NS1 record ${providerId} is not owned by target ${target}`);
    }
    const marker = typeof live.meta?.parallax === "string" ? live.meta.parallax : undefined;
    if (!readOwnershipComment(marker, this.#ownershipSecret, target)) {
      throw new Error(`NS1 record ${providerId} is not owned by target ${target}`);
    }
  }

  async #request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          "x-nsone-key": this.#apiKey,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`NS1 API transport failure: ${redact(error instanceof Error ? error.message : String(error), this.#apiKey)}`);
    }
    const payload = await readJson(response);
    if (!response.ok) {
      throw new Error(`NS1 API request failed (HTTP ${response.status})`);
    }
    return payload;
  }
}

function recordPath(zone: string, record: Pick<DesiredRecord, "name" | "type">): string {
  const domain = record.name === "@" ? zone : `${record.name}.${zone}`;
  return `/zones/${encodeURIComponent(zone)}/${encodeURIComponent(domain)}/${encodeURIComponent(record.type)}`;
}

function recordBody(target: string, zone: string, record: DesiredRecord, ownershipSecret: string): Record<string, unknown> {
  const marker = ownershipComment(target, record.id, ownershipSecret);
  if (!marker) throw new ProviderConstraintError(`NS1 ownership marker for record ${record.id} could not be written`);
  return {
    zone,
    domain: record.name === "@" ? zone : `${record.name}.${zone}`,
    type: record.type,
    ttl: record.ttl,
    answers: contentToAnswers(record.type, record.content),
    meta: { parallax: marker },
  };
}

function answersToContent(type: string, answers: readonly { answer: string[] }[]): string | undefined {
  const first = answers[0];
  if (!first || first.answer.length === 0) return undefined;
  if (type === "TXT") return first.answer.join("");
  return first.answer.join(" ");
}

function contentToAnswers(type: string, content: string): { answer: string[] }[] {
  if (type === "MX" || type === "SRV" || type === "URI") {
    return [{ answer: content.split(/\s+/u).filter((part) => part.length > 0) }];
  }
  return [{ answer: [content] }];
}

function asNs1Record(value: unknown): Ns1Record | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.domain !== "string" || typeof value.type !== "string") return undefined;
  if (typeof value.ttl !== "number") return undefined;
  const answers = Array.isArray(value.answers) ? value.answers.flatMap((entry) => {
    if (!isObject(entry) || !Array.isArray(entry.answer)) return [];
    const parts = entry.answer.filter((part): part is string => typeof part === "string");
    return parts.length > 0 ? [{ answer: parts }] : [];
  }) : [];
  const record: Ns1Record = { id: value.id, domain: value.domain, type: value.type, ttl: value.ttl, answers };
  if (isObject(value.meta)) record.meta = value.meta;
  return record;
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

function isSupportedType(value: string): value is RecordType {
  return RECORD_TYPES.some((candidate) => candidate === value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function redact(message: string, token: string): string {
  return message.replaceAll(token, "[redacted]");
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}
