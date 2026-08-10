import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authenticate,
  authorize,
  createAuthorizedHandler,
  type SecurityConfig,
} from "../../src/security/http-authorization.ts";

const config: SecurityConfig = {
  enabled: true,
  tokens: [
    { token: "viewer-secret", role: "viewer", subject: "read-only" },
    { token: "editor-secret", role: "editor", subject: "operator" },
    { token: "admin-secret", role: "admin", subject: "owner" },
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
    assert.deepEqual(authenticate(request("/api/v1/zones", "GET", "viewer-secret"), config), {
      role: "viewer",
      subject: "read-only",
    });
  });

  it("accepts a strictly parsed percent-encoded session cookie", () => {
    const cookieRequest = new Request("https://portal.example/api/v1/zones", {
      headers: { cookie: "theme=dark; parallax_session=viewer%2Dsecret" },
    });
    assert.equal(authenticate(cookieRequest, config)?.role, "viewer");
  });

  it("rejects malformed bearer credentials and ambiguous session cookies", () => {
    const malformed = new Request("https://portal.example/api/v1/zones", {
      headers: { authorization: "Basic viewer-secret", cookie: "parallax_session=viewer-secret" },
    });
    assert.equal(authenticate(malformed, config), undefined);

    const duplicate = new Request("https://portal.example/api/v1/zones", {
      headers: { cookie: "parallax_session=viewer-secret; parallax_session=editor-secret" },
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
          { token: "duplicated-secret", role: "viewer", subject: "reader" },
          { token: "duplicated-secret", role: "admin", subject: "owner" },
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
    assert.equal(authorize(editor, request("/api/v1/zones/example.com/revisions/2/restore", "POST")), true);
    assert.equal(authorize(editor, request("/api/v1/zones/example.com", "DELETE")), false);
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
    const forbidden = await handler(request("/api/v1/zones", "POST", "viewer-secret"));
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: "forbidden", message: "insufficient permissions" });

    const allowed = await handler(request("/api/v1/zones/example.com", "PUT", "editor-secret"));
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { actor: "operator" });
  });

  it("requires same-origin proof for cookie-authenticated mutations", async () => {
    const cookieHeaders = { cookie: "parallax_session=editor-secret" };
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
