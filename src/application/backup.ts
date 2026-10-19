import type {
  AccessTokenRepository, ApplyStatus, CredentialRepository, SettingsRepository, StatusRepository, StoredAccessToken, ZoneRepository,
} from "./ports.ts";
import { DomainValidationError, type AuditEntry, type Zone, type ZoneRevision } from "../domain/dns.ts";
import { readHealthChecks } from "../domain/health-checks.ts";
import { readAccountState, readMemberAudit, type AccountState, type AccountStateStore, type MemberAudit } from "./accounts/state.ts";
import { healthCheckStoreIssues } from "./control-plane.ts";

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

/**
 * Format 2 adds member accounts. Format 1 documents still restore; they simply
 * carry no accounts.
 */
export const BACKUP_FORMAT = 2;
const READABLE_FORMATS: readonly number[] = [1, 2];

/**
 * Members as they are stored: password hashes, encrypted factors (useless
 * without `PARALLAX_ACCOUNT_KEY`, kept apart from this file), recovery-code
 * hashes, linked identities, policy and the account audit trail.
 *
 * Never sessions, invitation/reset/link/challenge tokens or attempt counters:
 * a restore starts everybody signed out and no mailed link works again.
 */
export interface BackupAccounts {
  readonly state: AccountState;
  readonly audit: readonly MemberAudit[];
}

export interface BackupZone {
  readonly current: Zone;
  /** Ascending. Retention has already been applied; this is what is kept. */
  readonly revisions: readonly ZoneRevision[];
}

export interface BackupDocument {
  readonly format: 1 | 2;
  readonly takenAt: string;
  readonly zones: readonly BackupZone[];
  /** Ascending by id. */
  readonly audit: readonly AuditEntry[];
  readonly statuses: readonly ApplyStatus[];
  readonly settings: Record<string, unknown>;
  readonly accessTokens: readonly StoredAccessToken[];
  /** The credential store's document, byte for byte. Absent when none exists. */
  readonly credentials?: string;
  /** Format 2 only, and only where member accounts exist in the source. */
  readonly accounts?: BackupAccounts;
}

export interface BackupStores {
  readonly zones: ZoneRepository;
  readonly statuses: StatusRepository;
  readonly settings: SettingsRepository;
  readonly accessTokens: AccessTokenRepository;
  readonly credentials: CredentialRepository;
  /**
   * The health-check rules a commit enforces, for a restore that bypasses it.
   * Absent in a store that serves nothing, where only the syntax is checked.
   */
  readonly healthChecks?: {
    /** The lock commits holding an enabled health check take. */
    readonly exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
    /** Whether a zone's internal view would be published elsewhere under these settings. */
    readonly unsupported: (zone: string, settings: Record<string, unknown>) => boolean | Promise<boolean>;
  };
  /** Present where this process can read and write member accounts. */
  readonly accounts?: AccountStateStore;
}

export class BackupError extends Error {
  override readonly name = "BackupError";
}

export async function exportBackup(stores: BackupStores, now: () => Date = () => new Date()): Promise<BackupDocument> {
  const zones = await stores.zones.list();
  const backupZones: BackupZone[] = [];
  const statuses: ApplyStatus[] = [];
  for (const zone of zones) {
    const revisions = await stores.zones.listRevisions(zone.name);
    // ⚠️ Every read here is a separate lockless one, and nothing quiesces the
    // control plane -- so a commit landing between them leaves the document
    // saying one thing and carrying another. Measured: a zone exported as
    // revision 4 carrying a revision 5, which the restore then replayed onto 5.
    //
    // Read again and take the later one rather than refusing: a backup that
    // fails because the server was busy is a backup nobody takes. What must not
    // survive is the *inconsistency*, and re-reading the zone after its history
    // closes the window in the direction that matters -- the current snapshot
    // is never older than the revisions filed under it.
    const settled = await stores.zones.get(zone.name);
    if (settled === undefined) continue;
    const highest = revisions.reduce((top, snapshot) => Math.max(top, snapshot.revision), 0);
    backupZones.push({
      current: settled,
      revisions: highest > settled.revision
        ? await stores.zones.listRevisions(zone.name)
        : revisions,
    });
    statuses.push(...await stores.statuses.list(zone.name));
  }
  // Ascending, because that is the order a restore has to replay them in and
  // the reader should not have to know to sort first.
  // Read last, and kept whole. It names zones that no longer exist, and that is
  // correct rather than a mid-export artefact: a zone's deletion entry outlives
  // the zone on purpose, and filtering to the zones still present would throw
  // away the history of every zone ever deleted.
  const audit = (await stores.zones.audit()).slice().sort((left, right) => left.id - right.id);
  const credentials = await stores.credentials.read();
  const accounts = stores.accounts ? withoutLiveSecrets(await stores.accounts.snapshot()) : undefined;
  return {
    // A deployment without member accounts still writes format 1, which every earlier reader accepts.
    format: accounts ? BACKUP_FORMAT : 1,
    takenAt: now().toISOString(),
    zones: backupZones,
    audit,
    statuses,
    settings: await stores.settings.read(),
    accessTokens: await stores.accessTokens.list(),
    ...(credentials === undefined ? {} : { credentials }),
    ...(accounts ? { accounts } : {}),
  };
}

/** Keeps only what a member is, never what lets somebody act as one right now. */
function withoutLiveSecrets(snapshot: { state: AccountState; audit: MemberAudit[] }): BackupAccounts | undefined {
  const { state, audit } = snapshot;
  if (!state.enabled && state.users.length === 0) return undefined;
  return { state: { ...state, sessions: [], tokens: [], throttle: [], memberThrottle: {} }, audit };
}

export interface RestoreSummary {
  readonly zones: number;
  readonly revisions: number;
  readonly audit: number;
  readonly statuses: number;
  readonly settings: number;
  readonly accessTokens: number;
  readonly credentials: boolean;
  /** Members restored. Every one of them starts signed out. */
  readonly members: number;
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
  if (document.accounts && !stores.accounts) {
    throw new BackupError("this backup carries member accounts; restore it with PARALLAX_AUTH_MODE=accounts so they are not silently dropped");
  }
  // Held across the check and every write: a commit adding an enabled health
  // check elsewhere meanwhile would be counted against an empty store.
  return stores.healthChecks
    ? stores.healthChecks.exclusive(() => restore(stores, document))
    : restore(stores, document);
}

async function restore(stores: BackupStores, document: BackupDocument): Promise<RestoreSummary> {
  await assertEmpty(stores, document);
  // Everything is checked before anything is written, because a restore is not
  // a transaction: it is a sequence of writes into a store that has no way to
  // roll them back. A document that was going to fail at zone 300 used to fail
  // there, leaving 299 zones and no audit, no settings, no tokens -- and the
  // refusal above then made the retry impossible.
  assertRestorable(document);
  await assertHealthChecksRestorable(stores, document);

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
  // Last, and in one account transaction: state, audit and the activation marker
  // commit together or not at all. A failure anywhere above leaves member
  // accounts unrestored and therefore not enabled, so sign-in stays closed
  // rather than open on half a member set. The zone, settings and token writes
  // above are not one transaction across stores; an interrupted restore is
  // retried into an emptied store.
  if (document.accounts) await restoreAccounts(stores.accounts!, document.accounts);

  return {
    zones: document.zones.length,
    revisions,
    audit: document.audit.length,
    statuses: document.statuses.length,
    settings: Object.keys(document.settings).length,
    accessTokens: document.accessTokens.length,
    credentials: document.credentials !== undefined,
    members: document.accounts?.state.users.length ?? 0,
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
  if (typeof candidate.format !== "number" || !READABLE_FORMATS.includes(candidate.format)) {
    throw new BackupError(`unsupported backup format ${String(candidate.format)}; this build writes ${BACKUP_FORMAT} and reads ${READABLE_FORMATS.join(" and ")}`);
  }
  if (candidate.format === 1 && candidate.accounts !== undefined) throw new BackupError("a format 1 backup cannot carry member accounts");
  const accounts = candidate.accounts === undefined ? undefined : readBackupAccounts(candidate.accounts);
  const zones = requireArray(candidate.zones, "zones").map((entry, index) => {
    const zone = requireObject(entry, `zones[${index}]`);
    return {
      current: requireObject(zone.current, `zones[${index}].current`) as unknown as Zone,
      revisions: requireArray(zone.revisions, `zones[${index}].revisions`) as unknown as ZoneRevision[],
    };
  });
  return {
    format: candidate.format as 1 | 2,
    takenAt: typeof candidate.takenAt === "string" ? candidate.takenAt : "",
    zones,
    audit: requireArray(candidate.audit, "audit") as unknown as AuditEntry[],
    statuses: requireArray(candidate.statuses, "statuses") as unknown as ApplyStatus[],
    settings: requireObject(candidate.settings, "settings"),
    accessTokens: requireArray(candidate.accessTokens, "accessTokens") as unknown as StoredAccessToken[],
    ...(typeof candidate.credentials === "string" ? { credentials: candidate.credentials } : {}),
    ...(accounts ? { accounts } : {}),
  };
}

/**
 * Strict, unlike the rest of the document: the account state is checked
 * whole -- exact fields, references, unique addresses and identities, and a
 * ready state only with an administrator who can sign in -- because nothing
 * after this would catch a wrong one before people sign in against it. Any
 * activation stage of an enabled store is accepted and restored as taken.
 */
function readBackupAccounts(value: unknown): BackupAccounts {
  const section = requireObject(value, "accounts");
  const keys = Object.keys(section).sort();
  if (keys.length !== 2 || keys[0] !== "audit" || keys[1] !== "state") throw new BackupError("accounts must carry exactly state and audit");
  let state: AccountState, audit: MemberAudit[];
  try {
    state = readAccountState(section.state);
    audit = readMemberAudit(section.audit);
  } catch {
    throw new BackupError("accounts is not a valid member account state");
  }
  if (state.sessions.length > 0 || state.tokens.length > 0 || state.throttle.length > 0 || Object.keys(state.memberThrottle).length > 0) {
    throw new BackupError("accounts must not carry sessions, mailed or sign-in tokens, or attempt counters");
  }
  // Any activation stage restores as it was taken: enabled with no member yet, the first administrator
  // still enrolling, or an administrator recovery in progress. Member sign-in stays closed until that
  // administrator signs in with the password and enrolls a factor; no challenge or session comes back.
  if (!state.enabled) throw new BackupError("accounts must be enabled; a store that never enabled them has nothing to restore");
  return { state, audit };
}

/** One transaction into an account store that has never been enabled and holds no member. */
async function restoreAccounts(store: AccountStateStore, accounts: BackupAccounts): Promise<void> {
  await store.transact((transaction) => {
    if (transaction.state.enabled || transaction.state.users.length > 0 || transaction.state.bootstrap !== "empty") {
      throw new BackupError("refusing to restore member accounts into a store that already has them");
    }
    transaction.state = structuredClone(accounts.state);
    transaction.audit.push(...structuredClone([...accounts.audit]));
  });
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
  if (document.accounts && stores.accounts) {
    const state = await stores.accounts.read();
    if (state.enabled || state.users.length > 0 || state.bootstrap !== "empty") {
      throw new BackupError("refusing to restore into a store whose member accounts are already enabled or populated");
    }
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
 * The health-check rules a commit holds every zone to, applied to the zones
 * this document would leave behind, taken together.
 *
 * Every snapshot's policies must read, or the replay stops part way. The
 * current snapshots must also resolve to the records they protect, keep the
 * enabled addresses across all of them under the ceiling, and not enable a
 * policy where the settings in effect after the restore publish the internal
 * view elsewhere.
 */
async function assertHealthChecksRestorable(stores: BackupStores, document: BackupDocument): Promise<void> {
  const issues: string[] = [];
  const current: Zone[] = [];
  for (const [index, zone] of document.zones.entries()) {
    for (const [position, snapshot] of [zone.current, ...zone.revisions].entries()) {
      const read = readSnapshotHealthChecks(snapshot as Zone, `zones[${index}]${position === 0 ? ".current" : `.revisions[${position - 1}]`}`, issues);
      if (position === 0 && read) current.push(read);
    }
  }
  if (issues.length === 0) {
    const settings = Object.keys(document.settings).length > 0 ? document.settings : await stores.settings.read();
    const unsupported = stores.healthChecks
      ? (zone: string) => stores.healthChecks!.unsupported(zone, settings)
      : () => false;
    issues.push(...await healthCheckStoreIssues(current, unsupported));
  }
  if (issues.length > 0) throw new BackupError(`the backup's health checks cannot be restored: ${issues.join("; ")}`);
}

function readSnapshotHealthChecks(snapshot: Zone, label: string, issues: string[]): Zone | undefined {
  if (!Array.isArray(snapshot.views)) return undefined;
  const views: Zone["views"] = [];
  for (const view of snapshot.views) {
    // A view this cannot even name is the repositories' to refuse.
    if (typeof (view as { name?: unknown } | null)?.name !== "string") return undefined;
    try {
      const healthChecks = readHealthChecks((view as { healthChecks?: unknown }).healthChecks, view.name);
      views.push({ ...view, ...(healthChecks === undefined ? {} : { healthChecks }) });
    } catch (error) {
      if (!(error instanceof DomainValidationError)) throw error;
      issues.push(...error.issues.map((issue) => `${label}: ${issue}`));
      return undefined;
    }
  }
  return { ...snapshot, views };
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
