import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const FILE_VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;
const AAD = Buffer.from("parallax:credential-store:v1", "utf8");

export interface CloudflareCredentialInput {
  readonly zoneId: string;
  readonly token: string;
}

/** Safe to return from an admin API; deliberately contains no token field. */
export interface CloudflareCredentialMetadata {
  readonly zone: string;
  readonly zoneId: string;
  readonly updatedAt: string;
}

/** Server-only value for constructing a provider adapter. Never serialize this to HTTP. */
export interface CloudflareCredentialSecret extends CloudflareCredentialMetadata {
  readonly token: string;
}

export interface EncryptedCredentialStoreOptions {
  readonly filePath: string;
  /** Caller-owned key material is copied and must contain exactly 32 bytes. */
  readonly masterKey: Uint8Array;
  readonly now?: () => Date;
}

interface StoredCredential {
  zone: string;
  zoneId: string;
  token: string;
  updatedAt: string;
}

interface PlaintextDocument {
  credentials: StoredCredential[];
}

interface EncryptedEnvelope {
  version: 1;
  algorithm: "AES-256-GCM";
  nonce: string;
  authenticationTag: string;
  ciphertext: string;
}

/**
 * A small encrypted persistence boundary for per-zone provider credentials.
 *
 * Mutations on one instance are serialized and committed with a same-directory
 * temporary file followed by rename, so readers see either the old or new file.
 */
export class EncryptedCredentialStore {
  readonly #filePath: string;
  readonly #masterKey: Buffer;
  readonly #now: () => Date;
  #credentials: Map<string, StoredCredential> | undefined;
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

  async list(): Promise<CloudflareCredentialMetadata[]> {
    await this.#mutationTail;
    const credentials = await this.#load();
    return [...credentials.values()]
      .sort((left, right) => left.zone.localeCompare(right.zone))
      .map(toMetadata);
  }

  async getMetadata(zone: string): Promise<CloudflareCredentialMetadata | undefined> {
    const normalizedZone = normalizeZone(zone);
    await this.#mutationTail;
    const credential = (await this.#load()).get(normalizedZone);
    return credential ? toMetadata(credential) : undefined;
  }

  /** Trusted server wiring only. API handlers must use getMetadata/list instead. */
  async getSecret(zone: string): Promise<CloudflareCredentialSecret | undefined> {
    const normalizedZone = normalizeZone(zone);
    await this.#mutationTail;
    const credential = (await this.#load()).get(normalizedZone);
    return credential ? { ...toMetadata(credential), token: credential.token } : undefined;
  }

  async update(zone: string, input: CloudflareCredentialInput): Promise<CloudflareCredentialMetadata> {
    const normalizedZone = normalizeZone(zone);
    const zoneId = validateZoneId(input.zoneId);
    const token = validateToken(input.token);

    return this.#enqueueMutation(async () => {
      const credentials = await this.#load();
      const updatedAt = this.#now().toISOString();
      const credential = { zone: normalizedZone, zoneId, token, updatedAt };
      const next = new Map(credentials);
      next.set(normalizedZone, credential);
      await this.#persist(next);
      this.#credentials = next;
      return toMetadata(credential);
    });
  }

  async delete(zone: string): Promise<boolean> {
    const normalizedZone = normalizeZone(zone);
    return this.#enqueueMutation(async () => {
      const credentials = await this.#load();
      if (!credentials.has(normalizedZone)) return false;
      const next = new Map(credentials);
      next.delete(normalizedZone);
      await this.#persist(next);
      this.#credentials = next;
      return true;
    });
  }

  #enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(mutation);
    this.#mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #load(): Promise<Map<string, StoredCredential>> {
    if (this.#credentials) return this.#credentials;

    let encoded: string;
    try {
      encoded = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        this.#credentials = new Map();
        return this.#credentials;
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
      this.#credentials = new Map(document.credentials.map((credential) => [credential.zone, credential]));
      return this.#credentials;
    } catch {
      throw openError();
    }
  }

  async #persist(credentials: ReadonlyMap<string, StoredCredential>): Promise<void> {
    let temporaryPath: string | undefined;
    try {
      const directory = dirname(this.#filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const plaintext = JSON.stringify({
        credentials: [...credentials.values()].sort((left, right) => left.zone.localeCompare(right.zone)),
      } satisfies PlaintextDocument);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, this.#masterKey, nonce);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
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

function toMetadata(credential: StoredCredential): CloudflareCredentialMetadata {
  return {
    zone: credential.zone,
    zoneId: credential.zoneId,
    updatedAt: credential.updatedAt,
  };
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
  if (!isObject(value) || !Array.isArray(value.credentials)) throw openError();

  const credentials: StoredCredential[] = [];
  const seen = new Set<string>();
  for (const candidate of value.credentials) {
    if (!isObject(candidate)
      || typeof candidate.zone !== "string"
      || typeof candidate.zoneId !== "string"
      || typeof candidate.token !== "string"
      || typeof candidate.updatedAt !== "string") throw openError();
    const zone = normalizeZone(candidate.zone);
    const zoneId = validateZoneId(candidate.zoneId);
    const token = validateToken(candidate.token);
    if (zone !== candidate.zone || seen.has(zone) || !isIsoDate(candidate.updatedAt)) throw openError();
    seen.add(zone);
    credentials.push({ zone, zoneId, token, updatedAt: candidate.updatedAt });
  }
  return { credentials };
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

function invalidInput(): TypeError {
  return new TypeError("invalid provider credential");
}

function openError(): Error {
  return new Error("credential store could not be opened");
}

function saveError(): Error {
  return new Error("credential store could not be saved");
}
