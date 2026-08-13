import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictError, ControlPlane, DEFAULT_HISTORY_PAGE_SIZE } from "../../src/application/control-plane.ts";
import { ProviderNotConfiguredError, RevisionConflictError, type DesiredChange, type ZoneDeletion } from "../../src/application/ports.ts";
import type { ProviderRecord, ReconcileOperation } from "../../src/domain/reconciliation.ts";
import { createInMemoryAdapters, InMemoryApplyLock, InMemoryProvider, InMemoryStatusRepository, InMemoryZoneRepository } from "../../src/infrastructure/in-memory.ts";

class DelayedProvider extends InMemoryProvider {
  readonly started: Promise<void>;
  readonly #gate: Promise<void>;
  #signalStarted = (): void => {};
  #releaseGate = (): void => {};

  constructor() {
    super();
    this.started = new Promise<void>((resolve) => { this.#signalStarted = resolve; });
    this.#gate = new Promise<void>((resolve) => { this.#releaseGate = resolve; });
  }

  override async apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> {
    this.#signalStarted();
    await this.#gate;
    await super.apply(target, operation);
  }

  release(): void {
    this.#releaseGate();
  }
}

class CrossInstanceConflictRepository extends InMemoryZoneRepository {
  failNextSave = false;

  override async commitDesiredChange(change: DesiredChange): Promise<void> {
    if (!this.failNextSave) return super.commitDesiredChange(change);
    this.failNextSave = false;
    await super.commitDesiredChange(change);
    throw new RevisionConflictError("another server committed this revision first");
  }
}

class FailingDesiredChangeRepository extends InMemoryZoneRepository {
  failure: Error | undefined;

  override async commitDesiredChange(change: DesiredChange): Promise<void> {
    if (this.failure) throw this.failure;
    await super.commitDesiredChange(change);
  }
}

class FailingZoneDeletionRepository extends InMemoryZoneRepository {
  failure: Error | undefined;

  override async commitZoneDeletion(deletion: ZoneDeletion): Promise<void> {
    if (this.failure) throw this.failure;
    await super.commitZoneDeletion(deletion);
  }
}

/** A deployment that publishes to one provider only, as Cloudflare-only ones do. */
class SingleViewProvider extends InMemoryProvider {
  readonly #served: string;
  constructor(served: string) {
    super();
    this.#served = served;
  }
  #assertServed(target: string): void {
    if (!target.endsWith(`/${this.#served}`)) {
      throw new ProviderNotConfiguredError(`no provider is configured for ${target}`);
    }
  }
  override async list(target: string): Promise<ProviderRecord[]> {
    this.#assertServed(target);
    return super.list(target);
  }
  override async apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> {
    this.#assertServed(target);
    return super.apply(target, operation);
  }
}

function setup(): { service: ControlPlane; provider: ReturnType<typeof createInMemoryAdapters>["provider"] } {
  const adapters = createInMemoryAdapters();
  const clock = { now: () => new Date("2026-08-08T00:00:00.000Z") };
  return { service: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider, clock), provider: adapters.provider };
}

describe("ControlPlane", () => {
  it("blocks non-global external addresses until the operator explicitly acknowledges them", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    await assert.rejects(service.upsertRecord("example.com", "external", "private", {
      name: "app", type: "A", content: "10.0.0.10", ttl: 60,
    }), /acknowledgeNonGlobalIp/);
    const updated = await service.upsertRecord("example.com", "external", "private", {
      name: "app", type: "A", content: "10.0.0.10", ttl: 60, acknowledgeNonGlobalIp: true,
    });
    assert.equal(updated.views[0]?.records[0]?.acknowledgeNonGlobalIp, true);
  });

  it("synthesizes internal provider state from external baseline plus sparse owner/type overrides", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.8", ttl: 60, proxied: true,
    });
    await service.upsertRecord("example.com", "external", "www", {
      name: "www", type: "CNAME", content: "example.com", ttl: 300, proxied: true,
    });
    await service.upsertRecord("example.com", "internal", "root-override", {
      name: "@", type: "A", content: "10.0.0.8", ttl: 30,
    });

    const firstPreview = await service.preview("example.com", "internal");
    const secondPreview = await service.preview("example.com", "internal");
    assert.equal(firstPreview.views.internal?.summary.create, 2);
    assert.deepEqual(firstPreview.views.internal, secondPreview.views.internal);
    await service.apply("example.com", "internal");
    const internal = await provider.list("example.com/internal");
    assert.deepEqual(internal.map((record) => ({ name: record.name, type: record.type, content: record.content, ttl: record.ttl })), [
      { name: "@", type: "A", content: "10.0.0.8", ttl: 30 },
      { name: "www", type: "CNAME", content: "example.com", ttl: 300 },
    ]);
    assert.ok(internal.every((record) => record.proxied === undefined));
    assert.ok(internal.every((record) => record.id.startsWith("internal-")));
  });

  it("rejects conflicts introduced by combining the external baseline with internal overrides", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "address", {
      name: "www", type: "A", content: "8.8.8.8", ttl: 60,
    });
    await assert.rejects(service.upsertRecord("example.com", "internal", "alias", {
      name: "www", type: "CNAME", content: "internal.example.com", ttl: 60,
    }), /cannot coexist/);
  });

  it("stores monotonically revised desired state and audit history", async () => {
    const { service } = setup();
    assert.equal((await service.createZone("example.com", "alice")).revision, 1);
    assert.equal((await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.10", ttl: 60, proxied: true,
    }, "alice")).revision, 2);
    assert.equal((await service.upsertRecord("example.com", "internal", "root", {
      name: "@", type: "A", content: "10.0.0.10", ttl: 60,
    }, "bob")).revision, 3);

    const history = await service.audit("example.com");
    assert.deepEqual(history.entries.map((entry) => entry.revision), [3, 2, 1]);
    assert.deepEqual(history.entries.map((entry) => entry.actor), ["bob", "alice", "alice"]);
    assert.deepEqual([history.limit, history.offset, history.hasMore], [DEFAULT_HISTORY_PAGE_SIZE, 0, false]);
  });

  it("captures immutable snapshots for every desired revision and restores one as a new revision", async () => {
    const { service } = setup();
    await service.createZone("example.com", "alice");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.10", ttl: 60,
    }, "alice");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.20", ttl: 300,
    }, "bob");

    const { revisions } = await service.listRevisions("example.com");
    assert.deepEqual(revisions.map((snapshot) => snapshot.revision), [1, 2, 3]);
    assert.equal(revisions[1]?.views[0]?.records[0]?.content, "8.8.8.10");
    revisions[1]!.views[0]!.records[0]!.content = "mutated";
    assert.equal((await service.getRevision("example.com", 2)).views[0]?.records[0]?.content, "8.8.8.10");

    const restored = await service.restoreRevision("example.com", 2, "carol");
    assert.equal(restored.revision, 4);
    assert.equal(restored.views[0]?.records[0]?.content, "8.8.8.10");
    assert.equal((await service.getRevision("example.com", 4)).revision, 4);
    assert.equal((await service.status("example.com")).statuses[0]?.state, "pending");
    const audit = (await service.audit("example.com")).entries;
    assert.equal(audit.at(0)?.action, "desired.restored");
    assert.equal(audit.at(0)?.detail.restoredRevision, 2);
    assert.equal(((audit.at(0)?.detail.before as { views: Array<{ records: Array<{ content: string }> }> }).views[0]?.records[0]?.content), "8.8.8.20");
    assert.equal(((audit.at(0)?.detail.after as { views: Array<{ records: Array<{ content: string }> }> }).views[0]?.records[0]?.content), "8.8.8.10");
  });

  it("serializes concurrent restore and mutation without reusing a revision", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.10", ttl: 60,
    });
    const [restored, changed] = await Promise.all([
      service.restoreRevision("example.com", 1),
      service.upsertRecord("example.com", "internal", "root", {
        name: "@", type: "A", content: "10.0.0.1", ttl: 60,
      }),
    ]);
    assert.deepEqual([restored.revision, changed.revision], [3, 4]);
    assert.deepEqual((await service.listRevisions("example.com")).revisions.map((item) => item.revision), [1, 2, 3, 4]);
  });

  it("previews, applies and converges without duplicate provider changes", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.10", ttl: 60,
    });
    const preview = await service.preview("example.com");
    assert.equal(preview.views.external?.summary.create, 1);
    const applied = await service.apply("example.com");
    assert.equal(applied.statuses[0]?.state, "applied");
    assert.equal(applied.statuses[0]?.appliedRevision, 2);
    assert.equal(provider.calls.length, 2);
    assert.equal((await service.preview("example.com")).views.external?.operations.length, 0);
    await service.apply("example.com");
    assert.equal(provider.calls.length, 2);
  });

  it("serializes apply across ControlPlane instances sharing a zone lock", async () => {
    const state = new InMemoryZoneRepository();
    const provider = new DelayedProvider();
    const applyLock = new InMemoryApplyLock();
    const first = new ControlPlane(state, state, provider, undefined, applyLock);
    const second = new ControlPlane(state, state, provider, undefined, applyLock);
    await first.createZone("example.com");
    await first.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.10", ttl: 60,
    });

    const firstApply = first.apply("example.com");
    await provider.started;
    const secondApply = second.apply("example.com");
    provider.release();
    const results = await Promise.all([firstApply, secondApply]);

    assert.ok(results.flatMap((result) => result.statuses).every((status) => status.state === "applied"));
    assert.equal(provider.calls.filter((call) => call.operation.kind === "create").length, 2,
      "one external and one synthesized internal record should be created exactly once");
    assert.equal((await provider.list("example.com/external")).length, 1);
    assert.equal((await provider.list("example.com/internal")).length, 1);
  });

  it("does not globally block locks for different zones", async () => {
    const lock = new InMemoryApplyLock();
    let releaseFirst = (): void => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted = (): void => {};
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const first = lock.withZoneLock("first.example", async () => {
      firstStarted();
      await firstGate;
    });
    await started;

    await Promise.race([
      lock.withZoneLock("second.example", async () => undefined),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("unrelated zone lock was blocked")), 250)),
    ]);
    releaseFirst();
    await first;
  });

  it("adopts records that exist at the provider without taking them over", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    // Two records a human created at the provider, which Parallax knows nothing about.
    provider.seed("example.com/external", [
      { id: "a", name: "www", type: "A", content: "203.0.113.1", ttl: 300, providerId: "cf-1", managed: false },
      { id: "b", name: "docs", type: "CNAME", content: "pages.example.net", ttl: 300, providerId: "cf-2", managed: false },
    ]);

    const { zone, adopted } = await service.adoptProviderRecords("example.com", "external", "operator");
    assert.equal(adopted.length, 2);
    assert.deepEqual(zone.views.find((view) => view.name === "external")?.records.map((record) => record.id),
      ["www-a", "docs-cname"]);

    // The point of adoption: it describes what is there, so applying changes nothing.
    provider.calls.length = 0;
    const applied = await service.apply("example.com", "external");
    assert.equal(applied.statuses[0]?.state, "applied");
    assert.equal(provider.calls.length, 0, "adopted records must not be rewritten at the provider");
    assert.deepEqual((await provider.list("example.com/external")).map((record) => record.managed), [false, false],
      "the provider's records stay unmanaged -- whoever maintained them still does");
  });

  it("adopts a record whose provider reports proxied on a type that cannot be proxied", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    // Cloudflare sends proxied:false on TXT. Describing it verbatim would make
    // adoption fail against its own validation, taking every record with it.
    provider.seed("example.com/external", [
      { id: "t", name: "@", type: "TXT", content: "v=spf1 -all", ttl: 300, providerId: "cf-1", managed: false, proxied: false },
      { id: "a", name: "www", type: "A", content: "8.8.8.10", ttl: 300, providerId: "cf-2", managed: false, proxied: false },
    ]);

    const { adopted, seen } = await service.adoptProviderRecords("example.com", "external");
    assert.equal(seen, 2);
    assert.deepEqual(adopted.map((record) => record.id), ["root-txt", "www-a"]);
    assert.equal(adopted[0]?.proxied, undefined, "proxied means nothing on a TXT record");
    assert.equal(adopted[1]?.proxied, false, "on an address record it is a decision worth keeping");
  });

  it("names the record when one of them cannot be described", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    provider.seed("example.com/external", [
      { id: "ok", name: "www", type: "A", content: "8.8.8.10", ttl: 300, providerId: "cf-1", managed: false },
      { id: "bad", name: "alias", type: "CNAME", content: "not a hostname", ttl: 300, providerId: "cf-2", managed: false },
    ]);

    // Adoption commits the view at once, so one bad record stops all of them --
    // which is only workable if the message says which record.
    await assert.rejects(service.adoptProviderRecords("example.com", "external"), (error: Error) => {
      assert.match(error.message, /alias CNAME not a hostname/);
      return true;
    });
    const zone = await service.getZone("example.com");
    assert.equal(zone.views.find((view) => view.name === "external")?.records.length ?? 0, 0);
  });

  it("adopts idempotently, so re-running it does not accumulate duplicates", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    provider.seed("example.com/external", [
      { id: "a", name: "www", type: "A", content: "203.0.113.1", ttl: 300, providerId: "cf-1", managed: false },
    ]);
    await service.adoptProviderRecords("example.com", "external");
    const second = await service.adoptProviderRecords("example.com", "external");
    assert.equal(second.adopted.length, 0);
    assert.equal(second.zone.views.find((view) => view.name === "external")?.records.length, 1);
    assert.equal(second.zone.revision, 2, "a no-op adoption must not burn a revision");
  });

  it("needs nothing after adoption for the internal view to answer for what it adopted", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    provider.seed("example.com/external", [
      { id: "a", name: "www", type: "A", content: "8.8.8.10", ttl: 300, providerId: "cf-1", managed: false },
    ]);
    await service.adoptProviderRecords("example.com", "external");

    // The internal view is derived when it is reconciled, not stored, so the
    // zone still shows only the external records. Adoption is the whole step.
    const zone = await service.getZone("example.com");
    assert.deepEqual(zone.views.map((view) => `${view.name}=${view.records.length}`), ["external=1"]);
    await service.apply("example.com", "internal");
    assert.deepEqual((await provider.list("example.com/internal")).map((record) => record.content), ["8.8.8.10"]);
  });

  it("lets the internal view inherit adopted records, so unknown names are not left out", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    provider.seed("example.com/external", [
      { id: "a", name: "www", type: "A", content: "203.0.113.1", ttl: 300, providerId: "cf-1", managed: false },
    ]);
    await service.adoptProviderRecords("example.com", "external");
    // An internal override for one name must not hide the rest of the zone.
    await service.upsertRecord("example.com", "internal", "www", {
      name: "www", type: "A", content: "10.10.10.10", ttl: 60,
    });
    await service.upsertRecord("example.com", "external", "api", {
      name: "api", type: "A", content: "8.8.8.9", ttl: 300,
    });
    await service.apply("example.com", "internal");
    const internal = await provider.list("example.com/internal");
    assert.deepEqual(internal.map((record) => `${record.name} ${record.content}`).sort(),
      ["api 8.8.8.9", "www 10.10.10.10"],
      "the internal view answers for adopted names too, so nothing falls to NXDOMAIN");
  });

  it("prevents apply when desired state collides with an unmanaged record", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.10", ttl: 60,
    });
    provider.seed("example.com/external", [{
      id: "foreign", name: "@", type: "A", content: "203.0.113.1", ttl: 60,
      providerId: "foreign-1", managed: false,
    }]);
    const result = await service.apply("example.com");
    assert.equal(result.statuses[0]?.state, "failed");
    assert.match(result.statuses[0]?.error ?? "", /unmanaged/);
    assert.deepEqual(provider.calls.map((call) => call.target), ["example.com/internal"]);
  });

  it("rejects a CNAME that coexists with another record at the same name", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "address", {
      name: "www", type: "A", content: "8.8.8.10", ttl: 60,
    });
    await assert.rejects(
      service.upsertRecord("example.com", "external", "alias", {
        name: "www", type: "CNAME", content: "example.com", ttl: 60,
      }),
      /cannot coexist/,
    );
    assert.equal((await service.getZone("example.com")).revision, 2);
  });

  it("allows distinct A, AAAA, and TXT RRset values and rejects normalized duplicates", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "edge-one", {
      name: "edge", type: "AAAA", content: "2001:4860:4860:0:0:0:0:8888", ttl: 60,
    });
    const zone = await service.upsertRecord("example.com", "external", "edge-two", {
      name: "edge", type: "AAAA", content: "2001:4860:4860::8844", ttl: 60,
    });
    assert.deepEqual(zone.views[0]?.records.map((record) => record.content), [
      "2001:4860:4860::8888", "2001:4860:4860::8844",
    ]);

    await service.upsertRecord("example.com", "external", "txt-one", {
      name: "verify", type: "TXT", content: "first token", ttl: 60,
    });
    await service.upsertRecord("example.com", "external", "txt-two", {
      name: "verify", type: "TXT", content: "second token", ttl: 60,
    });

    await assert.rejects(
      service.upsertRecord("example.com", "external", "edge-duplicate", {
        name: "edge", type: "AAAA", content: "2001:4860:4860:0:0:0:0:8888", ttl: 300,
      }),
      /duplicate.*content/i,
    );
    await assert.rejects(
      service.upsertRecord("example.com", "external", "txt-duplicate", {
        name: "verify", type: "TXT", content: "  first token  ", ttl: 60,
      }),
      /duplicate.*content/i,
    );
  });

  it("replaces the complete external RRset when sparse internal overrides exist", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "edge-one", {
      name: "edge", type: "A", content: "8.8.8.8", ttl: 60,
    });
    await service.upsertRecord("example.com", "external", "edge-two", {
      name: "edge", type: "A", content: "8.8.4.4", ttl: 60,
    });
    await service.upsertRecord("example.com", "internal", "edge-private-one", {
      name: "edge", type: "A", content: "10.0.0.1", ttl: 60,
    });
    await service.upsertRecord("example.com", "internal", "edge-private-two", {
      name: "edge", type: "A", content: "10.0.0.2", ttl: 60,
    });

    const preview = await service.preview("example.com", "internal");
    const createOperations = preview.views.internal?.operations
      .filter((operation) => operation.kind === "create")
      .map((operation) => operation.kind === "create" ? operation.desired : undefined)
      .filter((record) => record !== undefined) ?? [];
    assert.deepEqual(createOperations.map((record) => record.content), ["10.0.0.1", "10.0.0.2"]);
    assert.equal(new Set(createOperations.map((record) => record.id)).size, 2);
    assert.ok(createOperations.every((record) => record.id.startsWith("internal-")));
  });

  it("serializes concurrent desired mutations without losing revisions", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    const [first, second] = await Promise.all([
      service.upsertRecord("example.com", "external", "one", { name: "one", type: "A", content: "8.8.8.1", ttl: 60 }),
      service.upsertRecord("example.com", "external", "two", { name: "two", type: "A", content: "8.8.8.2", ttl: 60 }),
    ]);
    assert.deepEqual([first.revision, second.revision], [2, 3]);
    const zone = await service.getZone("example.com");
    assert.equal(zone.views[0]?.records.length, 2);
    assert.deepEqual((await service.audit("example.com")).entries.map((entry) => entry.revision), [3, 2, 1]);
  });

  it("rejects a desired-state mutation when its expected revision is stale", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "one", {
      name: "one", type: "A", content: "8.8.8.1", ttl: 60,
    }, "alice", 1);

    await assert.rejects(
      service.replaceDesiredState("example.com", { views: [] }, "bob", 1),
      (error: unknown) => error instanceof ConflictError && /expected revision 1.*current revision is 2/i.test(error.message),
    );
    assert.equal((await service.getZone("example.com")).revision, 2);
    assert.equal((await service.audit("example.com")).entries.length, 2);
  });

  it("lets only one concurrent writer commit against the same expected revision", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    const results = await Promise.allSettled([
      service.upsertRecord("example.com", "external", "one", {
        name: "one", type: "A", content: "8.8.8.1", ttl: 60,
      }, "alice", 1),
      service.upsertRecord("example.com", "external", "two", {
        name: "two", type: "A", content: "8.8.8.2", ttl: 60,
      }, "bob", 1),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof ConflictError);
    assert.equal((await service.getZone("example.com")).revision, 2);
  });

  it("maps a repository-level cross-instance revision race to a conflict", async () => {
    const zones = new CrossInstanceConflictRepository();
    const service = new ControlPlane(zones, new InMemoryStatusRepository(), new InMemoryProvider());
    await service.createZone("example.com");
    zones.failNextSave = true;

    await assert.rejects(
      service.replaceDesiredState("example.com", { views: [] }, "alice", 1),
      (error: unknown) => error instanceof ConflictError && /current revision is 2/i.test(error.message),
    );
  });

  it("does not expose a snapshot or stale status when an audit/status unit-of-work commit fails", async () => {
    for (const failure of [new Error("audit unavailable"), new Error("status unavailable")]) {
      const state = new FailingDesiredChangeRepository();
      const service = new ControlPlane(state, state, new InMemoryProvider());
      await service.createZone("example.com", "alice");
      state.failure = failure;

      await assert.rejects(service.upsertRecord("example.com", "external", "root", {
        name: "@", type: "A", content: "8.8.8.8", ttl: 60,
      }, "alice"), failure);

      assert.equal((await service.getZone("example.com")).revision, 1);
      assert.equal((await service.audit("example.com")).entries.length, 1);
      assert.deepEqual((await service.status("example.com")).statuses, []);
    }
  });

  it("does not record a false deletion audit or partially delete state when deletion commit fails", async () => {
    const state = new FailingZoneDeletionRepository();
    const service = new ControlPlane(state, state, new InMemoryProvider(), {
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    });
    await service.createZone("example.com", "alice");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.8", ttl: 60,
    }, "alice");
    const failure = new Error("audit storage unavailable");
    state.failure = failure;

    await assert.rejects(service.deleteZone("example.com", "bob", 2), failure);

    assert.equal((await state.get("example.com"))?.revision, 2);
    assert.deepEqual((await state.listRevisions("example.com")).map((revision) => revision.revision), [1, 2]);
    assert.ok((await state.list("example.com")).length > 0);
    assert.deepEqual((await state.audit("example.com")).map((entry) => entry.action), ["record.upserted", "zone.created"]);
  });

  it("atomically deletes current state and records a secret-free before snapshot", async () => {
    const state = new FailingZoneDeletionRepository();
    const service = new ControlPlane(state, state, new InMemoryProvider(), {
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    });
    await service.createZone("example.com", "alice");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.8", ttl: 60,
    }, "alice");

    await service.deleteZone("example.com", "bob", 2);

    assert.equal(await state.get("example.com"), undefined);
    assert.deepEqual(await state.listRevisions("example.com"), []);
    assert.deepEqual(await state.list("example.com"), []);
    const deleted = (await state.audit("example.com")).at(0);
    assert.equal(deleted?.action, "zone.deleted");
    assert.equal(deleted?.actor, "bob");
    assert.equal(deleted?.revision, 3);
    assert.equal(deleted?.detail.after, null);
    assert.deepEqual(deleted?.detail.before, {
      views: [{ name: "external", records: [{ id: "root", name: "@", type: "A", content: "8.8.8.8", ttl: 60 }] }],
    });
    assert.doesNotMatch(JSON.stringify(deleted?.detail), /credential|secret|token/i);
  });

  it("bounds stored revisions and ages out audit history as changes accumulate", async () => {
    const adapters = createInMemoryAdapters();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new ControlPlane(adapters.zones, adapters.statuses, adapters.provider, {
      now: () => now,
    }, adapters.applyLock, { maxRevisionsPerZone: 3, auditRetentionDays: 30 });

    await service.createZone("example.com", "alice");
    for (let index = 0; index < 6; index += 1) {
      await service.upsertRecord("example.com", "external", `r${index}`, {
        name: `n${index}`, type: "A", content: "8.8.8.8", ttl: 300,
      }, "alice");
    }

    // Only the newest snapshots survive, and the current revision is always one.
    const stored = await adapters.zones.listRevisions("example.com");
    assert.deepEqual(stored.map((snapshot) => snapshot.revision), [5, 6, 7]);
    assert.equal((await service.getZone("example.com")).revision, 7);
    assert.equal((await service.audit("example.com")).entries.length, 7);

    // A change made after the window has passed drops everything older than it.
    now = new Date("2026-03-01T00:00:00.000Z");
    await service.upsertRecord("example.com", "external", "late", {
      name: "late", type: "A", content: "8.8.8.8", ttl: 300,
    }, "alice");

    const remaining = (await service.audit("example.com")).entries;
    assert.deepEqual(remaining.map((entry) => entry.revision), [8]);
    assert.deepEqual((await adapters.zones.listRevisions("example.com")).map((item) => item.revision), [6, 7, 8]);
  });

  it("keeps every revision and audit entry when retention is not configured", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    for (let index = 0; index < 5; index += 1) {
      await service.upsertRecord("example.com", "external", `r${index}`, {
        name: `n${index}`, type: "A", content: "8.8.8.8", ttl: 300,
      });
    }
    assert.equal((await service.listRevisions("example.com")).revisions.length, 6);
    assert.equal((await service.audit("example.com")).entries.length, 6);
  });

  it("withdraws its own published records when a zone is deleted and leaves foreign records alone", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com", "alice");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.8", ttl: 60,
    }, "alice");
    await service.apply("example.com");
    provider.seed("example.com/external", [
      ...await provider.list("example.com/external"),
      { id: "foreign", providerId: "foreign-1", managed: false, name: "legacy", type: "A", content: "8.8.4.4", ttl: 60 },
    ]);

    const result = await service.deleteZone("example.com", "bob");

    assert.deepEqual(result.removedProviderRecords.map((record) => `${record.view}/${record.name}/${record.content}`), [
      "external/@/8.8.8.8",
      "internal/@/8.8.8.8",
    ]);
    assert.deepEqual((await provider.list("example.com/external")).map((record) => record.id), ["foreign"]);
    assert.deepEqual(await provider.list("example.com/internal"), []);
  });

  it("deletes a zone that only ever published to one provider", async () => {
    // Split-horizon materializes `internal` from `external` whether or not a
    // provider backs it, so purging every view a zone could reach asked an
    // unconfigured provider to list its records -- and deleting a zone failed
    // outright on any deployment that publishes to Cloudflare alone.
    const adapters = createInMemoryAdapters();
    const provider = new SingleViewProvider("external");
    const service = new ControlPlane(adapters.zones, adapters.statuses, provider);
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", { name: "@", type: "A", content: "8.8.8.8", ttl: 60 });
    await service.apply("example.com", "external");

    const result = await service.deleteZone("example.com");

    assert.deepEqual(result.removedProviderRecords.map((record) => `${record.view}/${record.name}`), ["external/@"]);
    assert.deepEqual(await provider.list("example.com/external"), []);
    await assert.rejects(() => service.getZone("example.com"));
  });

  it("withdraws nothing when a later view cannot be read", async () => {
    // The zone is kept so the deletion can be retried, which is only true if the
    // retry has the same work to do -- reporting failure over records that are
    // already gone would leave the operator repairing instead of retrying.
    const { service, provider } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", { name: "@", type: "A", content: "8.8.8.8", ttl: 60 });
    await service.apply("example.com");
    assert.equal((await provider.list("example.com/external")).length, 1);
    assert.equal((await provider.list("example.com/internal")).length, 1);

    let reads = 0;
    const original = provider.list.bind(provider);
    provider.list = async (target: string) => {
      reads += 1;
      if (reads === 2) throw new Error("provider is unreachable");
      return original(target);
    };

    await assert.rejects(() => service.deleteZone("example.com"), /provider is unreachable/);
    provider.list = original;
    assert.equal((await provider.list("example.com/external")).length, 1, "the first view was withdrawn before the failure");
    assert.equal((await provider.list("example.com/internal")).length, 1);
    assert.equal((await service.getZone("example.com")).revision, 2);
  });

  it("keeps the zone when provider records cannot be withdrawn so the deletion can be retried", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", { name: "@", type: "A", content: "8.8.8.8", ttl: 60 });
    await service.apply("example.com");
    provider.failure = new Error("provider is unreachable");

    await assert.rejects(() => service.deleteZone("example.com"), /provider is unreachable/);
    assert.equal((await service.getZone("example.com")).revision, 2);
    assert.equal((await provider.list("example.com/external")).length, 1);

    provider.failure = undefined;
    await service.deleteZone("example.com");
    assert.deepEqual(await provider.list("example.com/external"), []);
  });

  it("abandons provider records only when the caller asks for it explicitly", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", { name: "@", type: "A", content: "8.8.8.8", ttl: 60 });
    await service.apply("example.com");

    const result = await service.deleteZone("example.com", "bob", undefined, { abandonProviderRecords: true });

    assert.deepEqual(result.removedProviderRecords, []);
    assert.equal((await provider.list("example.com/external")).length, 1);
  });

  it("reports mismatched or impossible applied revisions as pending without a future applied state", async () => {
    const zones = new InMemoryZoneRepository();
    const statuses = new InMemoryStatusRepository();
    const service = new ControlPlane(zones, statuses, new InMemoryProvider());
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.8", ttl: 60,
    });
    await statuses.save({
      zone: "example.com", view: "external", desiredRevision: 99, appliedRevision: 99, state: "applied",
    });

    const status = (await service.status("example.com")).statuses.find((item) => item.view === "external");
    assert.equal(status?.state, "pending");
    assert.equal(status?.desiredRevision, 2);
    assert.equal(status?.appliedRevision, 1);

    // A corrupt repository can also claim the current desired revision was applied
    // while carrying a different applied revision; status must fail closed.
    const corruptStatuses = new InMemoryStatusRepository();
    await corruptStatuses.save({
      zone: "example.com", view: "external", desiredRevision: 2, appliedRevision: 1, state: "applied",
    });
    const corruptService = new ControlPlane(zones, corruptStatuses, new InMemoryProvider());
    const corrupt = (await corruptService.status("example.com")).statuses.find((item) => item.view === "external");
    assert.equal(corrupt?.state, "pending");
    assert.equal(corrupt?.appliedRevision, 1);
  });

  it("reconciles removed views to an empty managed state", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", { name: "@", type: "A", content: "8.8.8.1", ttl: 60 });
    await service.apply("example.com");
    assert.equal((await provider.list("example.com/external")).length, 1);
    await service.replaceDesiredState("example.com", { views: [] });
    assert.equal((await service.status("example.com")).statuses[0]?.state, "pending");
    await service.apply("example.com");
    assert.equal((await provider.list("example.com/external")).length, 0);
  });

  it("records provider listing failures as failed apply status", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", { name: "@", type: "A", content: "8.8.8.1", ttl: 60 });
    provider.listFailure = new Error("provider unavailable");
    const result = await service.apply("example.com");
    assert.equal(result.statuses[0]?.state, "failed");
    assert.equal(result.statuses[0]?.error, "provider operation failed");
  });

  it("keeps a newer desired revision pending when it arrives during apply", async () => {
    const provider = new DelayedProvider();
    const service = new ControlPlane(new InMemoryZoneRepository(), new InMemoryStatusRepository(), provider);
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", { name: "@", type: "A", content: "8.8.8.1", ttl: 60 });
    const applying = service.apply("example.com");
    await provider.started;
    const changing = service.upsertRecord("example.com", "external", "root", { name: "@", type: "A", content: "8.8.8.2", ttl: 60 });
    provider.release();
    await applying;
    const changed = await changing;
    assert.equal(changed.revision, 3);
    const status = await service.status("example.com");
    assert.equal(status.desiredRevision, 3);
    assert.equal(status.statuses[0]?.state, "pending");
    assert.equal(status.statuses[0]?.appliedRevision, 2);
  });

  it("does not let a slow provider for one zone block another zone", async () => {
    const provider = new DelayedProvider();
    const state = new InMemoryZoneRepository();
    const service = new ControlPlane(state, state, provider);
    await service.createZone("first.example");
    await service.createZone("second.example");
    await service.upsertRecord("first.example", "external", "root", { name: "@", type: "A", content: "8.8.8.1", ttl: 60 });

    const applying = service.apply("first.example");
    await provider.started;
    const changed = await Promise.race([
      service.upsertRecord("second.example", "external", "root", { name: "@", type: "A", content: "8.8.4.4", ttl: 60 }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("unrelated zone was blocked")), 250)),
    ]);
    assert.equal(changed.revision, 2);
    provider.release();
    await applying;
  });
});
