import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PowerDnsProviderAdapter } from "../../src/adapters/powerdns.ts";
import type { CloseablePgPool } from "../../src/infrastructure/postgres.ts";

const SECRET = "an-ownership-secret-of-at-least-32-bytes";

/** Records every statement so the shape of a write can be asserted without a database. */
function pool(answers: Array<{ rows: unknown[] }>): { pool: CloseablePgPool; sql: string[] } {
  const sql: string[] = [];
  const client = {
    async query(text: string) {
      sql.push(text.trim().split(/\s+/u).slice(0, 3).join(" "));
      return answers.shift() ?? { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as unknown as CloseablePgPool, sql };
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
});
