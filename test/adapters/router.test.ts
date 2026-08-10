import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProviderAdapter } from "../../src/application/ports.ts";
import type { ProviderRecord, ReconcileOperation } from "../../src/domain/reconciliation.ts";
import { RoutingProviderAdapter } from "../../src/adapters/router.ts";

class SpyAdapter implements ProviderAdapter {
  readonly targets: string[] = [];
  async list(target: string): Promise<ProviderRecord[]> { this.targets.push(target); return []; }
  async apply(target: string, _operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> { this.targets.push(target); }
}

describe("RoutingProviderAdapter", () => {
  it("routes external views by normalized zone", async () => {
    const external = new SpyAdapter();
    const fallback = new SpyAdapter();
    const router = new RoutingProviderAdapter({ external: { "example.com.": external }, fallback });

    await router.list(" Example.COM./external ");

    assert.deepEqual(external.targets, ["example.com/external"]);
    assert.deepEqual(fallback.targets, []);
  });

  it("routes every internal view to the internal adapter", async () => {
    const internal = new SpyAdapter();
    const router = new RoutingProviderAdapter({ internal });
    await router.list("Sub.Example.COM./internal");
    assert.deepEqual(internal.targets, ["sub.example.com/internal"]);
  });

  it("uses the fallback when a view has no configured adapter", async () => {
    const fallback = new SpyAdapter();
    const router = new RoutingProviderAdapter({ fallback });
    await router.list("unconfigured.example/external");
    await router.list("unconfigured.example/internal");
    assert.deepEqual(fallback.targets, ["unconfigured.example/external", "unconfigured.example/internal"]);
    assert.equal(router.isConfigured("unconfigured.example/external"), true);
  });

  it("reports missing production routes without probing a provider", () => {
    const router = new RoutingProviderAdapter({ external: { "example.com": new SpyAdapter() } });
    assert.equal(router.isConfigured("example.com/external"), true);
    assert.equal(router.isConfigured("example.com/internal"), false);
    assert.equal(router.isConfigured("other.example/external"), false);
  });

  it("rejects malformed or unsupported targets", async () => {
    const router = new RoutingProviderAdapter({ fallback: new SpyAdapter() });
    await assert.rejects(() => router.list("example.com/private"), /no provider is configured/i);
    await assert.rejects(() => router.list("localhost/external"), /invalid provider target zone/i);
  });
});
