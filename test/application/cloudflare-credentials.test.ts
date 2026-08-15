import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CloudflareCredentialManager, CredentialNotFoundError } from "../../src/application/cloudflare-credentials.ts";
import type { ProviderAdapter } from "../../src/application/ports.ts";
import { RoutingProviderAdapter } from "../../src/adapters/router.ts";
import type { ProviderRecord, ReconcileOperation } from "../../src/domain/reconciliation.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";
import { EncryptedCredentialStore, type CloudflareCredentialSecret } from "../../src/security/credential-store.ts";

class SpyAdapter implements ProviderAdapter {
  readonly targets: string[] = [];
  async list(target: string): Promise<ProviderRecord[]> { this.targets.push(target); return []; }
  async apply(target: string, _operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> { this.targets.push(target); }
}

describe("CloudflareCredentialManager", () => {

  it("checks a profile against a domain before the domain is bound to it", async () => {
    // Profiles are write-only, so the portal has no token to send. Without this
    // the only testable binding is one that already exists, and the operator has
    // to commit before finding out whether the credential works.
    const directory = await mkdtemp(join(tmpdir(), "parallax-untested-"));
    try {
      const store = new EncryptedCredentialStore({
        repository: new FileConfigurationStore(join(directory, "configuration.json")).credentials,
        masterKey: randomBytes(32),
      });
      const probed: CloudflareCredentialSecret[] = [];
      const manager = new CloudflareCredentialManager({
        store,
        router: new RoutingProviderAdapter({}),
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        resolveZoneId: async (zone) => `id-for-${zone}`,
        createAdapter: (credential) => {
          probed.push(credential);
          return { async list() { return []; }, async apply() {} };
        },
      });
      await manager.upsertProfile("shared", { token: "top-secret" });

      const checked = await manager.test("Example.COM.", { profile: "shared" });

      assert.equal(checked.zone, "example.com");
      assert.equal(checked.zoneId, "id-for-example.com");
      assert.equal(probed.at(-1)?.token, "top-secret");
      // Checking must not create the binding it was checking.
      assert.deepEqual(await manager.listZones(), []);

      await assert.rejects(manager.test("example.com", { profile: "absent" }), CredentialNotFoundError);
      // And with nothing supplied it still means the stored binding, which
      // there is not one of.
      await assert.rejects(manager.test("example.com"), CredentialNotFoundError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads encrypted credentials, updates live routing, and restores environment routing after deletion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-manager-"));
    try {
      const store = new EncryptedCredentialStore({ repository: new FileConfigurationStore(join(directory, "configuration.json")).credentials, masterKey: randomBytes(32) });
      const environment = new SpyAdapter();
      const fallback = new SpyAdapter();
      const created: Array<{ credential: CloudflareCredentialSecret; adapter: SpyAdapter }> = [];
      const router = new RoutingProviderAdapter({ external: { "example.com": environment }, fallback });
      const manager = new CloudflareCredentialManager({
        store,
        router,
        environmentAdapters: new Map([["example.com", environment]]),
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        resolveZoneId: async (zone) => `id-for-${zone}`,
        createAdapter: (credential) => {
          const adapter = new SpyAdapter();
          created.push({ credential, adapter });
          return adapter;
        },
      });

      await manager.upsertProfile("shared", { accountId: "acct-1", token: "top-secret" });
      const binding = await manager.bindZone("Example.COM.", { profile: "shared" });
      assert.deepEqual(Object.keys(binding).sort(), ["accountId", "profile", "updatedAt", "zone", "zoneId"]);
      await router.list("example.com/external");
      assert.deepEqual(created[0]?.adapter.targets, ["example.com/external"]);

      const restartedRouter = new RoutingProviderAdapter({ fallback });
      const restarted = new CloudflareCredentialManager({
        store,
        router: restartedRouter,
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        resolveZoneId: async (zone) => `id-for-${zone}`,
        createAdapter: (credential) => {
          const adapter = new SpyAdapter();
          created.push({ credential, adapter });
          return adapter;
        },
      });
      await restarted.initialize();
      await restartedRouter.list("example.com/external");
      assert.equal(created.at(-1)?.credential.token, "top-secret");

      assert.equal(await manager.unbindZone("example.com"), true);
      await router.list("example.com/external");
      assert.deepEqual(environment.targets, ["example.com/external"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rotates one profile and re-routes every apex domain that reuses it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-manager-"));
    try {
      const store = new EncryptedCredentialStore({ repository: new FileConfigurationStore(join(directory, "configuration.json")).credentials, masterKey: randomBytes(32) });
      const router = new RoutingProviderAdapter();
      const created: CloudflareCredentialSecret[] = [];
      const manager = new CloudflareCredentialManager({
        store,
        router,
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        resolveZoneId: async (zone) => `id-for-${zone}`,
        createAdapter: (credential) => { created.push(credential); return new SpyAdapter(); },
      });

      await manager.upsertProfile("account-a", { accountId: "acct-a", token: "first" });
      for (const zone of ["one.example", "two.example"]) {
        await manager.bindZone(zone, { profile: "account-a" });
      }
      const summary = (await manager.listProfiles())[0];
      assert.deepEqual(summary?.zones, ["one.example", "two.example"]);
      assert.equal("token" in (summary ?? {}), false);

      created.length = 0;
      await manager.upsertProfile("account-a", { accountId: "acct-a", token: "rotated" });
      // One edit re-routes both domains with the new token and their own zone ids.
      assert.deepEqual(created.map((credential) => `${credential.zone}:${credential.zoneId}:${credential.token}`), [
        "one.example:id-for-one.example:rotated",
        "two.example:id-for-two.example:rotated",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refreshes routing after another replica rotates or removes a binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-manager-refresh-"));
    try {
      const path = join(directory, "configuration.json");
      const key = randomBytes(32);
      const firstStore = new EncryptedCredentialStore({ repository: new FileConfigurationStore(path).credentials, masterKey: key });
      const secondStore = new EncryptedCredentialStore({ repository: new FileConfigurationStore(path).credentials, masterKey: key });
      const router = new RoutingProviderAdapter();
      const routed: CloudflareCredentialSecret[] = [];
      const first = new CloudflareCredentialManager({
        store: firstStore,
        router,
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        resolveZoneId: async () => "zone-id",
        createAdapter: (credential) => { routed.push(credential); return new SpyAdapter(); },
      });
      const second = new CloudflareCredentialManager({
        store: secondStore,
        router: new RoutingProviderAdapter(),
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        resolveZoneId: async () => "zone-id",
        createAdapter: () => new SpyAdapter(),
      });
      await second.upsertProfile("shared", { token: "first" });
      await second.bindZone("example.com", { profile: "shared" });
      await first.initialize();
      assert.equal(routed.at(-1)?.token, "first");

      await second.upsertProfile("shared", { token: "rotated" });
      await first.refresh();
      assert.equal(routed.at(-1)?.token, "rotated");

      await second.unbindZone("example.com");
      await first.refresh();
      await assert.rejects(router.list("example.com/external"), /no provider is configured/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("tests supplied credentials without persisting them or exposing provider failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-manager-"));
    try {
      const store = new EncryptedCredentialStore({ repository: new FileConfigurationStore(join(directory, "configuration.json")).credentials, masterKey: randomBytes(32) });
      const manager = new CloudflareCredentialManager({
        store,
        router: new RoutingProviderAdapter(),
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        resolveZoneId: async (zone) => `id-for-${zone}`,
        createAdapter: () => ({
          async list() { throw new Error("transport included top-secret"); },
          async apply() {},
        }),
      });
      await assert.rejects(
        () => manager.test("example.com", { token: "top-secret" }),
        (error: unknown) => error instanceof Error && error.message === "Cloudflare credential test failed" && !error.message.includes("top-secret"),
      );
      assert.deepEqual(await manager.listZones(), []);
      assert.deepEqual(await manager.listProfiles(), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
