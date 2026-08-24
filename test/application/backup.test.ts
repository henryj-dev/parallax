import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  BACKUP_FORMAT, BackupError, exportBackup, importBackup, readBackupDocument, type BackupStores,
} from "../../src/application/backup.ts";
import type { CredentialRepository } from "../../src/application/ports.ts";
import { createFileStateAdapters } from "../../src/infrastructure/file-state.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";
import {
  createInMemoryAdapters, InMemoryAccessTokenRepository, InMemorySettingsRepository,
} from "../../src/infrastructure/in-memory.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** The store is one opaque document, so this is the whole of it. */
class InMemoryCredentialRepository implements CredentialRepository {
  #document: string | undefined;
  async read(): Promise<string | undefined> { return this.#document; }
  async write(document: string): Promise<void> { this.#document = document; }
  async update<T>(operation: (document: string | undefined) => { document: string; result: T }): Promise<T> {
    const { document, result } = operation(this.#document);
    this.#document = document;
    return result;
  }
}

async function fileStores(): Promise<{ stores: BackupStores; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "parallax-backup-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "nested", "state.json");
  const persisted = createFileStateAdapters(path);
  const configuration = new FileConfigurationStore(join(directory, "nested", "config.json"));
  return {
    path,
    stores: {
      zones: persisted.zones,
      statuses: persisted.statuses,
      settings: configuration.settings,
      accessTokens: configuration.accessTokens,
      credentials: configuration.credentials,
    },
  };
}

function memoryStores(): BackupStores {
  const persisted = createInMemoryAdapters();
  return {
    zones: persisted.zones,
    statuses: persisted.statuses,
    settings: new InMemorySettingsRepository(),
    accessTokens: new InMemoryAccessTokenRepository(),
    credentials: new InMemoryCredentialRepository(),
  };
}

function zoneAt(name: string, revision: number, content: string) {
  return {
    name,
    revision,
    views: [{ name: "internal", records: [{ id: "root", name: "@", type: "A" as const, content, ttl: 60 }] }],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: `2026-08-08T00:0${revision}:00.000Z`,
  };
}

function auditAt(zone: string, revision: number) {
  return {
    zone,
    revision,
    action: "record.upserted" as const,
    actor: "alice",
    at: `2026-08-08T00:0${revision}:00.000Z`,
    detail: {},
  };
}

/** A store with something of every kind in it. */
async function fill(stores: BackupStores): Promise<void> {
  for (const [name, count] of [["alpha.example", 3], ["bravo.example", 1]] as const) {
    for (let revision = 1; revision <= count; revision += 1) {
      await stores.zones.commitDesiredChange({
        snapshot: zoneAt(name, revision, `192.0.2.${revision}`),
        audit: auditAt(name, revision),
        statuses: [{ zone: name, view: "internal", desiredRevision: revision, appliedRevision: revision - 1, state: "pending" }],
      });
    }
  }
  await stores.settings.write({ revisionRetention: 25, allowLocalProvider: true });
  await stores.accessTokens.create({
    id: "tok_one",
    subject: "bootstrap",
    digest: Buffer.alloc(32, 1).toString("base64url"),
    role: "admin",
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  await stores.credentials.write(JSON.stringify({ version: 1, profiles: { main: { ciphertext: "not-a-real-secret" } } }));
}

/** Everything a restore is supposed to have carried, in a comparable shape. */
async function contentsOf(stores: BackupStores) {
  const zones = await stores.zones.list();
  return {
    zones,
    revisions: await Promise.all(zones.map((zone) => stores.zones.listRevisions(zone.name))),
    statuses: await Promise.all(zones.map((zone) => stores.statuses.list(zone.name))),
    // Ids are the store's to assign, so the comparison is over everything else.
    audit: (await stores.zones.audit()).map(({ id: _renumbered, ...rest }) => rest),
    settings: await stores.settings.read(),
    accessTokens: await stores.accessTokens.list(),
    credentials: await stores.credentials.read(),
  };
}

describe("backup and restore", () => {
  /**
   * The migration this exists for, with the second backend standing in for
   * PostgreSQL: both implement the same ports, and the document only ever
   * speaks to those. A test against a real database would prove the same thing
   * about the same three method calls, and would not run without one.
   */
  it("carries a whole store into a different backend", async () => {
    const source = await fileStores();
    await fill(source.stores);
    const before = await contentsOf(source.stores);

    const document = await exportBackup(source.stores, () => new Date("2026-08-24T00:00:00.000Z"));
    assert.equal(document.format, BACKUP_FORMAT);
    assert.equal(document.takenAt, "2026-08-24T00:00:00.000Z");

    // Through JSON, because that is how it travels.
    const target = memoryStores();
    const summary = await importBackup(target, readBackupDocument(JSON.parse(JSON.stringify(document))));

    assert.deepEqual(summary, {
      zones: 2, revisions: 4, audit: 4, statuses: 2, settings: 2, accessTokens: 1,
      credentials: true, auditRenumbered: true,
    });
    assert.deepEqual(await contentsOf(target), before);
  });

  it("carries the credential document byte for byte, because nothing here can read it", async () => {
    const source = await fileStores();
    const stored = JSON.stringify({ version: 1, profiles: { main: { ciphertext: "opaque" } } });
    await source.stores.credentials.write(stored);
    const document = await exportBackup(source.stores);
    assert.equal(document.credentials, stored);

    const target = memoryStores();
    await importBackup(target, document);
    assert.equal(await target.credentials.read(), stored);
  });

  it("says that the audit log came back renumbered", async () => {
    const source = await fileStores();
    await fill(source.stores);
    const target = memoryStores();
    const summary = await importBackup(target, await exportBackup(source.stores));
    assert.equal(summary.auditRenumbered, true);
    // The order and the content are what survive; the numbers are the store's.
    const restored = await target.zones.audit();
    assert.deepEqual(restored.map((entry) => entry.id), [4, 3, 2, 1]);
    assert.deepEqual(
      restored.map((entry) => `${entry.zone}@${entry.revision}`),
      ["bravo.example@1", "alpha.example@3", "alpha.example@2", "alpha.example@1"],
    );
  });

  it("refuses to restore over a store that already holds something", async () => {
    const source = await fileStores();
    await fill(source.stores);
    const document = await exportBackup(source.stores);

    await assert.rejects(() => importBackup(source.stores, document), BackupError);
    await assert.rejects(() => importBackup(source.stores, document), /already holds alpha.example/u);

    // A store with no zones but somebody's token in it is not empty either --
    // restoring would leave two sets of credentials and no sign of it.
    const half = memoryStores();
    await half.accessTokens.create({ id: "t", subject: "someone", digest: Buffer.alloc(32, 2).toString("base64url"), role: "viewer", createdAt: "2026-08-08T00:00:00.000Z" });
    await assert.rejects(() => importBackup(half, document), /already holds 1 access token/u);
  });

  it("keeps a zone whose current revision is no longer retained", async () => {
    const source = await fileStores();
    await source.stores.zones.save(zoneAt("alpha.example", 9, "192.0.2.9"));
    const document = await exportBackup(source.stores);
    assert.deepEqual(document.zones[0]?.revisions, []);

    const target = memoryStores();
    await importBackup(target, document);
    // Without the fallback this zone would arrive at whatever the newest
    // retained revision was, which is to say it would move backwards.
    assert.equal((await target.zones.get("alpha.example"))?.revision, 9);
  });

  it("refuses a document it was not asked to read", async () => {
    assert.throws(() => readBackupDocument("a string"), /must be a JSON object/u);
    assert.throws(() => readBackupDocument({ format: 99 }), /unsupported backup format 99/u);
    assert.throws(() => readBackupDocument({ format: BACKUP_FORMAT }), /zones must be an array/u);
    assert.throws(
      () => readBackupDocument({ format: BACKUP_FORMAT, zones: [{ current: 1 }] }),
      /zones\[0\].current must be an object/u,
    );
  });

  it("writes nothing about the store's location into the document", async () => {
    const source = await fileStores();
    await fill(source.stores);
    const document = JSON.stringify(await exportBackup(source.stores));
    // A document that named its origin would make a restore elsewhere look
    // wrong, and would put a filesystem path into whatever the operator does
    // with the file.
    assert.ok(!document.includes(source.path), "the backup names the store it came from");
    assert.ok(!document.includes(tmpdir()));
    // ...and it really did read the store rather than an empty one.
    assert.ok((await readFile(source.path, "utf8")).includes("alpha.example"));
  });
});
