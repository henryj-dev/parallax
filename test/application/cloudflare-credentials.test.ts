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
      const store = new EncryptedCredentialStore({ filePath: join(directory, "credentials.enc"), masterKey: randomBytes(32) });
      const environment = new SpyAdapter();
      const fallback = new SpyAdapter();
      const created: Array<{ credential: CloudflareCredentialSecret; adapter: SpyAdapter }> = [];
      const router = new RoutingProviderAdapter({ external: { "example.com": environment }, fallback });
      const manager = new CloudflareCredentialManager({
        store,
        router,
        environmentAdapters: new Map([["example.com", environment]]),
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        createAdapter: (credential) => {
          const adapter = new SpyAdapter();
          created.push({ credential, adapter });
          return adapter;
        },
      });

      const metadata = await manager.update("Example.COM.", { zoneId: "zone-1", token: "top-secret" });
      assert.deepEqual(Object.keys(metadata).sort(), ["updatedAt", "zone", "zoneId"]);
      await router.list("example.com/external");
      assert.deepEqual(created[0]?.adapter.targets, ["example.com/external"]);

      const restartedRouter = new RoutingProviderAdapter({ fallback });
      const restarted = new CloudflareCredentialManager({
        store,
        router: restartedRouter,
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        createAdapter: (credential) => {
          const adapter = new SpyAdapter();
          created.push({ credential, adapter });
          return adapter;
        },
      });
      await restarted.initialize();
      await restartedRouter.list("example.com/external");
      assert.equal(created.at(-1)?.credential.token, "top-secret");

      assert.equal(await manager.delete("example.com"), true);
      await router.list("example.com/external");
      assert.deepEqual(environment.targets, ["example.com/external"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("tests supplied credentials without persisting them or exposing provider failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-manager-"));
    try {
      const store = new EncryptedCredentialStore({ filePath: join(directory, "credentials.enc"), masterKey: randomBytes(32) });
      const manager = new CloudflareCredentialManager({
        store,
        router: new RoutingProviderAdapter(),
        ownershipSecret: "ownership-secret-that-is-at-least-32-bytes",
        createAdapter: () => ({
          async list() { throw new Error("transport included top-secret"); },
          async apply() {},
        }),
      });
      await assert.rejects(
        () => manager.test("example.com", { zoneId: "zone-1", token: "top-secret" }),
        (error: unknown) => error instanceof Error && error.message === "Cloudflare credential test failed" && !error.message.includes("top-secret"),
      );
      assert.deepEqual(await manager.list(), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
