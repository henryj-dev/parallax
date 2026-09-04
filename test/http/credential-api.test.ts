import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CloudflareCredentialManager } from "../../src/application/cloudflare-credentials.ts";
import { ZoneLookupForbiddenError, ZoneNotFoundError } from "../../src/adapters/cloudflare.ts";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { RoutingProviderAdapter } from "../../src/adapters/router.ts";
import { createApiHandler } from "../../src/http/api.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";
import { EncryptedCredentialStore } from "../../src/security/credential-store.ts";

const security = {
  enabled: true,
  tokens: [
    { token: "admin-token-000000000000000000000", role: "admin" as const, subject: "administrator" },
    { token: "editor-token-00000000000000000000", role: "editor" as const, subject: "operator" },
  ],
};

function request(path: string, method = "GET", body?: unknown, token = "admin-token-000000000000000000000"): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Cloudflare credential HTTP API", () => {

  it("answers a failed zone lookup with what the operator has to change", async () => {
    // These reach the HTTP layer only through the credential paths, so a claim
    // that the message "is not silent" is about this mapping, not about the
    // error being thrown. Unmapped, all three arrived as 500 internal_error.
    const directory = await mkdtemp(join(tmpdir(), "parallax-lookup-"));
    try {
      const store = new EncryptedCredentialStore({
        repository: new FileConfigurationStore(join(directory, "configuration.json")).credentials,
        masterKey: randomBytes(32),
      });
      let failure: Error = new ZoneLookupForbiddenError("grant it Zone -> Zone -> Read");
      const manager = new CloudflareCredentialManager({
        store,
        router: new RoutingProviderAdapter({}),
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        resolveZoneId: async () => { throw failure; },
        createAdapter: () => ({ async list() { return []; }, async apply() {} }),
      });
      await manager.upsertProfile("shared", { token: "top-secret" });
      const adapters = createInMemoryAdapters();
      const api = createApiHandler({
        controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider),
        credentials: manager,
      }, { enabled: false, tokens: [] });
      const test = () => api(new Request("http://localhost/api/v1/credentials/cloudflare/example.com/test", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ profile: "shared" }),
      }));

      let response = await test();
      assert.equal(response.status, 403);
      assert.match((await response.json() as { message: string }).message, /Zone -> Zone -> Read/);

      failure = new ZoneNotFoundError("no Cloudflare zone named example.com is visible to this token");
      response = await test();
      assert.equal(response.status, 404);

      // Anything else is the provider refusing the credential, which is what a
      // test reports -- not an internal fault.
      failure = new Error("Cloudflare API request failed while looking up example.com (HTTP 400)");
      response = await test();
      assert.equal(response.status, 502);
      assert.equal((await response.json() as { error: string }).error, "provider_test_failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("is admin-only and never returns a token while supporting list, metadata, test, update, and delete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-credential-api-"));
    try {
      const adapters = createInMemoryAdapters();
      const manager = new CloudflareCredentialManager({
        store: new EncryptedCredentialStore({ repository: new FileConfigurationStore(join(directory, "configuration.json")).credentials, masterKey: randomBytes(32) }),
        router: new RoutingProviderAdapter({ fallback: adapters.provider }),
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        resolveZoneId: async (zone) => `id-for-${zone}`,
        createAdapter: () => ({ async list() { return []; }, async apply() {} }),
      });
      const api = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), credentials: manager }, security);
      const secret = "never-return-this-token";

      assert.equal((await api(request("/api/v1/credentials/cloudflare", "GET", undefined, "editor-token-00000000000000000000"))).status, 403);
      assert.equal((await api(request("/api/v1/credentials/cloudflare/example.com", "PUT", { token: secret }))).status, 200);

      for (const path of ["/api/v1/credentials/cloudflare", "/api/v1/credentials/cloudflare/example.com"]) {
        const response = await api(request(path));
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.equal(text.includes(secret), false);
        assert.equal(text.includes('"token"'), false);
        assert.match(text, /id-for-example\.com/);
      }

      const tested = await api(request("/api/v1/credentials/cloudflare/example.com/test", "POST"));
      assert.equal(tested.status, 200);
      assert.deepEqual(await tested.json(), {
        ok: true,
        credential: (await manager.getZone("example.com")),
      });
      assert.equal((await api(request("/api/v1/credentials/cloudflare/example.com", "DELETE"))).status, 204);
      assert.equal((await api(request("/api/v1/credentials/cloudflare/example.com"))).status, 404);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses one profile across apex domains and refuses to delete it while bound", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-credential-api-"));
    try {
      const adapters = createInMemoryAdapters();
      const manager = new CloudflareCredentialManager({
        store: new EncryptedCredentialStore({ repository: new FileConfigurationStore(join(directory, "configuration.json")).credentials, masterKey: randomBytes(32) }),
        router: new RoutingProviderAdapter({ fallback: adapters.provider }),
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        resolveZoneId: async (zone) => `id-for-${zone}`,
        createAdapter: () => ({ async list() { return []; }, async apply() {} }),
      });
      const api = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), credentials: manager }, security);
      const secret = "account-wide-token";

      const before = Date.now();
      assert.equal((await api(request("/api/v1/credentials/profiles/account-a", "PUT", {
        accountId: "acct-1", token: secret,
      }))).status, 200);

      // The token is entered once and every apex domain points at the profile.
      for (const [zone, zoneId] of [["one.example", "z1"], ["two.example", "z2"]] as const) {
        assert.equal((await api(request(`/api/v1/credentials/cloudflare/${zone}`, "PUT", {
          zoneId, profile: "account-a",
        }))).status, 200);
      }

      const profiles = await (await api(request("/api/v1/credentials/profiles"))).json() as {
        profiles: Array<{ name: string; accountId?: string; updatedAt: string; zones: string[] }>;
      };
      const [listed, ...others] = profiles.profiles;
      assert.deepEqual(others, [], "one profile, listed once");
      assert.ok(listed, "the profile the token was entered against is listed");
      // `updatedAt` is held out of the comparison rather than filled in from the
      // response. Writing `updatedAt: profiles.profiles[0]?.updatedAt` compares
      // the field to itself, so a route that blanked or garbled the stamp would
      // pass -- and this stamp is what an operator reads to decide whether a
      // credential is the one they rotated. Assert its shape, and that it is not
      // older than the request that created it.
      const { updatedAt, ...rest } = listed;
      assert.deepEqual(rest, { name: "account-a", accountId: "acct-1", zones: ["one.example", "two.example"] });
      assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, "an ISO-8601 instant in UTC");
      assert.ok(Date.parse(updatedAt) >= before, `${updatedAt} predates the write that produced it`);
      assert.equal(JSON.stringify(profiles).includes(secret), false);

      const bound = await api(request("/api/v1/credentials/profiles/account-a", "DELETE"));
      assert.equal(bound.status, 409);
      assert.match(JSON.stringify(await bound.json()), /one\.example, two\.example/);

      assert.equal((await api(request("/api/v1/credentials/cloudflare/one.example", "DELETE"))).status, 204);
      assert.equal((await api(request("/api/v1/credentials/cloudflare/two.example", "DELETE"))).status, 204);
      assert.equal((await api(request("/api/v1/credentials/profiles/account-a", "DELETE"))).status, 204);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("tests an unsaved credential without persisting it and returns a redacted provider error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-credential-api-"));
    try {
      const adapters = createInMemoryAdapters();
      const manager = new CloudflareCredentialManager({
        store: new EncryptedCredentialStore({ repository: new FileConfigurationStore(join(directory, "configuration.json")).credentials, masterKey: randomBytes(32) }),
        router: new RoutingProviderAdapter(),
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        resolveZoneId: async (zone) => `id-for-${zone}`,
        createAdapter: () => ({ async list() { throw new Error("leaked secret-value"); }, async apply() {} }),
      });
      const api = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), credentials: manager }, security);
      const response = await api(request(
        "/api/v1/credentials/cloudflare/example.com/test",
        "POST",
        { token: "secret-value" },
      ));
      assert.equal(response.status, 502);
      const text = await response.text();
      assert.equal(text.includes("secret-value"), false);
      assert.deepEqual(await manager.listZones(), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
