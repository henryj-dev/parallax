import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { RevisionConflictError, type StatusRepository, type ZoneRepository } from "../../src/application/ports.ts";
import type { Zone } from "../../src/domain/dns.ts";
import { createFileStateAdapters, FileStateRepository } from "../../src/infrastructure/file-state.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileStateRepository", () => {
  it("pages the alphabetical zone listing without changing the complete listing", async () => {
    const repository = new FileStateRepository(await statePath());
    for (const name of ["charlie.example", "alpha.example", "bravo.example"]) {
      await repository.save(zoneFixture(name, 1));
    }

    assert.deepEqual((await repository.list({ limit: 1, offset: 1 })).map((zone) => zone.name), ["bravo.example"]);
    assert.deepEqual((await repository.list()).map((zone) => zone.name),
      ["alpha.example", "bravo.example", "charlie.example"]);
  });

  it("implements both repository ports and restores zones, audit, and status after restart", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    const zones: ZoneRepository = repository;
    const statuses: StatusRepository = repository;
    const zone = zoneFixture("example.com", 2);

    await zones.save(zone);
    await zones.saveRevision(zone);
    const audit = await zones.appendAudit({
      zone: zone.name,
      revision: zone.revision,
      action: "record.upserted",
      actor: "alice",
      at: "2026-08-08T00:01:00.000Z",
      detail: { view: "external" },
    });
    await statuses.save({
      zone: zone.name,
      view: "external",
      desiredRevision: 2,
      appliedRevision: 1,
      state: "pending",
    });

    const restarted = new FileStateRepository(path);
    assert.deepEqual(await restarted.get(zone.name), zone);
    assert.deepEqual(await restarted.getRevision(zone.name, 2), zone);
    assert.deepEqual(await restarted.listRevisions(zone.name), [zone]);
    assert.deepEqual(await restarted.audit(zone.name), [{ ...audit, id: 1 }]);
    assert.deepEqual(await restarted.get(zone.name, "external"), {
      zone: zone.name,
      view: "external",
      desiredRevision: 2,
      appliedRevision: 1,
      state: "pending",
    });
    assert.equal((await restarted.appendAudit({
      zone: zone.name,
      revision: 3,
      action: "record.deleted",
      actor: "bob",
      at: "2026-08-08T00:02:00.000Z",
      detail: {},
    })).id, 2);
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
  });

  it("persists immutable revision snapshots and removes them with a deleted zone", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    const first = zoneFixture("example.com", 1);
    const second = { ...zoneFixture("example.com", 2), updatedAt: "2026-08-08T00:01:00.000Z" };
    await repository.saveRevision(first);
    await repository.saveRevision(second);
    first.views[0]!.records[0]!.content = "203.0.113.1";

    const restarted = new FileStateRepository(path);
    assert.equal((await restarted.getRevision("example.com", 1))?.views[0]?.records[0]?.content, "192.0.2.10");
    assert.deepEqual((await restarted.listRevisions("example.com")).map((item) => item.revision), [1, 2]);
    await assert.rejects(restarted.saveRevision(zoneFixture("example.com", 1)), /already exists/);
    await restarted.delete("example.com");
    assert.deepEqual(await restarted.listRevisions("example.com"), []);
  });

  it("commits a revision, audit entry, and pending statuses in one durable file replacement", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    const snapshot = zoneFixture("example.com", 1);
    await repository.commitDesiredChange({
      snapshot,
      audit: {
        zone: snapshot.name, revision: 1, action: "zone.created", actor: "alice",
        at: "2026-08-08T00:00:00.000Z", detail: { before: null, after: { views: snapshot.views } },
      },
      statuses: [{
        zone: snapshot.name, view: "external", desiredRevision: 1, appliedRevision: 0, state: "pending",
      }],
    });

    const restarted = new FileStateRepository(path);
    assert.deepEqual(await restarted.get("example.com"), snapshot);
    assert.deepEqual(await restarted.getRevision("example.com", 1), snapshot);
    assert.equal((await restarted.audit("example.com"))[0]?.revision, 1);
    assert.equal((await restarted.get("example.com", "external"))?.state, "pending");
    await assert.rejects(repository.commitDesiredChange({
      snapshot, audit: { zone: snapshot.name, revision: 1, action: "zone.created", actor: "alice", at: snapshot.createdAt, detail: {} }, statuses: [],
    }), RevisionConflictError);
    assert.equal((await restarted.audit("example.com")).length, 1);
  });

  it("returns clones so callers cannot mutate persisted state", async () => {
    const repository = new FileStateRepository(await statePath());
    await repository.save(zoneFixture("example.com", 1));
    await repository.save({
      zone: "example.com",
      view: "external",
      desiredRevision: 1,
      appliedRevision: 0,
      state: "failed",
      error: "offline",
    });
    const audit = await repository.appendAudit({
      zone: "example.com",
      revision: 1,
      action: "zone.created",
      actor: "alice",
      at: "2026-08-08T00:00:00.000Z",
      detail: { source: "portal" },
    });

    const zone = await repository.get("example.com");
    zone!.views[0]!.records[0]!.content = "203.0.113.99";
    const status = await repository.get("example.com", "external");
    status!.error = "changed";
    audit.detail.source = "changed";

    assert.equal((await repository.get("example.com"))!.views[0]!.records[0]!.content, "192.0.2.10");
    assert.equal((await repository.get("example.com", "external"))!.error, "offline");
    assert.deepEqual((await repository.audit())[0]!.detail, { source: "portal" });
  });

  it("atomically appends an audit entry and prunes only expired entries for its zone", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    const base = {
      revision: 1,
      action: "provider.apply.started" as const,
      actor: "alice",
      detail: {},
    };
    await repository.appendAudit({ ...base, zone: "example.com", at: "2026-01-01T00:00:00.000Z" });
    await repository.appendAudit({ ...base, zone: "other.example", at: "2026-01-01T00:00:00.000Z" });

    const appended = await repository.appendAudit({
      ...base,
      zone: "example.com",
      at: "2026-03-01T00:00:00.000Z",
    }, { deleteAuditBefore: "2026-02-01T00:00:00.000Z" });

    const restarted = new FileStateRepository(path);
    assert.deepEqual(await restarted.audit("example.com"), [appended]);
    assert.equal((await restarted.audit("other.example"))[0]?.id, 2, "retention must stay scoped to one zone");
    const next = await restarted.appendAudit({
      ...base,
      zone: "example.com",
      at: "2026-03-02T00:00:00.000Z",
    });
    assert.equal(next.id, 4, "pruning must not reuse an audit identifier");
  });

  it("does not let an older apply result overwrite a newer pending revision", async () => {
    const repository = new FileStateRepository(await statePath());
    await repository.save({ zone: "example.com", view: "external", desiredRevision: 3, appliedRevision: 2, state: "pending" });
    await repository.save({ zone: "example.com", view: "external", desiredRevision: 2, appliedRevision: 2, state: "applied" });
    assert.deepEqual(await repository.get("example.com", "external"), {
      zone: "example.com", view: "external", desiredRevision: 3, appliedRevision: 2, state: "pending",
    });
  });

  it("serializes concurrent writes without losing zones, statuses, or audit ids", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    const count = 24;

    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const name = `zone-${index}.example`;
      await repository.save(zoneFixture(name, index + 1));
      await repository.save({
        zone: name,
        view: "external",
        desiredRevision: index + 1,
        appliedRevision: index,
        state: "pending",
      });
      return repository.appendAudit({
        zone: name,
        revision: index + 1,
        action: "zone.created",
        actor: "test",
        at: "2026-08-08T00:00:00.000Z",
        detail: {},
      });
    }));

    const restarted = new FileStateRepository(path);
    assert.equal((await restarted.list()).length, count);
    assert.equal((await restarted.audit()).length, count);
    assert.deepEqual((await restarted.audit()).map((entry) => entry.id).sort((a, b) => a - b),
      Array.from({ length: count }, (_, index) => index + 1));
    for (let index = 0; index < count; index += 1) {
      assert.equal((await restarted.list(`zone-${index}.example`)).length, 1);
    }
  });

  it("serializes provider work across independent file-backend instances", async () => {
    const path = await statePath();
    const first = createFileStateAdapters(path).applyLock;
    const second = createFileStateAdapters(path).applyLock;
    const events: string[] = [];
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const holding = first.withZoneLock("example.com", async () => {
      events.push("first-entered");
      firstEntered();
      await gate;
      events.push("first-leaving");
    });
    await entered;
    const waiting = second.withZoneLock("example.com", async () => { events.push("second-entered"); });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(events, ["first-entered"]);
    releaseFirst();
    await Promise.all([holding, waiting]);
    assert.deepEqual(events, ["first-entered", "first-leaving", "second-entered"]);
  });

  it("keeps a late apply attempt visible when another process already stored a newer desired revision", async () => {
    const path = await statePath();
    const desiredWriter = new FileStateRepository(path);
    const applyWriter = new FileStateRepository(path);
    await desiredWriter.save(zoneFixture("example.com", 3));
    await desiredWriter.save({
      zone: "example.com", view: "external", desiredRevision: 3,
      appliedRevision: 1, state: "pending",
    });
    await applyWriter.save({
      zone: "example.com", view: "external", desiredRevision: 2,
      appliedRevision: 2, state: "applied", lastAttemptAt: "2026-08-08T00:00:01.000Z",
    });

    assert.deepEqual(await new FileStateRepository(path).get("example.com", "external"), {
      zone: "example.com", view: "external", desiredRevision: 3,
      appliedRevision: 2, state: "pending", lastAttemptAt: "2026-08-08T00:00:01.000Z",
    });
  });

  it("locks and re-reads across independent repository instances", async () => {
    const path = await statePath();
    const left = new FileStateRepository(path);
    const right = new FileStateRepository(path);
    // Prime both readers before either writer changes the file. A whole-file
    // cache would make the second writer overwrite the first snapshot.
    await Promise.all([left.list(), right.list()]);
    await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const repository = index % 2 === 0 ? left : right;
      return repository.save(zoneFixture(`shared-${index}.example`, index + 1));
    }));

    assert.equal((await left.list()).length, 20);
    assert.equal((await right.list()).length, 20);
    await right.save(zoneFixture("late.example", 1));
    assert.equal((await left.get("late.example"))?.name, "late.example", "reads must observe external replacements");
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  });

  it("rejects malformed nested zones, statuses, revisions, and audit entries", async () => {
    const path = await statePath();
    const zone = zoneFixture("example.com", 1);
    await new FileStateRepository(path).save(zone);
    const valid = {
      version: 1,
      zones: { "example.com": zone },
      audit: [{ id: 1, zone: "example.com", revision: 1, action: "zone.created", actor: "alice",
        at: zone.createdAt, detail: {} }],
      statuses: { "example.com\u0000external": {
        zone: "example.com", view: "external", desiredRevision: 1, appliedRevision: 0, state: "pending",
      } },
      revisions: { "example.com": { "1": zone } },
      nextAuditId: 2,
    };
    const corruptions: unknown[] = [
      { ...valid, zones: { "example.com": { ...zone, views: [{ name: "external", records: [{ ...zone.views[0]!.records[0]!, ttl: "60" }] }] } } },
      { ...valid, zones: { "example.com": { ...zone, views: [{ name: "external", records: [
        zone.views[0]!.records[0]!,
        { id: "alias", name: "@", type: "CNAME", content: "target.example.com", ttl: 60 },
      ] }] } } },
      { ...valid, zones: { "example.com": { ...zone, views: [
        { name: "external", records: [{ id: "alias", name: "www", type: "CNAME", content: "target.example.com", ttl: 60 }] },
        { name: "internal", records: [{ id: "override", name: "www", type: "A", content: "192.0.2.20", ttl: 60 }] },
      ] } } },
      { ...valid, statuses: { "example.com\u0000external": { ...valid.statuses["example.com\u0000external"], state: "forged-applied" } } },
      { ...valid, revisions: { "example.com": { "2": zone } } },
      { ...valid, audit: [{ ...valid.audit[0], action: "security.hidden" }] },
    ];
    for (const corruption of corruptions) {
      await writeFile(path, `${JSON.stringify(corruption)}\n`, { encoding: "utf8", mode: 0o600 });
      await assert.rejects(new FileStateRepository(path).list(), /unsupported or invalid state file/);
    }
  });

  it("commits deletion audit, zone/revision deletion, and status deletion in one durable replacement", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    const snapshot = zoneFixture("example.com", 1);
    await repository.commitDesiredChange({
      snapshot,
      audit: { zone: snapshot.name, revision: 1, action: "zone.created", actor: "alice", at: snapshot.createdAt, detail: {} },
      statuses: [{ zone: snapshot.name, view: "external", desiredRevision: 1, appliedRevision: 0, state: "pending" }],
    });
    await repository.commitZoneDeletion({
      zone: "example.com",
      expectedRevision: 1,
      audit: { zone: "example.com", revision: 2, action: "zone.deleted", actor: "alice", at: snapshot.createdAt,
        detail: { before: { views: snapshot.views }, after: null } },
    });

    const restarted = new FileStateRepository(path);
    assert.equal(await restarted.get("example.com"), undefined);
    assert.deepEqual(await restarted.listRevisions("example.com"), []);
    assert.deepEqual(await restarted.list("example.com"), []);
    assert.deepEqual((await restarted.audit("example.com")).map((entry) => entry.action), ["zone.deleted", "zone.created"]);
  });

  it("leaves the complete file state unchanged when deletion has a stale expected revision", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    const snapshot = zoneFixture("example.com", 2);
    await repository.commitDesiredChange({
      snapshot,
      audit: { zone: snapshot.name, revision: 2, action: "zone.created", actor: "alice", at: snapshot.createdAt, detail: {} },
      statuses: [{ zone: snapshot.name, view: "external", desiredRevision: 2, appliedRevision: 1, state: "pending" }],
    });

    await assert.rejects(repository.commitZoneDeletion({
      zone: "example.com", expectedRevision: 1,
      audit: { zone: "example.com", revision: 2, action: "zone.deleted", actor: "bob", at: snapshot.createdAt, detail: {} },
    }), RevisionConflictError);

    const restarted = new FileStateRepository(path);
    assert.equal((await restarted.get("example.com"))?.revision, 2);
    assert.deepEqual((await restarted.listRevisions("example.com")).map((item) => item.revision), [2]);
    assert.equal((await restarted.list("example.com")).length, 1);
    assert.deepEqual((await restarted.audit("example.com")).map((entry) => entry.action), ["zone.created"]);
  });
});

describe("state written before a rule existed", () => {
  /**
   * A stored record the current rules would refuse must still be readable.
   *
   * Every read rebuilds records through `createDesiredRecord`, so a rule about
   * what may be *written* would apply retroactively to the whole store if it
   * were asked here too. One oversized record would then make the zone
   * unreadable -- and deleting the record means reading the zone first, so
   * there would be no way out. This is the same call `readPersistedViewName`
   * already made for view names.
   */
  it("reads a zone holding RDATA larger than the wire allows, so it can be deleted", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    await repository.save(zoneFixture("legacy.example", 1));

    // Written straight to the file, because saving it through the repository is
    // exactly what the new rule refuses.
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      zones: Record<string, { views: { records: Record<string, unknown>[] }[] }>;
    };
    raw.zones["legacy.example"]!.views[0]!.records.push({
      id: "oversized", name: "key", type: "OPENPGPKEY", content: "a".repeat(90_000), ttl: 60,
    });
    await writeFile(path, JSON.stringify(raw), "utf8");

    const zone = await new FileStateRepository(path).get("legacy.example");
    assert.equal(zone?.views[0]?.records.length, 2);
    assert.equal(zone?.views[0]?.records[1]?.id, "oversized");
  });
});

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "parallax-file-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "state.json");
}

function zoneFixture(name: string, revision: number): Zone {
  return {
    name,
    revision,
    views: [{
      name: "external",
      records: [{ id: "root", name: "@", type: "A", content: "192.0.2.10", ttl: 60 }],
    }],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}
