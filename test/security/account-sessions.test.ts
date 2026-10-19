import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { createApiHandler } from "../../src/http/api.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";
import {
  ACCOUNT_SESSION_COOKIE,
  ACCOUNT_SESSION_DEADLINE_MS,
  MAX_ACCOUNT_SESSION_COOKIE_BYTES,
  authenticate,
  authenticateRequest,
  createAuthorizedHandler,
  resolvedPrincipal,
  type AccountSessionResolution,
  type AccountSessionResolver,
  type SecurityConfig,
} from "../../src/security/http-authorization.ts";
import { signSession } from "../../src/security/session-token.ts";

/**
 * 회원 세션 확인 장치(`accountSessions`)의 계약.
 *
 * P0 에는 회원 저장소가 없다. 그래서 여기서는 테스트가 확인 장치를 직접 주입한다.
 * 장치가 돌려주는 답을 테스트 중에 바꿔서, 철회와 역할 강등이 다음 요청부터 바로
 * 적용되는지 본다. 이 장치는 운영 코드 어디에도 연결되어 있지 않다.
 */

const TOKEN_SESSION_SECRET = "token-session-secret-that-is-at-least-32-bytes";
const IDENTITY_SECRET = "identity-session-secret-at-least-32-bytes-long";
const ADMIN_TOKEN = "admin-secret-00000000000000000000";
const SESSION_VALUE = "account-session-value-1";

/**
 * 답을 바꿀 수 있고, 몇 번 어떤 값으로 불렸는지 기록하는 확인 장치. `revoke` 로 끊은
 * 값은 `revoked` 에 남고, 그 뒤의 `resolve` 는 `rejected` 로 답한다. 실제 저장소가
 * 할 일을 그대로 흉내 낸다.
 */
class ScriptedResolver implements AccountSessionResolver {
  answer: () => AccountSessionResolution | Promise<AccountSessionResolution> = () => ({ status: "rejected" });
  revokeAnswer: (value: string) => void | Promise<void> = () => undefined;
  readonly calls: string[] = [];
  readonly revokeCalls: string[] = [];
  readonly revoked = new Set<string>();
  readonly signals: AbortSignal[] = [];

  async resolve(value: string, signal: AbortSignal): Promise<AccountSessionResolution> {
    this.calls.push(value);
    this.signals.push(signal);
    if (this.revoked.has(value)) return { status: "rejected" };
    return this.answer();
  }

  async revoke(value: string, signal: AbortSignal): Promise<void> {
    this.revokeCalls.push(value);
    this.signals.push(signal);
    await this.revokeAnswer(value);
    this.revoked.add(value);
  }
}

function securityWith(resolver: AccountSessionResolver, extra: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    enabled: true,
    tokenSessionSecret: TOKEN_SESSION_SECRET,
    identitySessionSecret: IDENTITY_SECRET,
    tokens: [{ token: ADMIN_TOKEN, role: "admin", subject: "owner" }],
    accountSessions: resolver,
    ...extra,
  };
}

function accountCookie(value = SESSION_VALUE, name = ACCOUNT_SESSION_COOKIE): string {
  return `${name}=${encodeURIComponent(value)}`;
}

function call(path: string, init: { method?: string; cookie?: string; authorization?: string; origin?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  if (init.authorization !== undefined) headers.authorization = init.authorization;
  if (init.origin !== undefined) headers.origin = init.origin;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function api(security: SecurityConfig): (request: Request) => Promise<Response> {
  const adapters = createInMemoryAdapters();
  return createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) }, security);
}

const SAME_ORIGIN = "http://localhost";

describe("account sessions through the authorization layer", () => {
  it("serves an active account session with the role the resolver answered", async () => {
    const resolver = new ScriptedResolver();
    resolver.answer = () => ({ status: "active", role: "viewer", subject: "member-1" });
    let seen: unknown;
    const handler = createAuthorizedHandler(securityWith(resolver), (request) => {
      seen = resolvedPrincipal(request);
      return new Response("ok");
    });

    const response = await handler(call("/api/v1/zones", { cookie: accountCookie() }));
    assert.equal(response.status, 200);
    assert.deepEqual(seen, { role: "viewer", subject: "member-1", kind: "account-session" });
    // 확인 장치는 쿠키 값만 받는다. 요청 본문이나 헤더 전체를 넘기지 않는다.
    assert.deepEqual(resolver.calls, [SESSION_VALUE]);
  });

  it("applies a role change and a revocation on the very next request", async () => {
    const resolver = new ScriptedResolver();
    resolver.answer = () => ({ status: "active", role: "editor", subject: "member-1" });
    const handle = api(securityWith(resolver));
    const cookie = accountCookie();

    const created = await handle(call("/api/v1/zones", { method: "POST", cookie, origin: SAME_ORIGIN, body: { name: "a.example.com" } }));
    assert.equal(created.status, 201);

    // 같은 쿠키, 강등된 역할. 캐시된 이전 역할로 쓰기가 통과하면 안 된다.
    resolver.answer = () => ({ status: "active", role: "viewer", subject: "member-1" });
    const demoted = await handle(call("/api/v1/zones", { method: "POST", cookie, origin: SAME_ORIGIN, body: { name: "b.example.com" } }));
    assert.equal(demoted.status, 403);
    assert.equal((await handle(call("/api/v1/zones", { cookie }))).status, 200);

    // 철회. 다음 요청은 인증 실패다.
    resolver.answer = () => ({ status: "rejected" });
    const revoked = await handle(call("/api/v1/zones", { cookie }));
    assert.equal(revoked.status, 401);
    assert.equal(revoked.headers.get("www-authenticate"), "Bearer");
    assert.equal(resolver.calls.length, 4);
  });

  it("applies the account role to a command reached through the command endpoint", async () => {
    const resolver = new ScriptedResolver();
    resolver.answer = () => ({ status: "active", role: "editor", subject: "member-1" });
    const handle = api(securityWith(resolver));
    const cookie = accountCookie();

    const allowed = await handle(call("/api/v1/cli", { method: "POST", cookie, origin: SAME_ORIGIN, body: { argv: ["zone", "create", "--zone", "c.example.com"] } }));
    assert.equal(allowed.status, 200);
    const forbidden = await handle(call("/api/v1/cli", { method: "POST", cookie, origin: SAME_ORIGIN, body: { argv: ["settings", "get"] } }));
    assert.equal(forbidden.status, 403);
    assert.match(JSON.stringify(await forbidden.json()), /requires the admin role/u);
  });

  it("answers 503, not 401, when the resolver cannot answer, and does not count it as a failure", async () => {
    const resolver = new ScriptedResolver();
    resolver.answer = () => { throw new Error("connection refused by 10.0.0.11"); };
    const handler = createAuthorizedHandler(securityWith(resolver, { maxFailedAttempts: 1, lockoutMs: 60_000 }), () => new Response("ok"));
    const cookie = accountCookie();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await handler(call("/api/v1/zones", { cookie }));
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("www-authenticate"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json() as { error: string; message: string };
      assert.equal(body.error, "authentication_unavailable");
      // 장치가 던진 내용은 응답에 실리지 않는다.
      assert.doesNotMatch(body.message, /10\.0\.0\.11/u);
    }

    // 503 세 번이 실패로 세어졌다면 첫 거절부터 429 였을 것이다. 한도가 1 이므로
    // 첫 거절은 401, 두 번째 거절부터 429 다.
    resolver.answer = () => ({ status: "rejected" });
    assert.equal((await handler(call("/api/v1/zones", { cookie }))).status, 401);
    assert.equal((await handler(call("/api/v1/zones", { cookie }))).status, 429);
  });

  it("reads a malformed resolver answer as unavailable rather than as a lower role", async () => {
    const malformed: unknown[] = [
      undefined,
      null,
      "active",
      { status: "maybe" },
      { status: "active", role: "owner", subject: "member-1" },
      { status: "active", role: "viewer" },
      { status: "active", role: "viewer", subject: "" },
      { status: "active", role: "viewer", subject: "   " },
      { status: "active", role: "viewer", subject: "member\n1" },
      { status: "active", role: "viewer", subject: 7 },
    ];
    for (const answer of malformed) {
      const resolver = new ScriptedResolver();
      resolver.answer = () => answer as AccountSessionResolution;
      const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));
      const response = await handler(call("/api/v1/zones", { cookie: accountCookie() }));
      assert.equal(response.status, 503, JSON.stringify(answer));
    }
  });

  it("never asks the resolver about a request that sent an Authorization header", async () => {
    const resolver = new ScriptedResolver();
    resolver.answer = () => ({ status: "active", role: "admin", subject: "member-1" });
    let seen: unknown;
    const handler = createAuthorizedHandler(securityWith(resolver), (request) => {
      seen = resolvedPrincipal(request);
      return new Response("ok");
    });

    // 틀린 Bearer 는 그대로 실패다. 옆에 붙은 유효한 회원 쿠키로 넘어가지 않는다.
    for (const authorization of ["Bearer wrong-token-0000000000000000000000", "Basic abc", "Bearer"]) {
      const refused = await handler(call("/api/v1/zones", { authorization, cookie: accountCookie() }));
      assert.equal(refused.status, 401, authorization);
    }
    const accepted = await handler(call("/api/v1/zones", { authorization: `Bearer ${ADMIN_TOKEN}`, cookie: accountCookie() }));
    assert.equal(accepted.status, 200);
    assert.deepEqual(seen, { role: "admin", subject: "owner", kind: "access-token" });
    assert.deepEqual(resolver.calls, []);
  });

  it("decides a request that sent the account cookie by that cookie alone", async () => {
    const resolver = new ScriptedResolver();
    resolver.answer = () => ({ status: "active", role: "admin", subject: "member-1" });
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));
    const now = Math.floor(Date.now() / 1000);
    const tokenSession = `parallax_session=${encodeURIComponent(signSession({ subject: "owner", role: "admin", expiresAt: now + 600, id: "s-1" }, TOKEN_SESSION_SECRET))}`;
    const identity = `parallax_identity=${encodeURIComponent(signSession({ subject: "someone@example.com", role: "admin", expiresAt: now + 600 }, IDENTITY_SECRET))}`;

    // 두 번 온 회원 쿠키, 모양이 틀린 회원 쿠키는 실패다. 유효한 토큰 세션이나
    // 신원 쿠키가 같이 와도 그쪽으로 넘어가지 않고, 확인 장치도 부르지 않는다.
    const ambiguous = [
      `${accountCookie("first-value")}; ${accountCookie("second-value")}; ${tokenSession}`,
      `${ACCOUNT_SESSION_COOKIE}=%ZZ; ${identity}`,
      `${ACCOUNT_SESSION_COOKIE}=; ${tokenSession}`,
      `${ACCOUNT_SESSION_COOKIE}=has space; ${identity}`,
    ];
    for (const cookie of ambiguous) {
      assert.equal((await handler(call("/api/v1/zones", { cookie }))).status, 401, cookie);
    }
    assert.deepEqual(resolver.calls, []);

    // 철회된 회원 세션도 같다. 옆의 유효한 쿠키가 다른 신분을 대신 주지 않는다.
    resolver.answer = () => ({ status: "rejected" });
    assert.equal((await handler(call("/api/v1/zones", { cookie: `${accountCookie()}; ${tokenSession}; ${identity}` }))).status, 401);
    assert.equal(resolver.calls.length, 1);
  });

  it("refuses an account cookie outright where no resolver is configured", async () => {
    const handler = createAuthorizedHandler({
      enabled: true,
      identitySessionSecret: IDENTITY_SECRET,
      tokens: [{ token: ADMIN_TOKEN, role: "admin", subject: "owner" }],
    }, () => new Response("ok"));
    const identity = `parallax_identity=${encodeURIComponent(signSession({ subject: "someone@example.com", role: "viewer", expiresAt: Math.floor(Date.now() / 1000) + 600 }, IDENTITY_SECRET))}`;

    assert.equal((await handler(call("/api/v1/zones", { cookie: identity }))).status, 200);
    assert.equal((await handler(call("/api/v1/zones", { cookie: `${accountCookie()}; ${identity}` }))).status, 401);
    assert.equal((await handler(call("/api/v1/zones"))).status, 401);
  });

  it("keeps existing token sessions and identity sessions working beside a resolver", async () => {
    const resolver = new ScriptedResolver();
    const principals: unknown[] = [];
    const record = (request: Request): Response => {
      principals.push(resolvedPrincipal(request));
      return new Response("ok");
    };
    // 토큰 세션 서명 비밀이 있으면 신원 쿠키는 보지 않는다. 기존 규칙 그대로라서
    // 두 배포 모양을 따로 확인한다.
    const withTokenSessions = createAuthorizedHandler(securityWith(resolver), record);
    const identityOnly = createAuthorizedHandler(securityWith(resolver, { tokenSessionSecret: undefined }), record);
    const now = Math.floor(Date.now() / 1000);
    const tokenSession = `parallax_session=${encodeURIComponent(signSession({ subject: "owner", role: "admin", expiresAt: now + 600, id: "s-2" }, TOKEN_SESSION_SECRET))}`;
    const identity = `parallax_identity=${encodeURIComponent(signSession({ subject: "someone@example.com", role: "editor", expiresAt: now + 600 }, IDENTITY_SECRET))}`;

    assert.equal((await withTokenSessions(call("/api/v1/zones", { cookie: tokenSession }))).status, 200);
    assert.equal((await identityOnly(call("/api/v1/zones", { cookie: identity }))).status, 200);
    assert.equal((await withTokenSessions(call("/api/v1/zones", { authorization: `Bearer ${ADMIN_TOKEN}` }))).status, 200);
    assert.deepEqual(principals, [
      { role: "admin", subject: "owner", kind: "token-session" },
      { role: "editor", subject: "someone@example.com", kind: "identity-session" },
      { role: "admin", subject: "owner", kind: "access-token" },
    ]);
    assert.deepEqual(resolver.calls, []);
  });

  it("still demands same-origin proof for an unsafe request made with an account session", async () => {
    const resolver = new ScriptedResolver();
    resolver.answer = () => ({ status: "active", role: "admin", subject: "member-1" });
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));

    assert.equal((await handler(call("/api/v1/zones", { method: "POST", cookie: accountCookie() }))).status, 403);
    assert.equal((await handler(call("/api/v1/zones", { method: "POST", cookie: accountCookie(), origin: "https://elsewhere.example.com" }))).status, 403);
    assert.equal((await handler(call("/api/v1/zones", { method: "POST", cookie: accountCookie(), origin: SAME_ORIGIN }))).status, 200);
  });

  it("uses the __Host- cookie name over https and ignores the bare name there", async () => {
    const resolver = new ScriptedResolver();
    resolver.answer = () => ({ status: "active", role: "viewer", subject: "member-1" });
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));
    const secure = (cookie: string): Request => new Request("https://portal.example.com/api/v1/zones", { headers: { cookie } });

    assert.equal((await handler(secure(accountCookie(SESSION_VALUE, `__Host-${ACCOUNT_SESSION_COOKIE}`)))).status, 200);
    // https 에서 접두사 없는 이름은 다른 하위 도메인이 심을 수 있다. 회원 쿠키로 읽지 않는다.
    assert.equal((await handler(secure(accountCookie()))).status, 401);
    assert.deepEqual(resolver.calls, [SESSION_VALUE]);
  });

  it("reports the account caller on the session route, and 503 when it cannot", async () => {
    const resolver = new ScriptedResolver();
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("unreachable"));
    const cookie = accountCookie();

    resolver.answer = () => ({ status: "active", role: "editor", subject: "member-1" });
    const active = await handler(call("/api/v1/session", { cookie }));
    assert.equal(active.status, 200);
    assert.deepEqual(await active.json(), { role: "editor", subject: "member-1" });

    resolver.answer = () => Promise.reject(new Error("timeout"));
    const unavailable = await handler(call("/api/v1/session", { cookie }));
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("www-authenticate"), null);

    resolver.answer = () => ({ status: "rejected" });
    assert.equal((await handler(call("/api/v1/session", { cookie }))).status, 401);
  });
});

/** 다음 호출이 올 때 풀리는 약속. 가짜 타이머를 돌리기 전에 장치가 불렸는지 기다린다. */
function nextCall(): { readonly called: Promise<void>; readonly mark: () => void } {
  let mark: () => void = () => undefined;
  const called = new Promise<void>((resolve) => { mark = resolve; });
  return { called, mark };
}

function signOut(cookie: string, origin = SAME_ORIGIN): Request {
  return new Request(`${origin}/api/v1/session`, { method: "DELETE", headers: { cookie, origin } });
}

describe("account session sign-out with a resolver", () => {
  it("revokes the session in the store before it answers 204, so the next request is refused", async () => {
    const resolver = new ScriptedResolver();
    resolver.answer = () => ({ status: "active", role: "editor", subject: "member-1" });
    let finished = false;
    resolver.revokeAnswer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    };
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));
    const cookie = accountCookie();
    assert.equal((await handler(call("/api/v1/zones", { cookie }))).status, 200);

    const signedOut = await handler(signOut(cookie));
    assert.equal(signedOut.status, 204);
    // 204 가 오기 전에 저장소의 철회가 끝났다.
    assert.equal(finished, true);
    assert.deepEqual(resolver.revokeCalls, [SESSION_VALUE]);
    assert.deepEqual(signedOut.headers.getSetCookie(), [
      "parallax_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
      `${ACCOUNT_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    ]);

    // 브라우저가 지우기 전의 쿠키를 다시 보내도 서버가 이미 끊었다.
    const replayed = await handler(call("/api/v1/zones", { cookie }));
    assert.equal(replayed.status, 401);
  });

  it("answers 503 and clears nothing when the store cannot revoke, so it does not claim the session ended", async () => {
    const resolver = new ScriptedResolver();
    resolver.answer = () => ({ status: "active", role: "editor", subject: "member-1" });
    resolver.revokeAnswer = () => { throw new Error("connection refused by 10.0.0.11"); };
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));
    const cookie = accountCookie();

    const refused = await handler(signOut(cookie));
    assert.equal(refused.status, 503);
    assert.deepEqual(refused.headers.getSetCookie(), []);
    const body = await refused.json() as { error: string; message: string };
    assert.equal(body.error, "authentication_unavailable");
    assert.doesNotMatch(body.message, /10\.0\.0\.11/u);
    // 끊지 못했으므로 세션은 그대로다. 사용자는 다시 로그아웃할 수 있다.
    assert.equal((await handler(call("/api/v1/zones", { cookie }))).status, 200);
  });

  it("answers 503 when the store does not finish revoking in time, and aborts the signal it was given", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const resolver = new ScriptedResolver();
    const entered = nextCall();
    resolver.revokeAnswer = () => {
      entered.mark();
      return new Promise<void>(() => undefined);
    };
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));

    const pending = handler(signOut(accountCookie()));
    await entered.called;
    const signal = resolver.signals[0] as AbortSignal;
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(ACCOUNT_SESSION_DEADLINE_MS - 1);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    const answered = await pending;
    assert.equal(answered.status, 503);
    assert.deepEqual(answered.headers.getSetCookie(), []);
    assert.equal(signal.aborted, true);
    assert.equal(resolver.revoked.size, 0);
  });

  it("revokes every account cookie value sent, and skips values no session could have", async () => {
    const resolver = new ScriptedResolver();
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));
    const oversized = "a".repeat(MAX_ACCOUNT_SESSION_COOKIE_BYTES + 1);
    const cookie = [
      accountCookie("first-value"),
      accountCookie("second-value"),
      accountCookie("first-value"),
      accountCookie(oversized),
      `${ACCOUNT_SESSION_COOKIE}=%ZZ`,
      `${ACCOUNT_SESSION_COOKIE}=`,
    ].join("; ");

    const signedOut = await handler(signOut(cookie));
    assert.equal(signedOut.status, 204);
    assert.deepEqual(resolver.revokeCalls, ["first-value", "second-value"]);
    assert.equal(signedOut.headers.getSetCookie().length, 2);
  });

  it("revokes and clears only the __Host- name over https", async () => {
    const resolver = new ScriptedResolver();
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));
    const origin = "https://portal.example.com";
    const cookie = `${accountCookie("bare-value")}; ${accountCookie("secure-value", `__Host-${ACCOUNT_SESSION_COOKIE}`)}`;

    const signedOut = await handler(signOut(cookie, origin));
    assert.equal(signedOut.status, 204);
    assert.deepEqual(resolver.revokeCalls, ["secure-value"]);
    assert.deepEqual(signedOut.headers.getSetCookie(), [
      "__Host-parallax_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure",
      `__Host-${ACCOUNT_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure`,
    ]);
  });

  it("does not ask the store when no account cookie was sent", async () => {
    const resolver = new ScriptedResolver();
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));
    assert.equal((await handler(signOut("unrelated=1"))).status, 204);
    assert.deepEqual(resolver.revokeCalls, []);
  });

  it("does not clear an account cookie on token sign-in, because it may be a live member session", async () => {
    const resolver = new ScriptedResolver();
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));
    const signedIn = await handler(call("/api/v1/session", { method: "POST", cookie: accountCookie(), origin: SAME_ORIGIN, body: { token: ADMIN_TOKEN } }));
    assert.equal(signedIn.status, 200);
    const cookies = signedIn.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.match(cookies[0] as string, /^parallax_session=v1\./u);
  });
});

describe("account session lookups", () => {
  it("passes an AbortSignal to resolve, and leaves it alone when the answer comes in time", async () => {
    const resolver = new ScriptedResolver();
    resolver.answer = () => ({ status: "active", role: "viewer", subject: "member-1" });
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));
    assert.equal((await handler(call("/api/v1/zones", { cookie: accountCookie() }))).status, 200);
    assert.equal(resolver.signals.length, 1);
    assert.ok(resolver.signals[0] instanceof AbortSignal);
    assert.equal(resolver.signals[0]?.aborted, false);
  });

  it("answers 503 for a lookup that runs past the deadline, without counting it as a failure", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const resolver = new ScriptedResolver();
    const handler = createAuthorizedHandler(securityWith(resolver, { maxFailedAttempts: 1, lockoutMs: 60_000 }), () => new Response("ok"));
    const cookie = accountCookie();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const entered = nextCall();
      resolver.answer = () => {
        entered.mark();
        return new Promise<AccountSessionResolution>(() => undefined);
      };
      const pending = handler(call("/api/v1/zones", { cookie }));
      await entered.called;
      t.mock.timers.tick(ACCOUNT_SESSION_DEADLINE_MS);
      const answered = await pending;
      assert.equal(answered.status, 503);
      assert.equal(answered.headers.get("www-authenticate"), null);
      assert.equal(resolver.signals.at(-1)?.aborted, true);
    }

    // 시간 초과 두 번이 실패로 세어졌다면 첫 거절부터 429 였을 것이다.
    resolver.answer = () => ({ status: "rejected" });
    assert.equal((await handler(call("/api/v1/zones", { cookie }))).status, 401);
    assert.equal((await handler(call("/api/v1/zones", { cookie }))).status, 429);
  });

  it("refuses an account cookie longer than the bound without asking the store", async () => {
    const resolver = new ScriptedResolver();
    resolver.answer = () => ({ status: "active", role: "admin", subject: "member-1" });
    const handler = createAuthorizedHandler(securityWith(resolver), () => new Response("ok"));
    const longest = "a".repeat(MAX_ACCOUNT_SESSION_COOKIE_BYTES);

    const refused = await handler(call("/api/v1/zones", { cookie: accountCookie(`${longest}a`) }));
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(resolver.calls, []);

    assert.equal((await handler(call("/api/v1/zones", { cookie: accountCookie(longest) }))).status, 200);
    assert.deepEqual(resolver.calls, [longest]);
  });
});

describe("account session configuration", () => {
  it("refuses a resolver on a deployment with authentication disabled", async () => {
    const resolver = new ScriptedResolver();
    const disabled: SecurityConfig = { enabled: false, tokens: [], accountSessions: resolver };
    assert.throws(() => createAuthorizedHandler(disabled, () => new Response("ok")), TypeError);
    await assert.rejects(authenticateRequest(call("/api/v1/zones"), disabled), TypeError);

    // 실행 중에 바뀐 설정도 같다. 꺼진 인증과 확인 장치가 함께 오면 익명 관리자로
    // 답하지 않고 요청을 실패시킨다.
    let current: SecurityConfig = securityWith(resolver);
    const handler = createAuthorizedHandler(() => current, () => new Response("ok"));
    current = disabled;
    await assert.rejects(async () => handler(call("/api/v1/zones")), TypeError);
    assert.deepEqual(resolver.calls, []);
  });

  it("refuses the synchronous check on a configuration that has a resolver", () => {
    const resolver = new ScriptedResolver();
    assert.throws(
      () => authenticate(call("/api/v1/zones", { authorization: `Bearer ${ADMIN_TOKEN}` }), securityWith(resolver)),
      { name: "TypeError", message: "account sessions can only be checked by authenticateRequest" },
    );
  });

  it("refuses a token cookie name that would be read as the account cookie", () => {
    for (const cookieName of [ACCOUNT_SESSION_COOKIE, `__Host-${ACCOUNT_SESSION_COOKIE}`]) {
      assert.throws(
        () => createAuthorizedHandler({ enabled: true, tokens: [{ token: ADMIN_TOKEN, role: "admin", subject: "owner" }], cookieName }, () => new Response("ok")),
        { name: "TypeError", message: "invalid security configuration" },
      );
    }
  });
});

describe("authenticateRequest", () => {
  it("returns the three outcomes without turning one into another", async () => {
    const resolver = new ScriptedResolver();
    const security = securityWith(resolver);
    const cookie = accountCookie();

    resolver.answer = () => ({ status: "active", role: "admin", subject: "member-1" });
    assert.deepEqual(await authenticateRequest(call("/", { cookie }), security), {
      status: "authenticated",
      principal: { role: "admin", subject: "member-1", kind: "account-session" },
    });
    resolver.answer = () => ({ status: "rejected" });
    assert.deepEqual(await authenticateRequest(call("/", { cookie }), security), { status: "unauthenticated" });
    resolver.answer = () => { throw new Error("down"); };
    assert.deepEqual(await authenticateRequest(call("/", { cookie }), security), { status: "unavailable" });
    assert.deepEqual(await authenticateRequest(call("/"), security), { status: "unauthenticated" });
  });

  it("answers a disabled deployment as before, without a resolver", async () => {
    assert.deepEqual(await authenticateRequest(call("/"), { enabled: false, tokens: [] }), {
      status: "authenticated",
      principal: { role: "admin", subject: "authentication-disabled", kind: "authentication-disabled" },
    });
  });
});
