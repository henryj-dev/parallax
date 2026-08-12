import type { ProviderAdapter } from "../application/ports.ts";
import { type DesiredRecord, type RecordType } from "../domain/dns.ts";
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

const SUPPORTED: readonly RecordType[] = ["A", "AAAA", "CNAME", "TXT"];

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
      if (operation.kind === "delete") {
        // The cascade removes the marker with the row, so nothing has to be
        // deleted twice or can be left behind if this fails halfway.
        await this.#assertOwned(client, target, operation.providerId);
        await client.query("DELETE FROM records WHERE id = $1", [Number(operation.providerId)]);
      } else if (operation.kind === "update") {
        await this.#assertOwned(client, target, operation.providerId);
        await client.query(
          "UPDATE records SET name = $2, type = $3, content = $4, ttl = $5 WHERE id = $1",
          [Number(operation.providerId), absoluteName(operation.desired.name, zone), operation.desired.type,
            toStoredContent(operation.desired), operation.desired.ttl],
        );
        await client.query("UPDATE parallax_powerdns_ownership SET marker = $2 WHERE record_id = $1",
          [Number(operation.providerId), ownershipComment(target, operation.desired.id, this.#ownershipSecret)]);
      } else {
        const { rows } = await client.query(
          `INSERT INTO records (domain_id, name, type, content, ttl, disabled, auth)
           VALUES ($1, $2, $3, $4, $5, false, true) RETURNING id`,
          [domainId, absoluteName(operation.desired.name, zone), operation.desired.type,
            toStoredContent(operation.desired), operation.desired.ttl],
        );
        const id = asId(rows[0]);
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
    const id = asId(rows[0]);
    if (id === undefined) throw new Error(`PowerDNS has no zone named ${zone}`);
    return id;
  }

  /**
   * Refuses to change a row Parallax does not own, and refuses one owned for a
   * different target -- a record published for another view is not this view's
   * to edit.
   */
  async #assertOwned(client: PgClient, target: string, providerId: string): Promise<void> {
    const { rows } = await client.query(
      "SELECT marker FROM parallax_powerdns_ownership WHERE record_id = $1", [Number(providerId)]);
    const marker = rows[0] && typeof (rows[0] as { marker?: unknown }).marker === "string"
      ? (rows[0] as { marker: string }).marker
      : undefined;
    if (!readOwnershipComment(marker, this.#ownershipSecret, target)) {
      throw new Error(`PowerDNS record ${providerId} is not owned by target ${target}`);
    }
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
    await client.query("UPDATE records SET content = $2 WHERE id = $1", [row.id, fields.join(" ")]);
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
  id: number;
  name: string;
  type: string;
  content: string;
  ttl: number;
  marker: string | null;
}

function asRow(value: unknown): Row | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const id = asId(row);
  if (id === undefined || typeof row.name !== "string" || typeof row.type !== "string") return undefined;
  if (typeof row.content !== "string" || typeof row.ttl !== "number") return undefined;
  if (!SUPPORTED.includes(row.type as RecordType)) return undefined;
  return { id, name: row.name, type: row.type, content: row.content, ttl: row.ttl, marker: typeof row.marker === "string" ? row.marker : null };
}

function asId(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  if (typeof id === "number" && Number.isSafeInteger(id)) return id;
  // `pg` returns BIGINT as a string, which is what `records.id` is.
  if (typeof id === "string" && /^\d+$/u.test(id)) return Number(id);
  return undefined;
}
