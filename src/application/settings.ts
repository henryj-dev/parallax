import { isIP } from "node:net";
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
  /**
   * Address a client-side resolver override should send this control plane's
   * zones to. Empty means Parallax manages no overrides at all.
   *
   * Given rather than derived. The listener's own host is usually `0.0.0.0`,
   * which is not an address anything can be told to ask, and the address a
   * device must use is a fact about the network in front of it -- a Service, a
   * gateway, a published address -- that this process cannot see from inside.
   */
  readonly fallbackResolver: string;
}

export const DEFAULT_SETTINGS: ParallaxSettings = Object.freeze({
  allowLocalProvider: false,
  coreDnsDirectory: "",
  publicOrigin: "",
  trustForwardedHeaders: false,
  revisionRetention: 100,
  auditRetentionDays: 365,
  fallbackResolver: "",
});

/** Bounds keep date arithmetic and whole-store retention work predictable. */
export const MAX_REVISION_RETENTION = 1_000_000;
export const MAX_AUDIT_RETENTION_DAYS = 36_500;
export const SETTINGS_REFRESH_INTERVAL_MS = 5_000;

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
 * Keeps a process-local copy so requests never wait on the store, while a
 * bounded background refresh applies changes made by another process through
 * the same verifier and runtime listeners as a local update.
 */
export class SettingsService {
  readonly #repository: SettingsRepository;
  readonly #listeners: SettingsListener[] = [];
  readonly #verify: SettingsVerifier | undefined;
  readonly #advise: SettingsAdvisor | undefined;
  #settings: ParallaxSettings = DEFAULT_SETTINGS;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(repository: SettingsRepository, verify?: SettingsVerifier, advise?: SettingsAdvisor) {
    this.#repository = repository;
    this.#verify = verify;
    this.#advise = advise;
  }

  load(): Promise<ParallaxSettings> {
    return this.#enqueue(async () => {
      const candidate = parseSettings(await this.#repository.read());
      // A value restored from disk or written by another replica must satisfy the
      // same machine-specific invariants as an API update. Otherwise restart is a
      // bypass around the verifier that protects filesystem and proxy boundaries.
      await this.#verify?.(candidate, this.#settings);
      this.#settings = candidate;
      return this.#settings;
    });
  }

  current(): ParallaxSettings {
    return this.#settings;
  }

  onChange(listener: SettingsListener): void {
    this.#listeners.push(listener);
  }

  /** Re-reads and applies a setting written by another process or replica. */
  refresh(): Promise<ParallaxSettings> {
    return this.#enqueue(() => this.#refresh());
  }

  startRefreshing(
    intervalMs = SETTINGS_REFRESH_INTERVAL_MS,
    onError: (error: unknown) => void = () => {},
  ): () => void {
    const timer = setInterval(() => { this.refresh().catch(onError); }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Validates and persists a partial update, then lets the process re-wire itself. */
  update(patch: unknown): Promise<SettingsUpdate> {
    return this.#enqueue(async () => {
      const changes = readPatch(patch);
      if (Object.keys(changes).length === 0) return { settings: this.#settings, warnings: [] };
      const previous = this.#settings;
      let transition: { candidate: ParallaxSettings; applied: SettingsListener[] } | undefined;
      let candidate: ParallaxSettings;
      try {
        candidate = await this.#repository.update(async (stored) => {
          // The backend holds its cross-process lock from this latest read
          // through verification, runtime re-wiring, and the patch write. Two
          // individually valid concurrent patches therefore cannot commit an
          // invalid combination derived from the same stale snapshot.
          const merged = parseSettings({ ...stored, ...changes });
          await this.#verify?.(merged, previous);
          const applied = await this.#applyListeners(merged, previous);
          transition = { candidate: merged, applied };
          return { patch: changes, result: merged };
        });
      } catch (error) {
        if (transition) await this.#rollbackListeners(transition.applied, previous, transition.candidate);
        throw error;
      }
      this.#settings = candidate;
      return { settings: this.#settings, warnings: this.#advise?.(candidate, previous) ?? [] };
    });
  }

  async #refresh(): Promise<ParallaxSettings> {
    const candidate = parseSettings(await this.#repository.read());
    const previous = this.#settings;
    if (sameSettings(candidate, previous)) return previous;
    await this.#verify?.(candidate, previous);
    await this.#applyListeners(candidate, previous);
    this.#settings = candidate;
    return candidate;
  }

  async #applyListeners(candidate: ParallaxSettings, previous: ParallaxSettings): Promise<SettingsListener[]> {
    const applied: SettingsListener[] = [];
    try {
      for (const listener of this.#listeners) {
        await listener(candidate, previous);
        applied.push(listener);
      }
      return applied;
    } catch (error) {
      await this.#rollbackListeners(applied, previous, candidate);
      throw error;
    }
  }

  async #rollbackListeners(
    applied: SettingsListener[],
    previous: ParallaxSettings,
    candidate: ParallaxSettings,
  ): Promise<void> {
    for (const listener of [...applied].reverse()) {
      await Promise.resolve(listener(previous, candidate)).catch(() => undefined);
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation);
    this.#operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function sameSettings(left: ParallaxSettings, right: ParallaxSettings): boolean {
  return SETTING_KEYS.every((key) => left[key] === right[key]);
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
    revisionRetention: readCount(merged.revisionRetention, "revisionRetention", MAX_REVISION_RETENTION),
    auditRetentionDays: readCount(merged.auditRetentionDays, "auditRetentionDays", MAX_AUDIT_RETENTION_DAYS),
    fallbackResolver: readResolver(merged.fallbackResolver),
  };
}

/**
 * One address, or nothing. A hostname is refused: the device asking is outside
 * this network and may resolve a name differently, or not at all -- and the one
 * thing it cannot do while being told where to resolve names is resolve a name.
 */
function readResolver(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return "";
  if (!isIP(text)) throw new DomainValidationError(["fallbackResolver must be an IP address"]);
  return text;
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

function readCount(value: unknown, field: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new DomainValidationError([`${field} must be an integer between 0 and ${maximum}`]);
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
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback) {
    throw new DomainValidationError(["publicOrigin must use https unless it is a loopback origin"]);
  }
  return url.origin;
}
