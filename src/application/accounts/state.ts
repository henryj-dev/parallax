import type { Account, AccountStatus } from "../../domain/accounts.ts";
import { canonicalAccountEmail } from "../../domain/account-policy.ts";
import type { Role } from "../../security/http-authorization.ts";
import { createHash } from "node:crypto";
import { accountThrottleDropped } from "../../observability/signals.ts";

export const MEMBER_ACCOUNTS_FEATURE = "member-accounts-v1";
export type Member = { -readonly [K in keyof Account]: Account[K] } & { emailVerifiedAt: number | null; createdAt: number };
export interface Factor { encryptedSeed: string; confirmedAt: number | null; lastCounter: number; recoveryDigests: string[] }
export interface MemberSession {
  digest: string; userId: string; epoch: number; createdAt: number; lastSeenAt: number;
  absoluteExpiresAt: number; idleExpiresAt: number; mfaAt: number | null;
  kind: "account" | "legacy";
}
export interface ActionToken {
  digest: string; purpose: "invite" | "reset" | "email" | "challenge" | "enroll" | "oidc";
  userId: string | null; email: string | null; role: Role | null; epoch: number | null; expiresAt: number;
  sessionDigest: string | null; data: Record<string, string>;
}
export interface LinkedIdentity { userId: string; issuer: string; subject: string; kind: "linked" | "legacy" }
export interface MemberAudit { id: string; actor: string; action: string; userId: string | null; at: number; result: "committed" }
export type MemberThrottleKind = "login" | "mfa" | "reset";
export interface AccountState {
  format: 1; enabled: boolean; bootstrap: "empty" | "enrollment" | "ready";
  users: Member[]; passwords: Record<string, string>; factors: Record<string, Factor>;
  identities: LinkedIdentity[]; sessions: MemberSession[]; tokens: ActionToken[];
  /** Per-client counters (`kind:ip:<digest>`) and per-address counters for addresses no member has (`kind:ghost:<digest>`). */
  throttle: { key: string; count: number; expiresAt: number }[];
  /** Per-member attempt counters. One per member at most, so nothing has to be evicted to fit them. */
  memberThrottle: Record<string, Partial<Record<MemberThrottleKind, { count: number; expiresAt: number }>>>;
  settings: { legacyUntil: string | null; legacyRoleCap: "viewer" | "editor" | null; roleSource: "local"; mfaEvidence: "local-totp"; jit: { issuer: string; role: "viewer"; maxUsers: number }[] };
}
/** Audit entries older than `notBefore`, or beyond the newest `maxEntries`, are dropped when the transaction commits. */
export interface AuditRetention { notBefore: number; maxEntries: number }
/**
 * `state` is the whole document, read under the lock. `audit` starts empty in every store and holds only
 * the entries this transaction appends; the stored trail is never handed to the callback.
 */
export interface AccountTransaction { state: AccountState; audit: MemberAudit[]; retention?: AuditRetention }
/** Callback is synchronous: no hashing, mail, network or external effects under the lock. */
export interface AccountStateStore {
  transact<T>(operation: (transaction: AccountTransaction) => T): Promise<T>;
  /** The committed state without the audit trail and without writing anything. */
  read(): Promise<AccountState>;
  snapshot(): Promise<{ state: AccountState; audit: MemberAudit[] }>;
}
export function retainAudit(audit: MemberAudit[], retention: AuditRetention | undefined): MemberAudit[] {
  if (!retention) return audit;
  const kept = audit.filter((entry) => entry.at >= retention.notBefore);
  return kept.slice(Math.max(0, kept.length - retention.maxEntries));
}
export function emptyAccountState(): AccountState {
  return { format: 1, enabled: false, bootstrap: "empty", users: [], passwords: {}, factors: {}, identities: [], sessions: [], tokens: [], throttle: [], memberThrottle: {},
    settings: { legacyUntil: null, legacyRoleCap: null, roleSource: "local", mfaEvidence: "local-totp", jit: [] } };
}
function fail(): never { throw new Error("invalid account state"); }
let warnedDropped = false;
/** Documents whose dropped counters were already counted; bounded, oldest forgotten first. */
const countedDocuments = new Set<string>();
function firstSighting(digest: string): boolean {
  if (countedDocuments.has(digest)) return false;
  countedDocuments.add(digest);
  if (countedDocuments.size > 256) countedDocuments.delete(countedDocuments.values().next().value!);
  return true;
}
function obj(v: unknown, fields: string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail();
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== fields.length || fields.some((k) => !Object.hasOwn(r, k))) fail();
  return r;
}
function text(v: unknown, max = 1024): asserts v is string { if (typeof v !== "string" || !v || v.length > max || /[\x00-\x1f\x7f]/u.test(v)) fail(); }
function time(v: unknown): asserts v is number { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(); }
function digest(v: unknown): void { text(v, 43); if (!/^[A-Za-z0-9_-]{43}$/u.test(v) || Buffer.from(v, "base64url").toString("base64url") !== v) fail(); }
function role(v: unknown): asserts v is Role { if (v !== "viewer" && v !== "editor" && v !== "admin") fail(); }
function list(v: unknown): unknown[] { if (!Array.isArray(v)) fail(); return v; }
function unique(values: string[]): void { if (new Set(values).size !== values.length) fail(); }

/** Strict durable/backup parser. Never silently discard a future field. */
export function readAccountState(value: unknown): AccountState {
  // Attempt counters are transient. A document written before per-member counters existed has none.
  const withCounters = value && typeof value === "object" && !Array.isArray(value) && !("memberThrottle" in value) ? { ...value, memberThrottle: {} } : value;
  const r = obj(withCounters, ["format", "enabled", "bootstrap", "users", "passwords", "factors", "identities", "sessions", "tokens", "throttle", "memberThrottle", "settings"]);
  if (r.format !== 1 || typeof r.enabled !== "boolean" || !["empty", "enrollment", "ready"].includes(String(r.bootstrap))) fail();
  const users = list(r.users).map((value) => {
    const u = obj(value, ["userId", "canonicalLoginKey", "displayName", "role", "status", "version", "securityEpoch", "emailVerifiedAt", "createdAt"]);
    text(u.userId, 128); text(u.canonicalLoginKey, 254); if (canonicalAccountEmail(u.canonicalLoginKey) !== u.canonicalLoginKey) fail();
    text(u.displayName, 256); role(u.role); if (!["active", "suspended", "deleted"].includes(String(u.status))) fail();
    time(u.version); time(u.securityEpoch); if (u.version < 1 || u.securityEpoch < 1) fail();
    time(u.createdAt); if (u.emailVerifiedAt !== null) time(u.emailVerifiedAt);
    return { ...u } as unknown as Member;
  });
  unique(users.map((u) => u.userId)); unique(users.map((u) => u.canonicalLoginKey));
  const ids = new Set(users.map((u) => u.userId));
  const passwords: Record<string, string> = {}, factors: Record<string, Factor> = {};
  if (!r.passwords || typeof r.passwords !== "object" || Array.isArray(r.passwords)) fail();
  for (const [id, hash] of Object.entries(r.passwords)) { if (!ids.has(id)) fail(); text(hash, 2048); passwords[id] = hash; }
  if (!r.factors || typeof r.factors !== "object" || Array.isArray(r.factors)) fail();
  for (const [id, value] of Object.entries(r.factors)) {
    if (!ids.has(id)) fail();
    const f = obj(value, ["encryptedSeed", "confirmedAt", "lastCounter", "recoveryDigests"]);
    text(f.encryptedSeed, 256); if (!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(f.encryptedSeed)) fail();
    if (f.confirmedAt !== null) time(f.confirmedAt);
    if (typeof f.lastCounter !== "number" || !Number.isSafeInteger(f.lastCounter) || f.lastCounter < -1) fail();
    const recoveryDigests = list(f.recoveryDigests).map((v) => { digest(v); return v as string; }); unique(recoveryDigests);
    factors[id] = { encryptedSeed: f.encryptedSeed, confirmedAt: f.confirmedAt as number | null, lastCounter: f.lastCounter, recoveryDigests };
  }
  const identities = list(r.identities).map((value) => {
    const i = obj(value, ["userId", "issuer", "subject", "kind"]); if (i.kind !== "linked" && i.kind !== "legacy") fail(); if (!ids.has(String(i.userId))) fail(); text(i.issuer); text(i.subject);
    if (new URL(i.issuer).protocol !== "https:") fail(); return i as unknown as LinkedIdentity;
  }); unique(identities.map((i) => JSON.stringify([i.issuer, i.subject])));
  const sessions = list(r.sessions).map((value) => {
    const s = obj(value, ["digest", "userId", "epoch", "createdAt", "lastSeenAt", "absoluteExpiresAt", "idleExpiresAt", "mfaAt", "kind"]);
    digest(s.digest); if (!ids.has(String(s.userId))) fail(); time(s.epoch); time(s.createdAt); time(s.lastSeenAt); time(s.absoluteExpiresAt); time(s.idleExpiresAt);
    if (s.mfaAt !== null) time(s.mfaAt); if (!["account", "legacy"].includes(String(s.kind))) fail();
    if (s.epoch < 1 || s.lastSeenAt < s.createdAt || s.absoluteExpiresAt <= s.createdAt || s.idleExpiresAt > s.absoluteExpiresAt) fail();
    return s as unknown as MemberSession;
  }); unique(sessions.map((s) => s.digest));
  const tokens = list(r.tokens).map((value) => {
    const t = obj(value, ["digest", "purpose", "userId", "email", "role", "epoch", "expiresAt", "sessionDigest", "data"]);
    digest(t.digest); if (!["invite", "reset", "email", "challenge", "enroll", "oidc"].includes(String(t.purpose))) fail();
    if (t.userId !== null && !ids.has(String(t.userId))) fail(); if (t.email !== null && canonicalAccountEmail(String(t.email)) !== t.email) fail();
    if (t.role !== null) role(t.role); if (t.epoch !== null) time(t.epoch); time(t.expiresAt); if (t.sessionDigest !== null) digest(t.sessionDigest);
    if (!t.data || typeof t.data !== "object" || Array.isArray(t.data)) fail();
    for (const [k, v] of Object.entries(t.data)) { text(k, 128); text(v, 4096); }
    return t as unknown as ActionToken;
  }); unique(tokens.map((t) => t.digest));
  // Attempt counters are transient: an entry of an older or broken shape is dropped, never fatal, so a
  // store written by an earlier build still opens. Everything else in the document stays strict.
  // Why each entry went, so a warning names its cause: an older or broken shape, a repeated key, or a
  // counter for a member the document no longer has.
  const dropped = { shape: 0, duplicate: 0, member: 0 };
  const counter = (value: unknown): { count: number; expiresAt: number } | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const c = value as Record<string, unknown>;
    if (Object.keys(c).length !== 2 || !Number.isSafeInteger(c.count) || (c.count as number) < 0 || !Number.isSafeInteger(c.expiresAt) || (c.expiresAt as number) < 0) return undefined;
    return { count: c.count as number, expiresAt: c.expiresAt as number };
  };
  const seen = new Set<string>();
  const throttle: AccountState["throttle"] = [];
  for (const value of Array.isArray(r.throttle) ? r.throttle : []) {
    const key = value && typeof value === "object" ? (value as Record<string, unknown>).key : undefined;
    const c = counter(value && typeof value === "object" ? { count: (value as Record<string, unknown>).count, expiresAt: (value as Record<string, unknown>).expiresAt } : undefined);
    if (typeof key !== "string" || !/^(?:login|mfa|reset|token|link):(?:ip|ghost):[A-Za-z0-9_-]{43}$/u.test(key) || !c
      || Object.keys(value as object).length !== 3) { dropped.shape++; continue; }
    if (seen.has(key)) { dropped.duplicate++; continue; }
    seen.add(key); throttle.push({ key, ...c });
  }
  if (!Array.isArray(r.throttle)) dropped.shape++;
  const memberThrottle: AccountState["memberThrottle"] = {};
  const membersReadable = r.memberThrottle && typeof r.memberThrottle === "object" && !Array.isArray(r.memberThrottle);
  if (!membersReadable) dropped.shape++;
  const members = membersReadable ? r.memberThrottle as Record<string, unknown> : {};
  for (const [userId, counters] of Object.entries(members)) {
    if (!ids.has(userId)) { dropped.member++; continue; }
    if (!counters || typeof counters !== "object" || Array.isArray(counters)) { dropped.shape++; continue; }
    const entry: AccountState["memberThrottle"][string] = {};
    for (const [kind, value] of Object.entries(counters as Record<string, unknown>)) {
      const c = counter(value);
      if (!["login", "mfa", "reset"].includes(kind) || !c) { dropped.shape++; continue; }
      entry[kind as MemberThrottleKind] = c;
    }
    memberThrottle[userId] = entry;
  }
  const total = dropped.shape + dropped.duplicate + dropped.member;
  if (total > 0) {
    // Counted once per distinct document: the same stored document is read again on every request until
    // the next write rewrites it clean, and counting each read would blur a real defect signal.
    if (firstSighting(createHash("sha256").update(JSON.stringify([r.throttle, r.memberThrottle])).digest("base64url"))) {
      for (const [reason, count] of Object.entries(dropped)) if (count > 0) accountThrottleDropped({ reason }, count);
    }
    // Said once per process: the same document is read again until the next write rewrites it clean.
    if (!warnedDropped) {
      warnedDropped = true;
      console.warn(`parallax: dropped ${total} attempt-limit entr${total === 1 ? "y" : "ies"} (older or broken shape ${dropped.shape}, repeated key ${dropped.duplicate}, unknown member ${dropped.member}); those counts restart`);
    }
  }
  const settings = obj(r.settings, ["legacyUntil", "legacyRoleCap", "roleSource", "mfaEvidence", "jit"]);
  if (settings.legacyUntil !== null && (typeof settings.legacyUntil !== "string" || new Date(settings.legacyUntil).toISOString() !== settings.legacyUntil)) fail();
  if (![null, "viewer", "editor"].includes(settings.legacyRoleCap as null | string) || settings.roleSource !== "local" || settings.mfaEvidence !== "local-totp") fail();
  if ((settings.legacyUntil === null) !== (settings.legacyRoleCap === null)) fail();
  const jit = list(settings.jit).map((value) => {
    const j = obj(value, ["issuer", "role", "maxUsers"]); text(j.issuer); if (new URL(j.issuer).protocol !== "https:" || j.role !== "viewer") fail();
    time(j.maxUsers); if (j.maxUsers < 1) fail(); return j as unknown as AccountState["settings"]["jit"][number];
  }); unique(jit.map((j) => j.issuer));
  if (r.bootstrap === "empty" && users.length !== 0) fail();
  if (r.bootstrap === "ready" && !users.some((u) => u.status === "active" && u.role === "admin" && passwords[u.userId] && factors[u.userId]?.confirmedAt !== null && factors[u.userId]?.confirmedAt !== undefined)) fail();
  return structuredClone({ format: 1, enabled: r.enabled, bootstrap: r.bootstrap, users, passwords, factors, identities, sessions, tokens, throttle, memberThrottle,
    settings: { ...settings, jit } }) as AccountState;
}
export function readMemberAudit(value: unknown): MemberAudit[] {
  const entries = list(value).map((value) => {
    const a = obj(value, ["id", "actor", "action", "userId", "at", "result"]);
    text(a.id, 128); text(a.actor, 256); text(a.action, 128); if (a.userId !== null) text(a.userId, 128); time(a.at);
    if (a.result !== "committed") fail(); return a as unknown as MemberAudit;
  }); unique(entries.map((a) => a.id)); return structuredClone(entries);
}
export function activeStatus(status: AccountStatus): boolean { return status === "active"; }
