import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { RevisionConflictError, type StatusRepository, type ZoneRepository } from "../../src/application/ports.ts";
import type { Zone } from "../../src/domain/dns.ts";
import { FileStateRepository } from "../../src/infrastructure/file-state.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileStateRepository", () => {
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
