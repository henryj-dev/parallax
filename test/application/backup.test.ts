import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  BACKUP_FORMAT, BackupError, exportBackup, importBackup, readBackupDocument, type BackupStores,
} from "../../src/application/backup.ts";
import { ControlPlane } from "../../src/application/control-plane.ts";
import type { CredentialRepository } from "../../src/application/ports.ts";
import { parseSettings } from "../../src/application/settings.ts";
import { MAX_HEALTH_CHECK_TARGETS } from "../../src/domain/health-checks.ts";
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

/** A store whose zones were written by the control plane, holding health checks. */
async function storeWithHealthChecks(zone: string, addresses: number, enabled = true): Promise<BackupStores> {
  const stores = memoryStores();
  const service = new ControlPlane(stores.zones, stores.statuses, createInMemoryAdapters().provider,
    { now: () => new Date("2026-08-08T00:00:00.000Z") }, undefined, {}, (target) => target.endsWith("/internal") ? "listener" : "provider");
  await service.createZone(zone);
  const records = Array.from({ length: addresses }, (_, index) => ({
    id: `app-${index}`, name: "app", type: "A", content: `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`, ttl: 300,
  }));
  await service.replaceDesiredState(zone, { views: [{ name: "external", records: [] }, { name: "internal", records }] });
  await service.setHealthCheck(zone, { name: "app", type: "A", enabled, probe: { kind: "tcp", port: 443 } });
  return stores;
}

/** A restore target held to the rules a serving process enforces. */
function guardedStores(): { stores: BackupStores; locked: () => number } {
  let locked = 0;
  const stores = memoryStores();
  return {
    locked: () => locked,
    stores: {
      ...stores,
      healthChecks: {
        exclusive: async (operation) => { locked += 1; return operation(); },
        unsupported: (_zone, settings) => parseSettings(settings).allowLocalProvider,
      },
    },
  };
}

async function assertNothingWritten(stores: BackupStores): Promise<void> {
  assert.deepEqual(await stores.zones.list(), []);
  assert.deepEqual(await stores.zones.audit(), []);
  assert.deepEqual(await stores.settings.read(), {});
}

describe("restoring health checks", () => {
  it("restores policies that hold, under the lock commits take", async () => {
    const document = await exportBackup(await storeWithHealthChecks("example.com", 2));
    const target = guardedStores();
    await importBackup(target.stores, document);
    assert.equal(target.locked(), 1);
    const internal = (await target.stores.zones.get("example.com"))?.views.find((view) => view.name === "internal");
    assert.equal(internal?.healthChecks?.[0]?.enabled, true);
  });

  it("refuses zones whose enabled addresses together pass the limit, before writing any", async () => {
    const big = await exportBackup(await storeWithHealthChecks("example.com", MAX_HEALTH_CHECK_TARGETS));
    const small = await exportBackup(await storeWithHealthChecks("example.net", 1));
    const merged = { ...big, zones: [...big.zones, ...small.zones], audit: [...big.audit, ...small.audit.map((entry) => ({ ...entry, id: entry.id + 1000 }))] };
    const target = guardedStores();
    await assert.rejects(importBackup(target.stores, merged), (error: unknown) =>
      error instanceof BackupError && error.message.includes(`at most ${MAX_HEALTH_CHECK_TARGETS} addresses`));
    await assertNothingWritten(target.stores);
    // A disabled policy probes nothing, so the same pair restores once it is off.
    const off = await exportBackup(await storeWithHealthChecks("example.net", 1, false));
    await importBackup(target.stores, { ...big, zones: [...big.zones, ...off.zones] });
  });

  it("refuses a policy that protects nothing, and one that does not read, before writing any", async () => {
    const document = await exportBackup(await storeWithHealthChecks("example.com", 1));
    const strip = (zone: typeof document.zones[number]["current"]) => ({
      ...zone,
      views: zone.views.map((view) => (view.name === "internal" ? { ...view, records: [] } : view)),
    });
    const dangling = { ...document, zones: document.zones.map((zone) => ({ ...zone, current: strip(zone.current) })) };
    const target = guardedStores();
    await assert.rejects(importBackup(target.stores, dangling), (error: unknown) =>
      error instanceof BackupError && /no A record to protect/u.test(error.message));
    await assertNothingWritten(target.stores);

    const unreadable = {
      ...document,
      zones: document.zones.map((zone) => ({
        ...zone,
        revisions: zone.revisions.map((snapshot) => ({
          ...snapshot,
          views: snapshot.views.map((view) => (view.healthChecks
            ? { ...view, healthChecks: view.healthChecks.map((policy) => ({ ...policy, enabled: "yes" as never })) }
            : view)),
        })),
      })),
    };
    await assert.rejects(importBackup(target.stores, unreadable), (error: unknown) =>
      error instanceof BackupError && error.message.includes("revisions["));
    await assertNothingWritten(target.stores);
    await importBackup(target.stores, document);
  });

  it("refuses an enabled policy the restored settings would publish elsewhere", async () => {
    const document = await exportBackup(await storeWithHealthChecks("example.com", 1));
    const target = guardedStores();
    await assert.rejects(importBackup(target.stores, { ...document, settings: { allowLocalProvider: true } }), (error: unknown) =>
      error instanceof BackupError && error.message.includes("published to a provider"));
    await assertNothingWritten(target.stores);
    // The store's own settings count when the document carries none.
    const local = guardedStores();
    await local.stores.settings.write({ allowLocalProvider: true });
    await assert.rejects(importBackup(local.stores, document), /published to a provider/u);
    assert.deepEqual(await local.stores.zones.list(), []);
  });
});

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

  /**
   * The refusal covered zones and tokens, and wrote settings and the credential
   * document regardless -- so the ordinary order for a new instance (provision
   * credentials, then load data) destroyed the credentials it had just been
   * given, unrecoverably where the two master keys differ.
   */
  it("refuses to replace a credential document or settings that are already there", async () => {
    const source = await fileStores();
    await fill(source.stores);
    const document = await exportBackup(source.stores);

    const withCredentials = memoryStores();
    await withCredentials.credentials.write("TARGET-CIPHERTEXT-DO-NOT-LOSE");
    await assert.rejects(() => importBackup(withCredentials, document), /already holds a credential document/u);
    assert.equal(await withCredentials.credentials.read(), "TARGET-CIPHERTEXT-DO-NOT-LOSE");

    const withSettings = memoryStores();
    await withSettings.settings.write({ oidcIssuer: "https://idp.example" });
    await assert.rejects(() => importBackup(withSettings, document), /already holds 1 setting/u);
    // Settings are written as a patch, so a restore over them would have left a
    // document that is neither side's.
    assert.deepEqual(await withSettings.settings.read(), { oidcIssuer: "https://idp.example" });
  });

  /**
   * A restore is a sequence of writes into a store with no way to roll them
   * back, so anything that would fail has to be found before the first one.
   */
  it("finds a document that cannot be restored before it writes any of it", async () => {
    const source = await fileStores();
    await fill(source.stores);
    const document = await exportBackup(source.stores);
    const broken = {
      ...document,
      zones: document.zones.map((zone, index) => (index === 1
        ? { ...zone, revisions: [...zone.revisions, zone.revisions[0] as never] }
        : zone)),
    };

    const target = memoryStores();
    await assert.rejects(() => importBackup(target, broken), /more than once/u);
    // Nothing was written, so the retry that the emptiness refusal would
    // otherwise have made impossible is still available.
    assert.deepEqual(await target.zones.list(), []);
    await importBackup(target, document);
    assert.equal((await target.zones.list()).length, 2);
  });

  /**
   * ⚠️ One unusable row takes the whole API down: `prepareConfig` refuses a
   * configuration it cannot read, and it runs inside the request handler -- so
   * every request 500s, including the one that would delete the row.
   */
  it("refuses an access token record that would lock everyone out", async () => {
    const source = await fileStores();
    const document = await exportBackup(source.stores);
    const valid = {
      id: "t", subject: "someone", role: "admin",
      digest: Buffer.alloc(32, 1).toString("base64url"), createdAt: "2026-08-08T00:00:00.000Z",
    };
    const withToken = (token: Record<string, unknown>): typeof document =>
      ({ ...document, accessTokens: [token as never] });

    for (const [what, token] of [
      ["a role outside the three", { ...valid, role: "root" }],
      ["a digest that is not 32 bytes", { ...valid, digest: "AA" }],
      ["an unreadable expiry", { ...valid, expiresAt: "whenever" }],
      ["no subject", { ...valid, subject: "  " }],
    ] as const) {
      await assert.rejects(() => importBackup(memoryStores(), withToken(token)), /not a usable access token/u, what);
    }
    const target = memoryStores();
    await importBackup(target, withToken(valid));
    assert.equal((await target.accessTokens.list()).length, 1);
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
