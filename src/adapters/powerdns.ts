import { ProviderConstraintError, type ProviderAdapter } from "../application/ports.ts";
import { RECORD_TYPES, type DesiredRecord, type RecordType } from "../domain/dns.ts";
import type { ProviderRecord, ReconcileOperation } from "../domain/reconciliation.ts";
import type { CloseablePgPool, PgClient } from "../infrastructure/postgres.ts";
import { ownershipComment, readOwnershipComment } from "./ownership.ts";

/**
 * Publishes the internal view into PowerDNS's own database.
 *
 * The alternative -- writing RFC 1035 zone files for CoreDNS -- needs a
 * filesystem both processes can reach, which in a cluster means a volume that
 * has to survive restarts, because a zone file holds records nobody else has a
 * copy of. Here the records are rows, so the storage question is one PowerDNS
 * has already answered.
 *
 * PowerDNS has no per-record field to mark ownership with, so the marker lives
 * in a table of its own beside the records -- see `migrations/powerdns/`. It is
 * the same marker string the other providers carry and is verified the same way.
 */

const SUPPORTED: readonly RecordType[] = RECORD_TYPES;

export interface PowerDnsProviderAdapterOptions {
  readonly pool: CloseablePgPool;
  readonly ownershipSecret: string;
}

export class PowerDnsProviderAdapter implements ProviderAdapter {
  readonly #pool: CloseablePgPool;
  readonly #ownershipSecret: string;

  constructor(options: PowerDnsProviderAdapterOptions) {
    this.#ownershipSecret = options.ownershipSecret;
    this.#pool = options.pool;
    // Fail where the adapter is built rather than at the first apply.
    ownershipComment("validation/target", "validation", this.#ownershipSecret);
  }

  async list(target: string): Promise<ProviderRecord[]> {
    const zone = zoneOf(target);
    const client = await this.#pool.connect();
    try {
      const domainId = await this.#domainId(client, zone);
      const { rows } = await client.query(
        `SELECT r.id, r.name, r.type, r.content, r.ttl, o.marker
           FROM records r
           LEFT JOIN parallax_powerdns_ownership o ON o.record_id = r.id
          WHERE r.domain_id = $1 AND r.type = ANY($2) AND COALESCE(r.disabled, false) = false`,
        [domainId, [...SUPPORTED]],
      );
      return rows.flatMap((row) => {
        const record = asRow(row);
        if (!record) return [];
        const name = relativeName(record.name, zone);
        if (name === undefined) return [];
        const ownership = readOwnershipComment(record.marker ?? undefined, this.#ownershipSecret, target);
        return [{
          id: ownership ? ownership.recordId : String(record.id),
          providerId: String(record.id),
          managed: ownership !== undefined,
          name,
          type: record.type as RecordType,
          content: fromStoredContent(record.type as RecordType, record.content),
          ttl: record.ttl,
        }];
      });
    } finally {
      client.release();
    }
  }

  async apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> {
    const zone = zoneOf(target);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const domainId = await this.#domainId(client, zone);
      await this.#assertUnsigned(client, domainId, zone);
      if (operation.kind === "delete") {
        // The cascade removes the marker with the row, so nothing has to be
        // deleted twice or can be left behind if this fails halfway.
        const providerId = readProviderId(operation.providerId);
        await this.#assertOwned(client, target, domainId, providerId);
        const deleted = await client.query("DELETE FROM records WHERE id = $1 AND domain_id = $2", [providerId, domainId]);
        if (deleted.rowCount !== 1) throw new Error(`PowerDNS record ${providerId} disappeared before deletion`);
      } else if (operation.kind === "update") {
        const providerId = readProviderId(operation.providerId);
        await this.#assertOwned(client, target, domainId, providerId);
        const updated = await client.query(
          `UPDATE records
              SET name = $3, type = $4, content = $5, ttl = $6, auth = $7, ordername = NULL
            WHERE id = $1 AND domain_id = $2`,
          [providerId, domainId, absoluteName(operation.desired.name, zone), operation.desired.type,
            toStoredContent(operation.desired), operation.desired.ttl, isAuthoritative(operation.desired)],
        );
        if (updated.rowCount !== 1) throw new Error(`PowerDNS record ${providerId} disappeared before update`);
        await client.query("UPDATE parallax_powerdns_ownership SET marker = $2 WHERE record_id = $1",
          [providerId, ownershipComment(target, operation.desired.id, this.#ownershipSecret)]);
      } else {
        const { rows } = await client.query(
          `INSERT INTO records (domain_id, name, type, content, ttl, disabled, auth)
           VALUES ($1, $2, $3, $4, $5, false, $6) RETURNING id`,
          [domainId, absoluteName(operation.desired.name, zone), operation.desired.type,
            toStoredContent(operation.desired), operation.desired.ttl, isAuthoritative(operation.desired)],
        );
        const id = asProviderId(rows[0]);
        if (id === undefined) throw new Error("PowerDNS did not return an id for the inserted record");
        await client.query("INSERT INTO parallax_powerdns_ownership (record_id, marker) VALUES ($1, $2)",
          [id, ownershipComment(target, operation.desired.id, this.#ownershipSecret)]);
      }
      await this.#bumpSerial(client, domainId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #domainId(client: PgClient, zone: string): Promise<number> {
    const { rows } = await client.query("SELECT id FROM domains WHERE lower(name) = $1", [zone]);
    const id = asSafeId(rows[0]);
    if (id === undefined) throw new Error(`PowerDNS has no zone named ${zone}`);
    return id;
  }

  /**
   * Refuses to change a row Parallax does not own, and refuses one owned for a
   * different target -- a record published for another view is not this view's
   * to edit.
   */
  async #assertOwned(client: PgClient, target: string, domainId: number, providerId: string): Promise<void> {
    const { rows } = await client.query(
      `SELECT o.marker
         FROM parallax_powerdns_ownership o
         JOIN records r ON r.id = o.record_id
        WHERE o.record_id = $1 AND r.domain_id = $2
        FOR UPDATE`,
      [providerId, domainId]);
    const marker = rows[0] && typeof (rows[0] as { marker?: unknown }).marker === "string"
      ? (rows[0] as { marker: string }).marker
      : undefined;
    if (!readOwnershipComment(marker, this.#ownershipSecret, target)) {
      throw new Error(`PowerDNS record ${providerId} is not owned by target ${target}`);
    }
  }

  /**
   * `ordername` depends on the zone's NSEC/NSEC3 mode and empty non-terminals.
   * Guessing it in this direct-SQL adapter would silently corrupt denial proofs.
   * Unsigned zones ignore the field; signed zones must use PowerDNS's API (with
   * API-RECTIFY) or be changed through pdnsutil, both of which know the mode.
   */
  async #assertUnsigned(client: PgClient, domainId: number, zone: string): Promise<void> {
    const { rows } = await client.query<{ signed?: unknown }>(
      `SELECT
         EXISTS (SELECT 1 FROM cryptokeys WHERE domain_id = $1 AND active = true)
         OR EXISTS (
           SELECT 1
             FROM domainmetadata
            WHERE domain_id = $1 AND kind = 'PRESIGNED' AND content = '1'
         ) AS signed`,
      [domainId],
    );
    if (rows[0]?.signed === true) {
      throw new ProviderConstraintError(`PowerDNS zone ${zone} is DNSSEC-signed; direct SQL changes are refused because ordername requires zone rectification`);
    }
    if (rows[0]?.signed !== false) throw new Error("PowerDNS did not report whether the zone is DNSSEC-signed");
  }

  /**
   * Secondaries and caches decide whether to re-read from the serial, so a
   * change that does not move it is a change nothing downstream will notice.
   */
  async #bumpSerial(client: PgClient, domainId: number): Promise<void> {
    const { rows } = await client.query(
      "SELECT id, content FROM records WHERE domain_id = $1 AND type = 'SOA' LIMIT 1", [domainId]);
    const row = rows[0] as { id?: unknown; content?: unknown } | undefined;
    if (!row || typeof row.content !== "string") return;
    const fields = row.content.trim().split(/\s+/u);
    if (fields.length < 7) return;
    const serial = Number(fields[2]);
    if (!Number.isSafeInteger(serial)) return;
    fields[2] = String(serial + 1);
    await client.query("UPDATE records SET content = $2 WHERE id = $1 AND domain_id = $3", [row.id, fields.join(" "), domainId]);
  }
}

function zoneOf(target: string): string {
  const zone = target.slice(0, target.lastIndexOf("/")).trim().toLowerCase();
  if (!zone) throw new Error(`PowerDNS target is missing a zone: ${target}`);
  return zone;
}

function absoluteName(name: string, zone: string): string {
  return name === "@" ? zone : `${name}.${zone}`.toLowerCase();
}

function relativeName(name: string, zone: string): string | undefined {
  const lower = name.trim().toLowerCase().replace(/\.$/u, "");
  if (lower === zone) return "@";
  return lower.endsWith(`.${zone}`) ? lower.slice(0, -(zone.length + 1)) : undefined;
}

/**
 * Whether PowerDNS should treat the row as its own data.
 *
 * An NS record below the apex marks a delegation: the zone stops being the
 * answer there and points at another server. PowerDNS wants `auth` false for
 * those, and uses the flag to decide what it signs. An unsigned zone answers
 * correctly either way, so getting this wrong stays invisible until the day the
 * zone is signed.
 */
function isAuthoritative(record: DesiredRecord): boolean {
  return !(record.type === "NS" && record.name !== "@");
}

/** PowerDNS stores TXT as it is served, in quotes; the domain keeps them off. */
function toStoredContent(record: DesiredRecord): string {
  return record.type === "TXT" ? `"${record.content.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : record.content;
}

function fromStoredContent(type: RecordType, content: string): string {
  if (type !== "TXT") return content;
  const trimmed = content.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

interface Row {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  marker: string | null;
}

function asRow(value: unknown): Row | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const id = asProviderId(row);
  if (id === undefined || typeof row.name !== "string" || typeof row.type !== "string") return undefined;
  if (typeof row.content !== "string" || typeof row.ttl !== "number") return undefined;
  if (!SUPPORTED.includes(row.type as RecordType)) return undefined;
  return { id, name: row.name, type: row.type, content: row.content, ttl: row.ttl, marker: typeof row.marker === "string" ? row.marker : null };
}

function asSafeId(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  const parsed = typeof id === "string" && /^\d+$/u.test(id) ? Number(id) : id;
  if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  return undefined;
}

/** Keeps BIGINT identifiers as decimal strings so values above 2^53 stay exact. */
function asProviderId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  if (typeof id === "number") return Number.isSafeInteger(id) && id > 0 ? String(id) : undefined;
  if (typeof id !== "string" || !/^\d+$/u.test(id)) return undefined;
  try {
    const canonical = BigInt(id).toString();
    return canonical === "0" ? undefined : canonical;
  } catch {
    return undefined;
  }
}

function readProviderId(value: string): string {
  const parsed = asProviderId({ id: value });
  if (!parsed) throw new Error("invalid PowerDNS provider id");
  return parsed;
}
