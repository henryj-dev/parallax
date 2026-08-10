import type { ProviderAdapter } from "./ports.ts";
import { CloudflareProviderAdapter } from "../adapters/cloudflare.ts";
import { RoutingProviderAdapter } from "../adapters/router.ts";
import {
  CredentialValidationError,
  EncryptedCredentialStore,
  type CloudflareCredentialInput,
  type CloudflareCredentialMetadata,
  type CloudflareCredentialSecret,
} from "../security/credential-store.ts";

export interface CloudflareCredentialManagerOptions {
  readonly store: EncryptedCredentialStore;
  readonly router: RoutingProviderAdapter;
  readonly ownershipSecret: string;
  readonly environmentAdapters?: ReadonlyMap<string, ProviderAdapter>;
  readonly createAdapter?: (credential: CloudflareCredentialSecret) => ProviderAdapter;
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
    for (const metadata of await this.#store.list()) {
      const credential = await this.#store.getSecret(metadata.zone);
      if (credential) this.#router.registerExternal(metadata.zone, this.#createAdapter(credential));
    }
  }

  list(): Promise<CloudflareCredentialMetadata[]> {
    return this.#store.list();
  }

  get(zone: string): Promise<CloudflareCredentialMetadata | undefined> {
    return this.#store.getMetadata(zone);
  }

  async update(zone: string, input: CloudflareCredentialInput): Promise<CloudflareCredentialMetadata> {
    const metadata = await this.#store.update(zone, input);
    const credential = await this.#store.getSecret(metadata.zone);
    if (!credential) throw new Error("provider credential was not available after saving");
    this.#router.registerExternal(metadata.zone, this.#createAdapter(credential));
    return metadata;
  }

  async delete(zone: string): Promise<boolean> {
    const deleted = await this.#store.delete(zone);
    if (!deleted) return false;
    const normalizedZone = normalizeZone(zone);
    const fallback = this.#environmentAdapters.get(normalizedZone);
    if (fallback) this.#router.registerExternal(normalizedZone, fallback);
    else this.#router.unregisterExternal(normalizedZone);
    return true;
  }

  async test(zone: string, input?: CloudflareCredentialInput): Promise<CloudflareCredentialMetadata> {
    const credential = input
      ? secretForTest(zone, input)
      : await this.#store.getSecret(zone);
    if (!credential) throw new CredentialNotFoundError();
    const adapter = this.#createAdapter(credential);
    try {
      await adapter.list(`${credential.zone}/external`);
    } catch {
      throw new CredentialTestError();
    }
    return { zone: credential.zone, zoneId: credential.zoneId, updatedAt: credential.updatedAt };
  }
}

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

function secretForTest(zone: string, input: CloudflareCredentialInput): CloudflareCredentialSecret {
  const normalizedZone = normalizeZone(zone);
  const zoneId = input.zoneId.trim();
  if (!zoneId || !input.token.trim()) throw new CredentialValidationError();
  return { zone: normalizedZone, zoneId, token: input.token, updatedAt: new Date(0).toISOString() };
}

function normalizeZone(value: string): string {
  const zone = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!zone.includes(".") || zone.length > 253 || zone.split(".").some((label) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/u.test(label))) {
    throw new CredentialValidationError();
  }
  return zone;
}
