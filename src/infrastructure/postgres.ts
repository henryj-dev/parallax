import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { assertPersistedDesiredViewsValid } from "../application/control-plane.ts";
import { RevisionConflictError, type AccessTokenRepository, type ApplyLock, type ApplyStatus, type AuditRetentionPolicy, type CredentialRepository, type DesiredChange, type PageRequest, type RetentionPolicy, type SettingsRepository, type SettingsRepositoryUpdate, type StatusRepository, type StoredAccessToken, type ZoneDeletion, type ZoneRepository } from "../application/ports.ts";
import { AUDIT_ACTIONS,
  createDesiredRecord,
  normalizeZoneName,
  readPersistedViewName,
  type AuditEntry,
  type Zone,
  type ZoneRevision,
} from "../domain/dns.ts";

export interface PgQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

export interface PgQueryable {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>>;
}

export interface PgClient extends PgQueryable {
  release(destroy?: boolean | Error): void;
}

export interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>;
}

export interface CloseablePgPool extends PgPool {
  end(): Promise<void>;
}

export interface PostgresPoolOptions {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  ssl?: boolean | { rejectUnauthorized?: boolean };
}

interface PgPoolConstructor {
  new (configuration: PostgresPoolOptions & { connectionString: string }): CloseablePgPool;
}

const require = createRequire(import.meta.url);

/**
 * How many connections this process will hold, and how long a caller waits for
 * one before being told it cannot have it.
 *
 * `max` is `pg`'s own default written down rather than changed. It is here
 * because it is not an arbitrary number: `PostgresApplyLock.withZoneLock` holds
 * one checked-out client for the whole of an apply -- including the provider
 * network calls, because the advisory lock is session-scoped and has to outlive
 * them -- so this is also the number of zones that can be applied at once.
 * Raising it raises that; it does not remove the ceiling.
 *
 * The timeout is the actual fix. Without one, the caller that arrives after the
 * pool is exhausted waits forever: no error, no log, a request that simply
 * never answers. `applyPending` walks zones in sequence and never reaches it,
 * so this is the concurrent-HTTP-apply path.
 *
 * ⚠️ 10 seconds is shorter than a large apply, and deliberately. Waiting out an
 * apply would only move the hang; failing says which resource ran out while the
 * caller can still act on it.
 */
const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

export function createPostgresPool(connectionString: string, options: PostgresPoolOptions = {}): CloseablePgPool {
  if (connectionString.trim().length === 0) throw new Error("PostgreSQL connection string must not be empty");
  const module = require("pg") as { Pool: PgPoolConstructor };
  // Defaults first, so a caller that names one still wins.
  return new module.Pool({
    max: DEFAULT_MAX_CONNECTIONS,
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
    ...options,
    connectionString,
  });
}

export class PostgresZoneRepository implements ZoneRepository {
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  async list(page?: PageRequest): Promise<Zone[]> {
    const result = await this.#pool.query<SnapshotRow>(
      page
        ? "SELECT snapshot FROM parallax_zones ORDER BY name LIMIT $1 OFFSET $2"
        : "SELECT snapshot FROM parallax_zones ORDER BY name",
      page ? [page.limit, page.offset] : undefined,
    );
    return result.rows.map((row) => readZone(row.snapshot));
  }

  async get(name: string): Promise<Zone | undefined> {
    const result = await this.#pool.query<SnapshotRow>(
      "SELECT snapshot FROM parallax_zones WHERE name = $1",
      [name],
    );
    return result.rows[0] ? readZone(result.rows[0].snapshot) : undefined;
  }

  async save(zone: Zone): Promise<void> {
    const snapshot = readZone(zone);
    await this.#pool.query(
      `INSERT INTO parallax_zones (name, revision, snapshot)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (name) DO UPDATE
       SET revision = EXCLUDED.revision, snapshot = EXCLUDED.snapshot`,
      [snapshot.name, snapshot.revision, JSON.stringify(snapshot)],
    );
  }

  async saveRevision(snapshot: ZoneRevision): Promise<void> {
    const valid = readZone(snapshot);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [valid.name]);
      const current = await client.query<{ revision: unknown }>(
        "SELECT revision FROM parallax_zones WHERE name = $1 FOR UPDATE",
        [valid.name],
      );
      if (current.rows[0] && readPositiveInteger(current.rows[0].revision, "zone revision") >= valid.revision) {
        throw new RevisionConflictError(`revision ${valid.revision} already exists or is stale for zone ${valid.name}`);
      }

      const encoded = JSON.stringify(valid);
      await client.query(
        `INSERT INTO parallax_zones (name, revision, snapshot)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (name) DO UPDATE
         SET revision = EXCLUDED.revision, snapshot = EXCLUDED.snapshot`,
        [valid.name, valid.revision, encoded],
      );
      await client.query(
        `INSERT INTO parallax_zone_revisions (zone_name, revision, snapshot)
         VALUES ($1, $2, $3::jsonb)`,
        [valid.name, valid.revision, encoded],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isUniqueViolation(error)) {
        throw new RevisionConflictError(`revision ${valid.revision} already exists for zone ${valid.name}`, { cause: error });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async commitDesiredChange(change: DesiredChange): Promise<void> {
    const valid = readZone(change.snapshot);
    const detail = readObject(change.audit.detail, "audit detail");
    const statuses = change.statuses.map(validateStatus);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [valid.name]);
      const current = await client.query<{ revision: unknown }>(
        "SELECT revision FROM parallax_zones WHERE name = $1 FOR UPDATE",
        [valid.name],
      );
      if (current.rows[0] && readPositiveInteger(current.rows[0].revision, "zone revision") >= valid.revision) {
        throw new RevisionConflictError(`revision ${valid.revision} already exists or is stale for zone ${valid.name}`);
      }
      const encoded = JSON.stringify(valid);
      await client.query(
        `INSERT INTO parallax_zones (name, revision, snapshot)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (name) DO UPDATE
         SET revision = EXCLUDED.revision, snapshot = EXCLUDED.snapshot`,
        [valid.name, valid.revision, encoded],
      );
      await client.query(
        `INSERT INTO parallax_zone_revisions (zone_name, revision, snapshot)
         VALUES ($1, $2, $3::jsonb)`,
        [valid.name, valid.revision, encoded],
      );
      await client.query(
        `INSERT INTO parallax_audit (zone_name, revision, action, actor, occurred_at, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [change.audit.zone, change.audit.revision, change.audit.action, change.audit.actor,
          change.audit.at, JSON.stringify(detail)],
      );
      for (const status of statuses) await saveStatus(client, status);
      await pruneHistory(client, valid.name, change.retention);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isUniqueViolation(error)) {
        throw new RevisionConflictError(`revision ${valid.revision} already exists for zone ${valid.name}`, { cause: error });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async commitZoneDeletion(deletion: ZoneDeletion): Promise<void> {
    const detail = readObject(deletion.audit.detail, "audit detail");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [deletion.zone]);
      const current = await client.query<{ revision: unknown }>(
        "SELECT revision FROM parallax_zones WHERE name = $1 FOR UPDATE",
        [deletion.zone],
      );
      if (!current.rows[0]
        || readPositiveInteger(current.rows[0].revision, "zone revision") !== deletion.expectedRevision) {
        throw new RevisionConflictError(`expected revision ${deletion.expectedRevision} for zone ${deletion.zone}`);
      }
      await client.query(
        `INSERT INTO parallax_audit (zone_name, revision, action, actor, occurred_at, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [deletion.audit.zone, deletion.audit.revision, deletion.audit.action, deletion.audit.actor,
          deletion.audit.at, JSON.stringify(detail)],
      );
      // Revisions and apply statuses are foreign-key children with ON DELETE
      // CASCADE, so this statement removes the complete live zone state.
      const deleted = await client.query<{ name: unknown }>(
        "DELETE FROM parallax_zones WHERE name = $1 RETURNING name",
        [deletion.zone],
      );
      if (!deleted.rows[0] || readString(deleted.rows[0].name, "deleted zone name") !== deletion.zone) {
        throw new RevisionConflictError(`zone ${deletion.zone} disappeared while it was being deleted`);
      }
      await pruneHistory(client, deletion.zone, deletion.retention);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listRevisions(zone: string, page?: PageRequest): Promise<ZoneRevision[]> {
    if (!page) {
      const all = await this.#pool.query<SnapshotRow>(
        "SELECT snapshot FROM parallax_zone_revisions WHERE zone_name = $1 ORDER BY revision",
        [zone],
      );
      return all.rows.map((row) => readZone(row.snapshot));
    }
    // Page from the newest revision backwards, then restore ascending order.
    const result = await this.#pool.query<SnapshotRow>(
      `SELECT snapshot FROM parallax_zone_revisions WHERE zone_name = $1
       ORDER BY revision DESC LIMIT $2 OFFSET $3`,
      [zone, page.limit, page.offset],
    );
    return result.rows.map((row) => readZone(row.snapshot)).reverse();
  }

  async getRevision(zone: string, revision: number): Promise<ZoneRevision | undefined> {
    const result = await this.#pool.query<SnapshotRow>(
      "SELECT snapshot FROM parallax_zone_revisions WHERE zone_name = $1 AND revision = $2",
      [zone, revision],
    );
    return result.rows[0] ? readZone(result.rows[0].snapshot) : undefined;
  }

  async delete(name: string): Promise<void> {
    await this.#pool.query("DELETE FROM parallax_zones WHERE name = $1", [name]);
  }

  async appendAudit(input: Omit<AuditEntry, "id">, retention?: AuditRetentionPolicy): Promise<AuditEntry> {
    const detail = readObject(input.detail, "audit detail");
    const insert = async (queryable: PgQueryable): Promise<AuditEntry> => {
      const result = await queryable.query<AuditRow>(
        `INSERT INTO parallax_audit (zone_name, revision, action, actor, occurred_at, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id, zone_name, revision, action, actor, occurred_at, detail`,
        [input.zone, input.revision, input.action, input.actor, input.at, JSON.stringify(detail)],
      );
      if (!result.rows[0]) throw new Error("PostgreSQL did not return the inserted audit entry");
      return readAudit(result.rows[0]);
    };
    if (!retention?.deleteAuditBefore) return insert(this.#pool);

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.zone]);
      const entry = await insert(client);
      await pruneAudit(client, input.zone, retention);
      await client.query("COMMIT");
      return entry;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async audit(zone?: string, page?: PageRequest): Promise<AuditEntry[]> {
    const result = await this.#pool.query<AuditRow>(...auditQuery(zone, page));
    return result.rows.map(readAudit);
  }
}

export class PostgresStatusRepository implements StatusRepository {
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  async get(zone: string, view: string): Promise<ApplyStatus | undefined> {
    const result = await this.#pool.query<StatusRow>(
      `${STATUS_COLUMNS} WHERE zone_name = $1 AND view_name = $2`,
      [zone, view],
    );
    return result.rows[0] ? readStatus(result.rows[0]) : undefined;
  }

  async list(zone: string): Promise<ApplyStatus[]> {
    const result = await this.#pool.query<StatusRow>(
      `${STATUS_COLUMNS} WHERE zone_name = $1 ORDER BY view_name`,
      [zone],
    );
    return result.rows.map(readStatus);
  }

  async save(status: ApplyStatus): Promise<void> {
    await saveStatus(this.#pool, validateStatus(status));
  }

  async deleteZone(zone: string): Promise<void> {
    await this.#pool.query("DELETE FROM parallax_apply_statuses WHERE zone_name = $1", [zone]);
  }
}

class ApplyClientContext {
  readonly #storage = new AsyncLocalStorage<PgClient>();

  current(): PgClient | undefined {
    return this.#storage.getStore();
  }

  run<T>(client: PgClient, operation: () => Promise<T>): Promise<T> {
    return this.#storage.run(client, operation);
  }
}

class ContextualPgPool implements PgPool {
  readonly #pool: PgPool;
  readonly #context: ApplyClientContext;

  constructor(pool: PgPool, context: ApplyClientContext) {
    this.#pool = pool;
    this.#context = context;
  }

  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
    return (this.#context.current() ?? this.#pool).query<Row>(text, values);
  }

  connect(): Promise<PgClient> {
    const active = this.#context.current();
    if (!active) return this.#pool.connect();
    // A repository method that starts its own transaction while an apply lock
    // is active must reuse that lock's checked-out client. `release` belongs to
    // the outer lock owner and is intentionally a no-op for the borrower.
    return Promise.resolve({
      query: <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) => active.query<Row>(text, values),
      release: () => {},
    });
  }
}

/** Holds a session advisory lock on one client for the complete apply callback. */
export class PostgresApplyLock implements ApplyLock {
  readonly #pool: PgPool;
  readonly #context: ApplyClientContext | undefined;

  constructor(pool: PgPool, context?: ApplyClientContext) {
    this.#pool = pool;
    this.#context = context;
  }

  async withZoneLock<T>(zone: string, operation: () => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let locked = false;
    let released = false;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 1))", [zone]);
      locked = true;
      return await (this.#context ? this.#context.run(client, operation) : operation());
    } finally {
      if (locked) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 1))", [zone]);
        } catch (error) {
          // Never return a session that might still own an advisory lock to the pool.
          client.release(error instanceof Error ? error : true);
          released = true;
          throw error;
        }
      }
      if (!released) client.release();
    }
  }
}

/** Settings live one row per key so unrelated writes never clobber each other. */
export class PostgresSettingsRepository implements SettingsRepository {
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  async read(): Promise<Record<string, unknown>> {
    return this.#read(this.#pool, false);
  }

  async write(values: Record<string, unknown>): Promise<void> {
    await this.update(async () => ({ patch: values, result: undefined }));
  }

  async update<T>(
    operation: (current: Record<string, unknown>) => Promise<SettingsRepositoryUpdate<T>>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["parallax-settings"]);
      const current = await this.#read(client, true);
      const replacement = await operation(current);
      await this.#write(client, replacement.patch);
      await client.query("COMMIT");
      return replacement.result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #read(queryable: PgQueryable, forUpdate: boolean): Promise<Record<string, unknown>> {
    const result = await queryable.query<{ key: unknown; value: unknown }>(
      `SELECT key, value FROM parallax_settings ORDER BY key${forUpdate ? " FOR UPDATE" : ""}`,
    );
    const settings: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const row of result.rows) {
      const key = readString(row.key, "setting key");
      if (isDangerousObjectKey(key)) throw new Error(`invalid PostgreSQL setting key: ${key}`);
      settings[key] = row.value;
    }
    return settings;
  }

  async #write(queryable: PgQueryable, values: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(values);
    for (const [key] of entries) {
      if (isDangerousObjectKey(key)) throw new Error(`invalid PostgreSQL setting key: ${key}`);
    }
    for (const [key, value] of entries) {
      await queryable.query(
        `INSERT INTO parallax_settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value ?? null)],
      );
    }
  }
}

/** Holds the sealed credential document; the database never sees plaintext. */
export class PostgresCredentialRepository implements CredentialRepository {
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  async read(): Promise<string | undefined> {
    const result = await this.#pool.query<{ document: unknown }>(
      "SELECT document FROM parallax_credential_store WHERE id = 1",
    );
    const row = result.rows[0];
    return row ? readString(row.document, "credential document") : undefined;
  }

  async write(document: string): Promise<void> {
    await this.#pool.query(
      `INSERT INTO parallax_credential_store (id, document, updated_at)
       VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, updated_at = now()`,
      [document],
    );
  }

  async update<T>(operation: (document: string | undefined) => { document: string; result: T }): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["parallax-credential-store"]);
      const current = await client.query<{ document: unknown }>(
        "SELECT document FROM parallax_credential_store WHERE id = 1 FOR UPDATE",
      );
      const row = current.rows[0];
      const replacement = operation(row ? readString(row.document, "credential document") : undefined);
      await client.query(
        `INSERT INTO parallax_credential_store (id, document, updated_at)
         VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, updated_at = now()`,
        [replacement.document],
      );
      await client.query("COMMIT");
      return replacement.result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresAccessTokenRepository implements AccessTokenRepository {
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  async list(): Promise<StoredAccessToken[]> {
    const result = await this.#pool.query<AccessTokenRow>(
      "SELECT id, subject, role, token_digest, created_at, expires_at, last_used_at FROM parallax_access_tokens ORDER BY created_at, id",
    );
    return result.rows.map(readAccessToken);
  }

  async create(token: StoredAccessToken): Promise<void> {
    await this.#pool.query(
      // `last_used_at` is here because a restore carries one. Issuing never
      // sets it, so its absence was invisible until the file-to-PostgreSQL
      // migration -- which the backup path exists for -- silently reported
      // every migrated token as never used. That is the exact signal an
      // operator reads to decide which tokens to revoke.
      `INSERT INTO parallax_access_tokens (id, subject, role, token_digest, created_at, expires_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [token.id, token.subject, token.role, token.digest, token.createdAt, token.expiresAt ?? null, token.lastUsedAt ?? null],
    );
  }

  /**
   * One statement for the whole batch, and `GREATEST` so a slow flush from one
   * replica cannot move another's newer observation backwards.
   */
  async touch(uses: readonly { readonly id: string; readonly at: string }[]): Promise<void> {
    if (uses.length === 0) return;
    await this.#pool.query(
      `UPDATE parallax_access_tokens AS token
         SET last_used_at = GREATEST(COALESCE(token.last_used_at, use.at), use.at)
         FROM (SELECT unnest($1::text[]) AS id, unnest($2::timestamptz[]) AS at) AS use
        WHERE token.id = use.id`,
      [uses.map((use) => use.id), uses.map((use) => use.at)],
    );
  }

  async revoke(id: string, retainedAdministratorCount: number): Promise<"deleted" | "not-found" | "last-admin"> {
    if (!Number.isSafeInteger(retainedAdministratorCount) || retainedAdministratorCount < 0) {
      throw new TypeError("retained administrator count must be a non-negative integer");
    }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      // Different admin rows do not conflict under row locks, so every revoke
      // shares one transaction-scoped lock before checking the invariant.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["parallax-access-token-revoke"]);
      const target = await client.query<{ role: unknown }>(
        "SELECT role FROM parallax_access_tokens WHERE id = $1 FOR UPDATE",
        [id],
      );
      const row = target.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return "not-found";
      }
      const role = readString(row.role, "access token role");
      if (role === "admin") {
        const remaining = await client.query<{ count: unknown }>(
          "SELECT count(*) AS count FROM parallax_access_tokens WHERE role = 'admin' AND id <> $1",
          [id],
        );
        const storedAdministrators = readNonNegativeInteger(remaining.rows[0]?.count, "remaining administrator count");
        if (storedAdministrators + retainedAdministratorCount === 0) {
          await client.query("COMMIT");
          return "last-admin";
        }
      }
      const deleted = await client.query<{ id: unknown }>(
        "DELETE FROM parallax_access_tokens WHERE id = $1 RETURNING id",
        [id],
      );
      await client.query("COMMIT");
      return deleted.rows.length > 0 ? "deleted" : "not-found";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresAdapters(pool: PgPool): {
  zones: PostgresZoneRepository;
  statuses: PostgresStatusRepository;
  applyLock: PostgresApplyLock;
} {
  const context = new ApplyClientContext();
  const contextualPool = new ContextualPgPool(pool, context);
  return {
    zones: new PostgresZoneRepository(contextualPool),
    statuses: new PostgresStatusRepository(contextualPool),
    applyLock: new PostgresApplyLock(pool, context),
  };
}

interface SnapshotRow { snapshot: unknown }

interface AccessTokenRow {
  id: unknown;
  subject: unknown;
  role: unknown;
  token_digest: unknown;
  created_at: unknown;
  expires_at?: unknown;
  last_used_at?: unknown;
}

function readAccessToken(row: AccessTokenRow): StoredAccessToken {
  const role = readString(row.role, "access token role");
  if (role !== "admin" && role !== "editor" && role !== "viewer") {
    throw new Error(`invalid PostgreSQL access token role: ${role}`);
  }
  return {
    id: readString(row.id, "access token id"),
    subject: readString(row.subject, "access token subject"),
    role,
    digest: readString(row.token_digest, "access token digest"),
    createdAt: readTimestamp(row.created_at, "access token timestamp"),
    ...(row.expires_at === null || row.expires_at === undefined
      ? {}
      : { expiresAt: readTimestamp(row.expires_at, "access token expiry") }),
    ...(row.last_used_at === null || row.last_used_at === undefined
      ? {}
      : { lastUsedAt: readTimestamp(row.last_used_at, "access token last use") }),
  };
}

interface AuditRow {
  id: unknown;
  zone_name: unknown;
  revision: unknown;
  action: unknown;
  actor: unknown;
  occurred_at: unknown;
  detail: unknown;
}

interface StatusRow {
  zone_name: unknown;
  view_name: unknown;
  desired_revision: unknown;
  applied_revision: unknown;
  state: unknown;
  last_attempt_at: unknown;
  error: unknown;
  completed_operations: unknown;
  planned_operations: unknown;
}

const STATUS_COLUMNS = `SELECT zone_name, view_name, desired_revision, applied_revision,
  state, last_attempt_at, error, completed_operations, planned_operations FROM parallax_apply_statuses`;

const AUDIT_COLUMNS = "SELECT id, zone_name, revision, action, actor, occurred_at, detail FROM parallax_audit";

/** Newest first, so a bounded page is the most recent history rather than the oldest. */
function auditQuery(zone: string | undefined, page: PageRequest | undefined): [string, unknown[]] {
  if (zone === undefined) {
    return page
      ? [`${AUDIT_COLUMNS} ORDER BY id DESC LIMIT $1 OFFSET $2`, [page.limit, page.offset]]
      : [`${AUDIT_COLUMNS} ORDER BY id DESC`, []];
  }
  return page
    ? [`${AUDIT_COLUMNS} WHERE zone_name = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`, [zone, page.limit, page.offset]]
    : [`${AUDIT_COLUMNS} WHERE zone_name = $1 ORDER BY id DESC`, [zone]];
}

const KNOWN_AUDIT_ACTIONS: ReadonlySet<AuditEntry["action"]> = new Set(AUDIT_ACTIONS);

function readZone(value: unknown): Zone {
  const zone = readObject(value, "zone snapshot");
  const name = readString(zone.name, "zone name");
  if (normalizeZoneName(name) !== name) throw new Error("invalid PostgreSQL zone snapshot: name is not normalized");
  const revision = readPositiveInteger(zone.revision, "zone revision");
  const createdAt = readTimestamp(zone.createdAt, "zone createdAt");
  const updatedAt = readTimestamp(zone.updatedAt, "zone updatedAt");
  if (!Array.isArray(zone.views)) throw new Error("invalid PostgreSQL zone snapshot: views must be an array");
  const viewNames = new Set<string>();
  const views = zone.views.map((candidate, viewIndex) => {
    const view = readObject(candidate, `zone view ${viewIndex}`);
    const viewName = readPersistedViewName(readString(view.name, "view name"));
    if (viewNames.has(viewName)) throw new Error(`invalid PostgreSQL zone snapshot: duplicate view ${viewName}`);
    viewNames.add(viewName);
    if (!Array.isArray(view.records)) throw new Error("invalid PostgreSQL zone snapshot: records must be an array");
    const recordIds = new Set<string>();
    const records = view.records.map((record, recordIndex) => {
      const object = readObject(record, `record ${recordIndex}`);
      const id = readString(object.id, "record id");
      if (recordIds.has(id)) throw new Error(`invalid PostgreSQL zone snapshot: duplicate record ${id}`);
      recordIds.add(id);
      // Reading, not accepting. A stored record that today's rules would refuse
      // stays readable so an operator can delete it; refusing here would take
      // the whole zone away instead.
      return createDesiredRecord(id, object, { rehydrate: true });
    });
    return { name: viewName, records };
  });
  assertPersistedDesiredViewsValid(views);
  return { name, revision, views, createdAt, updatedAt };
}

function readAudit(row: AuditRow): AuditEntry {
  const action = readString(row.action, "audit action");
  if (!KNOWN_AUDIT_ACTIONS.has(action as AuditEntry["action"])) throw new Error(`invalid PostgreSQL audit action: ${action}`);
  return {
    id: readPositiveInteger(row.id, "audit id"),
    zone: readString(row.zone_name, "audit zone"),
    revision: readPositiveInteger(row.revision, "audit revision"),
    action: action as AuditEntry["action"],
    actor: readString(row.actor, "audit actor"),
    at: readTimestamp(row.occurred_at, "audit timestamp"),
    detail: structuredClone(readObject(row.detail, "audit detail")),
  };
}

function readStatus(row: StatusRow): ApplyStatus {
  const state = readString(row.state, "status state");
  if (state !== "pending" && state !== "applied" && state !== "failed") {
    throw new Error(`invalid PostgreSQL status state: ${state}`);
  }
  const status: ApplyStatus = {
    zone: readString(row.zone_name, "status zone"),
    view: readPersistedViewName(readString(row.view_name, "status view")),
    desiredRevision: readNonNegativeInteger(row.desired_revision, "desired revision"),
    appliedRevision: readNonNegativeInteger(row.applied_revision, "applied revision"),
    state,
  };
  if (row.last_attempt_at !== null && row.last_attempt_at !== undefined) {
    status.lastAttemptAt = readTimestamp(row.last_attempt_at, "last attempt timestamp");
  }
  if (row.error !== null && row.error !== undefined) status.error = readString(row.error, "status error");
  const hasCompleted = row.completed_operations !== null && row.completed_operations !== undefined;
  const hasPlanned = row.planned_operations !== null && row.planned_operations !== undefined;
  if (hasCompleted !== hasPlanned) throw new Error("invalid PostgreSQL status operation progress");
  if (hasCompleted && hasPlanned) {
    status.completedOperations = readNonNegativeInteger(row.completed_operations, "completed operations");
    status.plannedOperations = readNonNegativeInteger(row.planned_operations, "planned operations");
    if (status.completedOperations > status.plannedOperations) {
      throw new Error("invalid PostgreSQL status operation progress");
    }
  }
  return status;
}

function validateStatus(status: ApplyStatus): ApplyStatus {
  return readStatus({
    zone_name: status.zone,
    view_name: status.view,
    desired_revision: status.desiredRevision,
    applied_revision: status.appliedRevision,
    state: status.state,
    last_attempt_at: status.lastAttemptAt ?? null,
    error: status.error ?? null,
    completed_operations: status.completedOperations ?? null,
    planned_operations: status.plannedOperations ?? null,
  });
}

/** Trims one zone's history inside the transaction that produced the change. */
async function pruneHistory(client: PgQueryable, zone: string, retention: RetentionPolicy | undefined): Promise<void> {
  if (!retention) return;
  const maxRevisions = retention.maxRevisionsPerZone ?? 0;
  if (maxRevisions > 0) {
    await client.query(
      `DELETE FROM parallax_zone_revisions
       WHERE zone_name = $1 AND revision NOT IN (
         SELECT revision FROM parallax_zone_revisions WHERE zone_name = $1 ORDER BY revision DESC LIMIT $2
       )`,
      [zone, maxRevisions],
    );
  }
  await pruneAudit(client, zone, retention);
}

async function pruneAudit(client: PgQueryable, zone: string, retention: AuditRetentionPolicy | undefined): Promise<void> {
  if (retention?.deleteAuditBefore) {
    await client.query(
      "DELETE FROM parallax_audit WHERE zone_name = $1 AND occurred_at < $2",
      [zone, retention.deleteAuditBefore],
    );
  }
}

async function saveStatus(queryable: PgQueryable, valid: ApplyStatus): Promise<void> {
  // Desired state N+1 may commit while an apply of N is still talking to the
  // provider. Revision/state follow the newer desired row, while provider
  // progress and the latest attempt timestamp remain monotonic facts. In
  // particular, an older apply must still contribute `last_attempt_at`: zone
  // deletion uses it to find every target that may hold published records.
  await queryable.query(
    `INSERT INTO parallax_apply_statuses
       (zone_name, view_name, desired_revision, applied_revision, state, last_attempt_at, error,
        completed_operations, planned_operations)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (zone_name, view_name) DO UPDATE SET
       desired_revision = GREATEST(parallax_apply_statuses.desired_revision, EXCLUDED.desired_revision),
       applied_revision = GREATEST(parallax_apply_statuses.applied_revision, EXCLUDED.applied_revision),
       state = CASE
         WHEN EXCLUDED.desired_revision >= parallax_apply_statuses.desired_revision THEN EXCLUDED.state
         ELSE parallax_apply_statuses.state
       END,
       last_attempt_at = CASE
         WHEN EXCLUDED.last_attempt_at IS NULL THEN parallax_apply_statuses.last_attempt_at
         WHEN parallax_apply_statuses.last_attempt_at IS NULL
           OR EXCLUDED.last_attempt_at > parallax_apply_statuses.last_attempt_at THEN EXCLUDED.last_attempt_at
         ELSE parallax_apply_statuses.last_attempt_at
       END,
       error = CASE
         WHEN EXCLUDED.desired_revision >= parallax_apply_statuses.desired_revision THEN EXCLUDED.error
         ELSE parallax_apply_statuses.error
       END,
       completed_operations = CASE
         WHEN EXCLUDED.desired_revision >= parallax_apply_statuses.desired_revision THEN EXCLUDED.completed_operations
         ELSE parallax_apply_statuses.completed_operations
       END,
       planned_operations = CASE
         WHEN EXCLUDED.desired_revision >= parallax_apply_statuses.desired_revision THEN EXCLUDED.planned_operations
         ELSE parallax_apply_statuses.planned_operations
       END`,
    [valid.zone, valid.view, valid.desiredRevision, valid.appliedRevision, valid.state,
      valid.lastAttemptAt ?? null, valid.error ?? null,
      valid.completedOperations ?? null, valid.plannedOperations ?? null],
  );
}

function isDangerousObjectKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function readObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid PostgreSQL ${field}`);
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid PostgreSQL ${field}`);
  return value;
}

function readPositiveInteger(value: unknown, field: string): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new Error(`invalid PostgreSQL ${field}`);
  return number;
}

function readNonNegativeInteger(value: unknown, field: string): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) throw new Error(`invalid PostgreSQL ${field}`);
  return number;
}

function readTimestamp(value: unknown, field: string): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.valueOf())) throw new Error(`invalid PostgreSQL ${field}`);
  return date.toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "23505";
}
