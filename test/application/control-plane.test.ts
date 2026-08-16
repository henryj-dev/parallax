import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictError, ControlPlane, DEFAULT_HISTORY_PAGE_SIZE, NotFoundError, ProviderManagedRecordError } from "../../src/application/control-plane.ts";
import { ProviderConstraintError, ProviderNotConfiguredError, RevisionConflictError, type DesiredChange, type ProviderAdapter, type ZoneDeletion } from "../../src/application/ports.ts";
import type { DesiredRecord } from "../../src/domain/dns.ts";
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
  it("bounds public zone pages while preserving the complete internal listing", async () => {
    const { service } = setup();
    for (const zone of ["charlie.example", "alpha.example", "bravo.example"]) {
      await service.createZone(zone);
    }

    const first = await service.listZonePage({ limit: 2, offset: 0 });
    assert.deepEqual(first.zones.map((zone) => zone.name), ["alpha.example", "bravo.example"]);
    assert.deepEqual([first.limit, first.offset, first.hasMore], [2, 0, true]);

    const second = await service.listZonePage({ limit: 2, offset: 2 });
    assert.deepEqual(second.zones.map((zone) => zone.name), ["charlie.example"]);
    assert.equal(second.hasMore, false);
    assert.equal((await service.listZones()).length, 3, "trusted snapshot consumers still receive every zone");
  });

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

  it("counts a revision as changed whichever field of the record moved", async () => {
    // Enumerated from the record itself rather than listed here: a field added
    // to DesiredRecord joins this test without anyone remembering to add it,
    // which is the only way the count keeps up with the shape it describes.
    // Typed so the compiler, not a memory, keeps this current: a field added to
    // DesiredRecord makes this object incomplete and the test stops building.
    const base: Required<Omit<DesiredRecord, "id">> = {
      name: "www", type: "A", content: "8.8.8.10", ttl: 300,
      proxied: false, acknowledgeNonGlobalIp: false,
    };
    const moved: Record<string, unknown> = {
      name: "web", type: "AAAA", content: "8.8.8.11", ttl: 600, proxied: true,
      acknowledgeNonGlobalIp: true,
    };
    for (const field of Object.keys(base)) {
      const { service } = setup();
      await service.createZone("example.com");
      await service.upsertRecord("example.com", "external", "web", base);
      const after: Record<string, unknown> = { ...base, [field]: moved[field] };
      // AAAA needs an address of its own family; the point is the field moved.
      if (field === "type") { after.content = "2001:4860:4860::8888"; }
      await service.upsertRecord("example.com", "external", "web", after);

      const entry = (await service.audit("example.com")).entries
        .find((candidate) => candidate.action === "record.upserted");
      assert.equal(entry?.changed, 1, `moving ${field} must count as a change`);
      assert.equal(entry?.added, 0, `moving ${field} must not read as a new record`);
      assert.equal(entry?.removed, 0, `moving ${field} must not read as a deletion`);
    }
  });

  it("says in the audit line how many records a revision added, removed and changed", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "web", { name: "www", type: "A", content: "8.8.8.10", ttl: 300 });
    await service.upsertRecord("example.com", "external", "api", { name: "api", type: "A", content: "8.8.8.11", ttl: 300 });
    await service.upsertRecord("example.com", "external", "web", { name: "www", type: "A", content: "8.8.8.12", ttl: 300 });
    // The change that emptied the zone, which is the one worth spotting.
    await service.replaceDesiredState("example.com", { views: [{ name: "external", records: [] }] }, "someone");

    const entries = (await service.audit("example.com")).entries;
    const summary = (action: string): unknown => {
      const entry = entries.find((candidate) => candidate.action === action);
      assert.ok(entry, `no ${action} entry`);
      return { added: entry.added, removed: entry.removed, changed: entry.changed };
    };
    assert.deepEqual(summary("desired.replaced"), { added: 0, removed: 2, changed: 0 },
      "a revision that emptied the zone must not read like any other revision");
    assert.deepEqual(summary("record.upserted"), { added: 0, removed: 0, changed: 1 },
      "rewriting a record under the same id is a change, not an addition");
  });

  it("reports the counts for history written before they existed", async () => {
    // The entries that matter most are the ones already in the store: nobody
    // asks what a revision did until after it has happened.
    const adapters = createInMemoryAdapters();
    const service = new ControlPlane(adapters.zones, adapters.statuses, adapters.provider);
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "web", { name: "www", type: "A", content: "8.8.8.10", ttl: 300 });
    await service.replaceDesiredState("example.com", { views: [{ name: "external", records: [] }] }, "someone");

    // Nothing about the stored rows carries the counts; they hold snapshots.
    const stored = await adapters.zones.audit("example.com", { limit: 10, offset: 0 });
    const replaced = stored.find((entry) => entry.action === "desired.replaced");
    assert.equal((replaced as { added?: number }).added, undefined, "the store holds no counts");

    const read = (await service.audit("example.com")).entries
      .find((entry) => entry.action === "desired.replaced");
    assert.deepEqual({ added: read?.added, removed: read?.removed, changed: read?.changed },
      { added: 0, removed: 1, changed: 0 });
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

  it("refuses an adoption that would make the materialized internal view invalid", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "internal", "inside", {
      name: "www", type: "A", content: "10.0.0.1", ttl: 60,
    });
    provider.seed("example.com/external", [{
      id: "foreign", providerId: "cf-1", managed: false,
      name: "www", type: "CNAME", content: "target.example.net", ttl: 300,
    }]);

    await assert.rejects(
      service.adoptProviderRecords("example.com", "external", "alice"),
      /CNAME record at www cannot coexist/,
    );

    const zone = await service.getZone("example.com");
    assert.equal(zone.revision, 2);
    assert.deepEqual(zone.views.map((view) => view.name), ["internal"]);
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

  it("says how far a view got when the provider refuses part way through", async () => {
    const zones = new InMemoryZoneRepository();
    let accepted = 0;
    const provider: ProviderAdapter = {
      list: async () => [],
      apply: async () => {
        accepted += 1;
        if (accepted > 2) throw new ProviderConstraintError("that record does not fit here");
      },
    };
    const service = new ControlPlane(zones, new InMemoryStatusRepository(), provider);
    await service.createZone("example.com");
    for (const id of ["one", "two", "three", "four"]) {
      await service.upsertRecord("example.com", "external", id, {
        name: id, type: "A", content: `8.8.8.1${id.length}`, ttl: 300,
      });
    }

    const status = (await service.apply("example.com", "external")).statuses[0];
    assert.equal(status?.state, "failed");
    // A provider is written one record at a time, so a failed view is a view
    // that is part live -- and a resolver is answering for that part.
    assert.equal(status?.completedOperations, 2);
    assert.equal(status?.plannedOperations, 4);
    // Parallax's own sentence about its own data survives to the operator.
    assert.equal(status?.error, "that record does not fit here");
  });

  it("still withholds what the provider itself said", async () => {
    const zones = new InMemoryZoneRepository();
    const provider: ProviderAdapter = {
      list: async () => [],
      apply: async () => { throw new Error("PUT https://api.example/zones?token=super-secret failed"); },
    };
    const service = new ControlPlane(zones, new InMemoryStatusRepository(), provider);
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "one", { name: "www", type: "A", content: "8.8.8.10", ttl: 300 });

    const status = (await service.apply("example.com", "external")).statuses[0];
    assert.equal(status?.error, "provider operation failed");
    assert.equal(status?.completedOperations, 0, "how far it got is safe to report even when the reason is not");
    const audit = (await service.audit("example.com")).entries;
    assert.deepEqual(audit.slice(0, 2).map((entry) => entry.action), [
      "provider.apply.failed",
      "provider.apply.started",
    ]);
    assert.deepEqual(audit.slice(0, 2).map((entry) => entry.detail.completedOperations), [0, undefined]);
    assert.doesNotMatch(JSON.stringify(audit.slice(0, 2)), /super-secret|api\.example/i);
  });

  it("writes actor-bound audit records before and after provider mutations", async () => {
    const { service } = setup();
    await service.createZone("example.com", "alice");
    await service.upsertRecord("example.com", "external", "www", {
      name: "www", type: "A", content: "8.8.8.8", ttl: 60,
    }, "alice");

    await service.apply("example.com", "external", undefined, "alice");

    const entries = (await service.audit("example.com")).entries.slice(0, 2);
    assert.deepEqual(entries.map((entry) => entry.action), [
      "provider.apply.completed",
      "provider.apply.started",
    ]);
    assert.ok(entries.every((entry) => entry.actor === "alice"));
    assert.equal(entries[0]?.detail.completedOperations, 1);
    assert.equal(entries[1]?.detail.plannedOperations, 1);
    assert.doesNotMatch(JSON.stringify(entries), /credential|secret|token/i);
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

  it("ages out write-ahead provider audits during apply without touching another zone or revisions", async () => {
    const adapters = createInMemoryAdapters();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new ControlPlane(adapters.zones, adapters.statuses, adapters.provider, {
      now: () => now,
    }, adapters.applyLock, { auditRetentionDays: 30 });
    await service.createZone("example.com", "alice");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.8", ttl: 60,
    }, "alice");
    await service.apply("example.com", "external", undefined, "alice");
    await service.createZone("other.example", "alice");

    now = new Date("2026-03-01T00:00:00.000Z");
    await service.apply("example.com", "external", undefined, "alice");

    assert.deepEqual((await service.audit("example.com")).entries.map((entry) => entry.action), [
      "provider.apply.completed",
      "provider.apply.started",
    ]);
    assert.equal((await service.audit("other.example")).entries.length, 1,
      "applying one zone must not age out another zone's audit history");
    assert.deepEqual((await adapters.zones.listRevisions("example.com")).map((revision) => revision.revision), [1, 2],
      "provider audit retention must not alter immutable desired revisions");
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

  it("leaves a write-ahead audit trail when zone withdrawal fails part way through", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com", "alice");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.8", ttl: 60,
    }, "alice");
    await service.apply("example.com", undefined, undefined, "alice");
    const originalApply = provider.apply.bind(provider);
    provider.apply = async (target, operation) => {
      if (target === "example.com/internal") throw new Error("DELETE token=provider-secret failed");
      return originalApply(target, operation);
    };

    await assert.rejects(service.deleteZone("example.com", "bob"), /provider-secret/);
    provider.apply = originalApply;

    assert.equal((await provider.list("example.com/external")).length, 0);
    assert.equal((await provider.list("example.com/internal")).length, 1);
    assert.equal((await service.getZone("example.com")).revision, 2, "desired state remains available for repair");
    const purgeAudit = (await service.audit("example.com")).entries
      .filter((entry) => entry.detail.operation === "zone-delete");
    assert.deepEqual(purgeAudit.map((entry) => entry.action), [
      "provider.apply.failed",
      "provider.apply.started",
      "provider.apply.completed",
      "provider.apply.started",
    ]);
    assert.ok(purgeAudit.every((entry) => entry.actor === "bob"));
    assert.equal(purgeAudit[0]?.detail.error, "provider operation failed");
    assert.doesNotMatch(JSON.stringify(purgeAudit), /provider-secret|DELETE token/i);
  });

  it("withdraws reachable targets and explicitly abandons only unreadable ones", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", { name: "@", type: "A", content: "8.8.8.8", ttl: 60 });
    await service.apply("example.com");
    const originalList = provider.list.bind(provider);
    provider.list = async (target: string) => {
      if (target === "example.com/internal") throw new Error("provider is gone");
      return originalList(target);
    };

    const result = await service.deleteZone("example.com", "bob", undefined, { abandonProviderRecords: true });
    provider.list = originalList;

    assert.deepEqual(result.removedProviderRecords.map((record) => `${record.view}/${record.name}`), ["external/@"]);
    assert.deepEqual(result.abandonedProviderTargets, [{ view: "internal", target: "example.com/internal" }]);
    assert.deepEqual(await provider.list("example.com/external"), []);
    assert.equal((await provider.list("example.com/internal")).length, 1);
    const deleted = (await service.audit("example.com")).entries[0];
    assert.equal(deleted?.detail.providerRecordsAbandoned, true);
    assert.deepEqual(deleted?.detail.providerTargetsAbandoned, ["example.com/internal"]);
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

  it("carries an unfinished removed-view tombstone across unrelated edits and retires it once applied", async () => {
    const { service, provider } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.1", ttl: 60,
    });
    await service.apply("example.com");

    await service.replaceDesiredState("example.com", { views: [] });
    const edited = await service.upsertRecord("example.com", "internal", "inside", {
      name: "inside", type: "A", content: "10.0.0.1", ttl: 60,
    });
    const pending = (await service.status("example.com")).statuses.find((status) => status.view === "external");
    assert.equal(pending?.desiredRevision, edited.revision);
    assert.equal(pending?.state, "pending");

    await service.apply("example.com");
    assert.deepEqual(await provider.list("example.com/external"), []);

    await service.upsertRecord("example.com", "internal", "inside", {
      name: "inside", type: "A", content: "10.0.0.2", ttl: 60,
    });
    assert.equal((await service.status("example.com")).statuses.some((status) => status.view === "external"), false);
    const callCount = provider.calls.length;
    await service.apply("example.com");
    assert.equal(provider.calls.slice(callCount).some((call) => call.target === "example.com/external"), false);
  });

  it("carries an unaffected applied view forward to the zone's new revision", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.1", ttl: 60,
    });
    await service.apply("example.com", "external");

    const changed = await service.upsertRecord("example.com", "internal", "inside", {
      name: "inside", type: "A", content: "10.0.0.1", ttl: 60,
    });
    const external = (await service.status("example.com")).statuses.find((status) => status.view === "external");
    assert.equal(external?.state, "applied");
    assert.equal(external?.desiredRevision, changed.revision);
    assert.equal(external?.appliedRevision, changed.revision);
    assert.equal(external?.lastAttemptAt, "2026-08-08T00:00:00.000Z");
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
    const state = new InMemoryZoneRepository();
    const service = new ControlPlane(state, state, provider);
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
    assert.ok(status.statuses[0]?.lastAttemptAt, "the newer revision must retain evidence that the provider was reached");
  });

  it("does not let another replica edit between provider withdrawal and deletion commit", async () => {
    const provider = new DelayedProvider();
    const state = new InMemoryZoneRepository();
    const lock = new InMemoryApplyLock();
    const deletingReplica = new ControlPlane(state, state, provider, undefined, lock);
    const editingReplica = new ControlPlane(state, state, provider, undefined, lock);
    await deletingReplica.createZone("example.com");
    const zone = await deletingReplica.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.8.8", ttl: 60,
    });
    const record = zone.views.find((view) => view.name === "external")!.records[0]!;
    provider.seed("example.com/external", [{ ...record, providerId: "published", managed: true }]);
    await state.save({
      zone: "example.com", view: "external", desiredRevision: zone.revision,
      appliedRevision: zone.revision, state: "applied", lastAttemptAt: "2026-08-08T00:00:00.000Z",
    });

    const deleting = deletingReplica.deleteZone("example.com");
    await provider.started;
    const editing = editingReplica.upsertRecord("example.com", "external", "root", {
      name: "@", type: "A", content: "8.8.4.4", ttl: 60,
    });
    const early = await Promise.race([
      editing.then(() => "edited", () => "rejected"),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 20)),
    ]);
    assert.equal(early, "waiting", "the other replica must wait while deletion owns the zone lock");

    provider.release();
    await deleting;
    await assert.rejects(editing, NotFoundError);
    assert.deepEqual(await provider.list("example.com/external"), []);
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

  describe("records the provider owns", () => {
    async function withPlaceholder(): Promise<ControlPlane> {
      const { service } = setup();
      await service.createZone("example.com");
      // What adoption brings back for a name the provider serves itself. The
      // acknowledgement is what adoption sets: `100::` is not a global address,
      // and publishing one deliberately is a decision this refuses to make on
      // its own -- but the record already exists at the provider.
      await service.upsertRecord("example.com", "external", "apex", {
        name: "@", type: "AAAA", content: "100::", ttl: 300, acknowledgeNonGlobalIp: true,
      });
      await service.upsertRecord("example.com", "external", "bucket", { name: "files", type: "CNAME", content: "pub-1234.r2.dev", ttl: 300 });
      return service;
    }

    it("refuses to change one, and says where it can be changed", async () => {
      const service = await withPlaceholder();
      await assert.rejects(
        service.upsertRecord("example.com", "external", "apex", { name: "@", type: "AAAA", content: "2606:4700::1", ttl: 300, acknowledgeNonGlobalIp: true }),
        (error: unknown) => error instanceof ProviderManagedRecordError && /where it was created/u.test(error.message),
      );
      const zone = await service.getZone("example.com");
      const apex = zone.views.find((view) => view.name === "external")?.records.find((record) => record.id === "apex");
      assert.equal(apex?.content, "100::", "the refusal left the record as it was");
    });

    it("refuses to delete one", async () => {
      const service = await withPlaceholder();
      await assert.rejects(
        service.deleteRecord("example.com", "external", "bucket"),
        (error: unknown) => error instanceof ProviderManagedRecordError && /r2\.dev/u.test(error.message),
      );
    });

    it("refuses a wholesale replace that drops one", async () => {
      // The guard has to sit where the state is decided rather than on the two
      // obvious doors: a `PUT` of the whole desired state would otherwise delete
      // what `DELETE` is not allowed to.
      const service = await withPlaceholder();
      await assert.rejects(
        service.replaceDesiredState("example.com", { views: [{ name: "external", records: [] }] }),
        (error: unknown) => error instanceof ProviderManagedRecordError,
      );
      const zone = await service.getZone("example.com");
      assert.equal(zone.views.find((view) => view.name === "external")?.records.length, 2, "nothing was dropped");
    });

    it("still allows the internal view to answer the same name differently", async () => {
      // The point of the internal view. The record shape refused above is the
      // record shape expected here, and the guard has to tell the two apart.
      const service = await withPlaceholder();
      const updated = await service.upsertRecord("example.com", "internal", "apex-inside", {
        name: "@", type: "AAAA", content: "fd00::1", ttl: 60, acknowledgeNonGlobalIp: true,
      });
      const inside = updated.views.find((view) => view.name === "internal")?.records ?? [];
      assert.ok(inside.some((record) => record.content === "fd00::1"), "the override was accepted");
    });

    it("still follows the provider when it changes one there", async () => {
      // The lock is on changing it *here*. Adoption is the provider telling us
      // what it now holds, and refusing that would freeze the desired state
      // against the very source it is supposed to describe -- the record would
      // read one way in Parallax and answer another way in the world.
      const { service, provider } = setup();
      await service.createZone("example.com");
      provider.seed("example.com/external", [
        { id: "a", name: "@", type: "AAAA", content: "100::", ttl: 300, providerId: "cf-1", managed: false },
      ]);
      await service.adoptProviderRecords("example.com", "external", "operator");

      provider.seed("example.com/external", [
        { id: "a", name: "@", type: "AAAA", content: "2606:4700::1", ttl: 300, providerId: "cf-1", managed: false },
      ]);
      const { zone } = await service.adoptProviderRecords("example.com", "external", "operator");
      const apex = zone.views.find((view) => view.name === "external")?.records.find((record) => record.name === "@");
      assert.equal(apex?.content, "2606:4700::1", "adoption followed the provider through the lock");
    });

    it("leaves an ambiguous name alone rather than rewriting one of an RRset", async () => {
      // Two records at the same name and type. Refreshing "the" record there
      // means choosing one, and the wrong choice moves somebody else's value.
      const { service, provider } = setup();
      await service.createZone("example.com");
      provider.seed("example.com/external", [
        { id: "a", name: "@", type: "AAAA", content: "100::", ttl: 300, providerId: "cf-1", managed: false },
      ]);
      await service.adoptProviderRecords("example.com", "external", "operator");
      provider.seed("example.com/external", [
        { id: "a", name: "@", type: "AAAA", content: "2606:4700::1", ttl: 300, providerId: "cf-1", managed: false },
        { id: "b", name: "@", type: "AAAA", content: "2606:4700::2", ttl: 300, providerId: "cf-2", managed: false },
      ]);
      const { refreshed } = await service.adoptProviderRecords("example.com", "external", "operator");
      assert.equal(refreshed.length, 0, "nothing was rewritten on a guess");
    });

    it("lets an unrelated record in the same view still be changed", async () => {
      const service = await withPlaceholder();
      await service.upsertRecord("example.com", "external", "web", { name: "www", type: "A", content: "8.8.8.10", ttl: 300 });
      const updated = await service.upsertRecord("example.com", "external", "web", { name: "www", type: "A", content: "8.8.8.11", ttl: 300 });
      const web = updated.views.find((view) => view.name === "external")?.records.find((record) => record.id === "web");
      assert.equal(web?.content, "8.8.8.11", "the guard is about the owned record, not the view");
    });
  });


  describe("a view this process answers itself", () => {
    /** Publishes the external view and refuses the internal one, as a deployment does. */
    function withoutInternalPublisher(adapters: ReturnType<typeof createInMemoryAdapters>): ProviderAdapter {
      return {
        list: async (target) => {
          if (target.endsWith("/internal")) throw new ProviderNotConfiguredError(`no provider is configured for ${target}`);
          return adapters.provider.list(target);
        },
        apply: (target, operation) => adapters.provider.apply(target, operation),
      };
    }

    it("reports the desired revision as applied instead of failing for want of a provider", async () => {
      // What the portal showed: an internal view with no publisher, in a
      // deployment whose listener answers it, rendered as a red failure on the
      // front page while the system was doing exactly what it was configured to.
      const adapters = createInMemoryAdapters();
      const service = new ControlPlane(adapters.zones, adapters.statuses, withoutInternalPublisher(adapters),
        undefined, undefined, {}, (target) => target.endsWith("/internal"));
      await service.createZone("example.com");
      await service.upsertRecord("example.com", "external", "web", { name: "www", type: "A", content: "8.8.8.10", ttl: 300 });
      const zone = await service.getZone("example.com");

      const { statuses } = await service.apply("example.com");
      const internal = statuses.find((status) => status.view === "internal");
      assert.equal(internal?.state, "applied");
      assert.equal(internal?.appliedRevision, zone.revision, "the revision being answered is the desired one");
      assert.equal(internal?.error, undefined, "nothing failed, so nothing is reported");
    });

    it("does not call a view it answers itself unreadable in a preview", async () => {
      // Reported from the portal: adopting records, then previewing, showed the
      // internal view as an error -- "no provider is configured" -- on the screen
      // an operator reads before applying. `bc16ff2` fixed the same reasoning for
      // `apply` and left this door open, so the status went green and the preview
      // stayed red about the same view.
      const adapters = createInMemoryAdapters();
      const service = new ControlPlane(adapters.zones, adapters.statuses, withoutInternalPublisher(adapters),
        undefined, undefined, {}, (target) => target.endsWith("/internal"));
      await service.createZone("example.com");
      await service.upsertRecord("example.com", "external", "web", { name: "www", type: "A", content: "8.8.8.10", ttl: 300 });

      const { views } = await service.preview("example.com");
      assert.equal(views.internal?.error, undefined, "there is no provider to read, and that is not a failure");
      assert.deepEqual(views.internal?.operations, [], "and nothing to do about it");
      assert.ok(views.external, "the view that does publish is still planned");
    });

    it("deletes a zone without demanding an abandon for a view it answered itself", async () => {
      // The third door. Deletion withdraws what was published, and the set of
      // targets comes from the statuses -- which now include the view this
      // process answers. Nothing was ever published through a provider for it,
      // so asking to withdraw fails for want of one, and "delete this zone"
      // becomes a demand to acknowledge abandoning records that never existed.
      const adapters = createInMemoryAdapters();
      const service = new ControlPlane(adapters.zones, adapters.statuses, withoutInternalPublisher(adapters),
        undefined, undefined, {}, (target) => target.endsWith("/internal"));
      await service.createZone("example.com");
      await service.upsertRecord("example.com", "external", "web", { name: "www", type: "A", content: "8.8.8.10", ttl: 300 });
      await service.apply("example.com");

      const result = await service.deleteZone("example.com");
      assert.deepEqual(result.abandonedProviderTargets, [], "nothing was abandoned, because nothing was published");
      await assert.rejects(service.getZone("example.com"), NotFoundError);
    });

    it("still fails when nothing publishes it and nothing answers it either", async () => {
      // Without the listener there is nowhere for the internal view to go, and
      // that is a real failure worth the red -- the guard must not swallow it.
      const adapters = createInMemoryAdapters();
      const service = new ControlPlane(adapters.zones, adapters.statuses, withoutInternalPublisher(adapters));
      await service.createZone("example.com");
      await service.upsertRecord("example.com", "external", "web", { name: "www", type: "A", content: "8.8.8.11", ttl: 300 });
      const { statuses } = await service.apply("example.com");
      const internal = statuses.find((status) => status.view === "internal");
      assert.equal(internal?.state, "failed");
      assert.match(internal?.error ?? "", /no provider is configured/u);
    });
  });


  describe("what adopting changes beyond the records", () => {
    it("says the listener has become the authority for the whole zone", async () => {
      // The incident: a judgement command in a deploy request was `zone adopt`,
      // it succeeded, and the listener quietly went from forwarding the zone to
      // answering for it. `seen` and `adopted` describe records; what moved was
      // which questions this process answers for a domain.
      const { service, provider } = setup();
      await service.createZone("mail.example");
      provider.seed("mail.example/external", [
        { id: "a", name: "admin", type: "A", content: "8.8.8.10", ttl: 300, providerId: "cf-1", managed: false },
        { id: "b", name: "www", type: "A", content: "8.8.8.11", ttl: 300, providerId: "cf-2", managed: false, proxied: true },
      ]);

      const { warnings } = await service.adoptProviderRecords("mail.example", "external", "operator");
      assert.equal(warnings.length, 2);
      assert.match(warnings[0] ?? "", /answered by this process rather than forwarded/u);
      assert.match(warnings[0] ?? "", /NXDOMAIN inside/u, "the names nobody adopted");
      assert.match(warnings[1] ?? "", /1 proxied record\(s\) now answer with their origin/u);
    });

    it("says nothing when the zone was already answered here", async () => {
      // Only the transition is worth a warning. Repeating it on every later
      // adoption would train the reader to skip the line that matters.
      const { service, provider } = setup();
      await service.createZone("mail.example");
      provider.seed("mail.example/external", [
        { id: "a", name: "admin", type: "A", content: "8.8.8.10", ttl: 300, providerId: "cf-1", managed: false },
      ]);
      await service.adoptProviderRecords("mail.example", "external", "operator");

      provider.seed("mail.example/external", [
        { id: "a", name: "admin", type: "A", content: "8.8.8.10", ttl: 300, providerId: "cf-1", managed: false },
        { id: "b", name: "extra", type: "A", content: "8.8.8.12", ttl: 300, providerId: "cf-3", managed: false },
      ]);
      const { adopted, warnings } = await service.adoptProviderRecords("mail.example", "external", "operator");
      assert.equal(adopted.length, 1, "it did adopt something");
      assert.deepEqual(warnings, [], "and the authority did not change");
    });
  });

});
