import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import { applyMigrations, findMigrationsDirectory } from "../../src/infrastructure/migrations.ts";
import type { CloseablePgPool, PgClient, PgQueryResult } from "../../src/infrastructure/postgres.ts";

class MigrationClient implements PgClient {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly checksums = new Map<string, string>();
  releasedWith: boolean | Error | undefined;
  failSql = false;
  failUnlock = false;

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
    this.queries.push({ text, ...(values ? { values } : {}) });
    if (text.startsWith("SELECT checksum")) {
      const key = `${String(values?.[0])}/${String(values?.[1])}`;
      const checksum = this.checksums.get(key);
      return { rows: (checksum ? [{ checksum }] : []) as Row[] };
    }
    if (text.startsWith("INSERT INTO parallax_schema_migrations")) {
      this.checksums.set(`${String(values?.[0])}/${String(values?.[1])}`, String(values?.[2]));
    } else if (this.failSql && text.includes("CREATE TABLE IF NOT EXISTS parallax_zones")) {
      throw new Error("migration statement failed");
    } else if (this.failUnlock && text.includes("pg_advisory_unlock")) {
      throw new Error("unlock failed");
    }
    return { rows: [] };
  }

  release(destroy?: boolean | Error): void { this.releasedWith = destroy; }
}

class MigrationPool implements CloseablePgPool {
  readonly client: MigrationClient;
  constructor(client = new MigrationClient()) { this.client = client; }
  query<Row = Record<string, unknown>>(): Promise<PgQueryResult<Row>> { throw new Error("pool query was not expected"); }
  async connect(): Promise<PgClient> { return this.client; }
  async end(): Promise<void> {}
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function copiedMigrations(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "parallax-migrations-"));
  temporaryDirectories.push(directory);
  await cp(resolve(import.meta.dirname, "../../migrations"), directory, { recursive: true });
  return directory;
}

describe("database migrations", () => {
  it("resolves the trusted source or image root without accepting a closer attacker directory", async () => {
    assert.equal(findMigrationsDirectory(resolve(import.meta.dirname, "../../src")),
      resolve(import.meta.dirname, "../../migrations"));

    const project = await mkdtemp(join(tmpdir(), "parallax-image-root-"));
    temporaryDirectories.push(project);
    const entrypoint = join(project, "dist", "src");
    await mkdir(join(entrypoint, "migrations"), { recursive: true });
    await writeFile(join(entrypoint, "migrations", "001_initial.sql"), "SELECT 'attacker';\n", "utf8");
    await cp(resolve(import.meta.dirname, "../../migrations"), join(project, "migrations"), { recursive: true });

    assert.equal(findMigrationsDirectory(entrypoint), join(project, "migrations"));
  });

  it("runs only the fixed manifest and records checksums so a replay is skipped", async () => {
    const directory = await copiedMigrations();
    const pool = new MigrationPool();

    const first = await applyMigrations(pool, directory, "parallax");
    const sqlRuns = pool.client.queries.filter((query) => query.text === "BEGIN").length;
    assert.deepEqual(first.applied, [
      "001_initial.sql",
      "002_settings_and_credentials.sql",
      "003_audit_actions.sql",
      "004_security_invariants.sql",
    ]);
    assert.equal(sqlRuns, 4);

    const second = await applyMigrations(pool, directory, "parallax");
    assert.deepEqual(second.applied, []);
    assert.equal(pool.client.queries.filter((query) => query.text === "BEGIN").length, sqlRuns);

    const firstBegin = pool.client.queries.findIndex((query) => query.text === "BEGIN");
    const firstCommit = pool.client.queries.findIndex((query, index) => index > firstBegin && query.text === "COMMIT");
    const transaction = pool.client.queries.slice(firstBegin, firstCommit + 1);
    assert.equal(transaction[0]?.text, "BEGIN");
    assert.match(transaction[1]?.text ?? "", /CREATE TABLE IF NOT EXISTS parallax_zones/u);
    assert.doesNotMatch(transaction[1]?.text ?? "", /^\s*(?:BEGIN|COMMIT)\s*;/imu);
    assert.match(transaction.at(-2)?.text ?? "", /INSERT INTO parallax_schema_migrations/u,
      "the ledger write must be inside the same transaction as the schema SQL");
    assert.equal(transaction.at(-1)?.text, "COMMIT");
  });

  it("refuses an injected SQL file before acquiring a database connection", async () => {
    const directory = await copiedMigrations();
    await writeFile(join(directory, "999_attacker.sql"), "SELECT 'owned';\n", "utf8");
    let connects = 0;
    const pool = new MigrationPool();
    pool.connect = async () => { connects += 1; return pool.client; };

    await assert.rejects(applyMigrations(pool, directory, "parallax"), /unexpected: 999_attacker\.sql/);
    assert.equal(connects, 0);
  });

  it("preserves the migration failure even when unlock also fails and destroys the session", async () => {
    const directory = await copiedMigrations();
    const client = new MigrationClient();
    client.failSql = true;
    client.failUnlock = true;

    await assert.rejects(applyMigrations(new MigrationPool(client), directory, "parallax"), /migration statement failed/);
    assert.equal(client.queries.some((query) => query.text === "ROLLBACK"), true);
    assert.equal(client.releasedWith, true);
  });
});
