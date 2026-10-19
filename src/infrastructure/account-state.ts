import { emptyAccountState, MEMBER_ACCOUNTS_FEATURE, readAccountState, readMemberAudit, retainAudit, type AccountState, type AccountStateStore, type AccountTransaction, type MemberAudit } from "../application/accounts/state.ts";
import type { PgClient, PgPool } from "./postgres.ts";

export class InMemoryAccountStateStore implements AccountStateStore {
  #transaction: { state: AccountState; audit: MemberAudit[] } = { state: emptyAccountState(), audit: [] };
  #tail: Promise<void> = Promise.resolve();
  transact<T>(operation: (transaction: AccountTransaction) => T): Promise<T> {
    const result = this.#tail.then(() => {
      const draft: AccountTransaction = { state: structuredClone(this.#transaction.state), audit: [] };
      const result = operation(draft);
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("account transaction callback must be synchronous");
      const state = readAccountState(draft.state);
      if (this.#transaction.state.enabled && !state.enabled) throw new Error("account activation cannot be reversed");
      const audit = retainAudit(readMemberAudit([...this.#transaction.audit, ...draft.audit]), draft.retention);
      this.#transaction = structuredClone({ state, audit });
      return structuredClone(result);
    });
    this.#tail = result.then(() => undefined, () => undefined); return result;
  }
  async read(): Promise<AccountState> { await this.#tail; return structuredClone(this.#transaction.state); }
  async snapshot(): Promise<{ state: AccountState; audit: MemberAudit[] }> { await this.#tail; return structuredClone(this.#transaction); }
}

/** One shared row serializes authority, one-use tokens, replay counters and last-admin checks. */
export class PostgresAccountStateStore implements AccountStateStore {
  readonly pool: PgPool;
  constructor(pool: PgPool) { this.pool = pool; }
  async transact<T>(operation: (transaction: AccountTransaction) => T): Promise<T> {
    let client: PgClient | undefined = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["parallax:member-accounts-v1"]);
      const rows = await client.query<{ document: unknown }>("SELECT document FROM parallax_account_state WHERE id = 1 FOR UPDATE");
      const state = rows.rows[0] ? readAccountState(rows.rows[0].document) : emptyAccountState();
      const marker = await client.query<{ feature: string }>("SELECT feature FROM parallax_auth_features WHERE feature = $1", [MEMBER_ACCOUNTS_FEATURE]);
      if (state.enabled !== (marker.rows.length === 1)) throw new Error("incomplete account activation");
      const transaction: AccountTransaction = { state, audit: [] };
      const result = operation(transaction);
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("account transaction callback must be synchronous");
      const validated = readAccountState(transaction.state), audit = readMemberAudit(transaction.audit);
      await client.query("INSERT INTO parallax_account_state (id, document, revision) VALUES (1, $1::jsonb, 1) ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, revision = parallax_account_state.revision + 1", [JSON.stringify(validated)]);
      if (validated.enabled) await client.query("INSERT INTO parallax_auth_features (feature) VALUES ($1) ON CONFLICT DO NOTHING", [MEMBER_ACCOUNTS_FEATURE]);
      else if (state.enabled) throw new Error("account activation cannot be reversed");
      for (const entry of audit) await client.query("INSERT INTO parallax_account_audit (id, entry) VALUES ($1, $2::jsonb)", [entry.id, JSON.stringify(entry)]);
      if (transaction.retention && audit.length) {
        await client.query("DELETE FROM parallax_account_audit WHERE (entry->>'at')::bigint < $1", [transaction.retention.notBefore]);
        await client.query("DELETE FROM parallax_account_audit WHERE id IN (SELECT id FROM parallax_account_audit ORDER BY (entry->>'at')::bigint DESC, id DESC OFFSET $1)", [transaction.retention.maxEntries]);
      }
      await client.query("COMMIT"); return structuredClone(result);
    } catch (error) { await this.#rollback(client); client = undefined; throw error; }
    finally { client?.release(); }
  }
  /** A connection whose rollback failed may still hold the transaction; it is destroyed rather than returned to the pool. */
  async #rollback(client: PgClient): Promise<void> {
    try { await client.query("ROLLBACK"); client.release(); }
    catch (error) { client.release(error instanceof Error ? error : true); }
  }
  async read(): Promise<AccountState> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const rows = await client.query<{ document: unknown }>("SELECT document FROM parallax_account_state WHERE id = 1");
      const state = rows.rows[0] ? readAccountState(rows.rows[0].document) : emptyAccountState();
      const marker = await client.query("SELECT feature FROM parallax_auth_features WHERE feature = $1", [MEMBER_ACCOUNTS_FEATURE]);
      if (state.enabled !== (marker.rows.length === 1)) throw new Error("incomplete account activation");
      await client.query("COMMIT"); client.release(); return state;
    } catch (error) { await this.#rollback(client); throw error; }
  }
  async snapshot(): Promise<{ state: AccountState; audit: MemberAudit[] }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const rows = await client.query<{ document: unknown }>("SELECT document FROM parallax_account_state WHERE id = 1");
      const state = rows.rows[0] ? readAccountState(rows.rows[0].document) : emptyAccountState();
      const marker = await client.query("SELECT feature FROM parallax_auth_features WHERE feature = $1", [MEMBER_ACCOUNTS_FEATURE]);
      if (state.enabled !== (marker.rows.length === 1)) throw new Error("incomplete account activation");
      const auditRows = await client.query<{ entry: MemberAudit }>("SELECT entry FROM parallax_account_audit ORDER BY (entry->>'at')::bigint, id");
      const audit = readMemberAudit(auditRows.rows.map((row) => row.entry));
      await client.query("COMMIT"); client.release(); return { state, audit };
    } catch (error) { await this.#rollback(client); throw error; }
  }
}
