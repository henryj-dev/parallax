import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIdentityHandler } from "../../src/http/identity-routes.ts";
import { authenticate, IDENTITY_COOKIE, withIdentityProvider } from "../../src/security/http-authorization.ts";
import { readIdentity, type OidcConfig } from "../../src/security/oidc.ts";
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
    const state = handshake.get("parallax_oidc_state") as string;
    assert.match((started as Response).headers.get("location") ?? "", /code_challenge_method=S256/);

    const done = await handler(new Request(`https://parallax.example/auth/callback?code=abc&state=${state}`, {
      headers: { cookie: `parallax_oidc_state=${state}; parallax_oidc_verifier=${handshake.get("parallax_oidc_verifier")}; parallax_oidc_return=/zones` },
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
      readIdentity(CONFIG, { accessToken: "t", expiresIn: 300 }, provider({ sub: "stranger" })),
      (error: Error) => {
        // Anyone in the directory can authenticate; that is not the same as
        // being someone here, and defaulting would make it the same.
        assert.match(error.message, /no entitlement for Parallax/);
        return true;
      },
    );
  });

  it("does not take a role or a group as permission", async () => {
    // The provider labels people with `roles` and places them with `groups`,
    // and says in its own console that neither is for authorization. A holder
    // of both and no entitlement is somebody with a job title, not a grant.
    await assert.rejects(
      readIdentity(CONFIG, { accessToken: "t", expiresIn: 300 },
        provider({ sub: "labelled", roles: ["admin"], groups: ["platform"], roles_label: "Administrator" })),
      (error: Error) => {
        assert.match(error.message, /no entitlement for Parallax/);
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
      assert.equal(cookiesOf(started as Response).get("parallax_oidc_return"), "/", hostile);
    }
  });
});
