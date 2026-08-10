import type { ProviderAdapter } from "./ports.ts";
import { CloudflareProviderAdapter } from "../adapters/cloudflare.ts";
import { RoutingProviderAdapter } from "../adapters/router.ts";
import {
  CredentialValidationError,
  EncryptedCredentialStore,
  normalizeProfileName,
  type CloudflareCredentialSecret,
  type CloudflareProfileInput,
  type CloudflareProfileMetadata,
  type CloudflareZoneBinding,
} from "../security/credential-store.ts";

export interface CloudflareCredentialManagerOptions {
  readonly store: EncryptedCredentialStore;
  readonly router: RoutingProviderAdapter;
  readonly ownershipSecret: string;
  readonly environmentAdapters?: ReadonlyMap<string, ProviderAdapter>;
  readonly createAdapter?: (credential: CloudflareCredentialSecret) => ProviderAdapter;
}

/** A profile plus the apex domains that reuse it. */
export interface CloudflareProfileSummary extends CloudflareProfileMetadata {
  readonly zones: string[];
}

/** Coordinates encrypted credentials with live provider routing without exposing secrets. */
export class CloudflareCredentialManager {
  readonly #store: EncryptedCredentialStore;
  readonly #router: RoutingProviderAdapter;
  readonly #environmentAdapters: ReadonlyMap<string, ProviderAdapter>;
  readonly #createAdapter: (credential: CloudflareCredentialSecret) => ProviderAdapter;

  constructor(options: CloudflareCredentialManagerOptions) {
    this.#store = options.store;
    this.#router = options.router;
    this.#environmentAdapters = options.environmentAdapters ?? new Map();
    this.#createAdapter = options.createAdapter ?? ((credential) => new CloudflareProviderAdapter({
      zoneId: credential.zoneId,
      token: credential.token,
      ownershipSecret: options.ownershipSecret,
    }));
  }

  async initialize(): Promise<void> {
    for (const binding of await this.#store.listBindings()) await this.#route(binding.zone);
  }

  /** Profiles carry the reusable account id and API token; tokens never leave the store. */
  async listProfiles(): Promise<CloudflareProfileSummary[]> {
    const [profiles, bindings] = await Promise.all([this.#store.listProfiles(), this.#store.listBindings()]);
    return profiles.map((profile) => ({
      ...profile,
      zones: bindings.filter((binding) => binding.profile === profile.name).map((binding) => binding.zone),
    }));
  }

  async getProfile(name: string): Promise<CloudflareProfileSummary | undefined> {
    const profile = await this.#store.getProfile(name);
    if (!profile) return undefined;
    const bindings = await this.#store.listBindings();
    return {
      ...profile,
      zones: bindings.filter((binding) => binding.profile === profile.name).map((binding) => binding.zone),
    };
  }

  /** Re-routes every zone already bound to the profile so a rotated token takes effect at once. */
  async upsertProfile(name: string, input: CloudflareProfileInput): Promise<CloudflareProfileSummary> {
    const profile = await this.#store.upsertProfile(name, input);
    for (const binding of await this.#store.listBindings()) {
      if (binding.profile === profile.name) await this.#route(binding.zone);
    }
    const summary = await this.getProfile(profile.name);
    if (!summary) throw new Error("provider credential was not available after saving");
    return summary;
  }

  deleteProfile(name: string): Promise<boolean> {
    return this.#store.deleteProfile(name);
  }

  listZones(): Promise<CloudflareZoneBinding[]> {
    return this.#store.listBindings();
  }

  getZone(zone: string): Promise<CloudflareZoneBinding | undefined> {
    return this.#store.getBinding(zone);
  }

  async bindZone(zone: string, input: { zoneId: string; profile: string }): Promise<CloudflareZoneBinding> {
    const binding = await this.#store.bindZone(zone, input);
    await this.#route(binding.zone);
    return binding;
  }

  async unbindZone(zone: string): Promise<boolean> {
    const removed = await this.#store.unbindZone(zone);
    if (!removed) return false;
    const normalizedZone = normalizeZone(zone);
    const fallback = this.#environmentAdapters.get(normalizedZone);
    if (fallback) this.#router.registerExternal(normalizedZone, fallback);
    else this.#router.unregisterExternal(normalizedZone);
    return true;
  }

  /** Checks a stored binding, or an unsaved zone id and token, against the live API. */
  async test(zone: string, input?: { zoneId: string; token: string; accountId?: string }): Promise<CloudflareZoneBinding> {
    const credential = input ? secretForTest(zone, input) : await this.#store.getSecret(zone);
    if (!credential) throw new CredentialNotFoundError();
    await this.#probe(credential);
    return {
      zone: credential.zone,
      zoneId: credential.zoneId,
      profile: credential.profile,
      ...(credential.accountId ? { accountId: credential.accountId } : {}),
      updatedAt: credential.updatedAt,
    };
  }

  /**
   * Checks a profile before any zone uses it. Cloudflare has no token-only
   * probe, so the caller supplies a zone id to read through.
   */
  async testProfile(name: string, zoneId: string, token?: string): Promise<CloudflareProfileMetadata> {
    const profileName = normalizeProfileName(name);
    const stored = token === undefined ? await this.#store.getProfileSecret(profileName) : undefined;
    const secret = token ?? stored?.token;
    if (!secret) throw new CredentialNotFoundError();
    await this.#probe({
      zone: PROBE_ZONE,
      zoneId: validateZoneId(zoneId),
      profile: profileName,
      token: secret,
      updatedAt: new Date(0).toISOString(),
    });
    return (await this.#store.getProfile(profileName)) ?? { name: profileName, updatedAt: new Date(0).toISOString() };
  }

  async #probe(credential: CloudflareCredentialSecret): Promise<void> {
    const adapter = this.#createAdapter(credential);
    try {
      await adapter.list(`${credential.zone}/external`);
    } catch {
      throw new CredentialTestError();
    }
  }

  async #route(zone: string): Promise<void> {
    const credential = await this.#store.getSecret(zone);
    if (credential) this.#router.registerExternal(zone, this.#createAdapter(credential));
  }
}

/**
 * A syntactically valid zone used only to build a provider target while probing
 * a profile. The Cloudflare adapter addresses records by zone id, so the name
 * never reaches the API.
 */
const PROBE_ZONE = "profile-probe.invalid";

export class CredentialNotFoundError extends Error {
  constructor() {
    super("Cloudflare credential was not found");
  }
}

export class CredentialTestError extends Error {
  constructor() {
    super("Cloudflare credential test failed");
  }
}

function secretForTest(zone: string, input: { zoneId: string; token: string; accountId?: string }): CloudflareCredentialSecret {
  const normalizedZone = normalizeZone(zone);
  const zoneId = validateZoneId(input.zoneId);
  if (!input.token.trim()) throw new CredentialValidationError();
  return {
    zone: normalizedZone,
    zoneId,
    profile: "unsaved",
    ...(input.accountId?.trim() ? { accountId: input.accountId.trim() } : {}),
    token: input.token,
    updatedAt: new Date(0).toISOString(),
  };
}

function validateZoneId(value: string): string {
  const zoneId = value.trim();
  if (!zoneId) throw new CredentialValidationError();
  return zoneId;
}

function normalizeZone(value: string): string {
  const zone = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!zone.includes(".") || zone.length > 253 || zone.split(".").some((label) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/u.test(label))) {
    throw new CredentialValidationError();
  }
  return zone;
}
