import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { before, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { ControlPlane } from "../../src/application/control-plane.ts";
import type { OidcSettings } from "../../src/config.ts";
import { createAccountIdentityHandler } from "../../src/http/account-identity-routes.ts";
import { createApiHandler } from "../../src/http/api.ts";
import { InMemoryAccountStateStore } from "../../src/infrastructure/account-state.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";
import type { OidcVerificationPolicy } from "../../src/security/accounts/oidc-verifier.ts";
import { assertStorableCookies } from "../support/cookies.ts";
import { accountFixture, enrolledAdministrator } from "../support/accounts.ts";

const ORIGIN = "https://dns.example.com";
const ISSUER = "https://idp.example.com";
const CLIENT = "parallax-client";
const SETTINGS: OidcSettings = {
  issuer: ISSUER, clientId: CLIENT, clientSecret: "client-secret-for-tests", redirectUri: `${ORIGIN}/auth/callback`, scopes: "openid email",
  sessionSecret: "s".repeat(32), sessionMaxAgeSeconds: 3600,
};
const POLICY: OidcVerificationPolicy = { issuer: ISSUER, clientId: CLIENT, algorithms: ["RS256"], timeoutMs: 1000, cooldownMs: 1000,
  cacheMaxAgeMs: 60000, maxTokenAgeSeconds: 300, clockToleranceSeconds: 0 };

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let key: SigningKey;
let otherKey: SigningKey;
let jwk: Record<string, unknown>;
before(async () => {
  const pair = await generateKeyPair("RS256"); key = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  jwk = { ...await exportJWK(pair.publicKey), kid: "k1", alg: "RS256", use: "sig" };
});

/**
 * An identity provider that checks what a real one checks: the code is
 * one-use, bound to the redirect URI, the client and the PKCE challenge, and
 * the ID token it signs carries the nonce the authorization request named.
 */
class FakeProvider {
  readonly codes = new Map<string, { challenge: string; nonce: string; redirect: string; claims: JWTPayload; signWith?: SigningKey; nonceOverride?: string; userinfo?: Record<string, unknown> }>();
  readonly access = new Map<string, Record<string, unknown>>();
  /** Whether discovery publishes an end-session endpoint. */
  endSession = true;
  now: () => number;
  constructor(now: () => number) { this.now = now; }
  authorize(location: string, claims: JWTPayload, options: { signWith?: SigningKey; nonceOverride?: string; userinfo?: Record<string, unknown> } = {}): { state: string; code: string } {
    const url = new URL(location);
    assert.equal(url.origin + url.pathname, `${ISSUER}/authorize`);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("client_id"), CLIENT);
    const code = randomBytes(16).toString("base64url");
    this.codes.set(code, { challenge: url.searchParams.get("code_challenge")!, nonce: url.searchParams.get("nonce")!, redirect: url.searchParams.get("redirect_uri")!, claims, ...options });
    return { state: url.searchParams.get("state")!, code };
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, userinfo_endpoint: `${ISSUER}/userinfo`, ...(this.endSession ? { end_session_endpoint: `${ISSUER}/logout` } : {}), jwks_uri: `${ISSUER}/jwks` });
    }
    if (url === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
    if (url === `${ISSUER}/userinfo`) {
      const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /u, "") ?? "";
      const info = this.access.get(bearer);
      return info ? Response.json(info) : Response.json({ error: "invalid_token" }, { status: 401 });
    }
    if (url === `${ISSUER}/token`) {
      const form = new URLSearchParams(String(init?.body));
      const grant = this.codes.get(form.get("code") ?? ""); this.codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (!grant || form.get("client_id") !== CLIENT || form.get("redirect_uri") !== grant.redirect
        || createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const seconds = Math.floor(this.now() / 1000);
      const idToken = await new SignJWT({ iss: ISSUER, aud: CLIENT, iat: seconds - 1, exp: seconds + 300, nonce: grant.nonceOverride ?? grant.nonce, ...grant.claims })
        .setProtectedHeader({ alg: "RS256", kid: "k1" }).sign(grant.signWith ?? key);
      const accessToken = randomBytes(16).toString("base64url");
      this.access.set(accessToken, grant.userinfo ?? { sub: grant.claims.sub });
      return Response.json({ id_token: idToken, access_token: accessToken, token_type: "Bearer" });
    }
    throw new Error(`unexpected provider request ${url}`);
  };
}

class Browser {
  readonly cookies = new Map<string, string>();
  csrf = "";
  readonly handler: (request: Request) => Promise<Response>;
  constructor(handler: (request: Request) => Promise<Response>) { this.handler = handler; }
  async send(method: string, path: string, options: { body?: unknown; csrf?: boolean; accept?: string } = {}): Promise<Response> {
    const headers = new Headers({ origin: ORIGIN, ...(options.accept ? { accept: options.accept } : {}) });
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    if (options.csrf !== false && this.csrf && method !== "GET") headers.set("x-parallax-csrf", this.csrf);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.handler(new Request(`${ORIGIN}${path}`, { method, headers, redirect: "manual", ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }));
    assertStorableCookies(response.headers.getSetCookie(), `${method} ${path}`);
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";"); const index = pair!.indexOf("=");
      const name = pair!.slice(0, index), value = pair!.slice(index + 1);
      if (/Max-Age=0/u.test(line) || value === "") this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return response;
  }
}

async function deployment() {
  const store = new InMemoryAccountStateStore();
  const f = accountFixture(store);
  const service = await f.create();
  const admin = await enrolledAdministrator(service, f);
  const idp = new FakeProvider(f.now);
  const adapters = createInMemoryAdapters();
  const api = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), accounts: service },
    { enabled: true, tokens: [], accountSessions: service, disableTokenExchange: true });
  const identity = createAccountIdentityHandler({ service, settings: SETTINGS, policy: POLICY, fetchImpl: idp.fetch, now: f.now });
  const handler = async (request: Request): Promise<Response> => (await identity(request)) ?? api(request);
  return { store, f, service, admin, idp, handler };
}

async function adminSession(browser: Browser, f: ReturnType<typeof accountFixture>, secret: string): Promise<void> {
  browser.csrf = (await (await browser.send("GET", "/api/v1/account/csrf")).json() as { csrf: string }).csrf;
  await browser.send("POST", "/api/v1/account/login", { body: { email: "admin@example.com", password: "test-password-1" } });
  f.advance();
  const done = await browser.send("POST", "/api/v1/account/login/mfa", { body: { otp: f.otp(secret) } });
  browser.csrf = (await done.json() as { csrf: string }).csrf;
}

/** Runs a provider sign-in from `/auth/login` to the callback. */
async function ssoLogin(browser: Browser, idp: FakeProvider, claims: JWTPayload, options: Parameters<FakeProvider["authorize"]>[2] = {}): Promise<Response> {
  const start = await browser.send("GET", "/auth/login");
  assert.equal(start.status, 302);
  const { state, code } = idp.authorize(start.headers.get("location")!, claims, options);
  return browser.send("GET", `/auth/callback?state=${state}&code=${code}`);
}

describe("organization sign-in for member accounts", () => {
  it("never links or admits by email: an unlinked subject is refused even when its verified address belongs to a member", async () => {
    const { idp, handler } = await deployment();
    const response = await ssoLogin(new Browser(handler), idp, { sub: "stranger", email: "admin@example.com", email_verified: true });
    assert.equal(response.status, 403);
  });

  it("links a provider account from a freshly verified session, then signs in through it with a local code still required", async () => {
    const { f, admin, idp, handler } = await deployment();
    const browser = new Browser(handler);
    await adminSession(browser, f, admin.secret);
    const link = await browser.send("POST", "/auth/link");
    assert.equal(link.status, 200);
    const { state, code } = idp.authorize((await link.json() as { url: string }).url, { sub: "admin-at-idp" });
    const linked = await browser.send("GET", `/auth/callback?state=${state}&code=${code}`);
    assert.equal(linked.status, 302); assert.equal(linked.headers.get("location"), "/account");
    assert.deepEqual(await (await browser.send("GET", "/api/v1/account/identities")).json(), [{ issuer: ISSUER, subject: "admin-at-idp", kind: "linked" }]);

    const fresh = new Browser(handler);
    const callback = await ssoLogin(fresh, idp, { sub: "admin-at-idp" });
    assert.equal(callback.status, 302); assert.equal(callback.headers.get("location"), "/account/login?mfa=required");
    assert.equal(fresh.cookies.has("__Host-parallax_account"), false, "an administrator gets no session from the provider alone");
    fresh.csrf = (await (await fresh.send("GET", "/api/v1/account/csrf")).json() as { csrf: string }).csrf;
    f.advance();
    const done = await fresh.send("POST", "/api/v1/account/login/mfa", { body: { otp: f.otp(admin.secret) } });
    assert.equal(done.status, 200);
    assert.ok(fresh.cookies.has("__Host-parallax_account"));
  });

  it("refuses a wrong signature, a wrong nonce, a replayed callback, a foreign state and a broken PKCE exchange", async () => {
    const { f, admin, idp, handler } = await deployment();
    const owner = new Browser(handler);
    await adminSession(owner, f, admin.secret);
    const link = await owner.send("POST", "/auth/link");
    const grant = idp.authorize((await link.json() as { url: string }).url, { sub: "admin-at-idp" });
    await owner.send("GET", `/auth/callback?state=${grant.state}&code=${grant.code}`);

    assert.equal((await ssoLogin(new Browser(handler), idp, { sub: "admin-at-idp" }, { signWith: otherKey })).status, 403);
    assert.equal((await ssoLogin(new Browser(handler), idp, { sub: "admin-at-idp" }, { nonceOverride: "someone-elses-nonce" })).status, 403);

    const browser = new Browser(handler);
    const start = await browser.send("GET", "/auth/login");
    const replayed = idp.authorize(start.headers.get("location")!, { sub: "admin-at-idp" });
    assert.equal((await browser.send("GET", `/auth/callback?state=${replayed.state}&code=${replayed.code}`)).status, 302);
    const again = idp.authorize(start.headers.get("location")!, { sub: "admin-at-idp" });
    assert.equal((await browser.send("GET", `/auth/callback?state=${replayed.state}&code=${again.code}`)).status, 403, "a state is consumed once");

    const victim = new Browser(handler), attacker = new Browser(handler);
    const victimStart = await victim.send("GET", "/auth/login");
    await attacker.send("GET", "/auth/login");
    const stolen = idp.authorize(victimStart.headers.get("location")!, { sub: "admin-at-idp" });
    assert.equal((await attacker.send("GET", `/auth/callback?state=${stolen.state}&code=${stolen.code}`)).status, 403, "a state is bound to the browser that started it");

    const pkce = new Browser(handler);
    const pkceStart = await pkce.send("GET", "/auth/login");
    const tampered = new URL(pkceStart.headers.get("location")!); tampered.searchParams.set("code_challenge", "A".repeat(43));
    const broken = idp.authorize(tampered.href, { sub: "admin-at-idp" });
    assert.equal((await pkce.send("GET", `/auth/callback?state=${broken.state}&code=${broken.code}`)).status, 503);
  });

  it("admits a first sign-in only where an administrator opted in, as viewer, within the cap, and never onto an address in use", async () => {
    const { f, admin, idp, handler } = await deployment();
    const browser = new Browser(handler);
    await adminSession(browser, f, admin.secret);
    assert.equal((await browser.send("POST", "/api/v1/account/identities/policy", { body: { roleSource: "local", mfaEvidence: "local-totp", jit: [{ issuer: ISSUER, role: "viewer", maxUsers: 1 }] } })).status, 200);

    assert.equal((await ssoLogin(new Browser(handler), idp, { sub: "unverified", email: "u@example.com", email_verified: false })).status, 403);
    assert.equal((await ssoLogin(new Browser(handler), idp, { sub: "collides", email: "ADMIN@example.com", email_verified: true })).status, 403);
    const newcomer = new Browser(handler);
    const admitted = await ssoLogin(newcomer, idp, { sub: "newcomer", email: "new@example.com", email_verified: true, entitlements: ["admin"] });
    assert.equal(admitted.status, 302); assert.equal(admitted.headers.get("location"), "/");
    const me = await (await newcomer.send("GET", "/api/v1/account/me")).json() as { user: { role: string; canonicalLoginKey: string } };
    assert.deepEqual([me.user.role, me.user.canonicalLoginKey], ["viewer", "new@example.com"]);
    assert.equal((await ssoLogin(new Browser(handler), idp, { sub: "second", email: "second@example.com", email_verified: true })).status, 403, "the cap holds");
  });

  it("runs the temporary legacy sign-in only inside its window, reading the role the way legacy sign-in does, and never as a local account", async () => {
    const { f, service, idp, handler } = await deployment();
    await service.setLegacyHost(new Date(f.now() + 600_000).toISOString(), "editor");
    assert.equal((await ssoLogin(new Browser(handler), idp, { sub: "old-user" }, { userinfo: { sub: "old-user" } })).status, 403, "no grant, no legacy sign-in");
    assert.equal((await ssoLogin(new Browser(handler), idp, { sub: "old-user" }, { userinfo: { sub: "someone-else", entitlements: ["admin"] } })).status, 403,
      "userinfo must describe the subject the signed ID token names");
    // The ID token's own claim is not where legacy sign-in reads a role.
    assert.equal((await ssoLogin(new Browser(handler), idp, { sub: "old-user", entitlements: ["admin"] }, { userinfo: { sub: "old-user" } })).status, 403);
    const legacy = new Browser(handler);
    // A single string, in any case, as legacy sign-in accepts it; no email is needed.
    const response = await ssoLogin(legacy, idp, { sub: "old-user" }, { userinfo: { sub: "old-user", entitlements: "ADMIN" } });
    assert.equal(response.status, 302);
    const me = await (await legacy.send("GET", "/api/v1/account/me")).json() as { user: { role: string; canonicalLoginKey: string }; sessionKind: string; csrf: string };
    assert.deepEqual([me.user.role, me.sessionKind], ["editor", "legacy"]);
    assert.match(me.user.canonicalLoginKey, /@legacy\.invalid$/u, "a legacy sign-in holds no real address");
    legacy.csrf = me.csrf;
    assert.equal((await legacy.send("POST", "/api/v1/account/sessions/revoke", { body: {} })).status, 403, "legacy sessions cannot do sensitive work");
    assert.equal((await legacy.send("POST", "/api/v1/account/mfa/enroll", { body: { password: "anything-at-all" } })).status, 403, "nor attach a factor");
    // No local credential can be obtained: there is no password to reset and no address to reset it at.
    const anon = new Browser(handler);
    anon.csrf = (await (await anon.send("GET", "/api/v1/account/csrf")).json() as { csrf: string }).csrf;
    assert.equal((await anon.send("POST", "/api/v1/account/password/forgot", { body: { email: me.user.canonicalLoginKey } })).status, 200);
    assert.equal(f.messages.filter((m) => m.purpose === "password-reset").length, 0, "no reset link exists for a legacy sign-in");
    f.advance(601_000);
    assert.equal((await legacy.send("GET", "/api/v1/account/me")).status, 401, "the window's end applies to sessions already issued");
    assert.equal((await ssoLogin(new Browser(handler), idp, { sub: "old-user" }, { userinfo: { sub: "old-user", entitlements: ["editor"] } })).status, 403, "and to new sign-ins");
  });

  it("folds a legacy sign-in into the invited account that links the same provider account", async () => {
    const { f, service, admin, idp, handler } = await deployment();
    await service.setLegacyHost(new Date(f.now() + 600_000).toISOString(), "viewer");
    const legacy = new Browser(handler);
    await ssoLogin(legacy, idp, { sub: "moving-user" }, { userinfo: { sub: "moving-user", entitlements: ["viewer"] } });
    assert.equal((await legacy.send("GET", "/api/v1/account/me")).status, 200);
    const owner = new Browser(handler);
    await adminSession(owner, f, admin.secret);
    const link = await owner.send("POST", "/auth/link");
    const grant = idp.authorize((await link.json() as { url: string }).url, { sub: "moving-user" });
    assert.equal((await owner.send("GET", `/auth/callback?state=${grant.state}&code=${grant.code}`)).headers.get("location"), "/account");
    assert.equal((await legacy.send("GET", "/api/v1/account/me")).status, 401, "the legacy session ends with the record");
    assert.deepEqual((await (await owner.send("GET", "/api/v1/account/identities")).json() as { subject: string; kind: string }[]).map((i) => [i.subject, i.kind]), [["moving-user", "linked"]]);
  });

  it("names no location when the provider has no logout, so the page shows sign-in instead of signing back in", async () => {
    const { f, admin, idp, handler } = await deployment();
    idp.endSession = false;
    const browser = new Browser(handler);
    await adminSession(browser, f, admin.secret);
    const response = await browser.send("POST", "/auth/logout", { accept: "application/json" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {});
  });

  it("refuses to fold a suspended legacy record into an account", async () => {
    const { f, service, admin, idp, handler } = await deployment();
    await service.setLegacyHost(new Date(f.now() + 600_000).toISOString(), "viewer");
    await ssoLogin(new Browser(handler), idp, { sub: "held-user" }, { userinfo: { sub: "held-user", entitlements: ["viewer"] } });
    const owner = new Browser(handler);
    await adminSession(owner, f, admin.secret);
    const held = (await service.listMembers({ token: owner.cookies.get("__Host-parallax_account")! }))
      .find((member) => member.canonicalLoginKey.endsWith("@legacy.invalid"))!;
    await service.changeMember({ token: owner.cookies.get("__Host-parallax_account")! }, held.userId, held.version, { status: "suspended" });
    const link = await owner.send("POST", "/auth/link");
    const grant = idp.authorize((await link.json() as { url: string }).url, { sub: "held-user" });
    assert.equal((await owner.send("GET", `/auth/callback?state=${grant.state}&code=${grant.code}`)).status, 403, "linking does not undo an administrator's suspension");
  });

  it("ends the session here first, then sends the browser to the provider's logout", async () => {
    const { f, admin, handler } = await deployment();
    const browser = new Browser(handler);
    await adminSession(browser, f, admin.secret);
    const kept = new Map(browser.cookies);
    const response = await browser.send("POST", "/auth/logout", { accept: "application/json" });
    assert.equal(response.status, 200);
    // Page script reads the provider's logout from the body; a manual redirect's location is opaque to it.
    assert.match((await response.json() as { location: string }).location, /^https:\/\/idp\.example\.com\/logout\?/u);
    const replay = new Browser(handler); for (const [name, value] of kept) replay.cookies.set(name, value);
    assert.equal((await replay.send("GET", "/api/v1/account/me")).status, 401);
    const form = new Browser(handler);
    await adminSession(form, f, admin.secret);
    const navigated = await form.send("POST", "/auth/logout");
    assert.equal(navigated.status, 302, "a form post still gets a redirect");
    const withoutCsrf = new Browser(handler); for (const [name, value] of kept) withoutCsrf.cookies.set(name, value);
    assert.equal((await withoutCsrf.send("POST", "/auth/logout", { csrf: false })).status, 403);
  });
});
