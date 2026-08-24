import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIdentityHandler } from "../../src/http/identity-routes.ts";
import { authenticate, IDENTITY_COOKIE, withIdentityProvider } from "../../src/security/http-authorization.ts";
import { assumedEndpoints, beginAuthorization, createEndpointResolver, discoverEndpoints, endSessionUrl, readIdentity, type OidcConfig } from "../../src/security/oidc.ts";
import { readSession, signSession } from "../../src/security/session-token.ts";

const SECRET = "identity-session-secret-at-least-32-bytes";
const SETTINGS = {
  issuer: "https://idp.example",
  clientId: "parallax",
  clientSecret: "client-secret",
  redirectUri: "https://parallax.example/auth/callback",
  scopes: "openid profile email",
  sessionSecret: SECRET,
  sessionMaxAgeSeconds: 3600,
};
const CONFIG: OidcConfig = { ...SETTINGS };

/** A provider that answers the two calls the flow makes, with what it is given. */
function provider(claims: Record<string, unknown>, tokens: Record<string, unknown> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.endsWith("/oidc/token")) {
      return Response.json({ access_token: "provider-access-token", expires_in: 300, ...tokens });
    }
    if (url.endsWith("/oidc/userinfo")) return Response.json(claims);
    throw new Error(`unexpected call to ${url}`);
  }) as typeof fetch;
}

function cookiesOf(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const separator = (pair as string).indexOf("=");
    jar.set((pair as string).slice(0, separator), decodeURIComponent((pair as string).slice(separator + 1)));
  }
  return jar;
}

describe("session values", () => {
  it("reads back only what this secret signed, and only before it expires", () => {
    const value = signSession({ subject: "user-1", role: "editor", expiresAt: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    assert.deepEqual(readSession(value, SECRET)?.role, "editor");
    assert.equal(readSession(value, `${SECRET}-other`), undefined, "another secret must not open it");
    // The payload is readable, so the signature is the only thing stopping an
    // editor from rewriting themselves as an administrator.
    const [version, payload, signature] = value.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    claims.role = "admin";
    const forged = `${version}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    assert.equal(readSession(forged, SECRET), undefined, "a rewritten role must not verify");
    const expired = signSession({ subject: "user-1", role: "admin", expiresAt: Math.floor(Date.now() / 1000) - 1 }, SECRET);
    assert.equal(readSession(expired, SECRET), undefined);
  });
});

describe("identity sign-in", () => {
  it("carries the provider's role into the session and into authentication", async () => {
    const handler = createIdentityHandler({
      settings: SETTINGS,
      fetchImpl: provider({ sub: "keystone-user-1", entitlements: ["editor"], preferred_username: "ops" }),
    });
    const started = await handler(new Request("https://parallax.example/auth/login?next=/zones"));
    assert.equal(started?.status, 302);
    const handshake = cookiesOf(started as Response);
    // Over https the handshake cookies carry the `__Host-` prefix, which is what
    // stops a sibling host from setting one of them for the parent domain.
    const state = handshake.get("__Host-parallax_oidc_state") as string;
    assert.match((started as Response).headers.get("location") ?? "", /code_challenge_method=S256/);

    const done = await handler(new Request(`https://parallax.example/auth/callback?code=abc&state=${state}`, {
      headers: {
        cookie: `__Host-parallax_oidc_state=${state}; __Host-parallax_oidc_verifier=${handshake.get("__Host-parallax_oidc_verifier")}; __Host-parallax_oidc_return=/zones`,
      },
    }));
    assert.equal(done?.status, 302);
    assert.equal((done as Response).headers.get("location"), "/zones");
    const session = cookiesOf(done as Response).get(IDENTITY_COOKIE) as string;

    // The whole point: that cookie is now a principal the control plane accepts.
    const principal = authenticate(
      new Request("https://parallax.example/api/v1/zones", { headers: { cookie: `${IDENTITY_COOKIE}=${encodeURIComponent(session)}` } }),
      { enabled: true, tokens: [{ token: "a-token-of-at-least-32-bytes-long-x", subject: "deploy", role: "admin" }], identitySessionSecret: SECRET },
    );
    assert.deepEqual(principal, { role: "editor", subject: "keystone-user-1" });
  });

  it("reports who the caller is, so the portal can leave out what it cannot use", async () => {
    const { createAuthorizedHandler, SESSION_PATH } = await import("../../src/security/http-authorization.ts");
    const config = {
      enabled: true,
      tokens: [{ token: "a-token-of-at-least-32-bytes-long-x", subject: "deploy", role: "admin" as const }],
      identitySessionSecret: SECRET,
    };
    const handler = createAuthorizedHandler(config, async () => Response.json({ ok: true }));
    const session = signSession({ subject: "keystone-user-1", role: "viewer", expiresAt: Math.floor(Date.now() / 1000) + 60 }, SECRET);

    const answered = await handler(new Request(`https://parallax.example${SESSION_PATH}`, {
      headers: { cookie: `${IDENTITY_COOKIE}=${encodeURIComponent(session)}` },
    }));
    assert.equal(answered.status, 200);
    assert.deepEqual(await answered.json(), { role: "viewer", subject: "keystone-user-1" });

    const anonymous = await handler(new Request(`https://parallax.example${SESSION_PATH}`));
    assert.equal(anonymous.status, 401, "it must not describe a caller that has not authenticated");

    for (const authorization of ["Bearer wrong-token-value-that-is-long-enough", "Basic malformed"]) {
      const explicitFailure = await handler(new Request(`https://parallax.example${SESSION_PATH}`, {
        headers: {
          authorization,
          cookie: `${IDENTITY_COOKIE}=${encodeURIComponent(session)}`,
        },
      }));
      assert.equal(explicitFailure.status, 401,
        "an explicit invalid Authorization header must not fall back to the browser identity");
    }
  });

  it("refuses a callback whose state is not the one this browser was given", async () => {
    const handler = createIdentityHandler({ settings: SETTINGS, fetchImpl: provider({ sub: "x", entitlements: ["admin"] }) });
    const answered = await handler(new Request("https://parallax.example/auth/callback?code=abc&state=attacker", {
      headers: { cookie: "parallax_oidc_state=browser; parallax_oidc_verifier=v" },
    }));
    assert.equal(answered?.status, 302);
    assert.match((answered as Response).headers.get("location") ?? "", /signin_error/);
    // Not cleared either: a failed sign-in must not sign out whoever is already
    // signed in on this browser.
    assert.equal(cookiesOf(answered as Response).has(IDENTITY_COOKIE), false, "no session may be issued");
  });

  it("refuses an account the provider grants no role for", async () => {
    await assert.rejects(
      readIdentity(CONFIG, assumedEndpoints(CONFIG.issuer), { accessToken: "t", expiresIn: 300 }, provider({ sub: "stranger" })),
      (error: Error) => {
        // Anyone in the directory can authenticate; that is not the same as
        // being someone here, and defaulting would make it the same.
        assert.match(error.message, /no `entitlements` granting it a role in Parallax/u);
        return true;
      },
    );
  });

  it("does not take a role or a group as permission", async () => {
    // The provider labels people with `roles` and places them with `groups`,
    // and says in its own console that neither is for authorization. A holder
    // of both and no entitlement is somebody with a job title, not a grant.
    await assert.rejects(
      readIdentity(CONFIG, assumedEndpoints(CONFIG.issuer), { accessToken: "t", expiresIn: 300 },
        provider({ sub: "labelled", roles: ["admin"], groups: ["platform"], roles_label: "Administrator" })),
      (error: Error) => {
        assert.match(error.message, /no `entitlements` granting it a role in Parallax/u);
        return true;
      },
    );
  });

  it("does not treat an identity-provider config as an unauthenticated administrator", () => {
    const config = withIdentityProvider({ enabled: false, tokens: [] }, SECRET);
    assert.equal(config.enabled, true);
    const principal = authenticate(new Request("https://parallax.example/api/v1/zones"), config);
    assert.equal(principal, undefined);
  });

  it("refuses identity logout over GET, and still clears on a same-origin POST", async () => {
    const handler = createIdentityHandler({ settings: SETTINGS, fetchImpl: provider({ sub: "u", entitlements: ["viewer"] }) });
    const get = await handler(new Request("https://parallax.example/auth/logout"));
    assert.equal(get?.status, 405);

    const crossSite = await handler(new Request("https://parallax.example/auth/logout", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }));
    assert.equal(crossSite?.status, 403);

    const session = signSession({ subject: "user-1", role: "editor", expiresAt: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const cleared = await handler(new Request("https://parallax.example/auth/logout", {
      method: "POST",
      headers: {
        origin: "https://parallax.example",
        cookie: `${IDENTITY_COOKIE}=${encodeURIComponent(session)}`,
      },
    }));
    assert.equal(cleared?.status, 302);
    const cookieHeader = (cleared as Response).headers.getSetCookie().join("\n");
    assert.match(cookieHeader, new RegExp(`${IDENTITY_COOKIE}=`));
    assert.match(cookieHeader, /Max-Age=0/);
  });

  it("sends the browser only to a path on this origin", async () => {
    const handler = createIdentityHandler({ settings: SETTINGS, fetchImpl: provider({ sub: "u", entitlements: ["viewer"] }) });
    for (const hostile of ["//evil.example", "/\\evil.example", "https://evil.example"]) {
      const started = await handler(new Request(`https://parallax.example/auth/login?next=${encodeURIComponent(hostile)}`));
      assert.equal(cookiesOf(started as Response).get("__Host-parallax_oidc_return"), "/", hostile);
    }
  });

  /**
   * A cookie name that appears twice is one somebody else is also setting.
   *
   * Anything under a shared parent domain can set a cookie for that parent, and
   * the browser sends both. Reading the first one let a sibling host choose the
   * `state` and `verifier` this callback compares against -- so the victim's
   * browser would complete the attacker's authorization code and the session
   * that came back would be the attacker's account.
   */
  it("refuses a handshake whose state cookie somebody else is also setting", async () => {
    const handler = createIdentityHandler({
      settings: SETTINGS,
      fetchImpl: provider({ sub: "attacker", entitlements: ["admin"] }),
    });

    // Two sign-ins were started: the attacker's, and the victim's own. The
    // attacker holds the code and the state from theirs, and is positioned to
    // set a cookie for the parent domain, so the victim's browser now sends
    // both -- the attacker's first.
    const attacker = cookiesOf(await handler(new Request("https://parallax.example/auth/login?next=/")) as Response);
    const victim = cookiesOf(await handler(new Request("https://parallax.example/auth/login?next=/zones")) as Response);
    const attackerState = attacker.get("__Host-parallax_oidc_state") as string;

    // The callback carries the attacker's code and the attacker's state. Read
    // first-wins, the pair matches, the exchange completes -- and the session
    // the victim's browser is left holding belongs to the attacker's account.
    const shadowed = await handler(new Request(`https://parallax.example/auth/callback?code=attacker-code&state=${attackerState}`, {
      headers: {
        cookie: [
          `__Host-parallax_oidc_state=${attackerState}`,
          `__Host-parallax_oidc_verifier=${attacker.get("__Host-parallax_oidc_verifier")}`,
          `__Host-parallax_oidc_state=${victim.get("__Host-parallax_oidc_state")}`,
          `__Host-parallax_oidc_verifier=${victim.get("__Host-parallax_oidc_verifier")}`,
        ].join("; "),
      },
    }));
    assert.equal(shadowed?.status, 302);
    assert.match((shadowed as Response).headers.get("location") ?? "", /signin_error/u);
    // Not cleared -- never set. The failure path does not reach the exchange.
    assert.equal(cookiesOf(shadowed as Response).get(IDENTITY_COOKIE), undefined, "no session may be issued");
  });

  /**
   * The return cookie holds a path, not a token.
   *
   * Sharing the authentication side's value rule would have been the obvious
   * way to share the duplicate rule, and it would have dropped every return
   * path with a query string -- `?` is not in the token alphabet. The portal
   * builds `next` from `location.search` and `location.hash`, so the symptom
   * would have been landing on the root after signing in, with nothing said.
   */
  it("carries a return path that has a query string and a fragment", async () => {
    const handler = createIdentityHandler({ settings: SETTINGS, fetchImpl: provider({ sub: "u", entitlements: ["viewer"] }) });
    const next = "/zones?view=internal#rec";
    const started = await handler(new Request(`https://parallax.example/auth/login?next=${encodeURIComponent(next)}`));
    const handshake = cookiesOf(started as Response);
    assert.equal(handshake.get("__Host-parallax_oidc_return"), next);

    const state = handshake.get("__Host-parallax_oidc_state") as string;
    const done = await handler(new Request(`https://parallax.example/auth/callback?code=abc&state=${state}`, {
      headers: {
        cookie: [
          `__Host-parallax_oidc_state=${state}`,
          `__Host-parallax_oidc_verifier=${handshake.get("__Host-parallax_oidc_verifier")}`,
          `__Host-parallax_oidc_return=${encodeURIComponent(next)}`,
        ].join("; "),
      },
    }));
    assert.equal((done as Response).headers.get("location"), next);
  });
});

/**
 * The four endpoints, asked of the provider instead of assumed.
 *
 * They used to be `${issuer}/oidc/...`, which is one provider's layout and
 * nobody else's: Keycloak, Google, Okta and Entra all differ, so configuring
 * any of them meant filling in five variables and meeting a 404 at the first
 * redirect. The 2026-08-22 audit reported this and the decision to fix it was
 * taken on 2026-08-24.
 */
describe("OIDC discovery", () => {
  const ISSUER = "https://idp.example.com";

  /**
   * A provider serving its document.
   *
   * `issuer` defaults to the one being asked about, because a real provider
   * always publishes it and Discovery §4.3 makes the client check it. A test
   * that is about the issuer says so by giving its own.
   */
  function serving(document: unknown, status = 200): typeof fetch {
    const served = document !== null && typeof document === "object" && !("issuer" in document)
      ? { issuer: ISSUER, ...document }
      : document;
    return (async (input: string | URL | Request) => {
      assert.equal(String(input), `${ISSUER}/.well-known/openid-configuration`);
      return new Response(JSON.stringify(served), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  /** A document served exactly as given, for the tests that are about `issuer`. */
  function servingExactly(document: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify(document), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  }

  /**
   * OpenID Connect Discovery §4.3. This is the check that makes the
   * cross-origin endpoints below safe: without it, an open redirect under the
   * issuer -- or a takeover of one path on it -- hands an attacker this
   * deployment's `client_secret`, the authorization codes, and the claim the
   * role is read from. `fetch` follows redirects and `response.ok` stays true
   * afterwards, so the document really can come from anywhere.
   */
  it("refuses a discovery document that claims a different issuer", async () => {
    await assert.rejects(
      () => discoverEndpoints(ISSUER, servingExactly({
        issuer: "https://attacker.test",
        authorization_endpoint: "https://attacker.test/a",
        token_endpoint: "https://attacker.test/t",
        userinfo_endpoint: "https://attacker.test/u",
      })),
      /claims issuer "https:\/\/attacker.test", not/u,
    );
    // A document with no issuer at all is the same refusal, not a pass.
    await assert.rejects(
      () => discoverEndpoints(ISSUER, servingExactly({
        authorization_endpoint: `${ISSUER}/a`, token_endpoint: `${ISSUER}/t`, userinfo_endpoint: `${ISSUER}/u`,
      })),
      /claims issuer undefined/u,
    );
  });

  it("falls back to the issuer's own origin when discovery cannot be trusted", async () => {
    // The refusal must land on the safe side: `assumedEndpoints` stays on the
    // configured issuer, so a hostile document costs a round trip and nothing
    // else.
    const reasons: string[] = [];
    const resolve = createEndpointResolver(ISSUER, servingExactly({
      issuer: "https://attacker.test",
      authorization_endpoint: "https://attacker.test/a",
      token_endpoint: "https://attacker.test/t",
      userinfo_endpoint: "https://attacker.test/u",
    }), (reason) => reasons.push(reason));
    assert.deepEqual(await resolve(), assumedEndpoints(ISSUER));
    assert.match(reasons[0] ?? "", /claims issuer/u);
  });

  it("takes the endpoints the provider publishes, wherever it puts them", async () => {
    // Google is the everyday case: it issues as one host and hands its token
    // endpoint to another, so the endpoints are not required to share an origin.
    const endpoints = await discoverEndpoints(ISSUER, serving({
      issuer: ISSUER,
      authorization_endpoint: "https://idp.example.com/realms/main/protocol/openid-connect/auth",
      token_endpoint: "https://tokens.example.net/oauth2/token",
      userinfo_endpoint: "https://idp.example.com/realms/main/protocol/openid-connect/userinfo",
      end_session_endpoint: "https://idp.example.com/realms/main/protocol/openid-connect/logout",
    }));

    assert.equal(endpoints.token, "https://tokens.example.net/oauth2/token");
    const { url } = beginAuthorization(
      { issuer: ISSUER, clientId: "c", clientSecret: "s", redirectUri: "https://p.example/cb", scopes: "openid" },
      endpoints,
    );
    assert.ok(url.startsWith("https://idp.example.com/realms/main/protocol/openid-connect/auth?"), url);
  });

  it("keeps a query string the provider already put on its authorize URL", async () => {
    const endpoints = await discoverEndpoints(ISSUER, serving({
      authorization_endpoint: "https://idp.example.com/authorize?tenant=main",
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
    }));
    const { url } = beginAuthorization(
      { issuer: ISSUER, clientId: "c", clientSecret: "s", redirectUri: "https://p.example/cb", scopes: "openid" },
      endpoints,
    );
    assert.match(url, /\?tenant=main&response_type=code/u);
  });

  it("refuses an endpoint it would not have been willing to talk to", async () => {
    await assert.rejects(discoverEndpoints(ISSUER, serving({
      authorization_endpoint: "http://idp.example.com/authorize",
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
    })), /not an https URL/u);
  });

  it("sends the browser home when the provider offers no way to end its session", async () => {
    const endpoints = await discoverEndpoints(ISSUER, serving({
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
    }));
    assert.equal(endpoints.endSession, undefined);
    // A 404 on the way out of a logout that did clear the local cookie is worse
    // than simply landing where the redirect was going.
    assert.equal(endSessionUrl(endpoints, "id-token", "https://portal.example/"), "https://portal.example/");
  });

  /**
   * ⚠️ The fallback is not a shim for a hypothetical. It is the layout the
   * deployment running today is configured against, and removing it in the same
   * change that adds discovery would turn a compatibility fix into an outage.
   */
  it("falls back to the layout it used to assume, and says that it did", async () => {
    const reasons: string[] = [];
    const resolve = createEndpointResolver(ISSUER, serving({}, 404), (reason) => reasons.push(reason));

    assert.deepEqual(await resolve(), assumedEndpoints(ISSUER));
    assert.equal(reasons.length, 1);
    assert.match(reasons[0] ?? "", /no discovery document \(404\)/u);
  });

  it("asks once when it succeeds, and again after it fails", async () => {
    let asked = 0;
    const flaky = (async () => {
      asked += 1;
      if (asked === 1) return new Response("nope", { status: 503 });
      return new Response(JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/a`, token_endpoint: `${ISSUER}/t`, userinfo_endpoint: `${ISSUER}/u`,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const resolve = createEndpointResolver(ISSUER, flaky);

    assert.deepEqual(await resolve(), assumedEndpoints(ISSUER), "the first attempt fell back");
    assert.equal((await resolve()).authorization, `${ISSUER}/a`, "and the next one asked again");
    await resolve();
    assert.equal(asked, 2, "once it has an answer it stops asking");
  });

  it("reads the role from the claim the deployment names", async () => {
    const userinfo = (async () => new Response(
      JSON.stringify({ sub: "person", "parallax/role": ["editor"], entitlements: ["admin"] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
    const config: OidcConfig = {
      issuer: ISSUER, clientId: "c", clientSecret: "s", redirectUri: "https://p.example/cb",
      scopes: "openid", roleClaim: "parallax/role",
    };

    const identity = await readIdentity(config, assumedEndpoints(ISSUER), { accessToken: "t", expiresIn: 300 }, userinfo);

    assert.equal(identity.role, "editor", "the named claim, not the default one beside it");
  });
});
