import type { PasswordPolicy } from "../security/accounts/passwords.ts";
import type { TotpPolicy } from "../security/accounts/mfa.ts";

/** All values are operator decisions. Bounds below are validation, never defaults. */
export interface AccountPolicy {
  readonly loginKey: "email-nfc-lowercase-v1";
  readonly password: PasswordPolicy;
  readonly session: { readonly idleSeconds: number; readonly absoluteSeconds: number; readonly touchIntervalSeconds: number; readonly maxPerUser: number };
  readonly recentAuthSeconds: number;
  readonly mfa: TotpPolicy & { readonly recoveryCodeCount: number; readonly issuer: string };
  /** `challengeSeconds` is a sign-in code step; `enrollmentSeconds` a challenge that sets up an authenticator. */
  readonly tokens: { readonly inviteSeconds: number; readonly resetSeconds: number; readonly emailChangeSeconds: number; readonly challengeSeconds: number; readonly enrollmentSeconds: number };
  /**
   * `login`, `mfa` and `reset` count both per member and per client address; `link` counts provider
   * sign-in starts per address only. `maxEntries` bounds each kind's address table and outstanding
   * tokens of one purpose.
   */
  readonly rateLimit: { readonly login: AttemptPolicy; readonly mfa: AttemptPolicy; readonly reset: AttemptPolicy; readonly link: AttemptPolicy; readonly maxEntries: number };
  readonly retention: { readonly auditDays: number; readonly auditMaxEntries: number };
}
/**
 * `attempts` are allowed freely. After that, each further attempt waits `baseDelaySeconds × 2^(n−1)`
 * (n = how many past `attempts`), capped at `maxDelaySeconds`, and one attempt is allowed after each
 * wait; nothing locks for good. A counter starts over `windowSeconds` after its last attempt, so the cap
 * may not exceed the window.
 */
export interface AttemptPolicy { readonly attempts: number; readonly windowSeconds: number; readonly baseDelaySeconds: number; readonly maxDelaySeconds: number }
export class AccountPolicyError extends Error {
  override readonly name = "AccountPolicyError";
  constructor() { super("accounts requires a complete valid explicit account policy"); }
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccountPolicyError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some((key) => !Object.hasOwn(record, key))) throw new AccountPolicyError();
  return record;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new AccountPolicyError();
  return value;
}
function attempt(value: unknown): AttemptPolicy {
  const v = object(value, ["attempts", "windowSeconds", "baseDelaySeconds", "maxDelaySeconds"]);
  const windowSeconds = integer(v.windowSeconds, 1, 86400), baseDelaySeconds = integer(v.baseDelaySeconds, 1, windowSeconds);
  return { attempts: integer(v.attempts, 1, 10000), windowSeconds, baseDelaySeconds, maxDelaySeconds: integer(v.maxDelaySeconds, baseDelaySeconds, windowSeconds) };
}
export function readAccountPolicy(value: unknown): AccountPolicy {
  const v = object(value, ["loginKey", "password", "session", "recentAuthSeconds", "mfa", "tokens", "rateLimit", "retention"]);
  if (v.loginKey !== "email-nfc-lowercase-v1") throw new AccountPolicyError();
  const p = object(v.password, ["minLength", "maxBytes", "scrypt", "verifyLimits", "maxConcurrent", "maxQueued"]);
  const limits = object(p.verifyLimits, ["maxMemoryBytes", "maxWork", "maxKeylen"]);
  const s = object(p.scrypt, ["N", "r", "p", "maxmem", "keylen"]);
  const N = integer(s.N, 2, 2 ** 20);
  if ((N & (N - 1)) !== 0) throw new AccountPolicyError();
  const minLength = integer(p.minLength, 1, 1024);
  const session = object(v.session, ["idleSeconds", "absoluteSeconds", "touchIntervalSeconds", "maxPerUser"]);
  const idleSeconds = integer(session.idleSeconds, 1, 31536000), absoluteSeconds = integer(session.absoluteSeconds, idleSeconds, 31536000);
  const mfa = object(v.mfa, ["digits", "periodSeconds", "window", "algorithm", "recoveryCodeCount", "issuer"]);
  if (!["SHA1", "SHA256", "SHA512"].includes(String(mfa.algorithm)) || typeof mfa.issuer !== "string"
    || mfa.issuer.length === 0 || mfa.issuer.length > 256 || /[\x00-\x1f\x7f]/u.test(mfa.issuer)) throw new AccountPolicyError();
  const tokens = object(v.tokens, ["inviteSeconds", "resetSeconds", "emailChangeSeconds", "challengeSeconds", "enrollmentSeconds"]);
  const rate = object(v.rateLimit, ["login", "mfa", "reset", "link", "maxEntries"]);
  const retention = object(v.retention, ["auditDays", "auditMaxEntries"]);
  const result: AccountPolicy = {
    loginKey: v.loginKey,
    password: { verifyLimits: { maxMemoryBytes: integer(limits.maxMemoryBytes, Number(s.maxmem), 1024 ** 3), maxWork: integer(limits.maxWork, N * Number(s.r) * Number(s.p), 2 ** 29), maxKeylen: integer(limits.maxKeylen, Number(s.keylen), 128) }, minLength, maxBytes: integer(p.maxBytes, minLength, 65536), maxConcurrent: integer(p.maxConcurrent, 1, 16), maxQueued: integer(p.maxQueued, 0, 1024),
      scrypt: { N, r: integer(s.r, 1, 32), p: integer(s.p, 1, 16), maxmem: integer(s.maxmem, 1024, 1024 ** 3), keylen: integer(s.keylen, 32, 128) } },
    session: { idleSeconds, absoluteSeconds, touchIntervalSeconds: integer(session.touchIntervalSeconds, 0, idleSeconds), maxPerUser: integer(session.maxPerUser, 1, 1000) },
    recentAuthSeconds: integer(v.recentAuthSeconds, 1, absoluteSeconds),
    mfa: { digits: integer(mfa.digits, 6, 8), periodSeconds: integer(mfa.periodSeconds, 15, 120), window: integer(mfa.window, 0, 2),
      algorithm: mfa.algorithm as TotpPolicy["algorithm"], recoveryCodeCount: integer(mfa.recoveryCodeCount, 1, 100), issuer: mfa.issuer },
    tokens: { inviteSeconds: integer(tokens.inviteSeconds, 1, 31536000), resetSeconds: integer(tokens.resetSeconds, 1, 86400),
      emailChangeSeconds: integer(tokens.emailChangeSeconds, 1, 86400), challengeSeconds: integer(tokens.challengeSeconds, 1, 3600),
      enrollmentSeconds: integer(tokens.enrollmentSeconds, 1, 604800) },
    rateLimit: { login: attempt(rate.login), mfa: attempt(rate.mfa), reset: attempt(rate.reset), link: attempt(rate.link), maxEntries: integer(rate.maxEntries, 1, 1000000) },
    retention: { auditDays: integer(retention.auditDays, 1, 36500), auditMaxEntries: integer(retention.auditMaxEntries, 1, 10000000) },
  };
  if (result.password.scrypt.maxmem < 128 * result.password.scrypt.r * (N + result.password.scrypt.p + 2)) throw new AccountPolicyError();
  return result;
}

/** NFC + whole-address lowercase only. In particular plus aliases and dots remain distinct. */
export function canonicalAccountEmail(value: string): string {
  if (typeof value !== "string" || value.length > 254 || /[\s\x00-\x1f\x7f]/u.test(value)) throw new AccountPolicyError();
  const email = value.normalize("NFC").toLowerCase();
  if (!/^[a-z0-9!#$%&'*+\-/=?^_`{|}~.]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(email)
    || email.startsWith(".") || email.includes("..") || email.includes(".@")) throw new AccountPolicyError();
  return email;
}
