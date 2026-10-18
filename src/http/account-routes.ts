import { randomBytes } from "node:crypto";
import { AccountPolicyError } from "../domain/account-policy.ts";
import { AccountError } from "../domain/accounts.ts";
import { AccountService, MemberError } from "../application/accounts/service.ts";
import { PasswordError } from "../security/accounts/passwords.ts";
import { ACCOUNT_SESSION_COOKIE, hasSameOrigin } from "../security/http-authorization.ts";
import { cookieNameForRequest, readCookie } from "../security/cookies.ts";

const CSRF_COOKIE = "parallax_login_csrf";
const PREFIX = "/api/v1/account";
export const MEMBER_CHALLENGE_COOKIE = "parallax_member_challenge";
const CHALLENGE_ROUTES = ["/login/mfa", "/mfa/enroll", "/mfa/confirm"];
const ANONYMOUS_ROUTES = ["/login", "/invite/accept", "/password/forgot", "/password/reset"];
const mutation = (request: Request): boolean => !["GET", "HEAD", "OPTIONS"].includes(request.method);
export function accountCookie(request: Request): string | undefined { return readCookie(request.headers.get("cookie"), cookieNameForRequest(ACCOUNT_SESSION_COOKIE, request)); }
export function memberCookie(request: Request, value: string, maxAge?: number): string {
  return `${cookieNameForRequest(ACCOUNT_SESSION_COOKIE, request)}=${value}; Path=/; HttpOnly; SameSite=Lax${new URL(request.url).protocol === "https:" ? "; Secure" : ""}${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}`;
}
/** `maxAge` undefined: a browser-session cookie, gone when the browser closes; the server's expiry still rules. */
export function challengeCookie(request: Request, value: string, maxAge?: number): string {
  return `${cookieNameForRequest(MEMBER_CHALLENGE_COOKIE, request)}=${value}; Path=/; HttpOnly; SameSite=Strict${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
function json(value: unknown, status = 200, cookie?: string | string[]): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" }); for (const c of typeof cookie === "string" ? [cookie] : cookie ?? []) headers.append("set-cookie", c);
  return new Response(JSON.stringify(value), { status, headers });
}
/** A missing, ended or revoked session, answered the way the rest of the API answers it. */
class SessionRequired extends Error {}
function errorResponse(error: unknown): Response {
  if (error instanceof SessionRequired) return json({ error: "unauthorized", message: "authentication required" }, 401);
  if (error instanceof AccountError && ["version-conflict", "last-admin", "duplicate-login-key", "duplicate-id"].includes(error.code)) return json({ error: "conflict" }, 409);
  if (error instanceof MemberError && error.code === "rate-limited") {
    const response = json({ error: error.code }, 429);
    if (error.retryAfterSeconds !== undefined) response.headers.set("retry-after", String(error.retryAfterSeconds));
    return response;
  }
  if (error instanceof MemberError) return json({ error: error.code }, error.code === "unavailable" ? 503 : ["conflict", "last-admin"].includes(error.code) ? 409 : ["invalid-input", "weak-password"].includes(error.code) ? 400 : 403);
  // A hash beyond the verify limits, a full queue, or an abort is the service failing, never a wrong password.
  if (error instanceof PasswordError) return error.code === "invalid-password" ? json({ error: "invalid-input" }, 400) : json({ error: "unavailable" }, 503);
  if (error instanceof AccountError || error instanceof AccountPolicyError || error instanceof SyntaxError) return json({ error: "invalid-input" }, 400);
  return json({ error: "authentication_unavailable" }, 503);
}
async function body(request: Request): Promise<Record<string, unknown>> {
  // 64 KiB: the bound on a request body here, and so on a password. The policy's maxBytes matches it.
  const bytes = await request.arrayBuffer(); if (bytes.byteLength > 65536) throw new MemberError("invalid-input");
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MemberError("invalid-input"); return value as Record<string, unknown>;
}
function text(b: Record<string, unknown>, key: string): string { const v = b[key]; if (typeof v !== "string") throw new MemberError("invalid-input"); return v; }

/** Runs before the ordinary DNS authorization wrapper, including for /cli and session mutations. */
export function createAccountRoutes(service: AccountService, clientKey: (request: Request) => string): {
  handle(request: Request): Promise<Response | undefined>;
  guard(request: Request): Promise<Response | undefined>;
} {
  const authenticated = async (token: string | undefined): Promise<Awaited<ReturnType<AccountService["context"]>>> => {
    try { return await service.context(token ?? ""); }
    catch (error) { if (error instanceof MemberError && (error.code === "denied" || error.code === "not-enabled")) throw new SessionRequired(); throw error; }
  };
  const guard = async (request: Request): Promise<Response | undefined> => {
    if (!mutation(request)) return undefined;
    const token = accountCookie(request); if (!token || request.headers.has("authorization")) return undefined;
    try {
      const c = await authenticated(token);
      if (!hasSameOrigin(request) || !service.validCsrf(c.session.digest, request.headers.get("x-parallax-csrf") ?? "")) return json({ error: "csrf_rejected" }, 403);
      // The fresh-code rule for administration writes is decided once, in the authorization layer.
      return undefined;
    } catch (error) { return errorResponse(error); }
  };
  const handle = async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname; if (!path.startsWith(`${PREFIX}/`)) return undefined;
    try {
      const leaf = path.slice(PREFIX.length), token = accountCookie(request), actor = { token: token ?? "" };
      const ip = clientKey(request);
      if (leaf === "/csrf" && request.method === "GET") {
        const nonce = randomBytes(32).toString("base64url");
        return json({ csrf: service.csrf(nonce) }, 200, `${cookieNameForRequest(CSRF_COOKIE, request)}=${nonce}; Path=/; HttpOnly; SameSite=Strict${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`);
      }
      const b = request.method === "POST" ? await body(request) : {};
      const challengeRoute = CHALLENGE_ROUTES.includes(leaf);
      const challenge = !challengeRoute ? undefined : typeof b.challenge === "string" ? b.challenge
        : readCookie(request.headers.get("cookie"), cookieNameForRequest(MEMBER_CHALLENGE_COOKIE, request));
      const anonymous = ANONYMOUS_ROUTES.includes(leaf) || challenge !== undefined;
      if (request.headers.has("authorization")) return json({ error: "csrf_rejected" }, 403);
      // Every route that needs a member checks the session first, so an ended one is 401 on reads and writes alike.
      const session = anonymous ? undefined : await authenticated(token);
      if (mutation(request)) {
        if (!hasSameOrigin(request)) return json({ error: "csrf_rejected" }, 403);
        // Anonymous steps are bound to the login nonce, never to whatever session cookie the browser still carries.
        const csrfNonce = anonymous ? readCookie(request.headers.get("cookie"), cookieNameForRequest(CSRF_COOKIE, request)) : session!.session.digest;
        if (!csrfNonce || !service.validCsrf(csrfNonce, request.headers.get("x-parallax-csrf") ?? "")) return json({ error: "csrf_rejected" }, 403);
      }
      if (leaf === "/me" && request.method === "GET") {
        const c = session!;
        const { securityEpoch: _epoch, ...user } = c.user;
        return json({ user, csrf: c.csrf, recentMfa: c.recentMfa, mfaEnrolled: c.mfaEnrolled, sessionKind: c.session.kind });
      }
      if (leaf === "/identities" && request.method === "GET") return json(await service.identities(actor));
      if (leaf === "/sessions" && request.method === "GET") return json(await service.sessions(actor));
      if (leaf === "/members" && request.method === "GET") return json(await service.listMembers(actor));
      if (leaf === "/identities/policy" && request.method === "GET") return json(await service.identityPolicy(actor));
      if (request.method !== "POST") return json({ error: "not-found" }, 404);
      if (leaf === "/login") {
        const result = await service.login(text(b, "email"), text(b, "password"), ip);
        // The challenge stays in an HttpOnly cookie so page script never holds it.
        return "token" in result ? json({ csrf: result.csrf }, 200, [memberCookie(request, result.token), challengeCookie(request, "", 0)])
          : json({ mfaRequired: true, enrollmentRequired: result.enrollmentRequired }, 200, challengeCookie(request, result.challenge, result.enrollmentRequired ? undefined : service.challengeSeconds));
      }
      if (leaf === "/login/mfa") {
        const result = await service.completeMfa(challenge ?? "", text(b, "otp"), ip);
        // A recovery code retires the factor: the answer is a new enrollment challenge, not a session.
        return "token" in result ? json({ csrf: result.csrf }, 200, [memberCookie(request, result.token), challengeCookie(request, "", 0)])
          : json({ mfaRequired: true, enrollmentRequired: true }, 200, challengeCookie(request, result.challenge));
      }
      if (leaf === "/mfa/enroll") return json(await service.beginEnrollment(challenge !== undefined ? { challenge } : { actor, password: text(b, "password"), ip }));
      if (leaf === "/mfa/confirm") {
        const result = await service.confirmEnrollment({ ...(challenge !== undefined ? { challenge } : { actor }), otp: text(b, "otp"), ip });
        return json({ csrf: result.csrf, recoveryCodes: result.recoveryCodes }, 200, [memberCookie(request, result.token), challengeCookie(request, "", 0)]);
      }
      if (leaf === "/reauthenticate") { await service.reauthenticate(actor, text(b, "otp"), ip); return json({ ok: true }); }
      if (leaf === "/logout") { await service.revoke(actor.token); return json({ ok: true }, 200, memberCookie(request, "", 0)); }
      if (leaf === "/sessions/revoke") {
        if (b.createdAt !== undefined && (typeof b.createdAt !== "number" || !Number.isSafeInteger(b.createdAt))) throw new MemberError("invalid-input");
        await service.revokeSessions(actor, b.createdAt as number | undefined);
        // Ending every session, or this one, leaves this browser holding a dead cookie unless it is cleared here.
        const endsThisOne = b.createdAt === undefined || b.createdAt === session!.session.createdAt;
        return json({ ok: true }, 200, endsThisOne ? memberCookie(request, "", 0) : undefined);
      }
      if (leaf === "/delete") { await service.deleteSelf(actor, text(b, "password"), ip); return json({ ok: true }, 200, memberCookie(request, "", 0)); }
      if (leaf === "/password/change") { await service.changePassword(actor, text(b, "currentPassword"), text(b, "password"), ip); return json({ ok: true }, 200, memberCookie(request, "", 0)); }
      if (leaf === "/password/forgot") { await service.requestPasswordReset(text(b, "email"), ip); return json({ ok: true }); }
      if (leaf === "/password/reset") { await service.resetPassword(text(b, "token"), text(b, "password"), ip); return json({ ok: true }); }
      if (leaf === "/email/request") { await service.requestEmailChange(actor, text(b, "email")); return json({ ok: true }); }
      if (leaf === "/email/confirm") { await service.confirmEmailChange(actor, text(b, "token")); return json({ ok: true }, 200, memberCookie(request, "", 0)); }
      if (leaf === "/invite/accept") { await service.acceptInvite(text(b, "token"), text(b, "email"), text(b, "password"), text(b, "displayName"), ip); return json({ ok: true }); }
      if (leaf === "/members/invite") { const role = text(b, "role"); if (role !== "admin" && role !== "editor" && role !== "viewer") throw new MemberError("invalid-input"); await service.invite(actor, text(b, "email"), role); return json({ ok: true }); }
      if (leaf === "/members/change") {
        const role = b.role, status = b.status;
        if ((role !== undefined && role !== "admin" && role !== "editor" && role !== "viewer") || (status !== undefined && status !== "active" && status !== "suspended" && status !== "deleted") || typeof b.version !== "number" || !Number.isSafeInteger(b.version) || role === undefined && status === undefined) throw new MemberError("invalid-input");
        return json(await service.changeMember(actor, text(b, "userId"), b.version, { ...(role ? { role } : {}), ...(status ? { status } : {}) }));
      }
      if (leaf === "/mfa/recovery") return json({ recoveryCodes: await service.regenerateRecoveryCodes(actor) });
      if (leaf === "/identities/unlink") { await service.unlinkIdentity(actor, text(b, "issuer"), text(b, "subject")); return json({ ok: true }, 200, memberCookie(request, "", 0)); }
      if (leaf === "/identities/policy") {
        if (!Array.isArray(b.jit)) throw new MemberError("invalid-input");
        await service.configureIdentity(actor, { roleSource: text(b, "roleSource"), mfaEvidence: text(b, "mfaEvidence"), jit: b.jit }); return json({ ok: true });
      }
      return json({ error: "not-found" }, 404);
    } catch (error) { return errorResponse(error); }
  };
  return { handle, guard };
}
