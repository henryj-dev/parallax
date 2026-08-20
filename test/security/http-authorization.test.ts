import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authenticate,
  authorize,
  createAuthorizedHandler,
  setTrustedClientKey,
  type SecurityConfig,
} from "../../src/security/http-authorization.ts";

const config: SecurityConfig = {
  enabled: true,
  tokens: [
    { token: "viewer-secret-0000000000000000000", role: "viewer", subject: "read-only" },
    { token: "editor-secret-0000000000000000000", role: "editor", subject: "operator" },
    { token: "admin-secret-00000000000000000000", role: "admin", subject: "owner" },
  ],
};

function request(path: string, method = "GET", token?: string): Request {
  return new Request(`https://portal.example${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

describe("HTTP token authentication", () => {
  it("authenticates bearer tokens without returning the token", () => {
    assert.deepEqual(authenticate(request("/api/v1/zones", "GET", "viewer-secret-0000000000000000000"), config), {
      role: "viewer",
      subject: "read-only",
    });
  });

  it("accepts a strictly parsed percent-encoded session cookie", () => {
    const cookieRequest = new Request("https://portal.example/api/v1/zones", {
      headers: { cookie: "theme=dark; parallax_session=viewer%2Dsecret%2D0000000000000000000" },
    });
    assert.equal(authenticate(cookieRequest, config)?.role, "viewer");
  });

  it("rejects malformed bearer credentials and ambiguous session cookies", () => {
    const malformed = new Request("https://portal.example/api/v1/zones", {
      headers: { authorization: "Basic viewer-secret", cookie: "parallax_session=viewer-secret-0000000000000000000" },
    });
    assert.equal(authenticate(malformed, config), undefined);

    const duplicate = new Request("https://portal.example/api/v1/zones", {
      headers: { cookie: "parallax_session=viewer-secret-0000000000000000000; parallax_session=editor-secret-0000000000000000000" },
    });
    assert.equal(authenticate(duplicate, config), undefined);
  });

  it("can be explicitly disabled without reading credentials", () => {
    assert.deepEqual(authenticate(request("/api/v1/zones"), { enabled: false, tokens: [] }), {
      role: "admin",
      subject: "authentication-disabled",
    });
  });

  it("rejects invalid or duplicate token configuration without echoing secrets", () => {
    assert.throws(
      () => createAuthorizedHandler({
        enabled: true,
        tokens: [{ token: "secret with spaces", role: "admin", subject: "owner" }],
      }, async () => new Response()),
      (error: unknown) => error instanceof TypeError
        && error.message === "invalid security configuration"
        && !error.message.includes("secret with spaces"),
    );

    assert.throws(
      () => createAuthorizedHandler({
        enabled: true,
        tokens: [
          { token: "duplicated-secret-000000000000000", role: "viewer", subject: "reader" },
          { token: "duplicated-secret-000000000000000", role: "admin", subject: "owner" },
        ],
      }, async () => new Response()),
      /invalid security configuration/,
    );
  });
});

describe("HTTP role authorization", () => {
  it("allows viewers to read but not mutate", () => {
    const viewer = { role: "viewer", subject: "read-only" } as const;
    assert.equal(authorize(viewer, request("/api/v1/zones")), true);
    assert.equal(authorize(viewer, request("/api/v1/zones", "POST")), false);
  });

  it("allows editors to manage desired state, preview and apply", () => {
    const editor = { role: "editor", subject: "operator" } as const;
    assert.equal(authorize(editor, request("/api/v1/zones", "POST")), true);
    assert.equal(authorize(editor, request("/api/v1/zones/example.com", "PUT")), true);
    assert.equal(authorize(editor, request("/api/v1/zones/example.com/views/external/records/root", "DELETE")), true);
    assert.equal(authorize(editor, request("/api/v1/zones/example.com/preview", "POST")), true);
    assert.equal(authorize(editor, request("/api/v1/zones/example.com/apply", "POST")), true);
    assert.equal(authorize(editor, request("/api/v1/apply", "POST")), true);
    assert.equal(authorize(editor, request("/api/v1/zones/example.com/import", "POST")), true);
    assert.equal(authorize(editor, request("/api/v1/zones/example.com/adopt", "POST")), true);
    assert.equal(authorize(editor, request("/api/v1/zones/example.com/revisions/2/restore", "POST")), true);
    assert.equal(authorize(editor, request("/api/v1/zones/example.com", "DELETE")), false);
  });

  it("keeps zone adopt off the viewer path", () => {
    const viewer = { role: "viewer", subject: "read-only" } as const;
    assert.equal(authorize(viewer, request("/api/v1/zones/example.com/adopt", "POST")), false);
  });

  it("reserves zone deletion and credential paths for admins", () => {
    const admin = { role: "admin", subject: "owner" } as const;
    assert.equal(authorize(admin, request("/api/v1/zones/example.com", "DELETE")), true);
    assert.equal(authorize(admin, request("/api/v1/credentials/cloudflare", "PUT")), true);
    assert.equal(authorize({ role: "editor", subject: "operator" }, request("/api/v1/credentials/cloudflare", "GET")), false);
  });
});

describe("authorized handler", () => {
  const downstream = async (incoming: Request): Promise<Response> => Response.json({
    actor: incoming.headers.get("x-parallax-actor"),
  });
  const handler = createAuthorizedHandler(config, downstream);

  it("returns uniform no-store 401 errors without exposing supplied secrets", async () => {
    for (const incoming of [request("/api/v1/zones"), request("/api/v1/zones", "GET", "wrong-secret")]) {
      const response = await handler(incoming);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
      const body = await response.text();
      assert.equal(body, '{"error":"unauthorized","message":"authentication required"}');
      assert.doesNotMatch(body, /wrong-secret|viewer-secret/);
    }
  });

  it("returns a uniform 403 and propagates the authenticated subject as actor", async () => {
    const forbidden = await handler(request("/api/v1/zones", "POST", "viewer-secret-0000000000000000000"));
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: "forbidden", message: "insufficient permissions" });

    const allowed = await handler(request("/api/v1/zones/example.com", "PUT", "editor-secret-0000000000000000000"));
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { actor: "operator" });
  });

  it("rejects tokens that are too short to resist guessing", () => {
    assert.throws(
      () => createAuthorizedHandler({ enabled: true, tokens: [{ token: "short-admin-token", role: "admin", subject: "owner" }] }, downstream),
      /invalid security configuration/,
    );
  });

  it("stops answering after repeated authentication failures without blocking a valid token", async () => {
    let clock = 1_000;
    const throttled = createAuthorizedHandler(
      { ...config, maxFailedAttempts: 3, lockoutMs: 60_000 },
      downstream,
      () => clock,
    );
    const guess = async (): Promise<Response> => throttled(request("/api/v1/zones", "GET", "wrong-secret-0000000000000000000"));

    for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await guess()).status, 401);
    const blocked = await guess();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "60");

    // A holder of a real token is never punished for someone else's guessing.
    const allowed = await throttled(request("/api/v1/zones", "GET", "viewer-secret-0000000000000000000"));
    assert.equal(allowed.status, 200);

    clock += 60_001;
    assert.equal((await guess()).status, 401);
  });

  it("isolates failure budgets per trusted transport client", async () => {
    const throttled = createAuthorizedHandler(
      { ...config, maxFailedAttempts: 2, lockoutMs: 60_000 },
      downstream,
      () => 1_000,
    );
    const call = async (client: string, token: string): Promise<Response> => {
      const incoming = request("/api/v1/zones", "GET", token);
      setTrustedClientKey(incoming, client);
      return throttled(incoming);
    };

    assert.equal((await call("attacker", "wrong-secret-0000000000000000000")).status, 401);
    assert.equal((await call("attacker", "wrong-secret-0000000000000000000")).status, 401);
    assert.equal((await call("attacker", "viewer-secret-0000000000000000000")).status, 200,
      "a valid credential is always accepted even while failures are counted");
    assert.equal((await call("valid-client", "viewer-secret-0000000000000000000")).status, 200);
    assert.equal((await call("attacker", "wrong-secret-0000000000000000000")).status, 429,
      "neither the attacker's valid credential nor another client may reset its failure budget");
    assert.equal((await call("unrelated", "wrong-secret-0000000000000000000")).status, 401,
      "one attacker must not globally lock out unrelated clients");
  });

  it("owns the audit actor even when authentication is disabled", async () => {
    const open = createAuthorizedHandler({ enabled: false, tokens: [] }, downstream);
    const response = await open(new Request("https://portal.example/api/v1/zones", {
      headers: { "x-parallax-actor": "spoofed" },
    }));
    assert.deepEqual(await response.json(), { actor: "authentication-disabled" });
  });

  it("keeps provider-querying previews away from read-only tokens", async () => {
    assert.equal((await handler(request("/api/v1/zones/example.com/preview", "GET", "viewer-secret-0000000000000000000"))).status, 403);
    assert.equal((await handler(request("/api/v1/zones/example.com/preview", "GET", "editor-secret-0000000000000000000"))).status, 200);
    assert.equal((await handler(request("/api/v1/zones/example.com/status", "GET", "viewer-secret-0000000000000000000"))).status, 200);
  });

  it("exchanges a token for an HttpOnly session cookie the page cannot read", async () => {
    const issued = await handler(new Request("https://portal.example/api/v1/session", {
      method: "POST",
      headers: { origin: "https://portal.example", "content-type": "application/json" },
      body: JSON.stringify({ token: "editor-secret-0000000000000000000" }),
    }));

    assert.equal(issued.status, 200);
    assert.deepEqual(await issued.json(), { role: "editor", subject: "operator", expiresIn: 43_200 });
    const cookie = issued.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^parallax_session=editor-secret-0000000000000000000;/);
    for (const attribute of ["Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=43200", "Secure"]) {
      assert.ok(cookie.includes(attribute), `${attribute} in ${cookie}`);
    }

    // The issued cookie authenticates the next request.
    const reused = await handler(new Request("https://portal.example/api/v1/zones", {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    }));
    assert.deepEqual(await reused.json(), { actor: "operator" });
  });

  it("omits Secure on a plain-HTTP origin so a loopback session still works", async () => {
    const issued = await handler(new Request("http://127.0.0.1:3000/api/v1/session", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ token: "admin-secret-00000000000000000000" }),
    }));
    const cookie = issued.headers.get("set-cookie") ?? "";
    assert.equal(issued.status, 200);
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(!cookie.includes("Secure"), cookie);
  });

  it("refuses to issue a session cross-site, for a bad token, or without proof of origin", async () => {
    const body = JSON.stringify({ token: "admin-secret-00000000000000000000" });
    const crossSite = await handler(new Request("https://portal.example/api/v1/session", {
      method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body,
    }));
    assert.equal(crossSite.status, 403);

    const noProof = await handler(new Request("https://portal.example/api/v1/session", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }));
    assert.equal(noProof.status, 403);

    const wrongToken = await handler(new Request("https://portal.example/api/v1/session", {
      method: "POST",
      headers: { origin: "https://portal.example", "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-configured-token-0000000000" }),
    }));
    assert.equal(wrongToken.status, 401);
    assert.doesNotMatch(await wrongToken.text(), /not-a-configured-token/);
  });

  it("clears the session cookie on sign-out", async () => {
    const cleared = await handler(new Request("https://portal.example/api/v1/session", {
      method: "DELETE",
      headers: { "sec-fetch-site": "same-origin" },
    }));
    assert.equal(cleared.status, 204);
    const cookie = cleared.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^parallax_session=;/);
    assert.ok(cookie.includes("Max-Age=0"), cookie);
  });

  it("accepts Sec-Fetch-Site as same-origin proof for cookie-authenticated mutations", async () => {
    const allowed = await handler(new Request("https://portal.example/api/v1/zones/example.com/apply", {
      method: "POST",
      headers: { cookie: "parallax_session=editor-secret-0000000000000000000", "sec-fetch-site": "same-origin" },
    }));
    assert.equal(allowed.status, 200);

    const crossSite = await handler(new Request("https://portal.example/api/v1/zones/example.com/apply", {
      method: "POST",
      headers: { cookie: "parallax_session=editor-secret-0000000000000000000", "sec-fetch-site": "cross-site" },
    }));
    assert.equal(crossSite.status, 403);
  });

  it("requires same-origin proof for cookie-authenticated mutations", async () => {
    const cookieHeaders = { cookie: "parallax_session=editor-secret-0000000000000000000" };
    const rejected = await handler(new Request("https://portal.example/api/v1/zones/example.com/apply", {
      method: "POST",
      headers: cookieHeaders,
    }));
    assert.equal(rejected.status, 403);

    const allowed = await handler(new Request("https://portal.example/api/v1/zones/example.com/apply", {
      method: "POST",
      headers: { ...cookieHeaders, origin: "https://portal.example" },
    }));
    assert.equal(allowed.status, 200);
  });
});
