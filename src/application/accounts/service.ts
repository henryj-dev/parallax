import { createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalAccountEmail, readAccountPolicy, type AccountPolicy } from "../../domain/account-policy.ts";
import { createLocalAccount, changeAccountSecurity } from "../../domain/accounts.ts";
import { createPasswordHasher, type PasswordHasher } from "../../security/accounts/passwords.ts";
import { TotpAdapter, createRecoveryCodes, verifyRecoveryCode } from "../../security/accounts/mfa.ts";
import type { AccountMailer } from "../../adapters/account-mailer.ts";
import { clientBucket } from "../../security/client-bucket.ts";
import { accountClientUnidentified, accountLocalLimiterEvicted, accountThrottleSaturated } from "../../observability/signals.ts";
import type { AccountSessionResolver, AccountSessionResolution, Role } from "../../security/http-authorization.ts";
import { type AccountState, type AccountStateStore, type MemberThrottleKind, type AccountTransaction, type ActionToken, type Member, type MemberSession } from "./state.ts";

/** The member attempt one throttled request charged, so a verified success can take it back. */
type Charge = { readonly userId: string; readonly kind: MemberThrottleKind; readonly expiresAt: number; readonly previousExpiresAt: number } | undefined;

/**
 * At least eight characters after NFC, and three of four kinds: lower-case letters, upper-case
 * letters, digits, and everything else (space and any non-ASCII letter, Hangul included, count as
 * "everything else"). Judged on the NFC form, which is also what the hasher hashes.
 */
export function passwordComposition(password: string, minLength: number): boolean {
  if (typeof password !== "string" || !password.isWellFormed()) return false;
  const value = password.normalize("NFC");
  if (Array.from(value).length < minLength) return false;
  return [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u].filter((kind) => kind.test(value)).length >= 3;
}
/** What this service asks of the password hasher. */
type Hashing = Pick<PasswordHasher, "hash" | "verify" | "needsRehash">;
export class MemberError extends Error {
  override readonly name = "MemberError";
  readonly code: "invalid-input" | "weak-password" | "denied" | "conflict" | "last-admin" | "rate-limited" | "unavailable" | "mfa-required" | "not-enabled";
  /** For `rate-limited`: how long until the next attempt is allowed. */
  readonly retryAfterSeconds: number | undefined;
  constructor(code: MemberError["code"], retryAfterSeconds?: number) { super(`account operation rejected: ${code}`); this.code = code; this.retryAfterSeconds = retryAfterSeconds; }
}
export interface AccountActor { readonly token: string }
export interface MemberContext { readonly user: Member; readonly session: MemberSession; readonly csrf: string; readonly recentMfa: boolean; readonly mfaEnrolled: boolean }
export type LoginResult = { readonly challenge: string; readonly enrollmentRequired: boolean } | { readonly token: string; readonly csrf: string };
interface Dependencies {
  readonly store: AccountStateStore; readonly policy: AccountPolicy; readonly key: Uint8Array;
  readonly mailer: Pick<AccountMailer, "send" | "sendSecurityNotification">;
  readonly publicOrigin: string; readonly now?: () => number;
  /** Tests only, to observe hashing; a running server builds the hasher from the policy. */
  readonly passwordHasher?: Hashing;
}
const opaque = (): string => randomBytes(32).toString("base64url");
const hash = (value: string): string => createHash("sha256").update(value).digest("base64url");
const safeToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/u.test(v) && Buffer.from(v, "base64url").toString("base64url") === v;
function deny(): never { throw new MemberError("denied"); }
let warnedUnidentified = false;

/**
 * How many counters the process-local fallback limiter keeps. A memory bound, not a policy: an entry
 * is a short key and two numbers, so this many stay within a few megabytes whatever the traffic.
 */
const LOCAL_LIMITER_ENTRIES = 50_000;

/**
 * The fallback when the shared table cannot record a counter because every slot in it is at its
 * limit. Least-recently-used: a counter that keeps being hit stays, and when full the least recently
 * used one goes -- which can be a counter at its limit that has not been tried for a while. That loss,
 * and that each replica keeps its own (so N replicas allow up to N times the limit), are the price of
 * staying bounded; `parallax_account_local_limiter_evictions_total` shows when it is being paid.
 */
class LocalLimiter {
  readonly #entries = new Map<string, { count: number; expiresAt: number }>();
  counter(key: string, now: number, expiresAt: number): { count: number; expiresAt: number } {
    let entry = this.#entries.get(key);
    if (entry && entry.expiresAt <= now) entry = undefined;
    this.#entries.delete(key);
    if (!entry) {
      if (this.#entries.size >= LOCAL_LIMITER_ENTRIES) {
        const oldest = this.#entries.keys().next().value;
        if (oldest !== undefined) this.#entries.delete(oldest);
        accountLocalLimiterEvicted();
      }
      entry = { count: 0, expiresAt };
    }
    this.#entries.set(key, entry);
    return entry;
  }
}
/** Counted always; said once per process, without the address, so a misread proxy header is noticed. */
function unidentifiedClient(): void {
  accountClientUnidentified();
  if (warnedUnidentified) return;
  warnedUnidentified = true;
  console.warn("parallax: an account attempt limit could not read the client address and counted it in the shared bucket; check the trustForwardedHeaders setting and the proxy's X-Forwarded-For header");
}
function constant(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function publicMember(user: Member): Member { return { ...user }; }

export class AccountService implements AccountSessionResolver {
  readonly #store: AccountStateStore; readonly #policy: AccountPolicy; readonly #passwords: Hashing;
  readonly #totp: TotpAdapter; readonly #csrfKey: Buffer; readonly #rateKey: Buffer;
  readonly #mailer: Dependencies["mailer"]; readonly #origin: string; readonly #now: () => number;
  readonly #local = new LocalLimiter();
  private constructor(d: Dependencies, passwords: Hashing) {
    this.#store = d.store; this.#policy = readAccountPolicy(d.policy); this.#passwords = passwords; this.#mailer = d.mailer;
    if (d.key.byteLength !== 32 || new URL(d.publicOrigin).origin !== d.publicOrigin || !d.publicOrigin.startsWith("https://")) throw new MemberError("invalid-input");
    const derive = (label: string): Buffer => Buffer.from(hkdfSync("sha256", d.key, "parallax-member-accounts-v1", label, 32));
    this.#totp = new TotpAdapter(d.policy.mfa, derive("totp"), d.policy.mfa.issuer);
    this.#csrfKey = derive("csrf"); this.#rateKey = derive("throttle"); this.#origin = d.publicOrigin; this.#now = d.now ?? Date.now;
  }
  static async create(d: Dependencies): Promise<AccountService> { return new AccountService(d, d.passwordHasher ?? await createPasswordHasher(readAccountPolicy(d.policy).password)); }
  get challengeSeconds(): number { return this.#policy.tokens.challengeSeconds; }
  get enrollmentSeconds(): number { return this.#policy.tokens.enrollmentSeconds; }
  #requireComposition(password: string): void { if (!passwordComposition(password, this.#policy.password.minLength)) throw new MemberError("weak-password"); }
  csrf(nonce: string): string { return createHmac("sha256", this.#csrfKey).update(nonce).digest("base64url"); }
  validCsrf(nonce: string, value: string): boolean { return safeToken(nonce) && safeToken(value) && constant(this.csrf(nonce), value); }
  async enabled(): Promise<boolean> { return (await this.#store.read()).enabled; }
  async enable(): Promise<void> {
    await this.#store.transact((t) => { if (t.state.enabled) throw new MemberError("conflict"); t.state.enabled = true; this.#audit(t, "host", "enabled", null); });
  }
  async bootstrap(email: string, password: string, displayName: string): Promise<LoginResult> {
    this.#requireComposition(password);
    const canonical = canonicalAccountEmail(email), storedHash = await this.#passwords.hash(password), challenge = opaque();
    return this.#store.transact((t) => {
      this.#enabled(t.state); if (t.state.bootstrap !== "empty" || t.state.users.length) throw new MemberError("conflict");
      const user = this.#newMember(t.state, canonical, displayName, "admin", storedHash, false);
      t.state.bootstrap = "enrollment"; this.#action(t.state, challenge, "challenge", user, this.#policy.tokens.enrollmentSeconds);
      this.#audit(t, "host", "bootstrap", user.userId); return { challenge, enrollmentRequired: true };
    });
  }
  async login(email: string, password: string, ip: string): Promise<LoginResult> {
    const canonical = canonicalAccountEmail(email);
    const charge = await this.#throttle("login", ip, { email: canonical });
    const snapshot = await this.#store.transact((t) => {
      this.#enabled(t.state); const user = t.state.users.find((u) => u.canonicalLoginKey === canonical && u.status === "active");
      return user ? { user, storedHash: t.state.passwords[user.userId] } : undefined;
    });
    const valid = await this.#passwords.verify(password, snapshot?.storedHash);
    if (!valid || !snapshot?.storedHash) deny();
    // A hash made under older costs is replaced while the password is in hand, never by a background job.
    const rehashed = this.#passwords.needsRehash(snapshot.storedHash) ? await this.#passwords.hash(password) : undefined;
    const secret = opaque();
    return this.#store.transact((t) => {
      const user = this.#user(t.state, snapshot.user.userId);
      if (user.securityEpoch !== snapshot.user.securityEpoch || t.state.passwords[user.userId] !== snapshot.storedHash) deny();
      if (rehashed) { t.state.passwords[user.userId] = rehashed; this.#audit(t, `account:${user.userId}`, "password-rehashed", user.userId); }
      this.#refund(t.state, charge);
      const factor = t.state.factors[user.userId];
      if (user.role === "admin" || factor !== undefined) {
        // Issued by a password step, so it lasts as long as any sign-in step: enrollmentSeconds is for
        // challenges the server makes without one (bootstrap, host recovery), never handed to a browser.
        const enrollmentRequired = factor?.confirmedAt === null || factor === undefined;
        this.#action(t.state, secret, "challenge", user, this.#policy.tokens.challengeSeconds);
        return { challenge: secret, enrollmentRequired };
      }
      this.#newSession(t, user, secret, null); return { token: secret, csrf: this.csrf(hash(secret)) };
    });
  }
  /**
   * From a sign-in challenge, or from a member's own session with the current password: a session
   * cookie alone must not be enough to attach an authenticator and so earn a fresh-code session.
   */
  async beginEnrollment(input: { challenge?: string; actor?: AccountActor; password?: string; ip?: string }): Promise<{ secretBase32: string; otpauthUri: string }> {
    let proven: { userId: string; epoch: number; storedHash: string } | undefined;
    let charge: Charge;
    if (!input.challenge) {
      const c = await this.#store.transact((t) => { const c = this.#context(t.state, input.actor?.token ?? ""); if (c.session.kind !== "account") deny();
        return { userId: c.user.userId, epoch: c.user.securityEpoch, storedHash: t.state.passwords[c.user.userId] }; });
      // A password check is a password guess wherever it happens; it counts with sign-in attempts.
      charge = await this.#throttle("login", input.ip ?? "", { userId: c.userId });
      if (!c.storedHash || typeof input.password !== "string" || !await this.#passwords.verify(input.password, c.storedHash)) deny();
      proven = { userId: c.userId, epoch: c.epoch, storedHash: c.storedHash };
    }
    return this.#store.transact((t) => {
      const action = input.challenge ? this.#readAction(t.state, input.challenge, "challenge") : undefined;
      const user = action ? this.#tokenUser(t.state, action) : this.#context(t.state, input.actor?.token ?? "").user;
      if (proven && (user.userId !== proven.userId || user.securityEpoch !== proven.epoch || t.state.passwords[user.userId] !== proven.storedHash)) deny();
      this.#refund(t.state, charge);
      const enrollment = this.#totp.createEnrollment(user.canonicalLoginKey), encryptedSeed = this.#totp.encryptSecret(enrollment.secretBase32, user.userId);
      const old = t.state.factors[user.userId];
      if (action?.data.reenroll === "recovery") action.data = { reenroll: "recovery", pendingSeed: encryptedSeed };
      else if (old?.confirmedAt !== null && old?.confirmedAt !== undefined) throw new MemberError("conflict");
      else t.state.factors[user.userId] = { encryptedSeed, confirmedAt: null, lastCounter: -1, recoveryDigests: [] };
      this.#audit(t, input.actor ? `account:${user.userId}` : "challenge", "mfa-enrollment-started", user.userId); return enrollment;
    });
  }
  async confirmEnrollment(input: { challenge?: string; actor?: AccountActor; otp: string; ip: string }): Promise<{ token: string; csrf: string; recoveryCodes: string[] }> {
    const charge = await this.#throttle("mfa", input.ip, { userId: await this.#mfaSubject(input.challenge, input.actor) });
    const secret = opaque(), recovery = createRecoveryCodes(this.#policy.mfa.recoveryCodeCount);
    let replaced: string | undefined;
    const result = await this.#store.transact((t) => {
      const action = input.challenge ? this.#readAction(t.state, input.challenge, "challenge") : undefined;
      const context = action ? undefined : this.#context(t.state, input.actor?.token ?? "");
      if (context && context.session.kind !== "account") deny();
      const user = action ? this.#tokenUser(t.state, action) : context!.user;
      const pending = action?.data.reenroll === "recovery" ? action.data.pendingSeed : undefined;
      if (pending !== undefined) {
        // Replacing a factor after a recovery code: the new key must answer before the old one is dropped.
        const verified = this.#totp.verify(pending, user.userId, input.otp, this.#now()); if (!verified) deny();
        t.state.factors[user.userId] = { encryptedSeed: pending, confirmedAt: this.#now(), lastCounter: verified.counter, recoveryDigests: recovery.digests };
        replaced = user.canonicalLoginKey;
      } else {
        if (action?.data.reenroll === "recovery") deny();
        const factor = t.state.factors[user.userId]; if (!factor || factor.confirmedAt !== null) deny();
        this.#consumeOtp(t.state, user, input.otp, { unconfirmed: true }); factor.confirmedAt = this.#now(); factor.recoveryDigests = recovery.digests;
      }
      if (input.challenge) this.#consumeAction(t.state, input.challenge, "challenge");
      this.#refund(t.state, charge);
      if (user.role === "admin" && t.state.bootstrap === "enrollment") t.state.bootstrap = "ready";
      this.#revokeUser(t.state, user.userId); this.#newSession(t, user, secret, this.#now()); this.#audit(t, `account:${user.userId}`, "mfa-enrolled", user.userId);
      return { token: secret, csrf: this.csrf(hash(secret)), recoveryCodes: recovery.codes };
    });
    // Only a replacement after a recovery code is news to the owner; a first enrollment is not.
    if (replaced) await this.#notify(replaced, "mfa-replaced");
    return result;
  }
  /**
   * A recovery code proves the person but not the factor: it signs nobody in. The factor is retired,
   * every session ends, and the only thing issued is an enrollment challenge for a new factor.
   */
  async completeMfa(challenge: string, otp: string, ip: string): Promise<LoginResult> {
    const charge = await this.#throttle("mfa", ip, { userId: await this.#mfaSubject(challenge) }); const secret = opaque();
    let recoveredAddress: string | undefined;
    const result = await this.#store.transact((t): LoginResult => {
      const action = this.#readAction(t.state, challenge, "challenge"); if (action.data.reenroll) deny();
      const user = this.#tokenUser(t.state, action); const used = this.#consumeOtp(t.state, user, otp, { recovery: true });
      this.#consumeAction(t.state, challenge, "challenge"); this.#refund(t.state, charge);
      if (used === "recovery") {
        // The old factor stays until a new one is confirmed, so the last administrator is never left without one.
        this.#revokeUser(t.state, user.userId);
        this.#action(t.state, secret, "challenge", user, this.#policy.tokens.challengeSeconds, { reenroll: "recovery" });
        this.#audit(t, `account:${user.userId}`, "recovery-code-used", user.userId); recoveredAddress = user.canonicalLoginKey;
        return { challenge: secret, enrollmentRequired: true };
      }
      this.#newSession(t, user, secret, this.#now());
      return { token: secret, csrf: this.csrf(hash(secret)) };
    });
    // After the commit; a failed notice never undoes it.
    if (recoveredAddress) await this.#notify(recoveredAddress, "recovery-code-used");
    return result;
  }
  async reauthenticate(actor: AccountActor, otp: string, ip: string): Promise<void> {
    const charge = await this.#throttle("mfa", ip, { userId: await this.#mfaSubject(undefined, actor) });
    await this.#store.transact((t) => { const c = this.#context(t.state, actor.token); if (c.session.kind !== "account") deny(); this.#consumeOtp(t.state, c.user, otp, {}); this.#refund(t.state, charge); c.session.mfaAt = this.#now(); this.#audit(t, `account:${c.user.userId}`, "reauthenticated", c.user.userId); });
  }
  /**
   * Read-only unless the session is due a touch: most requests change nothing, so they write nothing.
   * The touch interval bounds how often an active session rewrites the state.
   */
  async context(token: string): Promise<MemberContext> {
    const state = await this.#store.read();
    const session = safeToken(token) ? state.sessions.find((s) => s.digest === hash(token)) : undefined;
    const due = session !== undefined && this.#now() - session.lastSeenAt >= this.#policy.session.touchIntervalSeconds * 1000;
    const context = this.#context(state, token);
    return due ? this.#store.transact((t) => this.#context(t.state, token)) : context;
  }
  async resolve(token: string, signal: AbortSignal): Promise<AccountSessionResolution> {
    if (signal.aborted) throw new MemberError("unavailable");
    try { const c = await this.context(token); if (signal.aborted) throw new MemberError("unavailable");
      return { status: "active", role: c.user.role, subject: `account:${c.user.userId}`, recentVerification: c.session.kind === "account" && c.recentMfa };
    } catch (error) { if (error instanceof MemberError && ["denied", "not-enabled"].includes(error.code)) return { status: "rejected" }; throw error; }
  }
  async revoke(token: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new MemberError("unavailable");
    await this.#store.transact((t) => { const session = t.state.sessions.find((s) => s.digest === hash(token));
      t.state.sessions = t.state.sessions.filter((s) => s.digest !== hash(token)); if (session) this.#audit(t, `account:${session.userId}`, "logout", session.userId); });
  }
  /** The member's live sessions, without their identifiers; `current` marks the one asking. */
  async sessions(actor: AccountActor): Promise<(Omit<MemberSession, "digest" | "epoch"> & { current: boolean })[]> {
    return this.#store.transact((t) => { const c = this.#context(t.state, actor.token);
      return t.state.sessions.filter((s) => s.userId === c.user.userId && this.#live(s)).map(({ digest, epoch: _epoch, ...s }) => ({ ...s, current: digest === c.session.digest })); });
  }
  async revokeSessions(actor: AccountActor, createdAt?: number): Promise<void> {
    await this.#store.transact((t) => { const c = this.#sensitive(t.state, actor); t.state.sessions = t.state.sessions.filter((s) => s.userId !== c.user.userId || (createdAt !== undefined && s.createdAt !== createdAt)); this.#audit(t, `account:${c.user.userId}`, "sessions-revoked", c.user.userId); });
  }
  async changePassword(actor: AccountActor, currentPassword: string, password: string, ip: string): Promise<void> {
    const c = await this.#store.transact((t) => { const c = this.#sensitive(t.state, actor); return { ...c, storedHash: t.state.passwords[c.user.userId] }; });
    // Checking the current password is a password guess too; it counts with sign-in attempts.
    const charge = await this.#throttle("login", ip, { userId: c.user.userId });
    if (!await this.#passwords.verify(currentPassword, c.storedHash)) deny(); this.#requireComposition(password); const next = await this.#passwords.hash(password);
    await this.#store.transact((t) => { const fresh = this.#sensitive(t.state, actor); if (fresh.user.securityEpoch !== c.user.securityEpoch) deny();
      this.#refund(t.state, charge);
      t.state.passwords[fresh.user.userId] = next; this.#bump(t.state, fresh.user); this.#audit(t, `account:${c.user.userId}`, "password-changed", c.user.userId); });
    await this.#notify(c.user.canonicalLoginKey, "password-changed");
  }
  async invite(actor: AccountActor, email: string, role: Role): Promise<void> {
    const canonical = canonicalAccountEmail(email); if (!["viewer", "editor", "admin"].includes(role)) throw new MemberError("invalid-input");
    const token = opaque();
    await this.#store.transact((t) => { const c = this.#admin(t.state, actor);
      this.#uniqueEmail(t.state, canonical);
      t.state.tokens = t.state.tokens.filter((x) => x.expiresAt > this.#now() && !(x.purpose === "invite" && x.email === canonical));
      if (t.state.tokens.filter((x) => x.purpose === "invite").length >= this.#policy.rateLimit.maxEntries) throw new MemberError("unavailable");
      t.state.tokens.push({ digest: hash(token), purpose: "invite", userId: null, email: canonical, role, epoch: null,
        expiresAt: this.#now() + this.#policy.tokens.inviteSeconds * 1000, sessionDigest: null, data: {} }); this.#audit(t, `account:${c.user.userId}`, "invited", null); });
    await this.#send(token, canonical, "invite");
  }
  /**
   * The link is checked before any hashing, so an anonymous caller cannot buy password work with a
   * guessed token.
   */
  async acceptInvite(token: string, email: string, password: string, displayName: string, ip: string): Promise<void> {
    const canonical = canonicalAccountEmail(email);
    await this.#throttle("token", ip);
    await this.#peekAction(token, "invite");
    this.#requireComposition(password);
    const storedHash = await this.#passwords.hash(password);
    await this.#store.transact((t) => { this.#enabled(t.state); const action = this.#consumeAction(t.state, token, "invite");
      if (action.email !== canonical || !action.role) deny();
      this.#uniqueEmail(t.state, canonical);
      const user = this.#newMember(t.state, canonical, displayName, action.role, storedHash, true); this.#audit(t, "invite", "invite-accepted", user.userId); });
  }
  /**
   * Replaces a password a member already has; it never creates one. A person who has only ever signed
   * in through a provider -- automatic sign-up or the legacy window -- has none to reset, so a reset
   * cannot turn a provider sign-in into a local credential that outlives the provider's say.
   *
   * The mail leaves after the answer: neither an existing address nor a slow SMTP server shows in how
   * long this takes. The mailer's own queue bound refuses excess, and a failed send voids the token.
   */
  async requestPasswordReset(email: string, ip: string): Promise<void> {
    const canonical = canonicalAccountEmail(email); await this.#throttle("reset", ip, { email: canonical }); const token = opaque();
    const found = await this.#store.transact((t) => { this.#enabled(t.state); const user = t.state.users.find((u) => u.canonicalLoginKey === canonical && u.status === "active" && u.emailVerifiedAt !== null);
      if (!user || !t.state.passwords[user.userId] || this.#legacyOnly(t.state, user.userId)) return false;
      t.state.tokens = t.state.tokens.filter((x) => !(x.purpose === "reset" && x.userId === user.userId));
      this.#action(t.state, token, "reset", user, this.#policy.tokens.resetSeconds); this.#audit(t, "anonymous", "password-reset-requested", user.userId); return true; });
    if (found) void this.#send(token, canonical, "password-reset").catch(() => undefined);
  }
  async resetPassword(token: string, password: string, ip: string): Promise<void> {
    await this.#throttle("token", ip);
    await this.#peekAction(token, "reset");
    this.#requireComposition(password);
    const storedHash = await this.#passwords.hash(password);
    const email = await this.#store.transact((t) => { const a = this.#consumeAction(t.state, token, "reset"), user = this.#tokenUser(t.state, a);
      if (!t.state.passwords[user.userId] || this.#legacyOnly(t.state, user.userId)) deny();
      t.state.passwords[user.userId] = storedHash; this.#bump(t.state, user); this.#audit(t, "reset", "password-reset", user.userId); return user.canonicalLoginKey; });
    await this.#notify(email, "password-changed");
  }
  async requestEmailChange(actor: AccountActor, email: string): Promise<void> {
    const canonical = canonicalAccountEmail(email), token = opaque();
    await this.#store.transact((t) => { const c = this.#sensitive(t.state, actor); this.#uniqueEmail(t.state, canonical);
      t.state.tokens = t.state.tokens.filter((x) => !(x.purpose === "email" && x.userId === c.user.userId));
      const a = this.#action(t.state, token, "email", c.user, this.#policy.tokens.emailChangeSeconds); a.email = canonical; a.sessionDigest = c.session.digest;
      this.#audit(t, `account:${c.user.userId}`, "email-change-requested", c.user.userId); }); await this.#send(token, canonical, "email-change");
  }
  async confirmEmailChange(actor: AccountActor, token: string): Promise<void> {
    const old = await this.#store.transact((t) => { const c = this.#sensitive(t.state, actor), a = this.#consumeAction(t.state, token, "email");
      if (a.userId !== c.user.userId || a.epoch !== c.user.securityEpoch || a.sessionDigest !== c.session.digest || !a.email) deny(); this.#uniqueEmail(t.state, a.email);
      const old = c.user.canonicalLoginKey; c.user.canonicalLoginKey = a.email; c.user.emailVerifiedAt = this.#now(); this.#bump(t.state, c.user);
      this.#audit(t, `account:${c.user.userId}`, "email-changed", c.user.userId); return old; }); await this.#notify(old, "email-changed");
  }
  async listMembers(actor: AccountActor): Promise<Member[]> { return this.#store.transact((t) => { this.#admin(t.state, actor); return t.state.users.map(publicMember); }); }
  async changeMember(actor: AccountActor, userId: string, expectedVersion: number, patch: { role?: Role; status?: "active" | "suspended" | "deleted" }): Promise<Member> {
    return this.#store.transact((t) => { const c = this.#admin(t.state, actor), user = t.state.users.find((u) => u.userId === userId); if (!user) deny();
      const updated = { ...user, ...changeAccountSecurity(user, expectedVersion, patch) }; this.#retainAdmin(t.state, user, updated);
      t.state.users[t.state.users.indexOf(user)] = updated; this.#revokeUser(t.state, userId); t.state.tokens = t.state.tokens.filter((x) => x.userId !== userId);
      if (updated.status === "deleted") this.#erase(t.state, updated);
      this.#audit(t, `account:${c.user.userId}`, updated.status === "deleted" ? "member-deleted" : "member-security-changed", userId); return publicMember(updated); });
  }
  /**
   * Leaving: the member's own account session, a fresh code and the current password. The last
   * administrator who can sign in cannot leave. Everything personal goes at once (see `#erase`).
   */
  async deleteSelf(actor: AccountActor, password: string, ip: string): Promise<void> {
    const c = await this.#store.transact((t) => { const c = this.#sensitive(t.state, actor); return { userId: c.user.userId, epoch: c.user.securityEpoch, storedHash: t.state.passwords[c.user.userId] }; });
    await this.#throttle("login", ip, { userId: c.userId });
    if (!c.storedHash || !await this.#passwords.verify(password, c.storedHash)) deny();
    await this.#store.transact((t) => {
      const fresh = this.#sensitive(t.state, actor);
      if (fresh.user.userId !== c.userId || fresh.user.securityEpoch !== c.epoch || t.state.passwords[c.userId] !== c.storedHash) deny();
      const updated = { ...fresh.user, ...changeAccountSecurity(fresh.user, fresh.user.version, { status: "deleted" }) };
      this.#retainAdmin(t.state, fresh.user, updated);
      t.state.users[t.state.users.indexOf(fresh.user)] = updated; this.#revokeUser(t.state, c.userId); t.state.tokens = t.state.tokens.filter((x) => x.userId !== c.userId);
      this.#erase(t.state, updated);
      this.#audit(t, `account:${c.userId}`, "member-left", c.userId);
    });
  }
  /**
   * A deleted member keeps only a tombstone: its id, `deleted` status, and the provider identities it
   * linked (issuer and subject), which stay so the same provider account cannot quietly become a new
   * member. Address, display name, password, factor, sessions, tokens and counters go now; the
   * address can be invited again. The audit trail never held an address.
   */
  #erase(state: AccountState, user: Member): void {
    user.canonicalLoginKey = `deleted-${createHash("sha256").update(user.userId).digest("hex").slice(0, 40)}@deleted.invalid`;
    user.displayName = "Deleted member"; user.emailVerifiedAt = null;
    delete state.passwords[user.userId]; delete state.factors[user.userId]; delete state.memberThrottle[user.userId];
  }
  async resetMfaHost(userId: string): Promise<void> {
    const email = await this.#store.transact((t) => { const user = this.#user(t.state, userId);
      // A host recovery also lifts the member's own attempt limit, which someone else may have run up on purpose.
      this.#retainAdmin(t.state, user, undefined); delete t.state.factors[userId]; delete t.state.memberThrottle[userId]; this.#bump(t.state, user); this.#audit(t, "host", "mfa-reset", userId); return user.canonicalLoginKey; });
    await this.#notify(email, "mfa-reset");
  }
  async regenerateRecoveryCodes(actor: AccountActor): Promise<string[]> {
    const recovery = createRecoveryCodes(this.#policy.mfa.recoveryCodeCount);
    return this.#store.transact((t) => { const c = this.#sensitive(t.state, actor), factor = t.state.factors[c.user.userId]; if (!factor || factor.confirmedAt === null) deny();
      factor.recoveryDigests = recovery.digests; this.#audit(t, `account:${c.user.userId}`, "recovery-codes-replaced", c.user.userId); return recovery.codes; });
  }
  async beginOidc(input: { issuer: string; purpose: "login" | "link"; actor?: AccountActor; verifier: string; nonce: string; state: string; ip: string }): Promise<void> {
    await this.#throttle("link", input.ip);
    await this.#store.transact((t) => {
      this.#enabled(t.state);
      const c = input.purpose === "link" ? this.#sensitive(t.state, input.actor ?? { token: "" }) : undefined;
      if (!safeToken(input.state)) throw new MemberError("invalid-input");
      t.state.tokens = t.state.tokens.filter((x) => x.expiresAt > this.#now());
      // Provider sign-in states have their own bound, so starting many cannot crowd out challenges or invitations.
      if (t.state.tokens.filter((x) => x.purpose === "oidc").length >= this.#policy.rateLimit.maxEntries) throw new MemberError("unavailable");
      t.state.tokens.push({ digest: hash(input.state), purpose: "oidc", userId: c?.user.userId ?? null, epoch: c?.user.securityEpoch ?? null,
        email: null, role: null, sessionDigest: c?.session.digest ?? null, expiresAt: this.#now() + this.#policy.tokens.challengeSeconds * 1000,
        data: { issuer: input.issuer, purpose: input.purpose, verifier: input.verifier, nonce: input.nonce } });
    });
  }
  async consumeOidcState(raw: string, actorToken?: string): Promise<{ issuer: string; purpose: "login" | "link"; verifier: string; nonce: string; userId: string | null; epoch: number | null; sessionDigest: string | null }> {
    return this.#store.transact((t) => {
      const a = this.#consumeAction(t.state, raw, "oidc");
      if (a.data.purpose === "link") {
        const c = this.#sensitive(t.state, { token: actorToken ?? "" });
        if (a.userId !== c.user.userId || a.epoch !== c.user.securityEpoch || a.sessionDigest !== c.session.digest) deny();
      } else if (a.data.purpose !== "login") deny();
      return { issuer: a.data.issuer!, purpose: a.data.purpose as "login" | "link", verifier: a.data.verifier!, nonce: a.data.nonce!, userId: a.userId, epoch: a.epoch, sessionDigest: a.sessionDigest };
    });
  }
  /** Whether a provider sign-in may still use the legacy window, so userinfo is only asked for when it matters. */
  async legacyWindowOpen(): Promise<boolean> {
    const { legacyUntil, legacyRoleCap } = (await this.#store.read()).settings;
    return legacyUntil !== null && legacyRoleCap !== null && Date.parse(legacyUntil) > this.#now();
  }
  /**
   * A legacy sign-in is not a member. It is kept under a key derived from issuer and subject -- never an
   * email address -- so it holds no address another person could be invited at, no password and no
   * factor, and nothing a reset or enrollment could attach to. It ends with the window, or when the
   * person links that provider account to their own invited account, which absorbs it.
   */
  async finishOidc(input: { issuer: string; subject: string; verifiedEmail?: string; legacyRole?: Role; state: Awaited<ReturnType<AccountService["consumeOidcState"]>>; actorToken?: string }): Promise<LoginResult | { linked: true }> {
    const raw = opaque();
    const outcome = await this.#store.transact((t): LoginResult | { linked: true; email: string } => {
      this.#enabled(t.state); if (input.issuer !== input.state.issuer || !input.subject || input.subject.length > 1024) deny();
      const identity = t.state.identities.find((i) => i.issuer === input.issuer && i.subject === input.subject);
      if (input.state.purpose === "link") {
        const c = this.#sensitive(t.state, { token: input.actorToken ?? "" });
        if (c.user.userId !== input.state.userId || c.user.securityEpoch !== input.state.epoch || c.session.digest !== input.state.sessionDigest) deny();
        if (identity && identity.userId !== c.user.userId) {
          // A suspended or deleted legacy record is an administrator's decision; linking does not undo it.
          const legacyUser = t.state.users.find((u) => u.userId === identity.userId);
          if (identity.kind !== "legacy" || !this.#legacyOnly(t.state, identity.userId) || legacyUser?.status !== "active") throw new MemberError("conflict");
          this.#removeMember(t.state, identity.userId);
          t.state.identities.push({ issuer: input.issuer, subject: input.subject, userId: c.user.userId, kind: "linked" });
          this.#audit(t, `account:${c.user.userId}`, "legacy-absorbed", c.user.userId);
        } else if (identity) {
          if (identity.kind === "linked") throw new MemberError("conflict");
          identity.kind = "linked";
        } else t.state.identities.push({ issuer: input.issuer, subject: input.subject, userId: c.user.userId, kind: "linked" });
        t.state.sessions = t.state.sessions.filter((s) => s.userId !== c.user.userId || s.kind !== "legacy");
        this.#audit(t, `account:${c.user.userId}`, "identity-linked", c.user.userId); return { linked: true, email: c.user.canonicalLoginKey };
      }
      const windowOpen = t.state.settings.legacyUntil !== null && t.state.settings.legacyRoleCap !== null && Date.parse(t.state.settings.legacyUntil) > this.#now();
      let user: Member;
      let legacy = false;
      if (identity) {
        user = this.#user(t.state, identity.userId);
        legacy = identity.kind === "legacy";
      } else {
        const jit = t.state.settings.jit.find((j) => j.issuer === input.issuer);
        if (jit) {
          if (t.state.identities.filter((i) => i.issuer === input.issuer && i.kind === "linked").length >= jit.maxUsers) throw new MemberError("conflict");
          if (!input.verifiedEmail) deny();
          const email = canonicalAccountEmail(input.verifiedEmail); this.#uniqueEmail(t.state, email);
          user = { ...createLocalAccount({ userId: opaque(), canonicalLoginKey: email, displayName: "SSO member", role: "viewer", status: "active" }), emailVerifiedAt: this.#now(), createdAt: this.#now() };
          t.state.identities.push({ issuer: input.issuer, subject: input.subject, userId: user.userId, kind: "linked" });
          this.#audit(t, "oidc", "jit-created", user.userId);
        } else {
          if (!windowOpen || !input.legacyRole) deny();
          legacy = true;
          const key = `legacy-${createHash("sha256").update(`${input.issuer}\n${input.subject}`).digest("hex").slice(0, 40)}@legacy.invalid`;
          user = { ...createLocalAccount({ userId: opaque(), canonicalLoginKey: key, displayName: "Legacy sign-in", role: "viewer", status: "active" }), emailVerifiedAt: null, createdAt: this.#now() };
          t.state.identities.push({ issuer: input.issuer, subject: input.subject, userId: user.userId, kind: "legacy" });
          this.#audit(t, "oidc", "legacy-created", user.userId);
        }
        t.state.users.push(user);
      }
      if (legacy) {
        if (!windowOpen || !this.#legacyOnly(t.state, user.userId)) deny();
        // The provider's current grant, read the way legacy sign-in reads it, capped, at every sign-in.
        if (!input.legacyRole) deny();
        const role: Role = t.state.settings.legacyRoleCap === "editor" && input.legacyRole !== "viewer" ? "editor" : "viewer";
        if (user.role !== role) { user.role = role; this.#bump(t.state, user); this.#audit(t, "oidc", "legacy-role-applied", user.userId); }
        this.#newSession(t, user, raw, null);
        t.state.sessions.find((s) => s.digest === hash(raw))!.kind = "legacy";
        return { token: raw, csrf: this.csrf(hash(raw)) };
      }
      if (user.role === "admin" || t.state.factors[user.userId] !== undefined) {
        const enrollmentRequired = t.state.factors[user.userId]?.confirmedAt == null;
        this.#action(t.state, raw, "challenge", user, this.#policy.tokens.challengeSeconds);
        return { challenge: raw, enrollmentRequired };
      }
      this.#newSession(t, user, raw, null);
      return { token: raw, csrf: this.csrf(hash(raw)) };
    });
    if ("linked" in outcome) { await this.#notify(outcome.email, "identity-linked"); return { linked: true }; }
    return outcome;
  }
  async identities(actor: AccountActor): Promise<{ issuer: string; subject: string; kind: "linked" | "legacy" }[]> {
    return this.#store.transact((t) => { const c = this.#context(t.state, actor.token); return t.state.identities.filter((i) => i.userId === c.user.userId).map(({ userId: _userId, ...i }) => i); });
  }
  async unlinkIdentity(actor: AccountActor, issuer: string, subject: string): Promise<void> {
    const email = await this.#store.transact((t) => {
      const c = this.#sensitive(t.state, actor); if (!t.state.passwords[c.user.userId]) throw new MemberError("conflict");
      const before = t.state.identities.length;
      t.state.identities = t.state.identities.filter((i) => !(i.userId === c.user.userId && i.issuer === issuer && i.subject === subject));
      if (before === t.state.identities.length) throw new MemberError("conflict");
      this.#bump(t.state, c.user); this.#audit(t, `account:${c.user.userId}`, "identity-unlinked", c.user.userId); return c.user.canonicalLoginKey;
    }); await this.#notify(email, "identity-unlinked");
  }
  /** What an administrator sees before changing it; reading needs no fresh code, changing does. */
  async identityPolicy(actor: AccountActor): Promise<{ roleSource: "local"; mfaEvidence: "local-totp"; jit: AccountState["settings"]["jit"]; legacyUntil: string | null; legacyRoleCap: "viewer" | "editor" | null }> {
    return this.#store.transact((t) => { const c = this.#context(t.state, actor.token); if (c.user.role !== "admin") deny();
      const { roleSource, mfaEvidence, jit, legacyUntil, legacyRoleCap } = t.state.settings; return { roleSource, mfaEvidence, jit, legacyUntil, legacyRoleCap }; });
  }
  async configureIdentity(actor: AccountActor, input: { roleSource: string; mfaEvidence: string; jit: AccountState["settings"]["jit"] }): Promise<void> {
    // Current provider contract proves neither current role revocation nor fresh MFA.
    if (input.roleSource !== "local" || input.mfaEvidence !== "local-totp") throw new MemberError("invalid-input");
    const settings = structuredClone(input);
    await this.#store.transact((t) => { const c = this.#admin(t.state, actor); t.state.settings.jit = settings.jit; this.#audit(t, `account:${c.user.userId}`, "identity-policy-changed", null); });
  }
  async recoverAdministratorHost(userId: string): Promise<{ challenge: string; enrollmentRequired: true }> {
    const raw = opaque();
    return this.#store.transact((t) => {
      const user = this.#user(t.state, userId);
      if (user.role !== "admin" || !t.state.passwords[userId]) deny();
      delete t.state.memberThrottle[userId];
      if (t.state.users.some((u) => u.userId !== userId && u.status === "active" && u.role === "admin" && t.state.passwords[u.userId] && t.state.factors[u.userId]?.confirmedAt != null)) throw new MemberError("conflict");
      delete t.state.factors[userId]; this.#bump(t.state, user); t.state.bootstrap = "enrollment";
      this.#action(t.state, raw, "challenge", user, this.#policy.tokens.enrollmentSeconds); this.#audit(t, "host", "administrator-recovery-started", userId);
      return { challenge: raw, enrollmentRequired: true };
    });
  }
  async setLegacyHost(until: string, roleCap: "viewer" | "editor"): Promise<void> {
    if (new Date(until).toISOString() !== until || Date.parse(until) <= this.#now() || !["viewer", "editor"].includes(roleCap)) throw new MemberError("invalid-input");
    await this.#store.transact((t) => { this.#enabled(t.state); t.state.settings.legacyUntil = until; t.state.settings.legacyRoleCap = roleCap; this.#audit(t, "host", "legacy-configured", null); });
  }
  /**
   * Two limits, both of which must allow the attempt, decided before any password is hashed.
   *
   * Per account: `login`, `mfa` and `reset` attempts against a real account are counted on that member,
   * in `memberThrottle` -- one counter per member and kind, which nothing can push out, not cleared by
   * a successful sign-in, only by its window ending. An address that belongs to nobody is counted the
   * same way under its own keyed entry (`kind:ghost:<hmac>`) with the same limit and window, so when it
   * is limited does not reveal whether an account exists.
   *
   * Per client: a table of `maxEntries` network-address buckets per kind (`clientBucket`).
   *
   * Both shared tables hold `maxEntries` per kind. When one is full, the oldest entry still under its
   * limit makes room; a full table of entries at their limit cannot, and that counter is then kept by
   * this process's `LocalLimiter` instead, under the same limit and window. Nothing is ever refused
   * because a table is full, no bucket shares another's allowance, and an unknown address is still
   * limited at the same attempt as a real one. Each such case is counted in
   * `parallax_account_throttle_saturated_total`.
   *
   * `token` counts guesses at mailed links (invitations, resets) by client under the reset limits;
   * `link` counts provider sign-in starts by client under `rateLimit.link`.
   */
  async #throttle(kind: "login" | "mfa" | "reset" | "token" | "link", ip: string, subject: { email?: string; userId?: string } = {}): Promise<Charge> {
    const policy = this.#policy.rateLimit[kind === "token" ? "reset" : kind], now = this.#now(), max = this.#policy.rateLimit.maxEntries;
    const window = now + policy.windowSeconds * 1000;
    const bucket = clientBucket(ip);
    if (bucket === "other") unidentifiedClient();
    let saturated = false;
    let charge: Charge;
    let retryAt = now;
    const windowMs = policy.windowSeconds * 1000;
    // A counter restarts `windowSeconds` after its last attempt; up to `attempts` there is no wait, then
    // each attempt waits base × 2^(n−1), capped, counted from the last attempt.
    const waitUntil = (c: { count: number; expiresAt: number }): number => c.count < policy.attempts ? 0
      : c.expiresAt - windowMs + Math.min(policy.maxDelaySeconds, policy.baseDelaySeconds * 2 ** Math.min(c.count - policy.attempts, 30)) * 1000;
    const allowed = await this.#store.transact((t) => { this.#enabled(t.state); t.state.throttle = t.state.throttle.filter((x) => x.expiresAt > now);
      const digest = (axis: string, value: string): string => createHmac("sha256", this.#rateKey).update(JSON.stringify([kind, axis, value])).digest("base64url");
      /** A counter in a bounded shared table, or this process's own when the table has no room. */
      const counter = (prefix: string, key: string): { count: number; expiresAt: number } => {
        const found = t.state.throttle.find((x) => x.key === key);
        if (found) return found;
        const table = t.state.throttle.filter((x) => x.key.startsWith(prefix));
        if (table.length >= max) {
          const room = table.filter((x) => x.count < policy.attempts).sort((a, b) => a.expiresAt - b.expiresAt)[0];
          if (!room) { saturated = true; return this.#local.counter(key, now, window); }
          t.state.throttle = t.state.throttle.filter((x) => x !== room);
        }
        const created = { key, count: 0, expiresAt: window }; t.state.throttle.push(created); return created;
      };
      const address = counter(`${kind}:ip:`, `${kind}:ip:${digest("ip", bucket)}`);
      const addressWait = waitUntil(address);
      if (now < addressWait) { retryAt = addressWait; return false; }
      // The account axis: the member's own counter, or the address's own keyed counter.
      let account: { count: number; expiresAt: number } | undefined;
      if (kind === "login" || kind === "mfa" || kind === "reset") {
        const user = subject.userId !== undefined ? t.state.users.find((u) => u.userId === subject.userId)
          : subject.email !== undefined ? t.state.users.find((u) => u.canonicalLoginKey === subject.email) : undefined;
        if (user) {
          const counters = t.state.memberThrottle[user.userId] ??= {};
          const current = counters[kind];
          const previousExpiresAt = current && current.expiresAt > now ? current.expiresAt : now;
          account = current && current.expiresAt > now ? current : (counters[kind] = { count: 0, expiresAt: now });
          charge = { userId: user.userId, kind, expiresAt: window, previousExpiresAt };
        } else if (subject.email !== undefined) {
          account = counter(`${kind}:ghost:`, `${kind}:ghost:${digest("ghost", subject.email)}`);
        }
      }
      if (account) { const accountWait = waitUntil(account); if (now < accountWait) { charge = undefined; retryAt = accountWait; address.count++; address.expiresAt = window; return false; } }
      address.count++; address.expiresAt = window;
      if (account) { account.count++; account.expiresAt = window; }
      return true; });
    if (saturated) accountThrottleSaturated({ kind });
    if (!allowed) throw new MemberError("rate-limited", Math.max(1, Math.ceil((retryAt - now) / 1000)));
    return charge;
  }
  /**
   * A verified password or code takes back the one attempt its own request charged to the member, in
   * the transaction that records the success, and only within the same window. Earlier failures stay.
   * The address and unknown-address counters keep it: those count requests, not mistakes.
   */
  #refund(state: AccountState, charge: Charge): void {
    if (!charge) return;
    const counter = state.memberThrottle[charge.userId]?.[charge.kind];
    // Its own attempt, and the clock it moved: a success neither adds a failure nor restarts a wait.
    if (counter && counter.expiresAt === charge.expiresAt && counter.count > 0) { counter.count--; counter.expiresAt = charge.previousExpiresAt; }
  }
  /** Reads, never consumes: a link that does not exist costs no hashing. */
  async #peekAction(raw: string, purpose: ActionToken["purpose"]): Promise<void> {
    if (!safeToken(raw)) deny();
    const state = await this.#store.read(); this.#enabled(state);
    if (!state.tokens.some((t) => t.digest === hash(raw) && t.purpose === purpose && t.expiresAt > this.#now())) deny();
  }
  /** A person known only through the legacy provider sign-in: no password, no linked identity. */
  #legacyOnly(state: AccountState, userId: string): boolean {
    return !state.passwords[userId] && state.identities.some((i) => i.userId === userId && i.kind === "legacy")
      && !state.identities.some((i) => i.userId === userId && i.kind === "linked");
  }
  #removeMember(state: AccountState, userId: string): void {
    state.users = state.users.filter((u) => u.userId !== userId); state.identities = state.identities.filter((i) => i.userId !== userId); delete state.memberThrottle[userId];
    this.#revokeUser(state, userId); state.tokens = state.tokens.filter((t) => t.userId !== userId); delete state.factors[userId]; delete state.passwords[userId];
  }
  /** Machine tokens are independent of members; who issued one is still recorded. */
  async recordMachineTokenAudit(actor: string, action: "token-issue-requested" | "token-revoke-requested"): Promise<void> {
    const userId = /^account:([A-Za-z0-9_-]{43})$/u.exec(actor)?.[1];
    if (!userId) return;
    await this.#store.transact((t) => { this.#user(t.state, userId); this.#audit(t, actor, action, userId); });
  }
  #enabled(state: AccountState): void { if (!state.enabled) throw new MemberError("not-enabled"); }
  #user(state: AccountState, id: string): Member { this.#enabled(state); const u = state.users.find((u) => u.userId === id && u.status === "active"); return u ?? deny(); }
  #context(state: AccountState, token: string): MemberContext {
    this.#enabled(state); if (state.bootstrap !== "ready") deny(); if (!safeToken(token)) deny(); const session = state.sessions.find((s) => s.digest === hash(token)); if (!session || !this.#live(session)) deny();
    const user = this.#user(state, session.userId); if (session.epoch !== user.securityEpoch || user.role === "admin" && (session.mfaAt === null || session.kind !== "account")) deny();
    if (session.kind === "legacy" && (!state.settings.legacyUntil || Date.parse(state.settings.legacyUntil) <= this.#now() || state.identities.some((i) => i.userId === user.userId && i.kind === "linked"))) deny();
    if (this.#now() - session.lastSeenAt >= this.#policy.session.touchIntervalSeconds * 1000) {
      session.lastSeenAt = this.#now(); session.idleExpiresAt = Math.min(session.absoluteExpiresAt, this.#now() + this.#policy.session.idleSeconds * 1000);
    }
    return { user, session, csrf: this.csrf(session.digest), mfaEnrolled: state.factors[user.userId]?.confirmedAt != null, recentMfa: session.mfaAt !== null && this.#now() >= session.mfaAt && this.#now() - session.mfaAt < this.#policy.recentAuthSeconds * 1000 };
  }
  #sensitive(state: AccountState, actor: AccountActor): MemberContext { const c = this.#context(state, actor.token); if (c.session.kind !== "account" || !c.recentMfa) throw new MemberError("mfa-required"); return c; }
  #admin(state: AccountState, actor: AccountActor): MemberContext { const c = this.#sensitive(state, actor); if (c.user.role !== "admin") deny(); return c; }
  #live(s: MemberSession): boolean { const now = this.#now(); return now >= s.createdAt && now < s.absoluteExpiresAt && now < s.idleExpiresAt; }
  #newMember(state: AccountState, email: string, displayName: string, role: Role, storedHash: string, verified: boolean): Member {
    this.#uniqueEmail(state, email); if (typeof displayName !== "string" || !displayName || displayName.length > 256 || /[\x00-\x1f\x7f]/u.test(displayName)) throw new MemberError("invalid-input");
    const user: Member = { ...createLocalAccount({ userId: opaque(), canonicalLoginKey: email, displayName, role, status: "active" }), emailVerifiedAt: verified ? this.#now() : null, createdAt: this.#now() };
    state.users.push(user); state.passwords[user.userId] = storedHash; return user;
  }
  #uniqueEmail(state: AccountState, email: string): void { if (state.users.some((u) => u.canonicalLoginKey === email)) throw new MemberError("conflict"); }
  /**
   * A token bound to a member: one per member and purpose. Issuing one replaces that member's earlier
   * unfinished token of the same purpose in the same transaction, so the earlier one stops working, and
   * no one -- not even someone holding the right password -- can fill the per-purpose bound for others.
   *
   * One exception keeps recovery whole: a re-enrollment challenge (issued after a recovery code) is
   * not replaced by an ordinary sign-in challenge, so signing in again cannot undo it before the new
   * factor is set up or it expires. A new re-enrollment challenge replaces all of the member's.
   */
  #action(state: AccountState, raw: string, purpose: ActionToken["purpose"], user: Member, seconds: number, data: Record<string, string> = {}): ActionToken {
    const reenroll = purpose === "challenge" && data.reenroll !== undefined;
    state.tokens = state.tokens.filter((t) => t.expiresAt > this.#now()
      && !(t.userId === user.userId && t.purpose === purpose && (reenroll || t.data.reenroll === undefined)));
    const action: ActionToken = { digest: hash(raw), purpose, userId: user.userId, email: null, role: null, epoch: user.securityEpoch, expiresAt: this.#now() + seconds * 1000, sessionDigest: null, data };
    if (state.tokens.filter((t) => t.purpose === purpose).length >= this.#policy.rateLimit.maxEntries) throw new MemberError("unavailable");
    state.tokens.push(action); return action;
  }
  #consumeAction(state: AccountState, raw: string, purpose: ActionToken["purpose"]): ActionToken { const a = this.#readAction(state, raw, purpose); state.tokens.splice(state.tokens.indexOf(a), 1); return a; }
  #readAction(state: AccountState, raw: string, purpose: ActionToken["purpose"]): ActionToken { this.#enabled(state); if (!safeToken(raw)) deny(); const a = state.tokens.find((t) => t.digest === hash(raw) && t.purpose === purpose && t.expiresAt > this.#now()); return a ?? deny(); }
  #tokenUser(state: AccountState, a: ActionToken): Member { const user = this.#user(state, a.userId ?? ""); if (a.epoch !== user.securityEpoch) deny(); return user; }
  /** Only a confirmed factor answers, except while confirming the enrollment that created it. */
  #consumeOtp(state: AccountState, user: Member, token: string, allow: { recovery?: boolean; unconfirmed?: boolean }): "totp" | "recovery" {
    const allowRecovery = allow.recovery === true;
    const f = state.factors[user.userId]; if (!f || (f.confirmedAt === null) !== (allow.unconfirmed === true)) deny();
    const verified = this.#totp.verify(f.encryptedSeed, user.userId, token, this.#now());
    if (verified && verified.counter > f.lastCounter) { f.lastCounter = verified.counter; return "totp"; }
    if (allowRecovery) { const index = f.recoveryDigests.findIndex((digest) => verifyRecoveryCode(token, digest)); if (index >= 0) { f.recoveryDigests.splice(index, 1); return "recovery"; } } deny();
  }
  /** Attempts count against the person, so a fresh challenge or session cannot reset the counter. */
  async #mfaSubject(challenge?: string, actor?: AccountActor): Promise<string | undefined> {
    const raw = challenge ?? actor?.token ?? "";
    if (!safeToken(raw)) return undefined;
    const digest = hash(raw);
    const state = await this.#store.read();
    const owner = challenge !== undefined ? state.tokens.find((t) => t.digest === digest && t.purpose === "challenge")?.userId
      : state.sessions.find((s) => s.digest === digest)?.userId;
    return owner ?? undefined;
  }
  #newSession(t: AccountTransaction, user: Member, raw: string, mfaAt: number | null): void {
    const now = this.#now(); t.state.sessions = t.state.sessions.filter((s) => this.#live(s));
    const owned = t.state.sessions.filter((s) => s.userId === user.userId).sort((a, b) => a.createdAt - b.createdAt);
    while (owned.length >= this.#policy.session.maxPerUser) { const oldest = owned.shift(); t.state.sessions = t.state.sessions.filter((s) => s !== oldest); }
    t.state.sessions.push({ digest: hash(raw), userId: user.userId, epoch: user.securityEpoch, createdAt: now, lastSeenAt: now,
      absoluteExpiresAt: now + this.#policy.session.absoluteSeconds * 1000, idleExpiresAt: now + this.#policy.session.idleSeconds * 1000, mfaAt, kind: "account" });
    this.#audit(t, `account:${user.userId}`, "session-created", user.userId);
  }
  #revokeUser(state: AccountState, id: string): void { state.sessions = state.sessions.filter((s) => s.userId !== id); }
  #bump(state: AccountState, user: Member): void { if (user.version >= Number.MAX_SAFE_INTEGER || user.securityEpoch >= Number.MAX_SAFE_INTEGER) throw new MemberError("conflict");
    user.version++; user.securityEpoch++; this.#revokeUser(state, user.userId); state.tokens = state.tokens.filter((t) => t.userId !== user.userId); }
  #retainAdmin(state: AccountState, current: Member, replacement: Member | undefined): void {
    const qualifies = (u: Member): boolean => u.status === "active" && u.role === "admin" && Boolean(state.passwords[u.userId]) && state.factors[u.userId]?.confirmedAt !== null && state.factors[u.userId]?.confirmedAt !== undefined;
    if (qualifies(current) && (!replacement || !qualifies(replacement)) && !state.users.some((u) => u.userId !== current.userId && qualifies(u))) throw new MemberError("last-admin");
  }
  #audit(t: AccountTransaction, actor: string, action: string, userId: string | null): void {
    t.audit.push({ id: randomUUID(), actor, action, userId, at: this.#now(), result: "committed" });
    t.retention = { notBefore: this.#now() - this.#policy.retention.auditDays * 86_400_000, maxEntries: this.#policy.retention.auditMaxEntries };
  }
  async #send(token: string, email: string, purpose: "invite" | "password-reset" | "email-change"): Promise<void> {
    const path = { invite: "/account/invite", "password-reset": "/account/reset", "email-change": "/account/email" }[purpose];
    const link = new URL(path, this.#origin); link.searchParams.set("token", token);
    try { await this.#mailer.send({ to: email, purpose, link: link.href }); }
    catch { await this.#store.transact((t) => { t.state.tokens = t.state.tokens.filter((t) => t.digest !== hash(token)); }); throw new MemberError("unavailable"); }
  }
  async #notify(to: string, event: Parameters<Dependencies["mailer"]["sendSecurityNotification"]>[0]["event"]): Promise<void> { await this.#mailer.sendSecurityNotification({ to, event }).catch(() => undefined); }
}
