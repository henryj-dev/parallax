import type {
  AccessTokenRepository, ApplyStatus, CredentialRepository, SettingsRepository, StatusRepository, StoredAccessToken, ZoneRepository,
} from "./ports.ts";
import type { AuditEntry, Zone, ZoneRevision } from "../domain/dns.ts";

/**
 * One document holding everything a Parallax store contains, and the two
 * directions it travels in.
 *
 * The backends already implement the same ports, so a document written from
 * one restores into the other and the file-to-PostgreSQL move is that and
 * nothing else -- there is no migration path here that is not also the backup
 * path, which is the only way both stay exercised.
 *
 * ⚠️ This document is exactly as sensitive as the files it copies. It carries
 * the credential store's document as stored -- ciphertext, useless without
 * `PARALLAX_CREDENTIAL_MASTER_KEY`, which is not a reason to leave it
 * somewhere the state file would not be left. Leaving credentials out was the
 * alternative, and it makes the migration a trap: every provider target breaks
 * on the far side and the operator finds out at the next apply.
 */

export const BACKUP_FORMAT = 1;

export interface BackupZone {
  readonly current: Zone;
  /** Ascending. Retention has already been applied; this is what is kept. */
  readonly revisions: readonly ZoneRevision[];
}

export interface BackupDocument {
  readonly format: typeof BACKUP_FORMAT;
  readonly takenAt: string;
  readonly zones: readonly BackupZone[];
  /** Ascending by id. */
  readonly audit: readonly AuditEntry[];
  readonly statuses: readonly ApplyStatus[];
  readonly settings: Record<string, unknown>;
  readonly accessTokens: readonly StoredAccessToken[];
  /** The credential store's document, byte for byte. Absent when none exists. */
  readonly credentials?: string;
}

export interface BackupStores {
  readonly zones: ZoneRepository;
  readonly statuses: StatusRepository;
  readonly settings: SettingsRepository;
  readonly accessTokens: AccessTokenRepository;
  readonly credentials: CredentialRepository;
}

export class BackupError extends Error {
  override readonly name = "BackupError";
}

export async function exportBackup(stores: BackupStores, now: () => Date = () => new Date()): Promise<BackupDocument> {
  const zones = await stores.zones.list();
  const backupZones: BackupZone[] = [];
  const statuses: ApplyStatus[] = [];
  for (const zone of zones) {
    backupZones.push({ current: zone, revisions: await stores.zones.listRevisions(zone.name) });
    statuses.push(...await stores.statuses.list(zone.name));
  }
  // Ascending, because that is the order a restore has to replay them in and
  // the reader should not have to know to sort first.
  const audit = (await stores.zones.audit()).slice().sort((left, right) => left.id - right.id);
  const credentials = await stores.credentials.read();
  return {
    format: BACKUP_FORMAT,
    takenAt: now().toISOString(),
    zones: backupZones,
    audit,
    statuses,
    settings: await stores.settings.read(),
    accessTokens: await stores.accessTokens.list(),
    ...(credentials === undefined ? {} : { credentials }),
  };
}

export interface RestoreSummary {
  readonly zones: number;
  readonly revisions: number;
  readonly audit: number;
  readonly statuses: number;
  readonly settings: number;
  readonly accessTokens: number;
  readonly credentials: boolean;
  /**
   * Said out loud rather than left for somebody to notice.
   *
   * Audit ids are assigned by the store, so a restored log is renumbered from
   * 1. The order and the content survive; the numbers do not, and anything
   * holding an id from before the restore is holding a stale cursor.
   */
  readonly auditRenumbered: boolean;
}

/**
 * Writes a document into whichever backend this process is configured for.
 *
 * Refuses a store that already holds zones. A restore is not a merge, and
 * there is no port here that could empty a store first -- deliberately, because
 * a truncate reachable from a command is a worse thing to own than an operator
 * having to remove a state file or drop a schema on purpose.
 */
export async function importBackup(stores: BackupStores, document: BackupDocument): Promise<RestoreSummary> {
  await assertEmpty(stores, document);
  // Everything is checked before anything is written, because a restore is not
  // a transaction: it is a sequence of writes into a store that has no way to
  // roll them back. A document that was going to fail at zone 300 used to fail
  // there, leaving 299 zones and no audit, no settings, no tokens -- and the
  // refusal above then made the retry impossible.
  assertRestorable(document);

  let revisions = 0;
  for (const zone of document.zones) {
    // Ascending, so each snapshot also becomes the current zone in turn and the
    // last one leaves the zone where the backup found it.
    for (const snapshot of [...zone.revisions].sort((left, right) => left.revision - right.revision)) {
      await stores.zones.saveRevision(snapshot);
      revisions += 1;
    }
    // The replay leaves the zone on the highest revision it wrote, which is not
    // always the one the document says is current -- the snapshot may have been
    // pruned past, or the export may have caught the zone mid-commit and
    // captured a revision newer than the `current` it had already read.
    // Membership alone was checked here, so the second case restored a zone to
    // a revision the document never claimed.
    const highest = zone.revisions.reduce((top, snapshot) => Math.max(top, snapshot.revision), 0);
    if (highest !== zone.current.revision) await stores.zones.save(zone.current);
  }
  for (const entry of [...document.audit].sort((left, right) => left.id - right.id)) {
    const { id: _assignedByTheStore, ...rest } = entry;
    await stores.zones.appendAudit(rest);
  }
  for (const status of document.statuses) await stores.statuses.save(status);
  if (Object.keys(document.settings).length > 0) await stores.settings.write(document.settings);
  for (const token of document.accessTokens) await stores.accessTokens.create(token);
  if (document.credentials !== undefined) await stores.credentials.write(document.credentials);

  return {
    zones: document.zones.length,
    revisions,
    audit: document.audit.length,
    statuses: document.statuses.length,
    settings: Object.keys(document.settings).length,
    accessTokens: document.accessTokens.length,
    credentials: document.credentials !== undefined,
    auditRenumbered: document.audit.length > 0,
  };
}

/**
 * Enough of a check that a wrong file fails before anything is written, and no
 * more: the repositories validate what they store, and repeating their rules
 * here would leave two definitions of what a zone is.
 */
export function readBackupDocument(value: unknown): BackupDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BackupError("a backup document must be a JSON object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.format !== BACKUP_FORMAT) {
    throw new BackupError(`unsupported backup format ${String(candidate.format)}; this build writes and reads ${BACKUP_FORMAT}`);
  }
  const zones = requireArray(candidate.zones, "zones").map((entry, index) => {
    const zone = requireObject(entry, `zones[${index}]`);
    return {
      current: requireObject(zone.current, `zones[${index}].current`) as unknown as Zone,
      revisions: requireArray(zone.revisions, `zones[${index}].revisions`) as unknown as ZoneRevision[],
    };
  });
  return {
    format: BACKUP_FORMAT,
    takenAt: typeof candidate.takenAt === "string" ? candidate.takenAt : "",
    zones,
    audit: requireArray(candidate.audit, "audit") as unknown as AuditEntry[],
    statuses: requireArray(candidate.statuses, "statuses") as unknown as ApplyStatus[],
    settings: requireObject(candidate.settings, "settings"),
    accessTokens: requireArray(candidate.accessTokens, "accessTokens") as unknown as StoredAccessToken[],
    ...(typeof candidate.credentials === "string" ? { credentials: candidate.credentials } : {}),
  };
}

/**
 * Refuses a store that already holds anything a restore would replace.
 *
 * It checked zones and tokens, and wrote settings and the credential document
 * regardless. Measured: a target provisioned with its own credentials and no
 * zones -- the ordinary order for a new instance -- had its credential
 * ciphertext replaced by the document's, unrecoverably where the two master
 * keys differ, and its settings left as neither side's because
 * `SettingsRepository.write` is a patch rather than a replacement.
 */
async function assertEmpty(stores: BackupStores, document: BackupDocument): Promise<void> {
  const zones = await stores.zones.list({ limit: 1, offset: 0 });
  if (zones.length > 0) {
    throw new BackupError(
      `refusing to restore into a store that already holds ${zones[0]?.name}.`
      + " Empty it first -- remove the state file and its .d directory, or drop and re-migrate the schema.",
    );
  }
  const tokens = await stores.accessTokens.list();
  if (tokens.length > 0) {
    throw new BackupError(`refusing to restore into a store that already holds ${tokens.length} access token(s)`);
  }
  if (document.credentials !== undefined && await stores.credentials.read() !== undefined) {
    throw new BackupError(
      "refusing to restore into a store that already holds a credential document."
      + " Replacing it would discard credentials this backup cannot restore if the two master keys differ.",
    );
  }
  const settings = await stores.settings.read();
  if (Object.keys(document.settings).length > 0 && Object.keys(settings).length > 0) {
    throw new BackupError(
      `refusing to restore into a store that already holds ${Object.keys(settings).length} setting(s).`
      + " Settings are written as a patch, so the result would be neither this backup's nor the store's.",
    );
  }
}

/**
 * Everything that would make the write loop fail part way, found first.
 *
 * The document reader deliberately validates shallowly and leaves the rest to
 * the repositories -- which is right for what a zone *is*, and wrong for what
 * makes a restore stop half done.
 */
function assertRestorable(document: BackupDocument): void {
  for (const [index, zone] of document.zones.entries()) {
    const seen = new Set<number>();
    for (const snapshot of zone.revisions) {
      const revision = (snapshot as { revision?: unknown }).revision;
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
        throw new BackupError(`zones[${index}] carries a revision that is not a positive integer`);
      }
      if (seen.has(revision)) throw new BackupError(`zones[${index}] carries revision ${revision} more than once`);
      seen.add(revision);
    }
  }
  const ids = new Set<number>();
  for (const entry of document.audit) {
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new BackupError("an audit entry carries an id that is not a positive integer");
    }
    if (ids.has(id)) throw new BackupError(`the audit log carries id ${id} more than once`);
    ids.add(id);
  }
  for (const [index, token] of document.accessTokens.entries()) {
    assertRestorableToken(token, index);
  }
}

/**
 * ⚠️ An access token record goes straight into the set every request is
 * authenticated against, and `prepareConfig` refuses a whole configuration it
 * cannot read -- inside the request handler. One unusable row therefore takes
 * the API down for everybody, including the call that would delete it.
 */
function assertRestorableToken(value: unknown, index: number): void {
  const token = value as Record<string, unknown>;
  const digest = typeof token.digest === "string" ? Buffer.from(token.digest, "base64url") : undefined;
  if (typeof token.id !== "string" || token.id.length === 0
    || typeof token.subject !== "string" || token.subject.trim().length === 0
    || (token.role !== "admin" && token.role !== "editor" && token.role !== "viewer")
    || digest === undefined || digest.byteLength !== 32 || digest.toString("base64url") !== token.digest
    || !isIsoTimestamp(token.createdAt)
    || (token.expiresAt !== undefined && !isIsoTimestamp(token.expiresAt))
    || (token.lastUsedAt !== undefined && !isIsoTimestamp(token.lastUsedAt))) {
    throw new BackupError(`accessTokens[${index}] is not a usable access token record`);
  }
}

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new BackupError(`${field} must be an array`);
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BackupError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
