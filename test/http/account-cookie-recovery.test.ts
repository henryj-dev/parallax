import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIdentityHandler } from "../../src/http/identity-routes.ts";
import { authenticateManagementRequest } from "../../src/http/management-authentication.ts";
import { portalRedirect } from "../../src/http/portal-entry.ts";
import {
  ACCOUNT_SESSION_COOKIE,
  createAuthorizedHandler,
  withIdentityProvider,
  type SecurityConfig,
} from "../../src/security/http-authorization.ts";
import { signSession } from "../../src/security/session-token.ts";

/**
 * 회원 세션 확인 장치가 없는 배포(이 버전의 운영 경로)에 남은 회원 쿠키.
 *
 * 회원 쿠키가 오면 그 쿠키만으로 판단한다. 확인 장치가 없으면 그 판단은 늘 거절이다.
 * 그래서 남은 쿠키 하나가 토큰 세션과 신원 세션을 모두 가린다. 평소 요청은 그대로
 * 거절하고(조용히 다른 쿠키로 넘어가지 않는다), 명시적인 로그인 성공과 로그아웃만
 * 그 쿠키를 지운다. 여기서는 응답 헤더를 그대로 확인하고, 쿠키 저장소를 흉내 내서
 * 다음 요청이 실제로 통과하는지 본다.
 */

const ADMIN_TOKEN = "admin-secret-00000000000000000000";
const TOKEN_SESSION_SECRET = "token-session-secret-that-is-at-least-32-bytes";
const IDENTITY_SECRET = "identity-session-secret-at-least-32-bytes";
const STALE = `${ACCOUNT_SESSION_COOKIE}=stale-member-session`;
const CLEARED_HTTP = `${ACCOUNT_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
const CLEARED_HTTPS = `__Host-${ACCOUNT_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure`;

const legacy: SecurityConfig = {
  enabled: true,
  tokens: [{ token: ADMIN_TOKEN, role: "admin", subject: "owner" }],
  tokenSessionSecret: TOKEN_SESSION_SECRET,
};

/** 브라우저 쿠키 저장소의 최소판. `Max-Age=0` 은 지우고, 나머지는 덮어쓴다. */
class CookieJar {
  readonly #cookies = new Map<string, string>();

  constructor(initial: string[] = []) {
    for (const pair of initial) this.#set(pair);
  }

  store(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      if (attributes.includes("Max-Age=0")) this.#cookies.delete(pair.slice(0, pair.indexOf("=")));
      else this.#set(pair);
    }
  }

  has(name: string): boolean {
    return this.#cookies.has(name);
  }

  header(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  #set(pair: string): void {
    const separator = pair.indexOf("=");
    this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function signIn(origin: string, cookie: string, token = ADMIN_TOKEN): Request {
  return new Request(`${origin}/api/v1/session`, {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

function signOut(origin: string, cookie: string): Request {
  return new Request(`${origin}/api/v1/session`, { method: "DELETE", headers: { origin, cookie } });
}

function whoAmI(origin: string, cookie: string): Request {
  return new Request(`${origin}/api/v1/session`, { headers: { cookie } });
}

describe("a leftover account cookie on token sign-in", () => {
  const handler = createAuthorizedHandler(legacy, () => new Response("ok"));
  const origin = "http://127.0.0.1:8080";

  it("blocks an ordinary request even beside a valid token session, as before", async () => {
    const session = signSession({ subject: "owner", role: "admin", expiresAt: Math.floor(Date.now() / 1000) + 600, id: "s-1" }, TOKEN_SESSION_SECRET);
    const both = `${STALE}; parallax_session=${encodeURIComponent(session)}`;
    assert.equal((await handler(whoAmI(origin, both))).status, 401);
    // 평소 요청은 아무것도 지우지 않는다.
    assert.deepEqual((await handler(whoAmI(origin, both))).headers.getSetCookie(), []);
  });

  it("clears it on a successful sign-in, so the next request with the new session passes", async () => {
    const jar = new CookieJar([STALE]);
    const signedIn = await handler(signIn(origin, jar.header()));
    assert.equal(signedIn.status, 200);
    const cookies = signedIn.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.match(cookies[0] as string, /^parallax_session=v1\.[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/u);
    assert.equal(cookies[1], CLEARED_HTTP);

    jar.store(signedIn);
    assert.equal(jar.has(ACCOUNT_SESSION_COOKIE), false);
    const next = await handler(whoAmI(origin, jar.header()));
    assert.equal(next.status, 200);
    assert.deepEqual(await next.json(), { role: "admin", subject: "owner" });
  });

  it("clears the __Host- name, with Secure, over https", async () => {
    const secure = "https://portal.example.com";
    const jar = new CookieJar([`__Host-${STALE}`]);
    const signedIn = await handler(signIn(secure, jar.header()));
    assert.equal(signedIn.status, 200);
    const cookies = signedIn.headers.getSetCookie();
    assert.match(cookies[0] as string, /^__Host-parallax_session=v1\.[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/u);
    assert.equal(cookies[1], CLEARED_HTTPS);
    jar.store(signedIn);
    assert.equal((await handler(whoAmI(secure, jar.header()))).status, 200);
  });

  it("clears nothing when the sign-in fails or is throttled", async () => {
    const throttled = createAuthorizedHandler({ ...legacy, maxFailedAttempts: 1, lockoutMs: 60_000 }, () => new Response("ok"));
    const wrong = await throttled(signIn(origin, STALE, "not-a-configured-token-0000000000"));
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.headers.getSetCookie(), []);
    const limited = await throttled(signIn(origin, STALE, "not-a-configured-token-0000000000"));
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.headers.getSetCookie(), []);
  });

  it("clears nothing when no session can be issued", async () => {
    const unsigned = createAuthorizedHandler({ enabled: true, tokens: legacy.tokens }, () => new Response("ok"));
    const refused = await unsigned(signIn(origin, STALE));
    assert.equal(refused.status, 503);
    assert.deepEqual(refused.headers.getSetCookie(), []);
  });
});

describe("a leftover account cookie on token sign-out", () => {
  const handler = createAuthorizedHandler(legacy, () => new Response("ok"));

  it("clears both cookies over plain http", async () => {
    const signedOut = await handler(signOut("http://127.0.0.1:8080", STALE));
    assert.equal(signedOut.status, 204);
    assert.deepEqual(signedOut.headers.getSetCookie(), [
      "parallax_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
      CLEARED_HTTP,
    ]);
  });

  it("clears both __Host- names over https", async () => {
    const signedOut = await handler(signOut("https://portal.example.com", `__Host-${STALE}`));
    assert.equal(signedOut.status, 204);
    assert.deepEqual(signedOut.headers.getSetCookie(), [
      "__Host-parallax_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure",
      CLEARED_HTTPS,
    ]);
  });

  it("signs out safely with the cookie sent twice or malformed, which ordinary requests still refuse", async () => {
    const origin = "http://127.0.0.1:8080";
    for (const cookie of [`${STALE}; ${ACCOUNT_SESSION_COOKIE}=another`, `${ACCOUNT_SESSION_COOKIE}=%ZZ`, `${ACCOUNT_SESSION_COOKIE}=${"a".repeat(600)}`]) {
      assert.equal((await handler(whoAmI(origin, cookie))).status, 401, cookie);
      const signedOut = await handler(signOut(origin, cookie));
      assert.equal(signedOut.status, 204, cookie);
      assert.equal(signedOut.headers.getSetCookie()[1], CLEARED_HTTP, cookie);
    }
  });

  it("still demands same-origin proof before it clears anything", async () => {
    const crossSite = await handler(new Request("http://127.0.0.1:8080/api/v1/session", {
      method: "DELETE",
      headers: { origin: "https://elsewhere.example.com", cookie: STALE },
    }));
    assert.equal(crossSite.status, 403);
    assert.deepEqual(crossSite.headers.getSetCookie(), []);
  });
});

const PORTAL = "https://parallax.example";
const SETTINGS = {
  issuer: "https://idp.example",
  clientId: "parallax",
  clientSecret: "client-secret",
  redirectUri: `${PORTAL}/auth/callback`,
  scopes: "openid profile email",
  sessionSecret: IDENTITY_SECRET,
  sessionMaxAgeSeconds: 3600,
};

function unsignedIdToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.test-signature`;
}

/** 로그인 흐름이 부르는 두 곳만 답하는 공급자. 발견 문서는 없어서 기본 경로를 쓴다. */
function identityHandler(): { readonly handle: (request: Request) => Promise<Response | undefined>; nonce: string } {
  const state = {
    nonce: "",
    handle: createIdentityHandler({
      settings: SETTINGS,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(typeof input === "object" && "url" in input ? input.url : input);
        if (url.endsWith("/oidc/token")) {
          return Response.json({
            access_token: "provider-access-token",
            expires_in: 300,
            id_token: unsignedIdToken({ iss: SETTINGS.issuer, aud: SETTINGS.clientId, sub: "member-1", exp: Math.floor(Date.now() / 1000) + 300, nonce: state.nonce }),
          });
        }
        if (url.endsWith("/oidc/userinfo")) return Response.json({ sub: "member-1", entitlements: ["editor"] });
        throw new Error(`unexpected call to ${url}`);
      }) as typeof fetch,
    }),
  };
  return state;
}

/** 로그인을 시작하고 공급자에서 돌아오는 요청을 만든다. 쿠키는 저장소에서 가져간다. */
async function completeSignIn(provider: ReturnType<typeof identityHandler>, jar: CookieJar, next: string, state?: string): Promise<Response> {
  const started = await provider.handle(new Request(`${PORTAL}/auth/login?next=${encodeURIComponent(next)}`, { headers: { cookie: jar.header() } })) as Response;
  assert.equal(started.status, 302);
  jar.store(started);
  const handshake = new Map(started.headers.getSetCookie().map((line) => {
    const pair = line.split(";")[0] as string;
    return [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
  }));
  provider.nonce = handshake.get("__Host-parallax_oidc_nonce") as string;
  const chosen = state ?? handshake.get("__Host-parallax_oidc_state") as string;
  return await provider.handle(new Request(`${PORTAL}/auth/callback?code=abc&state=${chosen}`, { headers: { cookie: jar.header() } })) as Response;
}

describe("a leftover account cookie on identity-provider sign-in", () => {
  it("clears it when the callback succeeds", async () => {
    const jar = new CookieJar([`__Host-${STALE}`]);
    const done = await completeSignIn(identityHandler(), jar, "/zones");
    assert.equal(done.status, 302);
    assert.equal(done.headers.get("location"), "/zones");
    const cookies = done.headers.getSetCookie();
    // 신원 쿠키, ID 토큰 쿠키, 회원 쿠키 지우기가 따로따로 온다.
    assert.ok(cookies.some((line) => line.startsWith("__Host-parallax_identity=v1.")), cookies.join("\n"));
    assert.ok(cookies.some((line) => line.startsWith("__Host-parallax_oidc_id=")), cookies.join("\n"));
    assert.equal(cookies.filter((line) => line === CLEARED_HTTPS).length, 1, cookies.join("\n"));
    assert.equal(cookies.filter((line) => line.includes(ACCOUNT_SESSION_COOKIE)).length, 1);
  });

  it("clears nothing when the callback is refused", async () => {
    const jar = new CookieJar([`__Host-${STALE}`]);
    const refused = await completeSignIn(identityHandler(), jar, "/", "attacker-state");
    assert.notEqual(refused.headers.get("location"), "/");
    assert.equal(refused.headers.getSetCookie().some((line) => line.includes(ACCOUNT_SESSION_COOKIE)), false);
  });

  it("clears it on identity sign-out, beside the identity cookies", async () => {
    const provider = identityHandler();
    const signedOut = await provider.handle(new Request(`${PORTAL}/auth/logout`, {
      method: "POST",
      headers: { origin: PORTAL, cookie: `__Host-${STALE}` },
    })) as Response;
    assert.equal(signedOut.status, 302);
    const cookies = signedOut.headers.getSetCookie();
    assert.equal(cookies.length, 3);
    assert.match(cookies[0] as string, /^__Host-parallax_identity=; /u);
    assert.match(cookies[1] as string, /^__Host-parallax_oidc_id=; /u);
    assert.equal(cookies[2], CLEARED_HTTPS);
  });

  it("does not clear it on a cross-site sign-out", async () => {
    const refused = await identityHandler().handle(new Request(`${PORTAL}/auth/logout`, {
      method: "POST",
      headers: { origin: "https://elsewhere.example.com", cookie: `__Host-${STALE}` },
    })) as Response;
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.headers.getSetCookie(), []);
  });
});

describe("portal sign-in through the identity provider", () => {
  // src/index.ts 가 포털 문서 요청에 하는 판단을 그대로 따른다.
  const security = withIdentityProvider({ enabled: true, tokens: legacy.tokens }, IDENTITY_SECRET);
  async function visit(jar: CookieJar): Promise<string | undefined> {
    const caller = await authenticateManagementRequest({ cookie: jar.header() }, security, PORTAL);
    assert.notEqual(caller, "unavailable");
    return portalRedirect({ signIn: "idp", pathname: "/", isDocument: true, authenticationRequired: security.enabled, authenticated: caller === "authenticated" });
  }

  it("ends the redirect loop a leftover account cookie would cause", async () => {
    const jar = new CookieJar([`__Host-${STALE}`]);
    const first = await visit(jar);
    assert.equal(first, "/auth/login?next=%2F");

    const done = await completeSignIn(identityHandler(), jar, "/");
    assert.equal(done.status, 302);
    assert.equal(done.headers.get("location"), "/");
    jar.store(done);
    assert.equal(jar.has(`__Host-${ACCOUNT_SESSION_COOKIE}`), false);

    // 돌아온 포털은 다시 로그인으로 보내지 않는다. API 도 같은 쿠키로 통과한다.
    assert.equal(await visit(jar), undefined);
    const api = createAuthorizedHandler(security, () => new Response("ok"));
    const session = await api(new Request(`${PORTAL}/api/v1/session`, { headers: { cookie: jar.header() } }));
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { role: "editor", subject: "member-1" });

    // 지우기가 없었다면 같은 신원 쿠키를 들고도 다시 로그인으로 갔을 것이다.
    const withoutClear = new CookieJar([...jar.header().split("; "), `__Host-${STALE}`]);
    assert.equal(await visit(withoutClear), "/auth/login?next=%2F");
  });
});
