import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Zone } from "../../src/domain/dns.ts";
import { RevisionConflictError } from "../../src/application/ports.ts";
import {
  PostgresStatusRepository,
  PostgresApplyLock,
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
    assert.deepEqual(pool.client.calls[6]!.values, ["example.com", "external", 1, 0, "pending", null, null]);
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
    assert.match(pool.calls[0]!.text, /WHERE parallax_apply_statuses\.desired_revision <= EXCLUDED\.desired_revision/);
    assert.deepEqual(pool.calls[0]!.values,
      ["example.com", "external", 4, 3, "failed", "2026-08-08T01:02:03.000Z", "offline"]);
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

  it("returns adapters sharing the injected pool", async () => {
    const pool = new FakePool();
    const adapters = createPostgresAdapters(pool);
    await adapters.statuses.deleteZone("example.com");
    assert.deepEqual(pool.calls[0]!.values, ["example.com"]);
    assert.ok(adapters.zones instanceof PostgresZoneRepository);
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

function zoneFixture(revision: number): Zone {
  return {
    name: "example.com", revision,
    views: [{ name: "external", records: [{ id: "root", name: "@", type: "A", content: "192.0.2.10", ttl: 60 }] }],
    createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z",
  };
}
