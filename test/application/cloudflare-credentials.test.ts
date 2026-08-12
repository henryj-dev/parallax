import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CloudflareCredentialManager } from "../../src/application/cloudflare-credentials.ts";
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
