import { DomainValidationError } from "../domain/dns.ts";
import type { SettingsRepository } from "./ports.ts";

/**
 * Operational configuration an administrator owns. It lives in the store rather
 * than the environment so every instance reads one value and a change does not
 * need a redeploy. Only bind address, database connection, and the keys that
 * protect stored secrets stay outside.
 */
export interface ParallaxSettings {
  /** Publish to a local file when no real provider is configured for a target. */
  readonly allowLocalProvider: boolean;
  /** Directory of RFC 1035 zone files for the internal view; empty disables it. */
  readonly coreDnsDirectory: string;
  /** Absolute origin browsers reach the portal at; empty derives it per request. */
  readonly publicOrigin: string;
  /** Trust `X-Forwarded-Proto`/`X-Forwarded-Host` from a reverse proxy. */
  readonly trustForwardedHeaders: boolean;
  /** Newest revision snapshots kept per zone; 0 keeps every one. */
  readonly revisionRetention: number;
  /** Days of audit history kept per zone; 0 keeps every entry. */
  readonly auditRetentionDays: number;
}

export const DEFAULT_SETTINGS: ParallaxSettings = Object.freeze({
  allowLocalProvider: false,
  coreDnsDirectory: "",
  publicOrigin: "",
  trustForwardedHeaders: false,
  revisionRetention: 100,
  auditRetentionDays: 365,
});

export const SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS) as Array<keyof ParallaxSettings>);

export type SettingsListener = (settings: ParallaxSettings, previous: ParallaxSettings) => void | Promise<void>;

/**
 * Rejects a candidate the process could not actually act on. Value shapes are
 * checked here in the application layer; whether a named path can be written is
 * a question about the machine, so the answer is injected.
 */
export type SettingsVerifier = (candidate: ParallaxSettings, previous: ParallaxSettings) => void | Promise<void>;

/**
 * Says what a legal change will cost. A verifier refuses what the process
 * cannot do; this reports what it can do but probably should not, which is a
 * different answer and belongs to the person making the change rather than to
 * whoever reads the log later.
 */
export type SettingsAdvisor = (candidate: ParallaxSettings, previous: ParallaxSettings) => readonly string[];

export interface SettingsUpdate {
  readonly settings: ParallaxSettings;
  readonly warnings: readonly string[];
}

/**
 * Reads settings once at startup and keeps the cached copy authoritative for
 * this process, so a request never waits on the store to answer a question the
 * control plane asks on every call.
 */
export class SettingsService {
  readonly #repository: SettingsRepository;
  readonly #listeners: SettingsListener[] = [];
  readonly #verify: SettingsVerifier | undefined;
  readonly #advise: SettingsAdvisor | undefined;
  #settings: ParallaxSettings = DEFAULT_SETTINGS;

  constructor(repository: SettingsRepository, verify?: SettingsVerifier, advise?: SettingsAdvisor) {
    this.#repository = repository;
    this.#verify = verify;
    this.#advise = advise;
  }

  async load(): Promise<ParallaxSettings> {
    this.#settings = parseSettings(await this.#repository.read());
    return this.#settings;
  }

  current(): ParallaxSettings {
    return this.#settings;
  }

  onChange(listener: SettingsListener): void {
    this.#listeners.push(listener);
  }

  /** Validates and persists a partial update, then lets the process re-wire itself. */
  async update(patch: unknown): Promise<SettingsUpdate> {
    const changes = readPatch(patch);
    if (Object.keys(changes).length === 0) return { settings: this.#settings, warnings: [] };
    const previous = this.#settings;
    const candidate = parseSettings({ ...toRecord(previous), ...changes });
    // Verified before it is stored, so a setting the process cannot act on is
    // refused to the person changing it. Left unchecked, the same mistake
    // surfaces at the first apply instead -- as a deliberately redacted
    // provider error, to somebody who was not there when the value changed.
    await this.#verify?.(candidate, previous);
    await this.#repository.write(changes);
    this.#settings = candidate;
    for (const listener of this.#listeners) await listener(this.#settings, previous);
    return { settings: this.#settings, warnings: this.#advise?.(candidate, previous) ?? [] };
  }
}

function toRecord(settings: ParallaxSettings): Record<string, unknown> {
  return { ...settings };
}

/** Applies stored values over the defaults, ignoring anything unrecognized. */
export function parseSettings(stored: Record<string, unknown>): ParallaxSettings {
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    if (stored[key] !== undefined) merged[key] = stored[key];
  }
  return {
    allowLocalProvider: readBoolean(merged.allowLocalProvider, "allowLocalProvider"),
    coreDnsDirectory: readText(merged.coreDnsDirectory, "coreDnsDirectory"),
    publicOrigin: readOrigin(merged.publicOrigin),
    trustForwardedHeaders: readBoolean(merged.trustForwardedHeaders, "trustForwardedHeaders"),
    revisionRetention: readCount(merged.revisionRetention, "revisionRetention"),
    auditRetentionDays: readCount(merged.auditRetentionDays, "auditRetentionDays"),
  };
}

function readPatch(patch: unknown): Record<string, unknown> {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new DomainValidationError(["settings must be an object"]);
  }
  const source = patch as Record<string, unknown>;
  const unknownKeys = Object.keys(source).filter((key) => !SETTING_KEYS.some((known) => known === key));
  if (unknownKeys.length > 0) {
    throw new DomainValidationError([`unknown setting: ${unknownKeys.sort().join(", ")}`]);
  }
  const changes: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (source[key] === undefined) continue;
    changes[key] = source[key];
  }
  // Validate the merged result so a patch can never persist an unusable value.
  parseSettings({ ...DEFAULT_SETTINGS, ...changes });
  return changes;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new DomainValidationError([`${field} must be true or false`]);
  return value;
}

function readText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new DomainValidationError([`${field} must be a string`]);
  const text = value.trim();
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw new DomainValidationError([`${field} must not contain control characters`]);
  return text;
}

function readCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainValidationError([`${field} must be a non-negative integer`]);
  }
  return value;
}

function readOrigin(value: unknown): string {
  const origin = readText(value, "publicOrigin");
  if (origin === "") return "";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new DomainValidationError(["publicOrigin must be an absolute http or https origin"]);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin.replace(/\/$/, "")) {
    throw new DomainValidationError(["publicOrigin must be an absolute http or https origin"]);
  }
  return url.origin;
}
