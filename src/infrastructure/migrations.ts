import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CloseablePgPool } from "./postgres.ts";

/**
 * Applying the schema is an operation like any other, so it belongs to the
 * command layer rather than to a human with a psql session. It is never done
 * implicitly at startup: a server that reshapes the store it depends on while
 * booting would be the one thing in this system that acts without being asked,
 * and an image rolled back to an older version would carry the schema forward
 * with it.
 *
 * The files are written to be re-appliable -- every object is created with
 * `IF NOT EXISTS` and each file wraps itself in its own transaction -- so the
 * whole set is replayed in name order every run. That is what the verification
 * scripts have always done, and it is why no version table is needed to decide
 * what to skip.
 */

/** A distinct key, so a migration run cannot be confused with a zone's apply lock. */
const MIGRATION_LOCK = "parallax:migrations";

/** Which database a run targets. PowerDNS keeps its records in its own. */
export type MigrationTarget = "parallax" | "powerdns";

export const MIGRATION_TARGETS: readonly MigrationTarget[] = ["parallax", "powerdns"];

export interface MigrationRun {
  readonly directory: string;
  readonly applied: readonly string[];
}

/**
 * Where the `.sql` files ended up relative to the running code: beside the
 * sources in a checkout, and one directory above `dist` in the image.
 */
export function findMigrationsDirectory(start: string, subdirectory?: string): string {
  let directory = start;
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = resolve(directory, "migrations");
    if (existsSync(candidate)) return subdirectory ? resolve(candidate, subdirectory) : candidate;
    directory = resolve(directory, "..");
  }
  throw new Error("the migrations directory could not be located");
}

export async function applyMigrations(pool: CloseablePgPool, directory: string): Promise<MigrationRun> {
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`no migrations were found in ${directory}`);

  const client = await pool.connect();
  let held = false;
  try {
    // A session lock rather than a transaction lock: each file opens and commits
    // its own transaction, so the lock has to outlive all of them. Two instances
    // starting together then apply in sequence instead of racing.
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 1))", [MIGRATION_LOCK]);
    held = true;
    for (const name of files) {
      const sql = await readFile(join(directory, name), "utf8");
      await client.query(sql);
    }
    return { directory, applied: files };
  } finally {
    if (held) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 1))", [MIGRATION_LOCK]);
        client.release();
      } catch {
        // Never return a session that might still hold the lock to the pool.
        client.release(true);
      }
    } else {
      client.release();
    }
  }
}
