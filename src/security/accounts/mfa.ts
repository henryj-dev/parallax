import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Secret, TOTP } from "otpauth";

export interface TotpPolicy {
  readonly digits: number;
  readonly periodSeconds: number;
  readonly window: number;
  readonly algorithm: "SHA1" | "SHA256" | "SHA512";
}

export class MfaError extends Error {
  readonly code: "invalid-policy" | "invalid-input";

  constructor(code: MfaError["code"]) {
    super(code === "invalid-policy" ? "invalid MFA policy" : "invalid MFA input");
    this.name = "MfaError";
    this.code = code;
  }
}

function validText(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value);
}

function decode(value: string, length?: number): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value && (length === undefined || bytes.length === length) ? bytes : undefined;
}

/** Holds only the encryption key, never enrolled plaintext seeds. Store the key separately from backups. */
export class TotpAdapter {
  readonly #policy: TotpPolicy;
  readonly #key: Buffer;
  readonly #issuer: string;

  constructor(policy: TotpPolicy, key: Uint8Array, issuer: string) {
    policy = { ...policy };
    if (!Number.isInteger(policy.digits) || policy.digits < 6 || policy.digits > 8
      || !Number.isInteger(policy.periodSeconds) || policy.periodSeconds < 15 || policy.periodSeconds > 120
      || !Number.isInteger(policy.window) || policy.window < 0 || policy.window > 2
      || !["SHA1", "SHA256", "SHA512"].includes(policy.algorithm) || key.byteLength !== 32 || !validText(issuer)) {
      throw new MfaError("invalid-policy");
    }
    this.#policy = Object.freeze({ ...policy });
    this.#key = Buffer.from(key);
    this.#issuer = issuer;
  }

  /** The only API returning enrollment secrets. Callers must not log, audit, or persist this response. */
  createEnrollment(label: string): { secretBase32: string; otpauthUri: string } {
    if (!validText(label)) throw new MfaError("invalid-input");
    const secret = new Secret({ size: 32 });
    const totp = this.#totp(secret, label);
    return { secretBase32: secret.base32, otpauthUri: totp.toString() };
  }

  encryptSecret(secretBase32: string, userId: string): string {
    if (!validText(userId)) throw new MfaError("invalid-input");
    const bytes = this.#readSecret(secretBase32);
    if (!bytes) throw new MfaError("invalid-input");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(this.#aad(userId));
    try {
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
    } finally {
      bytes.fill(0);
    }
  }

  /**
   * This is cryptographic verification only, not authorization. The repository must atomically consume
   * counter > lastConsumedCounter before issuing MFA evidence; concurrent callers can see the same match.
   */
  verify(encryptedSeed: string, userId: string, token: string, nowMs: number = Date.now()): { counter: number } | undefined {
    if (!validText(userId) || typeof token !== "string" || !new RegExp(`^[0-9]{${this.#policy.digits}}$`, "u").test(token)
      || !Number.isSafeInteger(nowMs) || nowMs < 0) return undefined;
    const bytes = this.#decrypt(encryptedSeed, userId);
    if (!bytes) return undefined;
    const secret = new Secret({ buffer: Uint8Array.from(bytes).buffer });
    try {
      const delta = this.#totp(secret, userId).validate({ token, timestamp: nowMs, window: this.#policy.window });
      if (delta === null) return undefined;
      const counter = Math.floor(nowMs / 1000 / this.#policy.periodSeconds) + delta;
      return counter >= 0 ? { counter } : undefined;
    } catch {
      return undefined;
    } finally {
      secret.bytes.fill(0);
      bytes.fill(0);
    }
  }

  #totp(secret: Secret, label: string): TOTP {
    return new TOTP({ issuer: this.#issuer, label, algorithm: this.#policy.algorithm,
      digits: this.#policy.digits, period: this.#policy.periodSeconds, secret });
  }

  #aad(userId: string): Buffer {
    return Buffer.from(JSON.stringify(["parallax", "account-totp-seed", "v1", userId]), "utf8");
  }

  #readSecret(value: string): Buffer | undefined {
    if (typeof value !== "string" || value.length < 32 || value.length > 103 || !/^[A-Z2-7]+$/u.test(value)) return undefined;
    try {
      const secret = Secret.fromBase32(value);
      const bytes = Buffer.from(secret.buffer);
      return bytes.length >= 20 && bytes.length <= 64 && secret.base32 === value ? bytes : undefined;
    } catch {
      return undefined;
    }
  }

  #decrypt(value: string, userId: string): Buffer | undefined {
    if (typeof value !== "string" || value.length > 256) return undefined;
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") return undefined;
    const iv = decode(parts[1]!, 12), tag = decode(parts[2]!, 16), ciphertext = decode(parts[3]!);
    if (!iv || !tag || !ciphertext || ciphertext.length < 20 || ciphertext.length > 64) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(this.#aad(userId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      return undefined;
    }
  }
}

/** Count is explicit policy input. Plaintext is returned once; only digests belong in storage. */
export function createRecoveryCodes(count: number): { codes: string[]; digests: string[] } {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new MfaError("invalid-input");
  const codes = Array.from({ length: count }, () => randomBytes(32).toString("base64url"));
  return { codes, digests: codes.map(digestRecoveryCode) };
}

export function digestRecoveryCode(code: string): string {
  if (typeof code !== "string" || !decode(code, 32)) throw new MfaError("invalid-input");
  return createHash("sha256").update("parallax-account-recovery-v1\0").update(code, "utf8").digest("base64url");
}

export function verifyRecoveryCode(code: string, digest: string): boolean {
  const expected = typeof digest === "string" ? decode(digest, 32) : undefined;
  if (!expected) return false;
  try {
    const actual = Buffer.from(digestRecoveryCode(code), "base64url");
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
