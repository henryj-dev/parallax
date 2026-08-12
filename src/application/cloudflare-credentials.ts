import type { ProviderAdapter } from "./ports.ts";
import { CloudflareProviderAdapter, resolveZoneId, ZoneLookupForbiddenError, ZoneNotFoundError } from "../adapters/cloudflare.ts";
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
  /** Injected so a test can bind without reaching Cloudflare. */
  readonly resolveZoneId?: (zone: string, token: string) => Promise<string>;
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
  readonly #resolveZoneId: (zone: string, token: string) => Promise<string>;

  constructor(options: CloudflareCredentialManagerOptions) {
    this.#store = options.store;
    this.#router = options.router;
    this.#environmentAdapters = options.environmentAdapters ?? new Map();
    this.#createAdapter = options.createAdapter ?? ((credential) => new CloudflareProviderAdapter({
      zoneId: credential.zoneId,
      token: credential.token,
      ownershipSecret: options.ownershipSecret,
    }));
    this.#resolveZoneId = options.resolveZoneId
      ?? ((zone, token) => resolveZoneId({ name: zone, token }));
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

  /**
   * Binds a domain to a profile. The zone id is looked up from the domain rather
   * than typed: it is an identifier the operator would otherwise have to copy out
   * of a dashboard, and getting it wrong points Parallax at somebody else's zone.
   * It is resolved once here and stored, so applying never needs the permission
   * the lookup does.
   */
  async bindZone(zone: string, input: { profile: string }): Promise<CloudflareZoneBinding> {
    const profileName = normalizeProfileName(input.profile);
    const profile = await this.#store.getProfileSecret(profileName);
    if (!profile) throw new CredentialNotFoundError();
    const zoneId = await this.#zoneIdFor(normalizeZone(zone), profile.token);
    const binding = await this.#store.bindZone(zone, { zoneId, profile: profileName });
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

  /**
   * Checks a binding against the live API before or after it is saved.
   *
   * A profile can be named instead of a token, which is what makes testing
   * first possible: profiles are write-only, so the portal never holds the
   * token it would otherwise have to send. Without this the only testable
   * binding is one that already exists, and the operator has to commit before
   * finding out whether the credential works.
   */
  async test(zone: string, input?: { token: string; accountId?: string } | { profile: string }): Promise<CloudflareZoneBinding> {
    const credential = input ? await this.#unsavedSecret(zone, input) : await this.#store.getSecret(zone);
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
   * Checks a profile before any zone uses it. Cloudflare has no token-only probe,
   * so the caller names a domain the token should be able to reach and the
   * profile is exercised against it -- which also proves the token can look zones
   * up, the permission binding will need.
   */
  async testProfile(name: string, zone: string, token?: string): Promise<CloudflareProfileMetadata> {
    const profileName = normalizeProfileName(name);
    const stored = token === undefined ? await this.#store.getProfileSecret(profileName) : undefined;
    const secret = token ?? stored?.token;
    if (!secret) throw new CredentialNotFoundError();
    const zoneName = normalizeZone(zone);
    await this.#probe({
      zone: zoneName,
      zoneId: await this.#zoneIdFor(zoneName, secret),
      profile: profileName,
      token: secret,
      updatedAt: new Date(0).toISOString(),
    });
    return (await this.#store.getProfile(profileName)) ?? { name: profileName, updatedAt: new Date(0).toISOString() };
  }

  /** Builds a credential to probe with, without storing anything. */
  async #unsavedSecret(zone: string, input: { token: string; accountId?: string } | { profile: string }): Promise<CloudflareCredentialSecret> {
    const normalizedZone = normalizeZone(zone);
    if (!("profile" in input)) {
      return secretForTest(zone, { ...input, zoneId: await this.#zoneIdFor(normalizedZone, input.token) });
    }
    const profileName = normalizeProfileName(input.profile);
    const profile = await this.#store.getProfileSecret(profileName);
    if (!profile) throw new CredentialNotFoundError();
    return {
      zone: normalizedZone,
      zoneId: await this.#zoneIdFor(normalizedZone, profile.token),
      profile: profileName,
      ...(profile.accountId ? { accountId: profile.accountId } : {}),
      token: profile.token,
      updatedAt: new Date(0).toISOString(),
    };
  }

  /**
   * Resolves a zone id, keeping the two failures an operator can act on and
   * turning anything else into the same answer a failed probe gives. A token
   * the provider rejects is a rejected credential, not an internal fault.
   */
  async #zoneIdFor(zone: string, token: string): Promise<string> {
    try {
      return await this.#resolveZoneId(zone, token);
    } catch (error) {
      if (error instanceof ZoneLookupForbiddenError || error instanceof ZoneNotFoundError) throw error;
      throw new CredentialTestError();
    }
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
