import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Zone } from "../../src/domain/dns.ts";
import { RevisionConflictError } from "../../src/application/ports.ts";
import {
  PostgresStatusRepository,
  PostgresApplyLock,
  PostgresAccessTokenRepository,
  PostgresCredentialRepository,
  PostgresSettingsRepository,
  PostgresZoneRepository,
  createPostgresAdapters,
  type PgClient,
  type PgPool,
  type PgQueryResult,
} from "../../src/infrastructure/postgres.ts";

interface Call { text: string; values?: readonly unknown[] }
type Handler = (call: Call) => PgQueryResult | Promise<PgQueryResult>;

class FakeClient implements PgClient {
  readonly calls: Call[] = [];
  readonly handler: Handler;
  released = false;
  constructor(handler: Handler) { this.handler = handler; }
  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
    const call = { text: normalize(text), ...(values ? { values } : {}) };
    this.calls.push(call);
    return await this.handler(call) as PgQueryResult<Row>;
  }
  release(): void { this.released = true; }
}

class FakePool implements PgPool {
  readonly calls: Call[] = [];
  readonly client: FakeClient;
  constructor(handler: Handler = () => ({ rows: [] }), clientHandler: Handler = handler) {
    this.client = new FakeClient(clientHandler);
    this.handler = handler;
  }
  readonly handler: Handler;
  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
    const call = { text: normalize(text), ...(values ? { values } : {}) };
    this.calls.push(call);
    return await this.handler(call) as PgQueryResult<Row>;
  }
  async connect(): Promise<PgClient> { return this.client; }
}

class CapacityPool implements PgPool {
  readonly max: number;
  readonly clients: FakeClient[] = [];
  checkedOut = 0;
  poolQueryCalls = 0;

  constructor(max: number) {
    this.max = max;
  }

  async query<Row = Record<string, unknown>>(_text: string, _values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
    this.poolQueryCalls += 1;
    if (this.checkedOut >= this.max) throw new Error("pool capacity exhausted");
    return { rows: [] };
  }

  async connect(): Promise<PgClient> {
    if (this.checkedOut >= this.max) throw new Error("pool capacity exhausted");
    this.checkedOut += 1;
    const client = new FakeClient(() => ({ rows: [] }));
    const release = client.release.bind(client);
    client.release = () => {
      if (!client.released) this.checkedOut -= 1;
      release();
    };
    this.clients.push(client);
    return client;
  }
}

describe("PostgresZoneRepository", () => {
  it("stores an immutable revision and current snapshot in one client transaction", async () => {
    const pool = new FakePool(undefined, (call) => {
      if (call.text.startsWith("SELECT revision")) return { rows: [] };
      return { rows: [] };
    });
    const repository = new PostgresZoneRepository(pool);
    const zone = zoneFixture(1);

    await repository.saveRevision(zone);

    assert.equal(pool.calls.length, 0, "transactional statements must not use pool.query");
    assert.deepEqual(pool.client.calls.map((call) => call.text.split(" ")[0]),
      ["BEGIN", "SELECT", "SELECT", "INSERT", "INSERT", "COMMIT"]);
    assert.match(pool.client.calls[1]!.text, /pg_advisory_xact_lock/);
    assert.deepEqual(pool.client.calls[1]!.values, ["example.com"]);
    assert.match(pool.client.calls[2]!.text, /FOR UPDATE/);
    assert.match(pool.client.calls[3]!.text, /parallax_zones/);
    assert.match(pool.client.calls[4]!.text, /parallax_zone_revisions/);
    assert.deepEqual(pool.client.calls[3]!.values, ["example.com", 1, JSON.stringify(zone)]);
    assert.equal(pool.client.released, true);
  });

  it("commits snapshot, audit, and pending status in the same client transaction", async () => {
    const pool = new FakePool(undefined, () => ({ rows: [] }));
    const repository = new PostgresZoneRepository(pool);
    const zone = zoneFixture(1);
    await repository.commitDesiredChange({
      snapshot: zone,
      audit: {
        zone: zone.name, revision: 1, action: "zone.created", actor: "alice",
        at: zone.createdAt, detail: { before: null, after: { views: zone.views } },
      },
      statuses: [{ zone: zone.name, view: "external", desiredRevision: 1, appliedRevision: 0, state: "pending" }],
    });

    assert.equal(pool.calls.length, 0);
    assert.deepEqual(pool.client.calls.map((call) => call.text.split(" ")[0]),
      ["BEGIN", "SELECT", "SELECT", "INSERT", "INSERT", "INSERT", "INSERT", "COMMIT"]);
    assert.match(pool.client.calls[5]!.text, /parallax_audit/);
    assert.match(pool.client.calls[6]!.text, /parallax_apply_statuses/);
    assert.deepEqual(pool.client.calls[6]!.values, ["example.com", "external", 1, 0, "pending", null, null, null, null]);
  });

  it("rolls back the desired change when audit or status persistence fails", async () => {
    for (const failingTable of ["parallax_audit", "parallax_apply_statuses"]) {
      const pool = new FakePool(undefined, (call) => {
        if (call.text.includes(failingTable)) throw new Error(`${failingTable} unavailable`);
        return { rows: [] };
      });
      const zone = zoneFixture(1);
      await assert.rejects(new PostgresZoneRepository(pool).commitDesiredChange({
        snapshot: zone,
        audit: { zone: zone.name, revision: 1, action: "zone.created", actor: "alice", at: zone.createdAt, detail: {} },
        statuses: [{ zone: zone.name, view: "external", desiredRevision: 1, appliedRevision: 0, state: "pending" }],
      }), /unavailable/);
      assert.equal(pool.client.calls.at(-1)?.text, "ROLLBACK");
      assert.equal(pool.client.calls.some((call) => call.text === "COMMIT"), false);
      assert.equal(pool.client.released, true);
    }
  });

  it("commits deletion audit and cascading live-state deletion in one advisory-locked transaction", async () => {
    const pool = new FakePool(undefined, (call) => {
      if (call.text.startsWith("SELECT revision")) return { rows: [{ revision: 3 }] };
      if (call.text.startsWith("DELETE FROM parallax_zones")) return { rows: [{ name: "example.com" }] };
      return { rows: [] };
    });
    const repository = new PostgresZoneRepository(pool);

    await repository.commitZoneDeletion({
      zone: "example.com",
      expectedRevision: 3,
      audit: {
        zone: "example.com", revision: 4, action: "zone.deleted", actor: "alice",
        at: "2026-08-08T00:00:00.000Z", detail: { before: { views: [] }, after: null },
      },
    });

    assert.equal(pool.calls.length, 0);
    assert.deepEqual(pool.client.calls.map((call) => call.text.split(" ")[0]),
      ["BEGIN", "SELECT", "SELECT", "INSERT", "DELETE", "COMMIT"]);
    assert.match(pool.client.calls[1]!.text, /pg_advisory_xact_lock/);
    assert.match(pool.client.calls[2]!.text, /FOR UPDATE/);
    assert.match(pool.client.calls[3]!.text, /parallax_audit/);
    assert.deepEqual(pool.client.calls[4]!.values, ["example.com"]);
    assert.equal(pool.client.released, true);
  });

  it("rolls back deletion without a false audit when audit insert or zone deletion fails", async () => {
    for (const failurePoint of ["parallax_audit", "DELETE FROM parallax_zones"]) {
      const failure = new Error(`${failurePoint} unavailable`);
      const pool = new FakePool(undefined, (call) => {
        if (call.text.startsWith("SELECT revision")) return { rows: [{ revision: 3 }] };
        if (call.text.includes(failurePoint)) throw failure;
        if (call.text.startsWith("DELETE FROM parallax_zones")) return { rows: [{ name: "example.com" }] };
        return { rows: [] };
      });

      await assert.rejects(new PostgresZoneRepository(pool).commitZoneDeletion({
        zone: "example.com", expectedRevision: 3,
        audit: { zone: "example.com", revision: 4, action: "zone.deleted", actor: "alice",
          at: "2026-08-08T00:00:00.000Z", detail: {} },
      }), failure);

      assert.equal(pool.client.calls.at(-1)?.text, "ROLLBACK");
      assert.equal(pool.client.calls.some((call) => call.text === "COMMIT"), false);
      assert.equal(pool.client.released, true);
    }
  });

  it("rejects deletion when the locked current revision does not match", async () => {
    const pool = new FakePool(undefined, (call) => {
      if (call.text.startsWith("SELECT revision")) return { rows: [{ revision: 4 }] };
      return { rows: [] };
    });

    await assert.rejects(new PostgresZoneRepository(pool).commitZoneDeletion({
      zone: "example.com", expectedRevision: 3,
      audit: { zone: "example.com", revision: 4, action: "zone.deleted", actor: "alice",
        at: "2026-08-08T00:00:00.000Z", detail: {} },
    }), RevisionConflictError);

    assert.equal(pool.client.calls.some((call) => call.text.includes("parallax_audit")), false);
    assert.equal(pool.client.calls.some((call) => call.text.startsWith("DELETE")), false);
    assert.equal(pool.client.calls.at(-1)?.text, "ROLLBACK");
  });

  it("rolls back the audit if the locked zone is not actually deleted", async () => {
    const pool = new FakePool(undefined, (call) => {
      if (call.text.startsWith("SELECT revision")) return { rows: [{ revision: 3 }] };
      return { rows: [] };
    });

    await assert.rejects(new PostgresZoneRepository(pool).commitZoneDeletion({
      zone: "example.com", expectedRevision: 3,
      audit: { zone: "example.com", revision: 4, action: "zone.deleted", actor: "alice",
        at: "2026-08-08T00:00:00.000Z", detail: {} },
    }), RevisionConflictError);

    assert.equal(pool.client.calls.some((call) => call.text.includes("parallax_audit")), true);
    assert.equal(pool.client.calls.at(-1)?.text, "ROLLBACK");
    assert.equal(pool.client.calls.some((call) => call.text === "COMMIT"), false);
  });

  it("rolls back and releases the same client when snapshot insertion fails", async () => {
    const duplicate = Object.assign(new Error("duplicate"), { code: "23505" });
    const pool = new FakePool(undefined, (call) => {
      if (call.text.includes("parallax_zone_revisions")) throw duplicate;
      return { rows: [] };
    });
    const repository = new PostgresZoneRepository(pool);

    await assert.rejects(repository.saveRevision(zoneFixture(1)), RevisionConflictError);
    assert.equal(pool.client.calls.at(-1)?.text, "ROLLBACK");
    assert.equal(pool.client.released, true);
    assert.equal(pool.client.calls.some((call) => call.text === "COMMIT"), false);
  });

  it("rejects a stale revision under the per-zone lock", async () => {
    const pool = new FakePool(undefined, (call) => call.text.startsWith("SELECT revision")
      ? { rows: [{ revision: 2 }] }
      : { rows: [] });

    await assert.rejects(new PostgresZoneRepository(pool).saveRevision(zoneFixture(2)), RevisionConflictError);
    assert.equal(pool.client.calls.some((call) => call.text.includes("INSERT INTO parallax_zones")), false);
    assert.equal(pool.client.calls.at(-1)?.text, "ROLLBACK");
  });

  it("uses parameterized reads and validates JSON snapshots returned by PostgreSQL", async () => {
    const zone = zoneFixture(3);
    const pool = new FakePool((call) => {
      if (call.text.includes("WHERE name")) return { rows: [{ snapshot: zone }] };
      return { rows: [{ snapshot: { ...zone, views: "corrupt" } }] };
    });
    const repository = new PostgresZoneRepository(pool);

    assert.deepEqual(await repository.get("example.com"), zone);
    assert.deepEqual(pool.calls[0]!.values, ["example.com"]);
    await assert.rejects(repository.list(), /views must be an array/);
  });

  it("rejects structurally valid snapshots whose records violate zone invariants", async () => {
    const zone = zoneFixture(3);
    const corrupt: Zone = {
      ...zone,
      views: [{
        name: "external",
        records: [
          { id: "address", name: "www", type: "A", content: "192.0.2.10", ttl: 60 },
          { id: "alias", name: "www", type: "CNAME", content: "target.example.com.", ttl: 60 },
        ],
      }],
    };
    const repository = new PostgresZoneRepository(new FakePool(() => ({ rows: [{ snapshot: corrupt }] })));

    await assert.rejects(repository.get("example.com"), /CNAME record.*cannot coexist/i);
  });

  it("pushes alphabetical zone pagination into PostgreSQL", async () => {
    const zone = zoneFixture(1);
    const pool = new FakePool(() => ({ rows: [{ snapshot: zone }] }));

    assert.deepEqual(await new PostgresZoneRepository(pool).list({ limit: 2, offset: 3 }), [zone]);
    assert.match(pool.calls[0]!.text, /ORDER BY name LIMIT \$1 OFFSET \$2/);
    assert.deepEqual(pool.calls[0]!.values, [2, 3]);
  });

  it("uses bigserial audit ids safely and retains parameterized zone filtering", async () => {
    const pool = new FakePool((call) => ({ rows: [{
      id: "42", zone_name: call.values?.[0] ?? "example.com", revision: 3,
      action: "record.upserted", actor: "alice", occurred_at: new Date("2026-08-08T00:00:00Z"), detail: { view: "external" },
    }] }));
    const repository = new PostgresZoneRepository(pool);
    const entries = await repository.audit("example.com");

    assert.equal(entries[0]?.id, 42);
    assert.equal(entries[0]?.at, "2026-08-08T00:00:00.000Z");
    assert.deepEqual(pool.calls[0]!.values, ["example.com"]);
  });

  it("appends and prunes same-zone audit history in one advisory-locked transaction", async () => {
    const occurredAt = new Date("2026-03-01T00:00:00.000Z");
    const pool = new FakePool(undefined, (call) => call.text.includes("INSERT INTO parallax_audit")
      ? { rows: [{
        id: "42",
        zone_name: "example.com",
        revision: 3,
        action: "provider.apply.started",
        actor: "alice",
        occurred_at: occurredAt,
        detail: { view: "external" },
      }] }
      : { rows: [] });
    const repository = new PostgresZoneRepository(pool);
    const appended = await repository.appendAudit({
      zone: "example.com",
      revision: 3,
      action: "provider.apply.started",
      actor: "alice",
      at: occurredAt.toISOString(),
      detail: { view: "external" },
    }, { deleteAuditBefore: "2026-02-01T00:00:00.000Z" });

    assert.equal(appended.id, 42);
    assert.equal(pool.calls.length, 0, "the insert and pruning must stay on the transaction client");
    assert.deepEqual(pool.client.calls.map((call) => call.text.split(" ")[0]),
      ["BEGIN", "SELECT", "INSERT", "DELETE", "COMMIT"]);
    assert.match(pool.client.calls[1]!.text, /pg_advisory_xact_lock/);
    assert.deepEqual(pool.client.calls[1]!.values, ["example.com"]);
    assert.deepEqual(pool.client.calls[3]!.values, ["example.com", "2026-02-01T00:00:00.000Z"]);
    assert.equal(pool.client.released, true);
  });

  it("rolls back a retained audit append when pruning fails", async () => {
    const failure = new Error("audit pruning unavailable");
    const pool = new FakePool(undefined, (call) => {
      if (call.text.includes("INSERT INTO parallax_audit")) return { rows: [{
        id: 42,
        zone_name: "example.com",
        revision: 3,
        action: "provider.apply.started",
        actor: "alice",
        occurred_at: new Date("2026-03-01T00:00:00.000Z"),
        detail: {},
      }] };
      if (call.text.startsWith("DELETE FROM parallax_audit")) throw failure;
      return { rows: [] };
    });

    await assert.rejects(new PostgresZoneRepository(pool).appendAudit({
      zone: "example.com",
      revision: 3,
      action: "provider.apply.started",
      actor: "alice",
      at: "2026-03-01T00:00:00.000Z",
      detail: {},
    }, { deleteAuditBefore: "2026-02-01T00:00:00.000Z" }), failure);

    assert.equal(pool.client.calls.at(-1)?.text, "ROLLBACK");
    assert.equal(pool.client.calls.some((call) => call.text === "COMMIT"), false);
    assert.equal(pool.client.released, true);
  });

  it("deletes zones with a parameter; schema cascades revisions and statuses but retains audit", async () => {
    const pool = new FakePool();
    await new PostgresZoneRepository(pool).delete("example.com");
    assert.equal(pool.calls[0]!.text, "DELETE FROM parallax_zones WHERE name = $1");
    assert.deepEqual(pool.calls[0]!.values, ["example.com"]);

    const migration = await readFile(new URL("../../migrations/001_initial.sql", import.meta.url), "utf8");
    assert.match(migration, /parallax_zone_revisions[\s\S]*REFERENCES parallax_zones\(name\) ON DELETE CASCADE/);
    assert.match(migration, /parallax_apply_statuses[\s\S]*REFERENCES parallax_zones\(name\) ON DELETE CASCADE/);
    assert.doesNotMatch(migration.match(/CREATE TABLE IF NOT EXISTS parallax_audit[\s\S]*?;/)?.[0] ?? "", /REFERENCES/);
    assert.match(migration, /id bigserial PRIMARY KEY/);
  });
});

describe("PostgresStatusRepository", () => {
  it("upserts all status fields with parameters", async () => {
    const pool = new FakePool();
    const repository = new PostgresStatusRepository(pool);
    await repository.save({
      zone: "example.com", view: "external", desiredRevision: 4, appliedRevision: 3,
      state: "failed", lastAttemptAt: "2026-08-08T01:02:03.000Z", error: "offline",
    });

    assert.match(pool.calls[0]!.text, /ON CONFLICT \(zone_name, view_name\) DO UPDATE/);
    assert.deepEqual(pool.calls[0]!.values,
      ["example.com", "external", 4, 3, "failed", "2026-08-08T01:02:03.000Z", "offline", null, null]);
  });

  it("merges a late apply attempt without downgrading a newer desired status", async () => {
    const pool = new FakePool();
    await new PostgresStatusRepository(pool).save({
      zone: "example.com", view: "external", desiredRevision: 4, appliedRevision: 3,
      state: "applied", lastAttemptAt: "2026-08-08T01:02:03.000Z",
    });

    const statement = pool.calls[0]!.text;
    assert.match(statement,
      /desired_revision = GREATEST\(parallax_apply_statuses\.desired_revision, EXCLUDED\.desired_revision\)/);
    assert.match(statement,
      /applied_revision = GREATEST\(parallax_apply_statuses\.applied_revision, EXCLUDED\.applied_revision\)/);
    assert.match(statement,
      /WHEN EXCLUDED\.desired_revision >= parallax_apply_statuses\.desired_revision THEN EXCLUDED\.state/);
    assert.match(statement,
      /WHEN EXCLUDED\.last_attempt_at IS NULL THEN parallax_apply_statuses\.last_attempt_at/);
    assert.match(statement,
      /EXCLUDED\.last_attempt_at > parallax_apply_statuses\.last_attempt_at THEN EXCLUDED\.last_attempt_at/);
    assert.doesNotMatch(statement, /WHERE parallax_apply_statuses\.desired_revision/,
      "an older apply result must still merge its attempt timestamp into the newer row");
  });

  it("maps nullable database fields and sorts list queries by view", async () => {
    const pool = new FakePool(() => ({ rows: [{
      zone_name: "example.com", view_name: "external", desired_revision: "2", applied_revision: 1,
      state: "pending", last_attempt_at: null, error: null,
    }] }));
    const status = await new PostgresStatusRepository(pool).list("example.com");
    assert.deepEqual(status, [{ zone: "example.com", view: "external", desiredRevision: 2, appliedRevision: 1, state: "pending" }]);
    assert.match(pool.calls[0]!.text, /ORDER BY view_name/);
    assert.deepEqual(pool.calls[0]!.values, ["example.com"]);
  });

  it("round-trips persisted partial-operation progress and rejects an incomplete pair", async () => {
    const pool = new FakePool((call) => call.text.startsWith("SELECT") ? { rows: [{
      zone_name: "example.com", view_name: "external", desired_revision: 4, applied_revision: 3,
      state: "failed", last_attempt_at: null, error: "offline", completed_operations: 2, planned_operations: 5,
    }] } : { rows: [] });
    const repository = new PostgresStatusRepository(pool);
    assert.deepEqual(await repository.get("example.com", "external"), {
      zone: "example.com", view: "external", desiredRevision: 4, appliedRevision: 3,
      state: "failed", error: "offline", completedOperations: 2, plannedOperations: 5,
    });
    await repository.save({
      zone: "example.com", view: "external", desiredRevision: 4, appliedRevision: 3,
      state: "failed", completedOperations: 2, plannedOperations: 5,
    });
    assert.deepEqual(pool.calls[1]?.values?.slice(-2), [2, 5]);

    const corrupt = new FakePool(() => ({ rows: [{
      zone_name: "example.com", view_name: "external", desired_revision: 4, applied_revision: 3,
      state: "failed", last_attempt_at: null, error: null, completed_operations: 2, planned_operations: null,
    }] }));
    await assert.rejects(new PostgresStatusRepository(corrupt).list("example.com"), /operation progress/);
  });

  it("returns adapters sharing the injected pool", async () => {
    const pool = new FakePool();
    const adapters = createPostgresAdapters(pool);
    await adapters.statuses.deleteZone("example.com");
    assert.deepEqual(pool.calls[0]!.values, ["example.com"]);
    assert.ok(adapters.zones instanceof PostgresZoneRepository);
  });
});

describe("PostgresAccessTokenRepository", () => {
  it("checks and deletes under one transaction-wide advisory lock", async () => {
    const pool = new FakePool(undefined, (call) => {
      if (call.text.startsWith("SELECT role")) return { rows: [{ role: "admin" }] };
      if (call.text.startsWith("SELECT count")) return { rows: [{ count: "1" }] };
      if (call.text.startsWith("DELETE")) return { rows: [{ id: "admin-a" }] };
      return { rows: [] };
    });
    const result = await new PostgresAccessTokenRepository(pool).revoke("admin-a", 0);
    assert.equal(result, "deleted");
    assert.equal(pool.calls.length, 0);
    assert.deepEqual(pool.client.calls.map((call) => call.text.split(" ")[0]),
      ["BEGIN", "SELECT", "SELECT", "SELECT", "DELETE", "COMMIT"]);
    assert.match(pool.client.calls[1]!.text, /pg_advisory_xact_lock/);
    assert.match(pool.client.calls[2]!.text, /FOR UPDATE/);
  });

  it("atomically refuses the final administrator without deleting it", async () => {
    const pool = new FakePool(undefined, (call) => {
      if (call.text.startsWith("SELECT role")) return { rows: [{ role: "admin" }] };
      if (call.text.startsWith("SELECT count")) return { rows: [{ count: "0" }] };
      return { rows: [] };
    });
    assert.equal(await new PostgresAccessTokenRepository(pool).revoke("only-admin", 0), "last-admin");
    assert.equal(pool.client.calls.some((call) => call.text.startsWith("DELETE")), false);
    assert.equal(pool.client.calls.at(-1)?.text, "COMMIT");
  });
});

describe("PostgresCredentialRepository", () => {
  it("derives a replacement from the locked current document in one transaction", async () => {
    const pool = new FakePool(undefined, (call) => call.text.startsWith("SELECT document")
      ? { rows: [{ document: "sealed-before" }] }
      : { rows: [] });
    const result = await new PostgresCredentialRepository(pool).update((current) => ({
      document: `${current}-after`,
      result: 42,
    }));
    assert.equal(result, 42);
    assert.deepEqual(pool.client.calls.map((call) => call.text.split(" ")[0]),
      ["BEGIN", "SELECT", "SELECT", "INSERT", "COMMIT"]);
    assert.match(pool.client.calls[1]!.text, /pg_advisory_xact_lock/);
    assert.match(pool.client.calls[2]!.text, /FOR UPDATE/);
    assert.deepEqual(pool.client.calls[3]!.values, ["sealed-before-after"]);
  });
});

describe("PostgresSettingsRepository", () => {
  it("returns a null-prototype map and rejects prototype-mutating keys", async () => {
    const safe = new PostgresSettingsRepository(new FakePool(() => ({ rows: [{ key: "auditRetentionDays", value: 30 }] })));
    const settings = await safe.read();
    assert.equal(Object.getPrototypeOf(settings), null);
    assert.equal(settings.auditRetentionDays, 30);

    const dangerous = new PostgresSettingsRepository(new FakePool(() => ({ rows: [{ key: "__proto__", value: { polluted: true } }] })));
    await assert.rejects(dangerous.read(), /invalid PostgreSQL setting key/);
    await assert.rejects(dangerous.write(Object.fromEntries([["constructor", true]])), /invalid PostgreSQL setting key/);
  });

  it("holds a global transaction lock across async derive and patch persistence", async () => {
    const pool = new FakePool(undefined, (call) => call.text.startsWith("SELECT key")
      ? { rows: [{ key: "publicOrigin", value: "https://portal.example" }] }
      : { rows: [] });
    let announceEntered = (): void => {};
    const entered = new Promise<void>((resolve) => { announceEntered = resolve; });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const update = new PostgresSettingsRepository(pool).update(async (current) => {
      assert.equal(current.publicOrigin, "https://portal.example");
      announceEntered();
      await gate;
      return { patch: { trustForwardedHeaders: true }, result: 42 };
    });
    await entered;

    assert.deepEqual(pool.client.calls.map((call) => call.text.split(" ")[0]), ["BEGIN", "SELECT", "SELECT"]);
    assert.match(pool.client.calls[1]!.text, /pg_advisory_xact_lock/);
    assert.deepEqual(pool.client.calls[1]!.values, ["parallax-settings"]);
    assert.match(pool.client.calls[2]!.text, /FOR UPDATE/);
    release();

    assert.equal(await update, 42);
    assert.deepEqual(pool.client.calls.map((call) => call.text.split(" ")[0]),
      ["BEGIN", "SELECT", "SELECT", "INSERT", "COMMIT"]);
    assert.deepEqual(pool.client.calls[3]!.values, ["trustForwardedHeaders", "true"]);
    assert.equal(pool.client.released, true);
  });

  it("rolls back without writing when an atomic settings derivation fails", async () => {
    const pool = new FakePool(undefined, (call) => call.text.startsWith("SELECT key")
      ? { rows: [{ key: "trustForwardedHeaders", value: true }] }
      : { rows: [] });
    const failure = new Error("merged settings are invalid");

    await assert.rejects(
      new PostgresSettingsRepository(pool).update(async () => { throw failure; }),
      failure,
    );

    assert.equal(pool.client.calls.some((call) => call.text.startsWith("INSERT")), false);
    assert.equal(pool.client.calls.at(-1)?.text, "ROLLBACK");
    assert.equal(pool.client.released, true);
  });
});

describe("PostgresApplyLock", () => {
  it("reuses each lock client for repository queries when the pool has no spare capacity", async () => {
    const pool = new CapacityPool(2);
    const adapters = createPostgresAdapters(pool);
    let entered = 0;
    let releaseGate = (): void => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const apply = (zone: string): Promise<void> => adapters.applyLock.withZoneLock(zone, async () => {
      entered += 1;
      if (entered === 2) releaseGate();
      await gate;
      await adapters.statuses.list(zone);
      await adapters.zones.saveRevision({ ...zoneFixture(1), name: zone });
    });

    await Promise.all([apply("first.example"), apply("second.example")]);

    assert.equal(pool.poolQueryCalls, 0, "repository queries must not request a third pooled connection");
    assert.equal(pool.checkedOut, 0);
    assert.equal(pool.clients.length, 2);
    assert.ok(pool.clients.every((client) => client.calls.some((call) => call.text.includes("parallax_apply_statuses"))));
  });

  it("holds a parameterized per-zone advisory lock on one client across the callback", async () => {
    const events: string[] = [];
    const pool = new FakePool(undefined, (call) => {
      events.push(call.text.includes("pg_advisory_unlock") ? "unlock" : "lock");
      return { rows: [] };
    });
    const lock = new PostgresApplyLock(pool);

    const value = await lock.withZoneLock("example.com", async () => {
      events.push("provider-and-status-work");
      assert.equal(pool.client.released, false);
      return 42;
    });

    assert.equal(value, 42);
    assert.deepEqual(events, ["lock", "provider-and-status-work", "unlock"]);
    assert.match(pool.client.calls[0]!.text, /pg_advisory_lock\(hashtextextended\(\$1, 1\)\)/);
    assert.deepEqual(pool.client.calls[0]!.values, ["example.com"]);
    assert.match(pool.client.calls[1]!.text, /pg_advisory_unlock/);
    assert.equal(pool.client.released, true);
  });

  it("unlocks and releases the client when apply work fails", async () => {
    const pool = new FakePool();
    const failure = new Error("provider failed");

    await assert.rejects(
      new PostgresApplyLock(pool).withZoneLock("example.com", async () => { throw failure; }),
      failure,
    );

    assert.equal(pool.client.calls.length, 2);
    assert.match(pool.client.calls[1]!.text, /pg_advisory_unlock/);
    assert.equal(pool.client.released, true);
  });
});

function normalize(text: string): string { return text.replace(/\s+/g, " ").trim(); }

describe("a stored snapshot the current rules would not accept", () => {
  /**
   * The same call `readPersistedViewName` made for view names: what is already
   * in the store stays readable, so an operator can remove it.
   *
   * Reading a zone rebuilds every record through `createDesiredRecord`. If the
   * RDATA size limit were asked on that path too, one oversized record would
   * make the zone -- and `listZones`, readiness and the DNS snapshot with it --
   * unreadable, and deleting the record needs the zone read first.
   */
  it("reads a zone whose RDATA is larger than the wire allows", async () => {
    const oversized: Zone = {
      name: "example.com", revision: 4,
      views: [{
        name: "external",
        records: [{ id: "oversized", name: "key", type: "OPENPGPKEY", content: "a".repeat(90_000), ttl: 60 }],
      }],
      createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z",
    };
    const pool = new FakePool(() => ({ rows: [{ snapshot: oversized }] }));
    const repository = new PostgresZoneRepository(pool);

    const zone = await repository.get("example.com");
    assert.equal(zone?.views[0]?.records[0]?.id, "oversized");
    assert.equal(zone?.views[0]?.records[0]?.content.length, 90_000);
  });
});

function zoneFixture(revision: number): Zone {
  return {
    name: "example.com", revision,
    views: [{ name: "external", records: [{ id: "root", name: "@", type: "A", content: "192.0.2.10", ttl: 60 }] }],
    createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z",
  };
}
