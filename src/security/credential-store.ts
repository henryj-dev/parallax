import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const FILE_VERSION = 1;
const DOCUMENT_VERSION = 2;
const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;
const AAD = Buffer.from("parallax:credential-store:v1", "utf8");
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

/** A caller supplied an unusable zone, zone id, profile, or token. Safe to report as a 400. */
export class CredentialValidationError extends TypeError {
  constructor(message = "invalid provider credential") {
    super(message);
    this.name = "CredentialValidationError";
  }
}

/** A profile is still bound to at least one zone and cannot be removed. */
export class CredentialInUseError extends Error {
  readonly zones: readonly string[];

  constructor(zones: readonly string[]) {
    super(`credential profile is still used by ${zones.join(", ")}`);
    this.name = "CredentialInUseError";
    this.zones = zones;
  }
}

/** The reusable half of a Cloudflare credential: one account and one API token. */
export interface CloudflareProfileInput {
  readonly accountId?: string;
  readonly token: string;
}

/** Safe to return from an admin API; deliberately contains no token field. */
export interface CloudflareProfileMetadata {
  readonly name: string;
  readonly accountId?: string;
  readonly updatedAt: string;
}

/** Ties one apex domain to a reusable profile and the zone id Cloudflare assigned it. */
export interface CloudflareZoneBindingInput {
  readonly zoneId: string;
  readonly profile: string;
}

export interface CloudflareZoneBinding {
  readonly zone: string;
  readonly zoneId: string;
  readonly profile: string;
  readonly accountId?: string;
  readonly updatedAt: string;
}

/** Server-only value for constructing a provider adapter. Never serialize this to HTTP. */
export interface CloudflareCredentialSecret {
  readonly zone: string;
  readonly zoneId: string;
  readonly profile: string;
  readonly accountId?: string;
  readonly token: string;
  readonly updatedAt: string;
}

export interface EncryptedCredentialStoreOptions {
  readonly filePath: string;
  /** Caller-owned key material is copied and must contain exactly 32 bytes. */
  readonly masterKey: Uint8Array;
  readonly now?: () => Date;
}

interface StoredProfile {
  name: string;
  accountId?: string;
  token: string;
  updatedAt: string;
}

interface StoredBinding {
  zone: string;
  zoneId: string;
  profile: string;
  updatedAt: string;
}

interface PlaintextDocument {
  version: 2;
  profiles: StoredProfile[];
  bindings: StoredBinding[];
}

interface EncryptedEnvelope {
  version: 1;
  algorithm: "AES-256-GCM";
  nonce: string;
  authenticationTag: string;
  ciphertext: string;
}

interface StoreState {
  profiles: Map<string, StoredProfile>;
  bindings: Map<string, StoredBinding>;
}

/**
 * A small encrypted persistence boundary for Cloudflare credentials.
 *
 * Credentials are split so an account-wide API token is entered once: a profile
 * holds the reusable account id and token, and each apex domain binds to a
 * profile plus its own zone id.
 *
 * Mutations on one instance are serialized and committed with a same-directory
 * temporary file followed by rename, so readers see either the old or new file.
 */
export class EncryptedCredentialStore {
  readonly #filePath: string;
  readonly #masterKey: Buffer;
  readonly #now: () => Date;
  #state: StoreState | undefined;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: EncryptedCredentialStoreOptions) {
    if (options.masterKey.byteLength !== 32) {
      throw new TypeError("master key must be exactly 32 bytes");
    }
    if (options.filePath.trim().length === 0) throw new TypeError("credential store path is required");
    this.#filePath = options.filePath;
    this.#masterKey = Buffer.from(options.masterKey);
    this.#now = options.now ?? (() => new Date());
  }

  async listProfiles(): Promise<CloudflareProfileMetadata[]> {
    await this.#mutationTail;
    const state = await this.#load();
    return [...state.profiles.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(toProfileMetadata);
  }

  async getProfile(name: string): Promise<CloudflareProfileMetadata | undefined> {
    const profileName = normalizeProfileName(name);
    await this.#mutationTail;
    const profile = (await this.#load()).profiles.get(profileName);
    return profile ? toProfileMetadata(profile) : undefined;
  }

  async upsertProfile(name: string, input: CloudflareProfileInput): Promise<CloudflareProfileMetadata> {
    const profileName = normalizeProfileName(name);
    const token = validateToken(input.token);
    const accountId = input.accountId === undefined ? undefined : validateAccountId(input.accountId);

    return this.#enqueueMutation(async () => {
      const state = await this.#load();
      const profile: StoredProfile = {
        name: profileName,
        ...(accountId ? { accountId } : {}),
        token,
        updatedAt: this.#now().toISOString(),
      };
      const next = cloneState(state);
      next.profiles.set(profileName, profile);
      await this.#persist(next);
      this.#state = next;
      return toProfileMetadata(profile);
    });
  }

  /** Refuses while any zone still points at the profile, so routing cannot silently break. */
  async deleteProfile(name: string): Promise<boolean> {
    const profileName = normalizeProfileName(name);
    return this.#enqueueMutation(async () => {
      const state = await this.#load();
      if (!state.profiles.has(profileName)) return false;
      const bound = [...state.bindings.values()]
        .filter((binding) => binding.profile === profileName)
        .map((binding) => binding.zone)
        .sort();
      if (bound.length > 0) throw new CredentialInUseError(bound);
      const next = cloneState(state);
      next.profiles.delete(profileName);
      await this.#persist(next);
      this.#state = next;
      return true;
    });
  }

  async listBindings(): Promise<CloudflareZoneBinding[]> {
    await this.#mutationTail;
    const state = await this.#load();
    return [...state.bindings.values()]
      .sort((left, right) => left.zone.localeCompare(right.zone))
      .map((binding) => toBinding(binding, state.profiles.get(binding.profile)));
  }

  async getBinding(zone: string): Promise<CloudflareZoneBinding | undefined> {
    const normalizedZone = normalizeZone(zone);
    await this.#mutationTail;
    const state = await this.#load();
    const binding = state.bindings.get(normalizedZone);
    return binding ? toBinding(binding, state.profiles.get(binding.profile)) : undefined;
  }

  async bindZone(zone: string, input: CloudflareZoneBindingInput): Promise<CloudflareZoneBinding> {
    const normalizedZone = normalizeZone(zone);
    const zoneId = validateZoneId(input.zoneId);
    const profileName = normalizeProfileName(input.profile);

    return this.#enqueueMutation(async () => {
      const state = await this.#load();
      if (!state.profiles.has(profileName)) {
        throw new CredentialValidationError(`credential profile ${profileName} does not exist`);
      }
      const binding: StoredBinding = {
        zone: normalizedZone,
        zoneId,
        profile: profileName,
        updatedAt: this.#now().toISOString(),
      };
      const next = cloneState(state);
      next.bindings.set(normalizedZone, binding);
      await this.#persist(next);
      this.#state = next;
      return toBinding(binding, next.profiles.get(profileName));
    });
  }

  async unbindZone(zone: string): Promise<boolean> {
    const normalizedZone = normalizeZone(zone);
    return this.#enqueueMutation(async () => {
      const state = await this.#load();
      if (!state.bindings.has(normalizedZone)) return false;
      const next = cloneState(state);
      next.bindings.delete(normalizedZone);
      await this.#persist(next);
      this.#state = next;
      return true;
    });
  }

  /** Trusted server wiring only. API handlers must use the metadata readers instead. */
  async getSecret(zone: string): Promise<CloudflareCredentialSecret | undefined> {
    const normalizedZone = normalizeZone(zone);
    await this.#mutationTail;
    const state = await this.#load();
    const binding = state.bindings.get(normalizedZone);
    const profile = binding ? state.profiles.get(binding.profile) : undefined;
    if (!binding || !profile) return undefined;
    return {
      zone: binding.zone,
      zoneId: binding.zoneId,
      profile: profile.name,
      ...(profile.accountId ? { accountId: profile.accountId } : {}),
      token: profile.token,
      updatedAt: binding.updatedAt,
    };
  }

  /** Trusted server wiring only, for testing a profile before any zone uses it. */
  async getProfileSecret(name: string): Promise<{ name: string; accountId?: string; token: string } | undefined> {
    const profileName = normalizeProfileName(name);
    await this.#mutationTail;
    const profile = (await this.#load()).profiles.get(profileName);
    if (!profile) return undefined;
    return {
      name: profile.name,
      ...(profile.accountId ? { accountId: profile.accountId } : {}),
      token: profile.token,
    };
  }

  #enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(mutation);
    this.#mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #load(): Promise<StoreState> {
    if (this.#state) return this.#state;

    let encoded: string;
    try {
      encoded = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        this.#state = { profiles: new Map(), bindings: new Map() };
        return this.#state;
      }
      throw openError();
    }

    try {
      const envelope = parseEnvelope(encoded);
      const decipher = createDecipheriv(ALGORITHM, this.#masterKey, envelope.nonce);
      decipher.setAAD(AAD);
      decipher.setAuthTag(envelope.authenticationTag);
      const plaintext = Buffer.concat([
        decipher.update(envelope.ciphertext),
        decipher.final(),
      ]).toString("utf8");
      const document = parseDocument(plaintext);
      this.#state = {
        profiles: new Map(document.profiles.map((profile) => [profile.name, profile])),
        bindings: new Map(document.bindings.map((binding) => [binding.zone, binding])),
      };
      return this.#state;
    } catch {
      throw openError();
    }
  }

  async #persist(state: StoreState): Promise<void> {
    let temporaryPath: string | undefined;
    try {
      const directory = dirname(this.#filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const document: PlaintextDocument = {
        version: DOCUMENT_VERSION,
        profiles: [...state.profiles.values()].sort((left, right) => left.name.localeCompare(right.name)),
        bindings: [...state.bindings.values()].sort((left, right) => left.zone.localeCompare(right.zone)),
      };
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, this.#masterKey, nonce);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(document), "utf8"), cipher.final()]);
      const envelope: EncryptedEnvelope = {
        version: FILE_VERSION,
        algorithm: "AES-256-GCM",
        nonce: nonce.toString("base64"),
        authenticationTag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };

      temporaryPath = join(
        directory,
        `.${basename(this.#filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
      );
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.#filePath);
      temporaryPath = undefined;
    } catch {
      throw saveError();
    } finally {
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function cloneState(state: StoreState): StoreState {
  return { profiles: new Map(state.profiles), bindings: new Map(state.bindings) };
}

function toProfileMetadata(profile: StoredProfile): CloudflareProfileMetadata {
  return {
    name: profile.name,
    ...(profile.accountId ? { accountId: profile.accountId } : {}),
    updatedAt: profile.updatedAt,
  };
}

function toBinding(binding: StoredBinding, profile: StoredProfile | undefined): CloudflareZoneBinding {
  return {
    zone: binding.zone,
    zoneId: binding.zoneId,
    profile: binding.profile,
    ...(profile?.accountId ? { accountId: profile.accountId } : {}),
    updatedAt: binding.updatedAt,
  };
}

export function normalizeProfileName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new CredentialValidationError("profile name must contain only lowercase letters, digits, _ or -");
  }
  return name;
}

function normalizeZone(value: string): string {
  const zone = value.trim().toLowerCase().replace(/\.$/u, "");
  const valid = zone.length <= 253
    && zone.includes(".")
    && zone.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u.test(label));
  if (!valid) throw invalidInput();
  return zone;
}

function validateZoneId(value: string): string {
  const zoneId = value.trim();
  if (zoneId.length === 0 || zoneId.length > 512 || hasControlCharacter(zoneId)) throw invalidInput();
  return zoneId;
}

function validateAccountId(value: string): string {
  const accountId = value.trim();
  if (accountId.length === 0) return "";
  if (accountId.length > 512 || hasControlCharacter(accountId)) throw invalidInput();
  return accountId;
}

function validateToken(value: string): string {
  if (value.trim().length === 0 || value.length > 8192 || hasControlCharacter(value)) throw invalidInput();
  return value;
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function parseEnvelope(encoded: string): {
  nonce: Buffer;
  authenticationTag: Buffer;
  ciphertext: Buffer;
} {
  const value: unknown = JSON.parse(encoded);
  if (!isObject(value)
    || value.version !== FILE_VERSION
    || value.algorithm !== "AES-256-GCM"
    || typeof value.nonce !== "string"
    || typeof value.authenticationTag !== "string"
    || typeof value.ciphertext !== "string") {
    throw openError();
  }
  const nonce = decodeBase64(value.nonce);
  const authenticationTag = decodeBase64(value.authenticationTag);
  const ciphertext = decodeBase64(value.ciphertext);
  if (nonce.byteLength !== NONCE_BYTES || authenticationTag.byteLength !== AUTHENTICATION_TAG_BYTES || ciphertext.byteLength === 0) {
    throw openError();
  }
  return { nonce, authenticationTag, ciphertext };
}

function parseDocument(encoded: string): PlaintextDocument {
  const value: unknown = JSON.parse(encoded);
  if (!isObject(value)) throw openError();
  // Documents written before profiles existed carry one token per zone; each
  // distinct token becomes a profile so nothing has to be re-entered.
  if (Array.isArray(value.credentials)) return migrateFromPerZoneCredentials(value.credentials);
  if (value.version !== DOCUMENT_VERSION || !Array.isArray(value.profiles) || !Array.isArray(value.bindings)) {
    throw openError();
  }

  const profiles: StoredProfile[] = [];
  const profileNames = new Set<string>();
  for (const candidate of value.profiles) {
    if (!isObject(candidate)
      || typeof candidate.name !== "string"
      || typeof candidate.token !== "string"
      || typeof candidate.updatedAt !== "string"
      || (candidate.accountId !== undefined && typeof candidate.accountId !== "string")) throw openError();
    const name = normalizeProfileName(candidate.name);
    if (name !== candidate.name || profileNames.has(name) || !isIsoDate(candidate.updatedAt)) throw openError();
    profileNames.add(name);
    profiles.push({
      name,
      ...(candidate.accountId ? { accountId: validateAccountId(candidate.accountId) } : {}),
      token: validateToken(candidate.token),
      updatedAt: candidate.updatedAt,
    });
  }

  const bindings: StoredBinding[] = [];
  const zones = new Set<string>();
  for (const candidate of value.bindings) {
    if (!isObject(candidate)
      || typeof candidate.zone !== "string"
      || typeof candidate.zoneId !== "string"
      || typeof candidate.profile !== "string"
      || typeof candidate.updatedAt !== "string") throw openError();
    const zone = normalizeZone(candidate.zone);
    const profile = normalizeProfileName(candidate.profile);
    if (zone !== candidate.zone || zones.has(zone) || !profileNames.has(profile) || !isIsoDate(candidate.updatedAt)) {
      throw openError();
    }
    zones.add(zone);
    bindings.push({ zone, zoneId: validateZoneId(candidate.zoneId), profile, updatedAt: candidate.updatedAt });
  }
  return { version: DOCUMENT_VERSION, profiles, bindings };
}

function migrateFromPerZoneCredentials(credentials: unknown[]): PlaintextDocument {
  const profiles: StoredProfile[] = [];
  const bindings: StoredBinding[] = [];
  const profileByToken = new Map<string, StoredProfile>();
  const zones = new Set<string>();

  for (const candidate of credentials) {
    if (!isObject(candidate)
      || typeof candidate.zone !== "string"
      || typeof candidate.zoneId !== "string"
      || typeof candidate.token !== "string"
      || typeof candidate.updatedAt !== "string") throw openError();
    const zone = normalizeZone(candidate.zone);
    const token = validateToken(candidate.token);
    if (zone !== candidate.zone || zones.has(zone) || !isIsoDate(candidate.updatedAt)) throw openError();
    zones.add(zone);

    let profile = profileByToken.get(token);
    if (!profile) {
      // Name the profile after the first zone that used the token; zone names
      // are already lowercase DNS labels, so only the dots need replacing.
      profile = { name: uniqueProfileName(zone.replace(/\./gu, "-"), profiles), token, updatedAt: candidate.updatedAt };
      profileByToken.set(token, profile);
      profiles.push(profile);
    }
    bindings.push({ zone, zoneId: validateZoneId(candidate.zoneId), profile: profile.name, updatedAt: candidate.updatedAt });
  }
  return { version: DOCUMENT_VERSION, profiles, bindings };
}

function uniqueProfileName(candidate: string, existing: readonly StoredProfile[]): string {
  const base = normalizeProfileName(candidate.slice(0, 63));
  if (!existing.some((profile) => profile.name === base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const name = `${base.slice(0, 63 - String(suffix).length - 1)}-${suffix}`;
    if (!existing.some((profile) => profile.name === name)) return name;
  }
  throw openError();
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw openError();
  return Buffer.from(value, "base64");
}

function isIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function invalidInput(): CredentialValidationError {
  return new CredentialValidationError();
}

function openError(): Error {
  return new Error("credential store could not be opened");
}

function saveError(): Error {
  return new Error("credential store could not be saved");
}
