import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
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

describe("the split layout", () => {
  /**
   * The measurement this split exists for, reduced to a shape a test can hold.
   *
   * Back to back on this Mac at ten zones of two hundred records with fifty
   * retained revisions: the state file went 19.9 MiB to 0.4 MiB, one record
   * change 1778 ms to 124 ms, and `list()` 421.9 ms to 19.4 ms. What is pinned
   * here is the reason -- that a change to one zone stops rewriting the others'
   * history -- because a timing assertion on a shared runner is not evidence.
   */
  it("leaves the other zones' history untouched when one zone changes", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    for (const name of ["alpha.example", "bravo.example"]) {
      await repository.commitDesiredChange({
        snapshot: zoneFixture(name, 1),
        audit: auditFixture(name, 1),
        statuses: [],
      });
    }
    const untouched = await stat(revisionPath(path, "bravo.example"));

    await repository.commitDesiredChange({
      snapshot: { ...zoneFixture("alpha.example", 2), updatedAt: "2026-08-08T00:05:00.000Z" },
      audit: auditFixture("alpha.example", 2),
      statuses: [],
    });

    const after = await stat(revisionPath(path, "bravo.example"));
    assert.equal(after.mtimeMs, untouched.mtimeMs, "the other zone's history was rewritten");
    // The state file holds current snapshots and statuses, and nothing that
    // grows with history.
    const document = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(document).sort(), ["auditOldestAt", "nextAuditId", "statuses", "version", "zones"]);
    assert.equal(await revisionCount(path, "alpha.example"), 2);
  });

  it("splits a version 1 document apart on the first write and loses nothing", async () => {
    const path = await statePath();
    const legacy = new FileStateRepository(path);
    await legacy.commitDesiredChange({ snapshot: zoneFixture("alpha.example", 1), audit: auditFixture("alpha.example", 1), statuses: [] });
    await legacy.commitDesiredChange({
      snapshot: { ...zoneFixture("alpha.example", 2), updatedAt: "2026-08-08T00:01:00.000Z" },
      audit: auditFixture("alpha.example", 2),
      statuses: [],
    });
    // Fold it back into the shape version 1 wrote, which is what an existing
    // deployment has on disk.
    const split = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const before = { revisions: await legacy.listRevisions("alpha.example"), audit: await legacy.audit() };
    await writeFile(path, `${JSON.stringify({
      version: 1,
      zones: split.zones,
      statuses: split.statuses,
      nextAuditId: split.nextAuditId,
      audit: before.audit,
      revisions: { "alpha.example": Object.fromEntries(before.revisions.map((one) => [String(one.revision), one])) },
    }, null, 2)}\n`);
    await rm(`${path}.d`, { recursive: true, force: true });

    // Readable before anything writes, and unchanged on disk by reading it.
    const reopened = new FileStateRepository(path);
    assert.deepEqual(await reopened.listRevisions("alpha.example"), before.revisions);
    assert.deepEqual(await reopened.audit(), before.audit);
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1, "a reader must not rewrite the store");

    // The first write splits it, under the lock.
    await reopened.appendAudit(auditFixture("alpha.example", 2));
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
    const migrated = new FileStateRepository(path);
    assert.deepEqual(await migrated.listRevisions("alpha.example"), before.revisions);
    assert.deepEqual((await migrated.audit()).slice(1), before.audit);
    assert.deepEqual(await migrated.get("alpha.example"), await legacy.get("alpha.example"));
  });

  /**
   * The window the design creates, and the reason the state file is the commit
   * point rather than one of three renames.
   *
   * A crash between a side-file write and that rename leaves a revision the
   * state file does not name, or an audit id it has not reached. Neither is
   * served, and the next write replaces both -- so what a crash leaves is
   * invisible rather than wrong.
   */
  it("ignores side-file writes the state file never committed", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    await repository.commitDesiredChange({ snapshot: zoneFixture("alpha.example", 1), audit: auditFixture("alpha.example", 1), statuses: [] });

    // A revision written by a commit that never reached the state file.
    const revisionFile = revisionPath(path, "alpha.example");
    const document = JSON.parse(await readFile(revisionFile, "utf8")) as { zone: string; revisions: Record<string, unknown> };
    document.revisions["2"] = { ...zoneFixture("alpha.example", 2), updatedAt: "2026-08-08T00:09:00.000Z" };
    await writeFile(revisionFile, JSON.stringify(document));
    // ...and an audit line from the same interrupted commit.
    const auditFile = join(`${path}.d`, "audit.jsonl");
    const orphan = { ...auditFixture("alpha.example", 2), id: 2 };
    await writeFile(auditFile, `${await readFile(auditFile, "utf8")}${JSON.stringify(orphan)}\n`);

    const reopened = new FileStateRepository(path);
    assert.deepEqual((await reopened.listRevisions("alpha.example")).map((one) => one.revision), [1]);
    assert.deepEqual((await reopened.audit()).map((one) => one.id), [1]);

    // The next commit reuses the id, and the later line is the one that counts.
    await reopened.appendAudit({ ...auditFixture("alpha.example", 1), actor: "the-real-one" });
    const entries = await new FileStateRepository(path).audit();
    assert.deepEqual(entries.map((one) => one.id), [2, 1]);
    assert.equal(entries[0]?.actor, "the-real-one");
  });

  /**
   * The window that used to destroy history: retention pruned the side files
   * before the state file landed, so a commit that never happened still took
   * revisions with it.
   */
  it("keeps every retained revision when a commit is interrupted before it lands", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    const retention = { maxRevisionsPerZone: 3 };
    for (let revision = 1; revision <= 4; revision += 1) {
      await repository.commitDesiredChange({
        snapshot: { ...zoneFixture("alpha.example", revision), updatedAt: `2026-08-08T00:0${revision}:00.000Z` },
        audit: auditFixture("alpha.example", revision),
        statuses: [],
        retention,
      });
    }
    const before = (await repository.listRevisions("alpha.example")).map((one) => one.revision);
    assert.deepEqual(before, [2, 3, 4], "retention should be holding three");

    // The state file as it stands is what a crash before the next commit's
    // rename leaves behind: read it back with a fresh repository and the
    // revision file must still carry every revision the committed state
    // vouches for.
    const reopened = new FileStateRepository(path);
    assert.equal((await reopened.get("alpha.example"))?.revision, 4);
    assert.deepEqual((await reopened.listRevisions("alpha.example")).map((one) => one.revision), [2, 3, 4]);

    // And a revision file that a crash left un-pruned is trimmed by the next
    // commit rather than left to grow.
    await repository.commitDesiredChange({
      snapshot: { ...zoneFixture("alpha.example", 5), updatedAt: "2026-08-08T00:05:00.000Z" },
      audit: auditFixture("alpha.example", 5),
      statuses: [],
      retention,
    });
    assert.deepEqual((await repository.listRevisions("alpha.example")).map((one) => one.revision), [3, 4, 5]);
  });

  it("takes a deleted zone's history with it", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    await repository.commitDesiredChange({ snapshot: zoneFixture("alpha.example", 1), audit: auditFixture("alpha.example", 1), statuses: [] });
    assert.equal(await revisionCount(path, "alpha.example"), 1);

    await repository.commitZoneDeletion({
      zone: "alpha.example",
      expectedRevision: 1,
      audit: { ...auditFixture("alpha.example", 1), action: "zone.deleted" },
    });
    await assert.rejects(stat(revisionPath(path, "alpha.example")), /ENOENT/u);
    assert.deepEqual(await repository.listRevisions("alpha.example"), []);
  });

  it("rewrites the audit log only when retention has something to remove", async () => {
    const path = await statePath();
    const repository = new FileStateRepository(path);
    const auditFile = join(`${path}.d`, "audit.jsonl");
    await repository.appendAudit({ ...auditFixture("alpha.example", 1), at: "2026-01-01T00:00:00.000Z" });
    await repository.appendAudit({ ...auditFixture("alpha.example", 1), at: "2026-08-08T00:00:00.000Z" });

    // Nothing is older than the cutoff, so this is an append and the two lines
    // that were there stay byte-for-byte where they were.
    const before = await readFile(auditFile, "utf8");
    await repository.appendAudit(
      { ...auditFixture("alpha.example", 1), at: "2026-08-09T00:00:00.000Z" },
      { deleteAuditBefore: "2025-01-01T00:00:00.000Z" },
    );
    assert.ok((await readFile(auditFile, "utf8")).startsWith(before), "an append rewrote the log");

    await repository.appendAudit(
      { ...auditFixture("alpha.example", 1), at: "2026-08-10T00:00:00.000Z" },
      { deleteAuditBefore: "2026-08-01T00:00:00.000Z" },
    );
    assert.deepEqual((await repository.audit()).map((one) => one.at), [
      "2026-08-10T00:00:00.000Z", "2026-08-09T00:00:00.000Z", "2026-08-08T00:00:00.000Z",
    ]);
    // ⚠️ The hint deliberately lags the log by one commit, and must never lead
    // it. Retention now runs *after* the state file lands -- a crash in that
    // window has to leave more history than configured rather than less -- so
    // the hint written at commit time still names the entry the prune removed.
    // Lagging costs one wasted pass over a log that is already short. Leading
    // would skip a prune that is still owed, which is unbounded growth.
    const hint = JSON.parse(await readFile(path, "utf8")).auditOldestAt as string;
    assert.ok(hint <= "2026-08-08T00:00:00.000Z", `the skip hint outran the log: ${hint}`);

    // ...and the next commit does the pass the lag left owed, without needing
    // retention to be asked for again.
    await repository.appendAudit(
      { ...auditFixture("alpha.example", 1), at: "2026-08-11T00:00:00.000Z" },
      { deleteAuditBefore: "2026-08-01T00:00:00.000Z" },
    );
    assert.equal(JSON.parse(await readFile(path, "utf8")).auditOldestAt, "2026-08-08T00:00:00.000Z");
  });
});

function revisionPath(statePath: string, zone: string): string {
  return join(`${statePath}.d`, `rev-${createHash("sha256").update(zone, "utf8").digest("hex")}.json`);
}

async function revisionCount(statePath: string, zone: string): Promise<number> {
  const document = JSON.parse(await readFile(revisionPath(statePath, zone), "utf8")) as { revisions: Record<string, unknown> };
  return Object.keys(document.revisions).length;
}

function auditFixture(zone: string, revision: number) {
  return { zone, revision, action: "record.upserted" as const, actor: "alice", at: "2026-08-08T00:00:00.000Z", detail: {} };
}

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
