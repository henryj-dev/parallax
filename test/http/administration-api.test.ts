import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccessTokenService } from "../../src/application/access-tokens.ts";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { SettingsService } from "../../src/application/settings.ts";
import type { AccessTokenRepository, SettingsRepository, StoredAccessToken } from "../../src/application/ports.ts";
import { createApiHandler } from "../../src/http/api.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";

const security = {
  enabled: true,
  tokens: [
    { token: "admin-token-000000000000000000000", role: "admin" as const, subject: "administrator" },
    { token: "editor-token-00000000000000000000", role: "editor" as const, subject: "operator" },
  ],
};

class MemorySettingsRepository implements SettingsRepository {
  values: Record<string, unknown> = {};
  async read(): Promise<Record<string, unknown>> { return { ...this.values }; }
  async write(patch: Record<string, unknown>): Promise<void> { this.values = { ...this.values, ...patch }; }
}

class MemoryAccessTokenRepository implements AccessTokenRepository {
  tokens: StoredAccessToken[] = [];
  async list(): Promise<StoredAccessToken[]> { return this.tokens.map((token) => ({ ...token })); }
  async create(token: StoredAccessToken): Promise<void> { this.tokens.push({ ...token }); }
  async delete(id: string): Promise<boolean> {
    const index = this.tokens.findIndex((token) => token.id === id);
    if (index < 0) return false;
    this.tokens.splice(index, 1);
    return true;
  }
}

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

async function setup() {
  const adapters = createInMemoryAdapters();
  const settings = new SettingsService(new MemorySettingsRepository());
  const accessTokens = new AccessTokenService(new MemoryAccessTokenRepository(), security.tokens);
  await settings.load();
  await accessTokens.load();
  const api = createApiHandler(
    new ControlPlane(adapters.zones, adapters.statuses, adapters.provider),
    security,
    undefined,
    { settings, accessTokens },
  );
  return { api, settings, accessTokens };
}

describe("administration HTTP API", () => {
  it("reads and updates settings, and refuses an unusable value", async () => {
    const { api, settings } = await setup();

    const read = await (await api(request("/api/v1/settings"))).json() as { settings: Record<string, unknown> };
    assert.equal(read.settings.revisionRetention, 100);
    assert.equal(read.settings.allowLocalProvider, false);

    const updated = await api(request("/api/v1/settings", "PUT", { allowLocalProvider: true, revisionRetention: 7 }));
    assert.equal(updated.status, 200);
    assert.equal(settings.current().allowLocalProvider, true);
    assert.equal(settings.current().revisionRetention, 7);

    const rejected = await api(request("/api/v1/settings", "PUT", { revisionRetention: -1 }));
    assert.equal(rejected.status, 400);
    assert.equal(settings.current().revisionRetention, 7);

    const unknown = await api(request("/api/v1/settings", "PUT", { madeUpSetting: true }));
    assert.equal(unknown.status, 400);
    assert.match(JSON.stringify(await unknown.json()), /unknown setting/);
  });

  it("issues a token once, lists it without the secret, and revokes it", async () => {
    const { api } = await setup();

    const created = await api(request("/api/v1/tokens", "POST", { subject: "deploy-bot", role: "editor" }));
    assert.equal(created.status, 201);
    const issued = await created.json() as { token: string; metadata: { id: string; subject: string } };
    assert.equal(issued.metadata.subject, "deploy-bot");
    assert.ok(issued.token.length >= 43);

    const listed = await (await api(request("/api/v1/tokens"))).json() as { tokens: Array<{ subject: string; managed: boolean }> };
    assert.equal(JSON.stringify(listed).includes(issued.token), false);
    assert.deepEqual(listed.tokens.map((token) => [token.subject, token.managed]), [
      ["administrator", true],
      ["operator", true],
      ["deploy-bot", false],
    ]);

    assert.equal((await api(request(`/api/v1/tokens/${issued.metadata.id}`, "DELETE"))).status, 204);
    assert.equal((await api(request(`/api/v1/tokens/${issued.metadata.id}`, "DELETE"))).status, 404);
  });

  it("keeps administration surfaces away from non-administrators", async () => {
    const { api } = await setup();
    const editor = "editor-token-00000000000000000000";

    for (const path of ["/api/v1/settings", "/api/v1/tokens"]) {
      assert.equal((await api(request(path, "GET", undefined, editor))).status, 403, path);
    }
    assert.equal((await api(request("/api/v1/settings", "PUT", { revisionRetention: 1 }, editor))).status, 403);
    assert.equal((await api(request("/api/v1/tokens", "POST", { subject: "x", role: "admin" }, editor))).status, 403);
  });

  it("reports the routes as absent when administration is not wired in", async () => {
    const adapters = createInMemoryAdapters();
    const api = createApiHandler(new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), security);
    assert.equal((await api(request("/api/v1/settings"))).status, 404);
    assert.equal((await api(request("/api/v1/tokens"))).status, 404);
  });
});
