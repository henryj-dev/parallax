import { createHash, randomBytes } from "node:crypto";
import type { OidcSettings } from "../config.ts";
import { AccountService, MemberError } from "../application/accounts/service.ts";
import { OidcVerifier, assertUserinfoSubject, readVerifiedOidcEmail, type OidcVerificationPolicy } from "../security/accounts/oidc-verifier.ts";
import { LEGACY_ROLE_CLAIM, readLegacyRole } from "../security/oidc.ts";
import { cookieNameForRequest, readCookie } from "../security/cookies.ts";
import { hasSameOrigin, trustedClientKey } from "../security/http-authorization.ts";
import { accountCookie, challengeCookie, memberCookie } from "./account-routes.ts";

const STATE_COOKIE = "parallax_member_oidc_state";
const BODY_LIMIT = 65536;
interface Endpoints { authorization: string; token: string; userinfo?: string; logout?: string }
interface Options {
  readonly service: AccountService; readonly settings: OidcSettings; readonly policy: OidcVerificationPolicy;
  readonly fetchImpl?: typeof fetch; readonly now?: () => number;
  /** The transport's client address, for the per-address limit on starting a sign-in. */
  readonly clientKey?: (request: Request) => string;
}
function cookie(request: Request, base: string, value: string, age: number): string {
  return `${cookieNameForRequest(base, request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" }); for (const c of cookies) headers.append("set-cookie", c); return new Response(null, { status: 302, headers });
}
/**
 * Page script cannot read where a cross-origin redirect points (a manual redirect is opaque), so a
 * fetch that asks for JSON gets the location in the body and navigates itself.
 */
function wantsJson(request: Request): boolean { return (request.headers.get("accept") ?? "").includes("application/json"); }
/** Names only a provider logout; with none, the page stays and shows sign-in rather than being sent anywhere. */
function located(request: Request, location: string | undefined, cookies: string[]): Response {
  if (!wantsJson(request)) return redirect(location ?? "/account/login", cookies);
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" }); for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(location ? { location } : {}), { status: 200, headers });
}

/** Accounts mode has no discovery fallback and never accepts an unverified ID token. */
export function createAccountIdentityHandler(options: Options): (request: Request) => Promise<Response | undefined> {
  const { service, settings, policy } = options, fetchImpl = options.fetchImpl ?? fetch, now = options.now ?? Date.now;
  const clientKey = options.clientKey ?? trustedClientKey;
  let verifier: Promise<OidcVerifier> | undefined;
  /** Bytes are counted as they arrive and the deadline covers the body, not only the headers. */
  const boundedFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const signal = AbortSignal.timeout(policy.timeoutMs);
    const response = await fetchImpl(url, { ...init, redirect: "error", signal });
    const declared = response.headers.get("content-length");
    if (!response.ok || declared !== null && !(/^[0-9]{1,6}$/u.test(declared) && Number(declared) <= BODY_LIMIT) || !response.body) { await response.body?.cancel().catch(() => undefined); throw new MemberError("unavailable"); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const aborted = (): void => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", aborted, { once: true });
    try {
      while (true) { if (signal.aborted) throw new MemberError("unavailable"); const part = await reader.read(); if (signal.aborted) throw new MemberError("unavailable");
        if (part.done) break; size += part.value.byteLength; if (size > BODY_LIMIT) throw new MemberError("unavailable"); chunks.push(part.value); }
      return new Response(Buffer.concat(chunks), { headers: { "content-type": "application/json" } });
    } finally { signal.removeEventListener("abort", aborted); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  };
  const discover = async (): Promise<Endpoints> => {
    if (policy.issuer !== settings.issuer || policy.clientId !== settings.clientId) throw new MemberError("invalid-input");
    const doc = JSON.parse(await (await boundedFetch(`${settings.issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`)).text()) as Record<string, unknown>;
    if (doc.issuer !== settings.issuer) throw new MemberError("unavailable");
    const endpoint = (v: unknown): string => { if (typeof v !== "string") throw new MemberError("unavailable"); const u = new URL(v);
      if (u.protocol !== "https:" || u.username || u.password || u.hash || u.origin !== new URL(settings.issuer).origin) throw new MemberError("unavailable"); return u.href; };
    return { authorization: endpoint(doc.authorization_endpoint), token: endpoint(doc.token_endpoint),
      ...(doc.userinfo_endpoint ? { userinfo: endpoint(doc.userinfo_endpoint) } : {}), ...(doc.end_session_endpoint ? { logout: endpoint(doc.end_session_endpoint) } : {}) };
  };
  // Kept for the verifier's own key-cache age, so starting a sign-in does not fetch discovery every time. A failure is not kept.
  let discovered: { at: number; endpoints: Promise<Endpoints> } | undefined;
  const endpoints = (): Promise<Endpoints> => {
    const at = now();
    if (discovered && at - discovered.at < policy.cacheMaxAgeMs) return discovered.endpoints;
    const pending: Promise<Endpoints> = discover().catch((error: unknown) => { if (discovered?.endpoints === pending) discovered = undefined; throw error; });
    discovered = { at, endpoints: pending };
    return pending;
  };
  return async (request) => {
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/u, "");
    if (!["/auth/login", "/auth/link", "/auth/callback", "/auth/logout"].includes(path)) return undefined;
    try {
      if (path === "/auth/login" || path === "/auth/link") {
        const linking = path === "/auth/link";
        if (request.method !== (linking ? "POST" : "GET")) return new Response(null, { status: 405 });
        const actorToken = accountCookie(request);
        if (linking) { const c = await service.context(actorToken ?? ""); if (!hasSameOrigin(request) || request.headers.has("authorization")
          || !service.validCsrf(c.session.digest, request.headers.get("x-parallax-csrf") ?? "")) throw new MemberError("denied"); }
        const e = await endpoints(), state = randomBytes(32).toString("base64url"), pkce = randomBytes(32).toString("base64url"), nonce = randomBytes(32).toString("base64url");
        await service.beginOidc({ issuer: settings.issuer, purpose: linking ? "link" : "login", ...(actorToken && linking ? { actor: { token: actorToken } } : {}), verifier: pkce, nonce, state, ip: clientKey(request) });
        const target = new URL(e.authorization); for (const [k, v] of Object.entries({ response_type: "code", client_id: settings.clientId, redirect_uri: settings.redirectUri,
          scope: settings.scopes, state, nonce, code_challenge: createHash("sha256").update(pkce).digest("base64url"), code_challenge_method: "S256" })) target.searchParams.set(k, v);
        return linking ? Response.json({ url: target.href }, { headers: { "cache-control": "no-store", "set-cookie": cookie(request, STATE_COOKIE, state, service.challengeSeconds) } })
          : redirect(target.href, [cookie(request, STATE_COOKIE, state, service.challengeSeconds)]);
      }
      if (path === "/auth/callback") {
        if (request.method !== "GET") return new Response(null, { status: 405 });
        const state = url.searchParams.get("state"), code = url.searchParams.get("code"), expected = readCookie(request.headers.get("cookie"), cookieNameForRequest(STATE_COOKIE, request));
        if (!state || !code || state !== expected || code.length > 8192 || url.searchParams.has("error")) throw new MemberError("denied");
        const actorToken = accountCookie(request), handshake = await service.consumeOidcState(state, actorToken), e = await endpoints();
        const response = await boundedFetch(e.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
          grant_type: "authorization_code", code, redirect_uri: settings.redirectUri, client_id: settings.clientId, client_secret: settings.clientSecret, code_verifier: handshake.verifier }) });
        const tokens = JSON.parse(await response.text()) as Record<string, unknown>; if (typeof tokens.id_token !== "string") throw new MemberError("denied");
        verifier ??= OidcVerifier.create(policy, { fetchImpl }).catch((error: unknown) => { verifier = undefined; throw error; });
        const identity = await (await verifier).verify(tokens.id_token, handshake.nonce, now());
        // During the legacy window the role is read the way legacy sign-in reads it: from userinfo whose
        // subject matches the signed ID token, by the configured claim, string or list, highest role wins.
        let legacyRole: ReturnType<typeof readLegacyRole>;
        if (handshake.purpose === "login" && await service.legacyWindowOpen() && e.userinfo && typeof tokens.access_token === "string") {
          const info: unknown = JSON.parse(await (await boundedFetch(e.userinfo, { headers: { authorization: `Bearer ${tokens.access_token}` } })).text());
          assertUserinfoSubject(identity, info);
          legacyRole = readLegacyRole((info as Record<string, unknown>)[settings.roleClaim ?? LEGACY_ROLE_CLAIM]);
        }
        const verifiedEmail = readVerifiedOidcEmail(identity);
        const result = await service.finishOidc({ issuer: identity.issuer, subject: identity.subject, ...(verifiedEmail ? { verifiedEmail } : {}), ...(legacyRole ? { legacyRole } : {}), state: handshake, ...(actorToken ? { actorToken } : {}) });
        const cleared = cookie(request, STATE_COOKIE, "", 0);
        if ("linked" in result) return redirect("/account", [cleared]);
        if ("challenge" in result) return redirect(`/account/login?mfa=${result.enrollmentRequired ? "enroll" : "required"}`,
          [cleared, challengeCookie(request, result.challenge, result.enrollmentRequired ? undefined : service.challengeSeconds)]);
        return redirect("/", [cleared, challengeCookie(request, "", 0), memberCookie(request, result.token)]);
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const token = accountCookie(request), c = await service.context(token ?? "");
      if (!hasSameOrigin(request) || request.headers.has("authorization") || !service.validCsrf(c.session.digest, request.headers.get("x-parallax-csrf") ?? "")) throw new MemberError("denied");
      await service.revoke(token!);
      // Local revocation must succeed first; provider availability never undoes it.
      let location: string | undefined;
      try { const e = await endpoints(); if (e.logout) { const target = new URL(e.logout); target.searchParams.set("post_logout_redirect_uri", new URL("/", settings.redirectUri).href); location = target.href; } } catch { /* Local logout is already committed. */ }
      return located(request, location, [memberCookie(request, "", 0)]);
    } catch (error) {
      const status = error instanceof MemberError && error.code === "unavailable" ? 503 : error instanceof MemberError && error.code === "rate-limited" ? 429 : 403;
      const headers = new Headers({ "cache-control": "no-store" });
      if (error instanceof MemberError && error.retryAfterSeconds !== undefined) headers.set("retry-after", String(error.retryAfterSeconds));
      return Response.json({ error: error instanceof MemberError ? error.code : "identity_authentication_failed" }, { status, headers });
    }
  };
}
