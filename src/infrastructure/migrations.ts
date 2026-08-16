import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { CloseablePgPool } from "./postgres.ts";

/**
 * Applying the schema is an operation like any other, so it belongs to the
 * command layer rather than to a human with a psql session. It is never done
 * implicitly at startup: a server that reshapes the store it depends on while
 * booting would be the one thing in this system that acts without being asked,
 * and an image rolled back to an older version would carry the schema forward
 * with it.
 *
 * A fixed manifest is checked before a database connection is acquired. Each
 * applied file is then recorded with its SHA-256 checksum, so an unexpected,
 * missing, or changed migration fails closed instead of being executed. This
 * also makes a repeated run a no-op rather than replaying trusted SQL merely
 * because it is idempotent.
 */

/** A distinct key, so a migration run cannot be confused with a zone's apply lock. */
const MIGRATION_LOCK = "parallax:migrations";

/** Which database a run targets. Only this control plane's own, now. */
export type MigrationTarget = "parallax";

export const MIGRATION_TARGETS: readonly MigrationTarget[] = ["parallax"];

export interface MigrationRun {
  readonly directory: string;
  readonly applied: readonly string[];
}

const MIGRATION_FILES: Readonly<Record<MigrationTarget, readonly string[]>> = {
  parallax: [
    "001_initial.sql",
    "002_settings_and_credentials.sql",
    "003_audit_actions.sql",
    "004_security_invariants.sql",
  ],
};

/**
 * Where the `.sql` files ended up relative to the running entry point: beside
 * `src` in a checkout, and beside `dist` in the image. The relationship is
 * deliberately deterministic. Walking upwards for the first directory named
 * `migrations` would let a closer, writable directory replace the trusted one.
 */
export function findMigrationsDirectory(start: string, subdirectory?: string): string {
  const codeRoot = resolve(start, "..");
  const projectRoot = basename(codeRoot) === "dist" ? resolve(codeRoot, "..") : codeRoot;
  const candidate = resolve(projectRoot, "migrations");
  if (existsSync(candidate)) return subdirectory ? resolve(candidate, subdirectory) : candidate;
  throw new Error("the migrations directory could not be located");
}

export async function applyMigrations(
  pool: CloseablePgPool,
  directory: string,
  target: MigrationTarget = "parallax",
): Promise<MigrationRun> {
  const discovered = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const files = [...MIGRATION_FILES[target]];
  const unexpected = discovered.filter((name) => !files.includes(name));
  const missing = files.filter((name) => !discovered.includes(name));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error([
      `migration directory does not match the ${target} manifest`,
      ...(unexpected.length > 0 ? [`unexpected: ${unexpected.join(", ")}`] : []),
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
    ].join("; "));
  }

  const client = await pool.connect();
  let held = false;
  let destroyClient = false;
  try {
    // A session lock rather than a transaction lock: each manifest entry gets
    // its own transaction, so the lock has to outlive all of them. Two instances
    // starting together then apply in sequence instead of racing.
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 2))", [MIGRATION_LOCK]);
    held = true;
    await client.query(`CREATE TABLE IF NOT EXISTS parallax_schema_migrations (
      target text NOT NULL,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (target, name)
    )`);
    const applied: string[] = [];
    for (const name of files) {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
      const recorded = await client.query<{ checksum: unknown }>(
        "SELECT checksum FROM parallax_schema_migrations WHERE target = $1 AND name = $2",
        [target, name],
      );
      if (recorded.rows[0]) {
        if (recorded.rows[0].checksum !== checksum) {
          throw new Error(`migration ${target}/${name} changed after it was applied`);
        }
        continue;
      }
      const body = migrationBody(sql, target, name);
      try {
        // The checked-in files retain BEGIN/COMMIT so an operator can still run
        // one directly with psql. The runner removes that wrapper and owns the
        // transaction, making the schema change and its ledger row indivisible.
        await client.query("BEGIN");
        await client.query(body);
        await client.query(
          "INSERT INTO parallax_schema_migrations (target, name, checksum) VALUES ($1, $2, $3)",
          [target, name, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        // Clear an aborted transaction before trying to unlock the session. The
        // original migration/ledger error is preserved even if rollback fails.
        await client.query("ROLLBACK").catch(() => { destroyClient = true; });
        throw error;
      }
      applied.push(name);
    }
    return { directory, applied };
  } finally {
    if (held && !destroyClient) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 2))", [MIGRATION_LOCK]);
      } catch {
        // Never return a session that might still hold the lock to the pool.
        destroyClient = true;
      }
    }
    client.release(destroyClient || undefined);
  }
}

/** Removes exactly one checked-in outer transaction without parsing SQL bodies. */
function migrationBody(source: string, target: MigrationTarget, name: string): string {
  const wrappers = [...source.matchAll(/^\s*(BEGIN|COMMIT)\s*;\s*$/gimu)];
  const first = wrappers[0];
  const last = wrappers.at(-1);
  if (wrappers.length !== 2 || first?.[1]?.toUpperCase() !== "BEGIN"
    || last?.[1]?.toUpperCase() !== "COMMIT" || first.index === undefined || last.index === undefined) {
    throw new Error(`migration ${target}/${name} must have exactly one outer BEGIN/COMMIT wrapper`);
  }
  return source.slice(first.index + first[0].length, last.index).trim();
}
