import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface ScryptParameters {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly maxmem: number;
  readonly keylen: number;
}

/** Deployment policy is required. These bounds are safety limits, not password policy defaults. */
export interface PasswordPolicy {
  readonly minLength: number;
  readonly maxBytes: number;
  readonly scrypt: ScryptParameters;
  readonly verifyLimits: { readonly maxMemoryBytes: number; readonly maxWork: number; readonly maxKeylen: number };
  readonly maxConcurrent: number;
  readonly maxQueued: number;
}

export class PasswordError extends Error {
  readonly code: "invalid-policy" | "invalid-password" | "unavailable" | "aborted";

  constructor(code: PasswordError["code"]) {
    super(code === "invalid-policy" ? "invalid password policy"
      : code === "invalid-password" ? "password does not meet policy"
        : code === "aborted" ? "password operation aborted" : "password service unavailable");
    this.name = "PasswordError";
    this.code = code;
  }
}

interface ParsedHash {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

interface Work {
  readonly start: () => void;
  readonly abort: () => void;
}

function integer(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function validatePolicy(policy: PasswordPolicy): void {
  const { N, r, p, maxmem, keylen } = policy.scrypt;
  if (!integer(policy.minLength, 1, 1024) || !integer(policy.maxBytes, policy.minLength, 65536)
    || !integer(N, 2, 2 ** 20) || (N & (N - 1)) !== 0
    || !integer(r, 1, 32) || !integer(p, 1, 16) || !integer(keylen, 32, 128)
    || !integer(maxmem, 1024, 1024 ** 3) || 128 * r * (N + p + 2) > maxmem
    || !integer(policy.verifyLimits.maxMemoryBytes, maxmem, 1024 ** 3)
    || !integer(policy.verifyLimits.maxWork, N * r * p, 2 ** 29)
    || !integer(policy.verifyLimits.maxKeylen, keylen, 128)
    || !integer(policy.maxConcurrent, 1, 16) || !integer(policy.maxQueued, 0, 1024)) {
    throw new PasswordError("invalid-policy");
  }
}

function decode(value: string, min: number, max: number): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length >= min && bytes.length <= max && bytes.toString("base64url") === value ? bytes : undefined;
}

export class PasswordHasher {
  readonly #policy: PasswordPolicy;
  readonly #queue: Work[] = [];
  #active = 0;
  #dummy: string | undefined;

  /** Prefer createPasswordHasher: it initializes the per-instance dummy hash before accepting requests. */
  private constructor(policy: PasswordPolicy) {
    try {
      const snapshot = { ...policy, scrypt: { ...policy.scrypt }, verifyLimits: { ...policy.verifyLimits } };
      validatePolicy(snapshot);
      this.#policy = Object.freeze({ ...snapshot, scrypt: Object.freeze(snapshot.scrypt), verifyLimits: Object.freeze(snapshot.verifyLimits) });
    } catch {
      throw new PasswordError("invalid-policy");
    }
  }

  static async create(policy: PasswordPolicy): Promise<PasswordHasher> {
    const hasher = new PasswordHasher(policy);
    const salt = randomBytes(16);
    const hash = await hasher.#derive(randomBytes(32).toString("base64url"), salt, hasher.#policy.scrypt);
    hasher.#dummy = hasher.#encode(salt, hash);
    return hasher;
  }

  async hash(password: string, options: { readonly signal?: AbortSignal } = {}): Promise<string> {
    const normalized = this.#normalizedPassword(password, true);
    if (normalized === undefined) throw new PasswordError("invalid-password");
    const salt = randomBytes(16);
    const hash = await this.#derive(normalized, salt, this.#policy.scrypt, options.signal);
    return this.#encode(salt, hash);
  }

  /**
   * Undefined/malformed hashes use the initialized dummy; account lookup failure must not skip this call.
   * A well-formed hash whose parameters exceed `verifyLimits` throws `PasswordError("unavailable")` instead of
   * returning false. Callers must surface that as a service failure, never as a password mismatch.
   */
  async verify(password: string, encodedHash?: string, options: { readonly signal?: AbortSignal } = {}): Promise<boolean> {
    const parsed = this.#parse(encodedHash);
    if (parsed && !this.#withinLimits(parsed)) throw new PasswordError("unavailable");
    const normalized = this.#normalizedPassword(password, false);
    const target = parsed ?? this.#parse(this.#dummy)!;
    const actual = await this.#derive(normalized ?? "invalid-password-input", target.salt, target.parameters, options.signal);
    const equal = actual.length === target.hash.length && timingSafeEqual(actual, target.hash);
    actual.fill(0);
    return parsed !== undefined && normalized !== undefined && equal;
  }

  isSafeHash(encodedHash: string): boolean {
    const parsed = this.#parse(encodedHash);
    return parsed !== undefined && this.#withinLimits(parsed);
  }

  needsRehash(encodedHash: string): boolean {
    const parsed = this.#parse(encodedHash);
    if (!parsed) return true;
    const current = this.#policy.scrypt;
    return parsed.parameters.N !== current.N || parsed.parameters.r !== current.r
      || parsed.parameters.p !== current.p || parsed.hash.length !== current.keylen;
  }

  /**
   * Rejects ill-formed UTF-16 first, then applies Unicode NFC so composed and decomposed input of the same password
   * derive the same key. Length and byte limits apply to the NFC form. No trimming or case folding is performed.
   * The raw-length pre-bound keeps normalization work bounded for oversized input.
   */
  #normalizedPassword(password: string, enforceMinimum: boolean): string | undefined {
    if (typeof password !== "string" || password.length > this.#policy.maxBytes * 4 || !password.isWellFormed()) return undefined;
    const normalized = password.normalize("NFC");
    return Buffer.byteLength(normalized, "utf8") <= this.#policy.maxBytes
      && (!enforceMinimum || Array.from(normalized).length >= this.#policy.minLength) ? normalized : undefined;
  }

  #encode(salt: Buffer, hash: Buffer): string {
    const { N, r, p } = this.#policy.scrypt;
    const encoded = `scrypt$v1$${N}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
    hash.fill(0);
    return encoded;
  }

  #parse(encoded: string | undefined): ParsedHash | undefined {
    if (typeof encoded !== "string" || encoded.length > 512) return undefined;
    const parts = encoded.split("$");
    if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== "v1") return undefined;
    const [, , n, block, parallel, saltValue, hashValue] = parts as [string, string, string, string, string, string, string];
    if (![n, block, parallel].every((value) => /^[1-9][0-9]{0,7}$/u.test(value))) return undefined;
    const N = Number(n), r = Number(block), p = Number(parallel);
    if (!integer(N, 2, 2 ** 20) || (N & (N - 1)) !== 0 || !integer(r, 1, 32) || !integer(p, 1, 16)) return undefined;
    const salt = decode(saltValue, 16, 64), hash = decode(hashValue, 32, 128);
    if (!salt || !hash) return undefined;
    return { salt, hash, parameters: { N, r, p, maxmem: this.#policy.verifyLimits.maxMemoryBytes, keylen: hash.length } };
  }

  #withinLimits(parsed: ParsedHash): boolean {
    const { N, r, p, keylen } = parsed.parameters, limits = this.#policy.verifyLimits;
    return 128 * r * (N + p + 2) <= limits.maxMemoryBytes && N * r * p <= limits.maxWork && keylen <= limits.maxKeylen;
  }

  #derive(password: string, salt: Buffer, parameters: ScryptParameters, signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted) return Promise.reject(new PasswordError("aborted"));
    if (this.#active >= this.#policy.maxConcurrent && this.#queue.length >= this.#policy.maxQueued) {
      return Promise.reject(new PasswordError("unavailable"));
    }
    return new Promise((resolve, reject) => {
      const work: Work = {
        abort: () => {
          const index = this.#queue.indexOf(work);
          if (index >= 0) {
            this.#queue.splice(index, 1);
            reject(new PasswordError("aborted"));
          }
          // A running crypto operation owns its slot until the callback, even after cancellation.
        },
        start: () => {
          this.#active++;
          const finish = (error: Error | null, key?: Buffer): void => {
            signal?.removeEventListener("abort", work.abort);
            this.#active--;
            const next = this.#queue.shift();
            if (next) next.start();
            if (error || signal?.aborted || !key) {
              key?.fill(0);
              reject(new PasswordError(signal?.aborted ? "aborted" : "unavailable"));
            } else resolve(key);
          };
          try {
            const { keylen, ...options } = parameters;
            scrypt(password, salt, keylen, options, finish);
          } catch {
            finish(new Error("password service unavailable"));
          }
        },
      };
      signal?.addEventListener("abort", work.abort, { once: true });
      if (this.#active < this.#policy.maxConcurrent) work.start();
      else this.#queue.push(work);
    });
  }
}

export function createPasswordHasher(policy: PasswordPolicy): Promise<PasswordHasher> {
  return PasswordHasher.create(policy);
}
