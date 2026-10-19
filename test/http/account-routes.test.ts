import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { describe, it } from "node:test";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { createApiHandler } from "../../src/http/api.ts";
import { InMemoryAccountStateStore } from "../../src/infrastructure/account-state.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";
import { assertStorableCookies } from "../support/cookies.ts";
import { accountFixture, accountTestPolicy, enrolledAdministrator } from "../support/accounts.ts";

const ORIGIN = "https://dns.example.com";
const MACHINE = "m".repeat(43);

/** A browser, reduced to what matters here: a cookie jar and the origin it sends. */
class Browser {
  readonly cookies = new Map<string, string>();
  csrf = "";
  readonly handler: (request: Request) => Promise<Response>;
  constructor(handler: (request: Request) => Promise<Response>) { this.handler = handler; }
  async send(method: string, path: string, options: { body?: unknown; csrf?: string | null; origin?: string | null; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
    const csrf = options.csrf === undefined ? this.csrf : options.csrf;
    if (csrf) headers.set("x-parallax-csrf", csrf);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.handler(new Request(`${ORIGIN}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }));
    assertStorableCookies(response.headers.getSetCookie(), `${method} ${path}`);
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";"); const index = pair!.indexOf("=");
      const name = pair!.slice(0, index), value = pair!.slice(index + 1);
      if (/Max-Age=0/u.test(line) || value === "") this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return response;
  }
  async anonymous(): Promise<void> { this.csrf = (await (await this.send("GET", "/api/v1/account/csrf")).json() as { csrf: string }).csrf; }
}

async function deployment() {
  const store = new InMemoryAccountStateStore();
  const f = accountFixture(store);
  const service = await f.create();
  const admin = await enrolledAdministrator(service, f);
  const adapters = createInMemoryAdapters();
  const handler = createApiHandler(
    { controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), accounts: service },
    { enabled: true, tokens: [{ token: MACHINE, role: "admin", subject: "machine" }], accountSessions: service, disableTokenExchange: true },
  );
  return { store, f, service, admin, handler };
}

async function signIn(browser: Browser, f: ReturnType<typeof accountFixture>, secret: string): Promise<void> {
  await browser.anonymous();
  const login = await browser.send("POST", "/api/v1/account/login", { body: { email: "admin@example.com", password: "test-password-1" } });
  assert.equal(login.status, 200);
  f.advance();
  const mfa = await browser.send("POST", "/api/v1/account/login/mfa", { body: { otp: f.otp(secret) } });
  assert.equal(mfa.status, 200);
  browser.csrf = (await mfa.json() as { csrf: string }).csrf;
}

describe("member account routes", () => {
  it("signs an administrator in with a password and a code, without the challenge ever reaching page script", async () => {
    const { f, admin, handler } = await deployment();
    const browser = new Browser(handler);
    await browser.anonymous();
    const login = await browser.send("POST", "/api/v1/account/login", { body: { email: "ADMIN@example.com", password: "test-password-1" } });
    assert.equal(login.status, 200);
    const body = await login.json() as Record<string, unknown>;
    assert.deepEqual(body, { mfaRequired: true, enrollmentRequired: false });
    const challengeCookie = login.headers.getSetCookie().find((line) => line.startsWith("__Host-parallax_member_challenge="))!;
    assert.match(challengeCookie, /HttpOnly/u); assert.match(challengeCookie, /Secure/u); assert.match(challengeCookie, /SameSite=Strict/u);
    assert.match(challengeCookie, new RegExp(`Max-Age=${accountTestPolicy.tokens.challengeSeconds}`, "u"));
    // A challenge is not a session.
    assert.equal((await browser.send("GET", "/api/v1/account/me")).status, 401);
    f.advance();
    const mfa = await browser.send("POST", "/api/v1/account/login/mfa", { body: { otp: f.otp(admin.secret) } });
    assert.equal(mfa.status, 200);
    browser.csrf = (await mfa.json() as { csrf: string }).csrf;
    const me = await (await browser.send("GET", "/api/v1/account/me")).json() as { user: Record<string, unknown>; recentMfa: boolean };
    assert.equal(me.user.role, "admin"); assert.equal(me.recentMfa, true);
    assert.equal("securityEpoch" in me.user, false);
  });

  it("refuses a mutation without the header, from another origin, or with a bearer token, and never falls back to a cookie", async () => {
    const { handler } = await deployment();
    const browser = new Browser(handler);
    await browser.anonymous();
    const body = { email: "admin@example.com", password: "test-password-1" };
    assert.equal((await browser.send("POST", "/api/v1/account/login", { body, csrf: null })).status, 403);
    assert.equal((await browser.send("POST", "/api/v1/account/login", { body, csrf: "A".repeat(43) })).status, 403);
    assert.equal((await browser.send("POST", "/api/v1/account/login", { body, origin: "https://attacker.example.com" })).status, 403);
    assert.equal((await browser.send("POST", "/api/v1/account/login", { body, headers: { authorization: `Bearer ${MACHINE}` } })).status, 403);
  });

  it("guards ordinary DNS writes from a member session with the same CSRF rule", async () => {
    const { f, admin, handler } = await deployment();
    const browser = new Browser(handler);
    await signIn(browser, f, admin.secret);
    const csrf = browser.csrf;
    const without = await browser.send("POST", "/api/v1/zones", { body: { name: "example.com" }, csrf: null });
    assert.equal(without.status, 403); assert.deepEqual(await without.json(), { error: "csrf_rejected" });
    const created = await browser.send("POST", "/api/v1/zones", { body: { name: "example.com" }, csrf });
    assert.equal(created.status, 201);
  });

  it("demands a fresh code from an administrator for tokens, credentials, settings and the CLI route", async () => {
    const { f, admin, handler } = await deployment();
    const browser = new Browser(handler);
    await signIn(browser, f, admin.secret);
    f.advance((accountTestPolicy.recentAuthSeconds + 1) * 1000);
    for (const [method, path, body] of [["POST", "/api/v1/tokens", { subject: "ci", role: "viewer" }], ["PUT", "/api/v1/settings", {}], ["POST", "/api/v1/cli", { argv: ["zone", "list"] }]] as const) {
      const response = await browser.send(method, path, { body });
      assert.equal(response.status, 403, path); assert.deepEqual(await response.json(), { error: "reauthentication_required" }, path);
    }
    // The router drops empty segments and percent-decodes the rest; the rule reads the path the same way.
    for (const [method, path] of [["POST", "/api/v1//tokens"], ["POST", "/api/v1/%74okens"], ["POST", "/api//v1/cli"], ["POST", "/api/v1/tokens/"],
      ["POST", "/API/V1/TOKENS"], ["PUT", "//api/v1/settings"], ["PUT", "/api/v1/%73ettings/"], ["POST", "/api/v1/cli/"], ["DELETE", "/api/v1/credentials/cloudflare/example.com"]] as const) {
      const response = await browser.send(method, path, { body: {} });
      assert.equal(response.status, 403, path); assert.deepEqual(await response.json(), { error: "reauthentication_required" }, path);
    }
    assert.equal((await browser.send("POST", "/api/v1/%E0%A4%A/tokens", { body: {} })).status, 400, "a path that does not decode is refused");
    f.advance();
    assert.equal((await browser.send("POST", "/api/v1/account/reauthenticate", { body: { otp: f.otp(admin.secret) } })).status, 200);
    // Past the guard: the CLI route now runs the command, and the tokens route reaches its (absent) service rather than the guard.
    assert.equal((await browser.send("POST", "/api/v1/cli", { body: { argv: ["zone", "list"] } })).status, 200);
    assert.notEqual((await browser.send("POST", "/api/v1/tokens", { body: { subject: "ci", role: "viewer" } })).status, 403);
  });

  it("keeps machine tokens on DNS routes, and away from people's operations and the token-to-cookie exchange", async () => {
    const { handler } = await deployment();
    const machine = new Browser(handler);
    const bearer = { authorization: `Bearer ${MACHINE}` };
    assert.equal((await machine.send("GET", "/api/v1/zones", { headers: bearer, origin: null })).status, 200);
    assert.equal((await machine.send("GET", "/api/v1/account/members", { headers: bearer, origin: null })).status, 403);
    assert.equal((await machine.send("POST", "/api/v1/account/members/invite", { headers: bearer, body: { email: "x@example.com", role: "admin" } })).status, 403);
    const exchange = await machine.send("POST", "/api/v1/session", { body: { token: MACHINE }, csrf: null });
    assert.equal(exchange.status, 403); assert.deepEqual(await exchange.json(), { error: "human_login_required" });
    const cli = await machine.send("POST", "/api/v1/cli", { headers: bearer, body: { argv: ["accounts", "bootstrap", "--email", "x@example.com", "--display-name", "X"] }, origin: null });
    assert.notEqual(cli.status, 200);
    assert.match(JSON.stringify(await cli.json()), /local CLI/u);
  });

  it("clears this browser's cookie when ending every session or this one, and only then", async () => {
    const { f, admin, handler } = await deployment();
    const other = new Browser(handler);
    await signIn(other, f, admin.secret);
    const browser = new Browser(handler);
    f.advance();
    await signIn(browser, f, admin.secret);
    const listed = (await (await browser.send("GET", "/api/v1/account/sessions")).json()) as { createdAt: number; current: boolean }[];
    assert.equal(listed.filter((s) => s.current).length, 1, "exactly one session is marked as this one");
    assert.equal("digest" in listed[0]!, false);
    const otherCreatedAt = listed.find((s) => !s.current)!.createdAt;
    const currentCreatedAt = listed.find((s) => s.current)!.createdAt;
    const one = await browser.send("POST", "/api/v1/account/sessions/revoke", { body: { createdAt: otherCreatedAt } });
    assert.equal(one.status, 200);
    assert.equal(one.headers.getSetCookie().some((line) => line.startsWith("__Host-parallax_account=")), false, "ending another session keeps this cookie");
    const mine = await browser.send("POST", "/api/v1/account/sessions/revoke", { body: { createdAt: currentCreatedAt } });
    assert.equal(mine.status, 200);
    const cleared = mine.headers.getSetCookie().find((line) => line.startsWith("__Host-parallax_account="));
    assert.ok(cleared && /Max-Age=0/u.test(cleared), "ending this session clears this browser's cookie");
    assert.equal(browser.cookies.has("__Host-parallax_account"), false);
    assert.equal((await browser.send("GET", "/api/v1/account/me")).status, 401);
    const again = new Browser(handler);
    f.advance();
    await signIn(again, f, admin.secret);
    const all = await again.send("POST", "/api/v1/account/sessions/revoke", { body: {} });
    assert.ok(all.headers.getSetCookie().some((line) => line.startsWith("__Host-parallax_account=") && /Max-Age=0/u.test(line)), "ending every session clears it too");
  });

  it("ends a session on the server, so the old cookie stops working everywhere", async () => {
    const { f, admin, handler } = await deployment();
    const browser = new Browser(handler);
    await signIn(browser, f, admin.secret);
    const kept = new Map(browser.cookies);
    assert.equal((await browser.send("POST", "/api/v1/account/logout", { body: {} })).status, 200);
    const replay = new Browser(handler); for (const [name, value] of kept) replay.cookies.set(name, value);
    // An ended session is 401 on every route, reads and writes alike, so the portal can tell it from a refusal.
    assert.equal((await replay.send("GET", "/api/v1/account/me")).status, 401);
    assert.equal((await replay.send("GET", "/api/v1/zones", { origin: null })).status, 401);
    assert.equal((await replay.send("POST", "/api/v1/zones", { body: { name: "example.com" }, csrf: "A".repeat(43) })).status, 401);
    assert.equal((await replay.send("POST", "/api/v1/account/sessions/revoke", { body: {}, csrf: "A".repeat(43) })).status, 401);
  });

  it("turns a recovery code into a new enrollment rather than a session, and the replacement factor then signs in", async () => {
    const { f, admin, handler } = await deployment();
    const browser = new Browser(handler);
    await browser.anonymous();
    await browser.send("POST", "/api/v1/account/login", { body: { email: "admin@example.com", password: "test-password-1" } });
    const recovered = await browser.send("POST", "/api/v1/account/login/mfa", { body: { otp: admin.recoveryCodes[0] } });
    assert.deepEqual(await recovered.json(), { mfaRequired: true, enrollmentRequired: true });
    assert.equal(browser.cookies.has("__Host-parallax_account"), false);
    const enrollment = await (await browser.send("POST", "/api/v1/account/mfa/enroll", { body: {} })).json() as { secretBase32: string };
    f.advance();
    const confirmed = await browser.send("POST", "/api/v1/account/mfa/confirm", { body: { otp: f.otp(enrollment.secretBase32) } });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json() as { recoveryCodes: string[] }).recoveryCodes.length, accountTestPolicy.mfa.recoveryCodeCount);
    // The old factor and the used code are both gone.
    const again = new Browser(handler);
    await again.anonymous();
    await again.send("POST", "/api/v1/account/login", { body: { email: "admin@example.com", password: "test-password-1" } });
    f.advance();
    assert.equal((await again.send("POST", "/api/v1/account/login/mfa", { body: { otp: f.otp(admin.secret) } })).status, 403);
    await again.send("POST", "/api/v1/account/login", { body: { email: "admin@example.com", password: "test-password-1" } });
    assert.equal((await again.send("POST", "/api/v1/account/login/mfa", { body: { otp: admin.recoveryCodes[1] } })).status, 403);
    await again.send("POST", "/api/v1/account/login", { body: { email: "admin@example.com", password: "test-password-1" } });
    f.advance();
    assert.equal((await again.send("POST", "/api/v1/account/login/mfa", { body: { otp: f.otp(enrollment.secretBase32) } })).status, 200);
  });

  it("answers a reset request the same way for an unknown address, a known one, and a mail failure", async () => {
    const { f, handler } = await deployment();
    const browser = new Browser(handler);
    await browser.anonymous();
    const answers: unknown[] = [];
    for (const email of ["nobody@example.com", "admin@example.com"]) {
      const response = await browser.send("POST", "/api/v1/account/password/forgot", { body: { email } });
      answers.push([response.status, await response.json()]);
    }
    f.failMail();
    const failed = await browser.send("POST", "/api/v1/account/password/forgot", { body: { email: "admin@example.com" } });
    answers.push([failed.status, await failed.json()]);
    assert.deepEqual(answers, [[200, { ok: true }], [200, { ok: true }], [200, { ok: true }]]);
  });

  it("reports a stored hash beyond the verify limits as unavailable, never as a wrong password", async () => {
    const { store, handler } = await deployment();
    await store.transact((t) => {
      const [userId] = Object.keys(t.state.passwords);
      t.state.passwords[userId!] = t.state.passwords[userId!]!.replace(/^scrypt\$v1\$1024\$/u, "scrypt$v1$1048576$");
    });
    const browser = new Browser(handler);
    await browser.anonymous();
    const response = await browser.send("POST", "/api/v1/account/login", { body: { email: "admin@example.com", password: "test-password-1" } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "unavailable" });
  });

  it("replaces a hash made under older costs at the next successful sign-in, and only then", async () => {
    const { store, handler } = await deployment();
    const salt = randomBytes(16), older = `scrypt$v1$512$8$1$${salt.toString("base64url")}$${scryptSync("test-password-1", salt, 32, { N: 512, r: 8, p: 1 }).toString("base64url")}`;
    await store.transact((t) => { const [userId] = Object.keys(t.state.passwords); t.state.passwords[userId!] = older; });
    const browser = new Browser(handler);
    await browser.anonymous();
    assert.equal((await browser.send("POST", "/api/v1/account/login", { body: { email: "admin@example.com", password: "wrong-password-1" } })).status, 403);
    assert.equal(Object.values((await store.read()).passwords)[0], older, "a failed sign-in changes nothing");
    assert.equal((await browser.send("POST", "/api/v1/account/login", { body: { email: "admin@example.com", password: "test-password-1" } })).status, 200);
    assert.match(Object.values((await store.read()).passwords)[0]!, new RegExp(`^scrypt\\$v1\\$${accountTestPolicy.password.scrypt.N}\\$`, "u"));
  });

  it("serves the identity policy to an administrator and refuses a role or MFA source the provider cannot back", async () => {
    const { f, admin, handler } = await deployment();
    const browser = new Browser(handler);
    await signIn(browser, f, admin.secret);
    assert.deepEqual(await (await browser.send("GET", "/api/v1/account/identities/policy")).json(),
      { roleSource: "local", mfaEvidence: "local-totp", jit: [], legacyUntil: null, legacyRoleCap: null });
    for (const body of [{ roleSource: "idp", mfaEvidence: "local-totp", jit: [] }, { roleSource: "local", mfaEvidence: "idp", jit: [] }]) {
      assert.equal((await browser.send("POST", "/api/v1/account/identities/policy", { body })).status, 400);
    }
    const jit = [{ issuer: "https://idp.example.com", role: "viewer", maxUsers: 2 }];
    assert.equal((await browser.send("POST", "/api/v1/account/identities/policy", { body: { roleSource: "local", mfaEvidence: "local-totp", jit } })).status, 200);
    assert.deepEqual((await (await browser.send("GET", "/api/v1/account/identities/policy")).json() as { jit: unknown }).jit, jit);
  });
});
