import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PowerDnsProviderAdapter } from "../../src/adapters/powerdns.ts";
import { ownershipComment } from "../../src/adapters/ownership.ts";
import type { CloseablePgPool } from "../../src/infrastructure/postgres.ts";

const SECRET = "an-ownership-secret-of-at-least-32-bytes";

/** Records every statement so the shape of a write can be asserted without a database. */
function pool(answers: Array<{ rows: unknown[]; rowCount?: number }>): {
  pool: CloseablePgPool;
  sql: string[];
  statements: Array<{ text: string; values?: readonly unknown[] }>;
} {
  const sql: string[] = [];
  const statements: Array<{ text: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      sql.push(text.trim().split(/\s+/u).slice(0, 3).join(" "));
      statements.push({ text, ...(values ? { values } : {}) });
      return answers.shift() ?? { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as unknown as CloseablePgPool, sql, statements };
}

describe("PowerDNS adapter", () => {
  it("refuses a secret too short to sign an ownership marker", () => {
    assert.throws(() => new PowerDnsProviderAdapter({ pool: pool([]).pool, ownershipSecret: "short" }), /at least 32 bytes/);
  });

  it("says which zone is missing rather than failing obscurely", async () => {
    const adapter = new PowerDnsProviderAdapter({ pool: pool([{ rows: [] }]).pool, ownershipSecret: SECRET });
    await assert.rejects(adapter.list("absent.example/internal"), /PowerDNS has no zone named absent\.example/);
  });

  it("rolls back rather than leaving a record without its marker", async () => {
    // The record and the marker that says Parallax owns it are written in one
    // transaction. A record without a marker is one nothing will admit to
    // owning and nothing will ever clean up.
    const { pool: failing, sql } = pool([
      { rows: [] },                 // BEGIN
      { rows: [{ id: 1 }] },        // domain lookup
      { rows: [{ signed: false }] }, // DNSSEC guard
      { rows: [{ id: "42" }] },     // INSERT records
    ]);
    const adapter = new PowerDnsProviderAdapter({ pool: failing, ownershipSecret: SECRET });
    const client = await failing.connect();
    const original = client.query.bind(client);
    let calls = 0;
    (client as { query: unknown }).query = async (text: string) => {
      calls += 1;
      if (text.includes("INSERT INTO parallax_powerdns_ownership")) throw new Error("marker write failed");
      return original(text);
    };

    await assert.rejects(adapter.apply("example.com/internal", {
      kind: "create",
      desired: { id: "www", name: "www", type: "A", content: "10.0.0.1", ttl: 300 },
    }), /marker write failed/);
    assert.ok(calls > 0);
    assert.ok(sql.includes("ROLLBACK"), `expected a rollback, saw: ${sql.join(" | ")}`);
  });

  it("scopes updates to the zone, recomputes auth, and keeps BIGINT ids exact", async () => {
    const providerId = "9007199254740993";
    const target = "example.com/internal";
    const { pool: database, statements } = pool([
      { rows: [] },
      { rows: [{ id: 7 }] },
      { rows: [{ signed: false }] },
      { rows: [{ marker: ownershipComment(target, "delegation", SECRET) }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [] },
      { rows: [] },
    ]);
    const adapter = new PowerDnsProviderAdapter({ pool: database, ownershipSecret: SECRET });

    await adapter.apply(target, {
      kind: "update",
      providerId,
      desired: { id: "delegation", name: "child", type: "NS", content: "ns.child.example.com", ttl: 300 },
    });

    const update = statements.find((statement) => statement.text.includes("UPDATE records\n"));
    assert.ok(update);
    assert.match(update.text, /auth = \$7, ordername = NULL/u);
    assert.match(update.text, /id = \$1 AND domain_id = \$2/u);
    assert.equal(update.values?.[0], providerId);
    assert.equal(update.values?.[1], 7);
    assert.equal(update.values?.[6], false, "a child NS is a delegation, not authoritative data");
  });

  it("refuses direct SQL changes to signed zones instead of guessing ordername", async () => {
    const { pool: database, statements } = pool([
      { rows: [] },
      { rows: [{ id: 7 }] },
      { rows: [{ signed: true }] },
      { rows: [] },
    ]);
    const adapter = new PowerDnsProviderAdapter({ pool: database, ownershipSecret: SECRET });
    await assert.rejects(adapter.apply("example.com/internal", {
      kind: "create",
      desired: { id: "www", name: "www", type: "A", content: "10.0.0.1", ttl: 300 },
    }), /DNSSEC-signed.*ordername/u);

    const guard = statements.find((statement) => statement.text.includes("FROM cryptokeys"));
    assert.ok(guard);
    assert.match(guard.text, /FROM domainmetadata/u);
    assert.match(guard.text, /kind = 'PRESIGNED' AND content = '1'/u);
    assert.deepEqual(guard.values, [7]);
  });
});
