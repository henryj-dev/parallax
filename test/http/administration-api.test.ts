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
  #tail: Promise<void> = Promise.resolve();
  async read(): Promise<Record<string, unknown>> {
    await this.#tail;
    return { ...this.values };
  }
  async write(patch: Record<string, unknown>): Promise<void> { this.values = { ...this.values, ...patch }; }
  update<T>(
    operation: (current: Record<string, unknown>) => Promise<{ patch: Record<string, unknown>; result: T }>,
  ): Promise<T> {
    const result = this.#tail.then(async () => {
      const replacement = await operation({ ...this.values });
      await this.write(replacement.patch);
      return replacement.result;
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

class MemoryAccessTokenRepository implements AccessTokenRepository {
  tokens: StoredAccessToken[] = [];
  async list(): Promise<StoredAccessToken[]> { return this.tokens.map((token) => ({ ...token })); }
  async create(token: StoredAccessToken): Promise<void> { this.tokens.push({ ...token }); }
  async revoke(id: string, retainedAdministratorCount: number): Promise<"deleted" | "not-found" | "last-admin"> {
    const index = this.tokens.findIndex((token) => token.id === id);
    if (index < 0) return "not-found";
    if (this.tokens[index]?.role === "admin"
      && this.tokens.filter((token, tokenIndex) => tokenIndex !== index && token.role === "admin").length + retainedAdministratorCount === 0) {
      return "last-admin";
    }
    this.tokens.splice(index, 1);
    return "deleted";
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
    { controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), settings, accessTokens },
    security,
  );
  return { api, settings, accessTokens };
}

describe("the override report over HTTP", () => {
  /** A credential manager that holds bindings and no provider at all. */
  function credentialsHolding(bindings: { zone: string; profile: string }[]) {
    return { listZones: async () => bindings.map((binding) => ({ ...binding })) };
  }

  it("says why each zone is or is not covered, without reaching a provider", async () => {
    // The route exists because the answer used to require a shell on the pod,
    // and it must not need the credential to work: the day somebody asks is
    // often the day the token is the broken thing.
    const adapters = createInMemoryAdapters();
    const control = new ControlPlane(adapters.zones, adapters.statuses, adapters.provider);
    await control.createZone("tinymail.app");
    await control.createZone("tinyuniver.se");
    await control.upsertRecord("tinyuniver.se", "internal", "inside", { name: "www", type: "A", content: "10.17.192.11", ttl: 300 });
    const api = createApiHandler(
      {
        controlPlane: control,
        credentials: credentialsHolding([
          { zone: "tinymail.app", profile: "main" },
          { zone: "tinyuniver.se", profile: "main" },
        ]) as unknown as Parameters<typeof createApiHandler>[0]["credentials"],
      },
      security,
    );

    const response = await api(request("/api/v1/fallback/main/coverage"));
    assert.equal(response.status, 200);
    const body = await response.json() as { profile: string; zones: { zone: string; covered: boolean; reason: string }[] };
    assert.equal(body.profile, "main");
    assert.deepEqual(body.zones, [
      // Bound, but nothing to answer for, so the listener claims no authority.
      { zone: "tinymail.app", covered: false, reason: "empty", profile: "main" },
      { zone: "tinyuniver.se", covered: true, reason: "covered", profile: "main" },
    ]);
  });

  it("refuses a route that does not exist rather than guessing an action", async () => {
    const { api } = await setup();
    assert.equal((await api(request("/api/v1/fallback/main/nonsense"))).status, 404);
    assert.equal((await api(request("/api/v1/fallback"))).status, 404);
  });
});

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

  it("runs any command through the API, so the CLI surface is reachable over HTTP", async () => {
    const { api } = await setup();

    const created = await api(request("/api/v1/cli", "POST", { argv: ["zone", "create", "--zone", "example.com"] }));
    assert.equal(created.status, 200);
    assert.deepEqual((await created.json() as { command: string }).command, "zone create");

    const listed = await api(request("/api/v1/cli", "POST", { argv: ["zone", "list"] }));
    const body = await listed.json() as { command: string; result: { zones: Array<{ name: string }> } };
    assert.deepEqual(body.result.zones.map((zone) => zone.name), ["example.com"]);

    // The same command, reached the ordinary way, gives the same answer.
    const direct = await (await api(request("/api/v1/zones"))).json() as { zones: Array<{ name: string }> };
    assert.deepEqual(direct.zones.map((zone) => zone.name), ["example.com"]);
  });

  it("applies the caller's role to a command reached through the API", async () => {
    const { api } = await setup();
    const editor = "editor-token-00000000000000000000";

    // An editor may run an editor command over the endpoint...
    assert.equal((await api(request("/api/v1/cli", "POST", { argv: ["zone", "create", "--zone", "a.example"] }, editor))).status, 200);
    // ...but the endpoint is not a way around what the role cannot do.
    const forbidden = await api(request("/api/v1/cli", "POST", { argv: ["settings", "get"] }, editor));
    assert.equal(forbidden.status, 403);
    assert.match(JSON.stringify(await forbidden.json()), /requires the admin role/);
  });

  it("rejects an unusable command invocation without running anything", async () => {
    const { api } = await setup();
    for (const argv of [["nonsense"], ["zone", "list", "extra"]]) {
      const response = await api(request("/api/v1/cli", "POST", { argv }));
      assert.equal(response.status, 400, JSON.stringify(argv));
    }
    assert.equal((await api(request("/api/v1/cli", "POST", { argv: "zone list" }))).status, 400);
    assert.equal((await api(request("/api/v1/cli", "POST", { argv: ["zone", "get"] }))).status, 400);
  });

  it("reports the routes as absent when administration is not wired in", async () => {
    const adapters = createInMemoryAdapters();
    const api = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) }, security);
    assert.equal((await api(request("/api/v1/settings"))).status, 404);
    assert.equal((await api(request("/api/v1/tokens"))).status, 404);
  });
});
