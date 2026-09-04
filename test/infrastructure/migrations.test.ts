import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  /**
   * The other half of the resolution rule: it looks in exactly one place, and
   * when that place is empty it says so instead of widening.
   *
   * The test above proves the walk does not *prefer* a closer directory. It
   * cannot prove the walk does not *fall back* to one, because it always hands
   * over a tree where the trusted directory exists. This is the arm that makes
   * "deterministic" true rather than merely "correct in the happy case" -- if
   * a future version answered `undefined`, or searched upwards, the difference
   * would land here and nowhere else.
   */
  it("refuses to guess when there is no migrations directory beside the code", async () => {
    const project = await mkdtemp(join(tmpdir(), "parallax-no-migrations-"));
    temporaryDirectories.push(project);
    await mkdir(join(project, "src"), { recursive: true });

    assert.throws(
      () => findMigrationsDirectory(join(project, "src")),
      /the migrations directory could not be located/u,
    );
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
      "005_access_token_lifetime.sql",
    ]);
    assert.equal(sqlRuns, 5, "one transaction per manifest entry");

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

  /**
   * The direction that matters for a tamper control, and the one nothing tested.
   *
   * The case above proves a *matching* checksum is skipped, which is the
   * everyday path: run the command twice, nothing happens the second time. A
   * ledger that stored nothing at all and compared nothing would pass it, and so
   * would one whose comparison was inverted -- both skip a second run.
   *
   * What the checksum is actually for is this: a file in `migrations/` that is
   * not the file this database was built from. However it got that way -- an
   * edited release, a rebase that quietly changed history, somebody who reached
   * the image -- the schema in front of the runner no longer describes the
   * schema behind it, and executing the difference is the worst available
   * answer. So it stops, names the file, and applies nothing.
   *
   * 🔑 It must stop **without running the SQL**, which is why the transaction
   * count is asserted rather than just the message: a run that threw after
   * executing the changed file would report the tamper and have already applied
   * it.
   */
  it("refuses a migration whose file changed after it was applied", async () => {
    const directory = await copiedMigrations();
    const pool = new MigrationPool();
    await applyMigrations(pool, directory, "parallax");
    const transactionsAfterFirstRun = pool.client.queries.filter((query) => query.text === "BEGIN").length;

    // A trailing comment is the smallest possible change and it moves the
    // digest exactly as much as a rewritten statement would -- which is the
    // property a checksum has and a "does the file look different" check
    // does not.
    const tampered = join(directory, "003_audit_actions.sql");
    await writeFile(tampered, `${await readFile(tampered, "utf8")}-- appended after it was applied\n`, "utf8");

    await assert.rejects(
      applyMigrations(pool, directory, "parallax"),
      /migration parallax\/003_audit_actions\.sql changed after it was applied/u,
    );
    assert.equal(
      pool.client.queries.filter((query) => query.text === "BEGIN").length,
      transactionsAfterFirstRun,
      "it must refuse before executing anything, not report the tamper afterwards",
    );
  });

  /**
   * The runner owns the transaction, so it has to be able to find the one the
   * file carries -- and refuse the file when it cannot.
   *
   * The checked-in `.sql` files keep their own `BEGIN`/`COMMIT` so an operator
   * can still run one through psql. The runner strips that wrapper and wraps
   * the body itself, which is what makes the schema change and its ledger row
   * indivisible. A file with no wrapper, or with more than one, is a file whose
   * boundaries this stripping cannot be sure of: running the body anyway would
   * either leave the ledger write outside the transaction or commit half of it.
   *
   * Both shapes are refused before any SQL runs, which the transaction count
   * below is what proves.
   */
  it("refuses a migration that does not carry exactly one outer BEGIN/COMMIT", async () => {
    for (const [label, body] of [
      ["no wrapper at all", "CREATE TABLE parallax_zones ();\n"],
      ["a second pair inside it", "BEGIN;\nSELECT 1;\nBEGIN;\nSELECT 2;\nCOMMIT;\nCOMMIT;\n"],
      ["a COMMIT before its BEGIN", "COMMIT;\nSELECT 1;\nBEGIN;\n"],
    ] as const) {
      const directory = await copiedMigrations();
      await writeFile(join(directory, "001_initial.sql"), body, "utf8");
      const pool = new MigrationPool();

      await assert.rejects(
        applyMigrations(pool, directory, "parallax"),
        /migration parallax\/001_initial\.sql must have exactly one outer BEGIN\/COMMIT wrapper/u,
        label,
      );
      assert.equal(pool.client.queries.filter((query) => query.text === "BEGIN").length, 0, label);
    }
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
