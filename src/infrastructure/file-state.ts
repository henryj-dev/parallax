import { createHash, randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { mergeApplyStatus, RevisionConflictError, type ApplyLock, type ApplyStatus, type AuditRetentionPolicy, type DesiredChange, type PageRequest, type RetentionPolicy, type StatusRepository, type ZoneDeletion, type ZoneRepository } from "../application/ports.ts";
import { assertPersistedDesiredViewsValid } from "../application/control-plane.ts";
import { AUDIT_ACTIONS, createDesiredRecord, normalizeZoneName, readPersistedViewName, type AuditEntry, type Zone, type ZoneRevision } from "../domain/dns.ts";
import { ensurePrivateDirectory, withFileLock } from "./atomic-file.ts";

/**
 * What the state file itself holds, and nothing more.
 *
 * ⚠️ Version 1 held the revision snapshots and the whole audit log in here as
 * well, and every change rewrote all of it. Measured on this Mac at ten zones
 * of two hundred records with fifty retained revisions -- half the default
 * retention -- the file reached **19.9 MiB and one record change took 506 ms**,
 * because the cost was `zones x revisions x records` whatever was actually
 * edited. Reads paid it too: `list()` parsed and re-validated every record of
 * every revision to answer "what zones are there".
 *
 * So the two things that grow without bound moved out, and what is left is the
 * part whose size is the deployment's: one current snapshot per zone, the apply
 * statuses, and two counters.
 */
interface PersistedState {
  version: 2;
  zones: Record<string, Zone>;
  statuses: Record<string, ApplyStatus>;
  nextAuditId: number;
  /**
   * The oldest audit entry's timestamp, or absent when the log is empty.
   *
   * Here rather than derived, so a commit can decide whether retention has
   * anything to remove without reading the log at all. That is what keeps an
   * append an append.
   */
  auditOldestAt?: string;
}

const STATE_VERSION = 2;

/** One zone's retained history, in a file of its own. */
interface PersistedRevisions {
  zone: string;
  revisions: Record<string, ZoneRevision>;
}

/**
 * A dependency-free, durable repository for file-backed Parallax processes.
 *
 * A local queue and a cross-process file lock serialize zone/status changes.
 * The state now spans three kinds of file, and the rename of the state file is
 * the **commit point**: side files are written first, and a reader ignores
 * anything the state file does not vouch for -- a revision newer than the
 * zone's current one, an audit id at or past `nextAuditId`. A crash between the
 * two therefore leaves garbage that is invisible rather than state that is
 * wrong, and the next write overwrites it.
 */
export class FileStateRepository implements ZoneRepository, StatusRepository {
  readonly #path: string;
  readonly #sideDirectory: string;
  #writeTail: Promise<void> = Promise.resolve();
  /** Set when the last read found a half-written final line, so the next write repairs it. */
  #tornAuditTail = false;

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error("state file path must not be empty");
    this.#path = path;
    this.#sideDirectory = `${path}.d`;
  }

  list(page?: PageRequest): Promise<Zone[]>;
  list(zone: string): Promise<ApplyStatus[]>;
  async list(zoneOrPage?: string | PageRequest): Promise<Zone[] | ApplyStatus[]> {
    const { state } = await this.#read();
    if (typeof zoneOrPage === "string") {
      return Object.values(state.statuses)
        .filter((status) => status.zone === zoneOrPage)
        .map(clone)
        .sort((left, right) => left.view.localeCompare(right.view));
    }
    const names = Object.keys(state.zones).sort((left, right) => left.localeCompare(right));
    const selected = zoneOrPage ? names.slice(zoneOrPage.offset, zoneOrPage.offset + zoneOrPage.limit) : names;
    return selected.map((name) => clone(state.zones[name]!));
  }

  get(name: string): Promise<Zone | undefined>;
  get(zone: string, view: string): Promise<ApplyStatus | undefined>;
  async get(name: string, view?: string): Promise<Zone | ApplyStatus | undefined> {
    const { state } = await this.#read();
    if (view !== undefined) {
      const status = state.statuses[statusKey(name, view)];
      return status ? clone(status) : undefined;
    }
    const zone = state.zones[name];
    return zone ? clone(zone) : undefined;
  }

  save(zone: Zone): Promise<void>;
  save(status: ApplyStatus): Promise<void>;
  async save(value: Zone | ApplyStatus): Promise<void> {
    await this.#mutate((draft) => {
      if (isZone(value)) draft.state.zones[value.name] = clone(value);
      else {
        const key = statusKey(value.zone, value.view);
        draft.state.statuses[key] = mergeApplyStatus(draft.state.statuses[key], clone(value));
      }
    });
  }

  async saveRevision(snapshot: ZoneRevision): Promise<void> {
    await this.#mutate(async (draft) => {
      const revisions = await draft.revisionsOf(snapshot.name);
      const key = String(snapshot.revision);
      if (revisions[key]) throw new Error(`revision ${snapshot.revision} already exists for zone ${snapshot.name}`);
      draft.putRevision(clone(snapshot));
      draft.state.zones[snapshot.name] = clone(snapshot);
    });
  }

  async commitDesiredChange(change: DesiredChange): Promise<void> {
    await this.#mutate(async (draft) => {
      const snapshot = clone(change.snapshot);
      const current = draft.state.zones[snapshot.name];
      if (current && current.revision >= snapshot.revision) {
        throw new RevisionConflictError(`revision ${snapshot.revision} already exists or is stale for zone ${snapshot.name}`);
      }
      const statuses = change.statuses.map(clone);

      // The revision file is read before it is written, because retention has
      // to see what is already there. Only this zone's.
      await draft.revisionsOf(snapshot.name);
      draft.putRevision(snapshot);
      draft.state.zones[snapshot.name] = clone(snapshot);
      draft.appendAudit(change.audit);
      for (const status of statuses) draft.state.statuses[statusKey(status.zone, status.view)] = status;
      await draft.applyRetention(snapshot.name, change.retention);
    });
  }

  async commitZoneDeletion(deletion: ZoneDeletion): Promise<void> {
    await this.#mutate(async (draft) => {
      const current = draft.state.zones[deletion.zone];
      if (!current || current.revision !== deletion.expectedRevision) {
        throw new RevisionConflictError(`expected revision ${deletion.expectedRevision} for zone ${deletion.zone}`);
      }
      delete draft.state.zones[deletion.zone];
      draft.dropRevisions(deletion.zone);
      for (const [key, status] of Object.entries(draft.state.statuses)) {
        if (status.zone === deletion.zone) delete draft.state.statuses[key];
      }
      draft.appendAudit(deletion.audit);
      await draft.applyRetention(deletion.zone, deletion.retention);
    });
  }

  async listRevisions(zone: string, page?: PageRequest): Promise<ZoneRevision[]> {
    const view = await this.#read();
    const revisions = view.legacy?.revisions[zone] ?? await this.#readRevisionFile(zone, view.state);
    const ascending = Object.values(revisions).map(clone).sort((left, right) => left.revision - right.revision);
    if (!page) return ascending;
    const end = Math.max(0, ascending.length - page.offset);
    return ascending.slice(Math.max(0, end - page.limit), end);
  }

  async getRevision(zone: string, revision: number): Promise<ZoneRevision | undefined> {
    const view = await this.#read();
    const revisions = view.legacy?.revisions[zone] ?? await this.#readRevisionFile(zone, view.state);
    const snapshot = revisions[String(revision)];
    return snapshot ? clone(snapshot) : undefined;
  }

  async delete(name: string): Promise<void> {
    await this.#mutate((draft) => {
      delete draft.state.zones[name];
      draft.dropRevisions(name);
    });
  }

  async appendAudit(input: Omit<AuditEntry, "id">, retention?: AuditRetentionPolicy): Promise<AuditEntry> {
    return this.#mutate(async (draft) => {
      const entry = draft.appendAudit(input);
      await draft.applyRetention(input.zone, retention);
      return clone(entry);
    });
  }

  async audit(zone?: string, page?: PageRequest): Promise<AuditEntry[]> {
    const view = await this.#read();
    const entries = view.legacy?.audit ?? await this.#readAuditLog(view.state);
    const newestFirst = entries
      .filter((entry) => zone === undefined || entry.zone === zone)
      .map(clone)
      .sort((left, right) => right.id - left.id);
    return page ? newestFirst.slice(page.offset, page.offset + page.limit) : newestFirst;
  }

  async deleteZone(zone: string): Promise<void> {
    await this.#mutate((draft) => {
      for (const [key, status] of Object.entries(draft.state.statuses)) {
        if (status.zone === zone) delete draft.state.statuses[key];
      }
    });
  }

  async #read(): Promise<StateView> {
    await this.#writeTail;
    return this.#readFile();
  }

  #mutate<T>(operation: (draft: MutationDraft) => Promise<T> | T): Promise<T> {
    const result = this.#writeTail.then(() => withFileLock(this.#path, async () => {
      // Always re-read after the cross-process lock is held. A cached snapshot
      // here turns a successful CLI/replica write into the next writer's loss.
      const view = await this.#readFile();
      const state = clone(view.state);
      // A version 1 document is split apart here, under the lock, and not on
      // the read path that also meets one: a reader has no right to rewrite the
      // store, and two of them racing to do it would have no lock between them.
      const migrating = view.legacy;

      const loaded = new Map<string, Record<string, ZoneRevision>>();
      const touched = new Set<string>();
      const dropped = new Set<string>();
      const appended: AuditEntry[] = [];
      let compacted: AuditEntry[] | undefined;
      let pruneRevisions: { zone: string; keep: number } | undefined;
      let pruneAudit: { zone: string; before: string } | undefined;

      const revisionsOf = async (zone: string): Promise<Record<string, ZoneRevision>> => {
        const already = loaded.get(zone);
        if (already) return already;
        const fromDisk = migrating?.revisions[zone] ?? await this.#readRevisionFile(zone, state);
        const copy = clone(fromDisk);
        loaded.set(zone, copy);
        return copy;
      };

      const draft: MutationDraft = {
        state,
        revisionsOf,
        putRevision(snapshot) {
          const revisions = loaded.get(snapshot.name) ?? {};
          revisions[String(snapshot.revision)] = snapshot;
          loaded.set(snapshot.name, revisions);
          touched.add(snapshot.name);
          dropped.delete(snapshot.name);
        },
        dropRevisions(zone) {
          loaded.delete(zone);
          touched.delete(zone);
          dropped.add(zone);
        },
        appendAudit(input) {
          const entry: AuditEntry = clone({ ...input, id: state.nextAuditId });
          state.nextAuditId += 1;
          appended.push(entry);
          if (state.auditOldestAt === undefined || entry.at < state.auditOldestAt) state.auditOldestAt = entry.at;
          return entry;
        },
        /**
         * ⚠️ Retention decides here and deletes **after the commit**.
         *
         * It used to prune the side files before the state file landed, and a
         * crash in that window destroyed history the commit never earned.
         * Measured: a zone at revision 4 keeping three, committing revision 5 --
         * the keep-top-three ran over `[2,3,4,5]`, wrote `[3,4,5]`, and the
         * crash left the zone at revision 4 with only two of its three
         * revisions. Revision 2 was gone, and retention would never have
         * removed it.
         *
         * Deferring it inverts the error: a crash now leaves *more* history
         * than configured, which the next commit trims.
         */
        async applyRetention(zone, retention) {
          const maxRevisions = (retention as RetentionPolicy | undefined)?.maxRevisionsPerZone ?? 0;
          if (maxRevisions > 0 && !dropped.has(zone)) {
            await revisionsOf(zone);
            pruneRevisions = { zone, keep: maxRevisions };
          }
          const before = retention?.deleteAuditBefore;
          // The log is read only when something in it could actually be older
          // than the cutoff. Every other commit leaves it an append.
          if (!before || state.auditOldestAt === undefined || state.auditOldestAt >= before) return;
          pruneAudit = { zone, before };
        },
      };

      const value = await operation(draft);

      // Everything the state file will vouch for goes down first. A crash
      // anywhere in here leaves side files a reader already ignores.
      //
      // The order is also what makes a lockless read safe. Readers take the
      // state file first and a side file second, so the only skew they can see
      // is a side file *ahead* of the state file -- which is exactly what the
      // filters above drop. The reverse, a state file naming a revision that is
      // not there yet, cannot happen while this order holds.
      if (migrating) {
        for (const [zone, revisions] of Object.entries(migrating.revisions)) {
          if (!loaded.has(zone) && !dropped.has(zone)) await this.#writeRevisionFile(zone, revisions);
        }
        if (!compacted) compacted = migrating.audit;
      }
      for (const zone of touched) await this.#writeRevisionFile(zone, loaded.get(zone) ?? {});
      // A torn tail must be cut out rather than appended after: the next line
      // would start mid-object and the damage would become permanent.
      if (compacted || (this.#tornAuditTail && appended.length > 0)) {
        await this.#rewriteAuditLog([...(compacted ?? await this.#readAuditLog(state)), ...appended]);
      } else if (appended.length > 0) {
        await this.#appendAuditLog(appended);
      }

      await this.#writeStateFile(state);

      // Only now, because until the state file landed these were still named by
      // it. An unlink that a crash skips leaves a file nothing reads.
      for (const zone of dropped) await this.#removeRevisionFile(zone);
      // Retention, on the safe side of the commit. Skipping it leaves history
      // the operator did not ask to keep; doing it before would have thrown
      // away history they did.
      if (pruneRevisions) {
        const revisions = loaded.get(pruneRevisions.zone) ?? {};
        const keep = new Set(Object.keys(revisions).map(Number).sort((left, right) => right - left).slice(0, pruneRevisions.keep));
        if (keep.size < Object.keys(revisions).length) {
          for (const key of Object.keys(revisions)) if (!keep.has(Number(key))) delete revisions[key];
          await this.#writeRevisionFile(pruneRevisions.zone, revisions);
        }
      }
      if (pruneAudit) {
        const { zone, before } = pruneAudit;
        const kept = (await this.#readAuditLog(state)).filter((entry) => entry.zone !== zone || entry.at >= before);
        await this.#rewriteAuditLog(kept);
        // The hint follows the log it describes, and never leads it. Written
        // after the rewrite, so a crash in between leaves it pointing at an
        // entry that is already gone -- which costs one wasted pass. Written
        // before, it would name an entry that is still there and skip the prune
        // that removes it, and the log would grow without bound.
        //
        // ⚠️ This is a second write of the state file, and it is not a second
        // commit: nothing else in `state` has changed, so a crash before it
        // leaves the store exactly as the first write left it.
        const oldest = oldestAt(kept);
        const next = oldest === undefined ? undefined : oldest;
        if (next !== state.auditOldestAt) {
          if (next === undefined) delete state.auditOldestAt;
          else state.auditOldestAt = next;
          await this.#writeStateFile(state);
        }
      }
      return value;
    }));
    this.#writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #readFile(): Promise<StateView> {
    await ensurePrivateDirectory(dirname(this.#path));
    let source: string;
    try {
      await chmod(this.#path, 0o600);
      source = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { state: emptyState() };
      throw error;
    }
    const parsed: unknown = JSON.parse(source);
    try {
      return readStateDocument(parsed);
    } catch (error) {
      throw new Error(`unsupported or invalid state file: ${this.#path}`, { cause: error });
    }
  }

  #revisionPath(zone: string): string {
    // Hashed rather than spelled out: a zone name is not a filename, and the
    // apply lock beside it already names its files this way.
    return join(this.#sideDirectory, `rev-${createHash("sha256").update(zone, "utf8").digest("hex")}.json`);
  }

  /**
   * One zone's history, minus anything the state file does not vouch for.
   *
   * A revision past the zone's current one was written by a commit that did not
   * finish. It is dropped rather than served, and the next write to this zone
   * replaces it.
   */
  async #readRevisionFile(zone: string, state: PersistedState): Promise<Record<string, ZoneRevision>> {
    let source: string;
    try {
      source = await readFile(this.#revisionPath(zone), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(source);
    let document: PersistedRevisions;
    try {
      document = readRevisionDocument(parsed);
    } catch (error) {
      throw new Error(`unsupported or invalid revision file for zone ${zone}`, { cause: error });
    }
    if (document.zone !== zone) throw new Error(`revision file for ${zone} names zone ${document.zone}`);
    const committed = state.zones[zone]?.revision;
    if (committed === undefined) return {};
    return Object.fromEntries(Object.entries(document.revisions).filter(([, snapshot]) => snapshot.revision <= committed));
  }

  async #writeRevisionFile(zone: string, revisions: Record<string, ZoneRevision>): Promise<void> {
    await ensurePrivateDirectory(this.#sideDirectory);
    if (Object.keys(revisions).length === 0) {
      await unlink(this.#revisionPath(zone)).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
      return;
    }
    const document: PersistedRevisions = { zone, revisions };
    await writeFileAtomically(this.#revisionPath(zone), `${JSON.stringify(document, null, 2)}\n`);
  }

  async #removeRevisionFile(zone: string): Promise<void> {
    await unlink(this.#revisionPath(zone)).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }

  get #auditPath(): string {
    return join(this.#sideDirectory, "audit.jsonl");
  }

  /**
   * The committed audit log.
   *
   * Two things are filtered out, and both are the shape a crash leaves. An id
   * at or past `nextAuditId` belongs to an append whose commit never landed. A
   * repeated id is that same append happening again afterwards, so the later
   * line is the one that counts.
   */
  async #readAuditLog(state: PersistedState): Promise<AuditEntry[]> {
    let source: string;
    try {
      source = await readFile(this.#auditPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const byId = new Map<number, AuditEntry>();
    const lines = source.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      let entry: AuditEntry;
      try {
        entry = readAuditEntry(JSON.parse(line));
      } catch (error) {
        // ⚠️ The last line is the one a crash can tear, because this log is the
        // only side file that is appended rather than replaced by rename. It was
        // refused here, and refusing it wedged the store: `audit()` threw
        // forever, and so did every commit, because retention is on by default
        // and reads the log. Measured -- a truncated tail made both throw.
        //
        // A torn tail is dropped. An unparseable line with committed lines after
        // it is not a torn append; it is corruption, and that still refuses.
        if (index === lines.length - 1 || lines.slice(index + 1).every((rest) => rest.trim().length === 0)) {
          this.#tornAuditTail = true;
          break;
        }
        throw new Error(`unsupported or invalid audit log line ${index + 1}`, { cause: error });
      }
      if (entry.id >= state.nextAuditId) continue;
      byId.set(entry.id, entry);
    }
    return [...byId.values()];
  }

  async #appendAuditLog(entries: readonly AuditEntry[]): Promise<void> {
    await ensurePrivateDirectory(this.#sideDirectory);
    const file = await open(this.#auditPath, "a", 0o600);
    try {
      await file.writeFile(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async #rewriteAuditLog(entries: readonly AuditEntry[]): Promise<void> {
    await ensurePrivateDirectory(this.#sideDirectory);
    const ascending = [...entries].sort((left, right) => left.id - right.id);
    await writeFileAtomically(this.#auditPath, ascending.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  }

  async #writeStateFile(state: PersistedState): Promise<void> {
    await writeFileAtomically(this.#path, `${JSON.stringify(state, null, 2)}\n`);
  }
}

/** What one mutation may reach, and what it has to ask for. */
interface MutationDraft {
  readonly state: PersistedState;
  revisionsOf(zone: string): Promise<Record<string, ZoneRevision>>;
  putRevision(snapshot: ZoneRevision): void;
  dropRevisions(zone: string): void;
  appendAudit(input: Omit<AuditEntry, "id">): AuditEntry;
  applyRetention(zone: string, retention: RetentionPolicy | AuditRetentionPolicy | undefined): Promise<void>;
}

/**
 * A state file as read, plus the whole of a version 1 document when that is
 * what was found. Version 1 kept everything in one place, so there is nothing
 * else to go and read -- and nothing to migrate until a writer holds the lock.
 */
interface StateView {
  state: PersistedState;
  legacy?: {
    audit: AuditEntry[];
    revisions: Record<string, Record<string, ZoneRevision>>;
  };
}

function oldestAt(...groups: readonly (readonly AuditEntry[])[]): string | undefined {
  let oldest: string | undefined;
  for (const group of groups) {
    for (const entry of group) if (oldest === undefined || entry.at < oldest) oldest = entry.at;
  }
  return oldest;
}

async function writeFileAtomically(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    // Flush the replacement and the directory entry so a crash after this
    // call cannot leave a truncated or missing file behind.
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function createFileStateAdapters(path: string): {
  zones: ZoneRepository;
  statuses: StatusRepository;
  applyLock: ApplyLock;
} {
  const repository = new FileStateRepository(path);
  return { zones: repository, statuses: repository, applyLock: new FileApplyLock(path) };
}

/** Holds a per-zone lock file across provider work and the following state commit. */
/**
 * How long a second process waits for a zone that is already being applied.
 *
 * The default is sized for a file write, and this lock is not one: it is held
 * across the whole of a provider apply, which is one network round trip per
 * record, in sequence. A large zone runs well past fifteen seconds, so a CLI
 * that arrived during one was told the lock had timed out -- and the message
 * then suggested removing it, which is the one thing that must not happen while
 * the holder is alive.
 *
 * Two minutes is still bounded. It is long enough that waiting for an ordinary
 * apply succeeds, and short enough that a genuinely wedged lock is reported
 * rather than waited on forever.
 */
const ZONE_LOCK_TIMEOUT_MS = 120_000;

class FileApplyLock implements ApplyLock {
  readonly #statePath: string;
  constructor(statePath: string) { this.#statePath = statePath; }

  withZoneLock<T>(zone: string, operation: () => Promise<T>): Promise<T> {
    // A lock of its own, beside the state file rather than on it: the state
    // file is locked only for the moment a change is committed, so provider
    // traffic never holds it.
    const key = createHash("sha256").update(zone, "utf8").digest("hex");
    return withFileLock(`${this.#statePath}.zone-${key}`, operation, { timeoutMs: ZONE_LOCK_TIMEOUT_MS });
  }
}

function emptyState(): PersistedState {
  return { version: STATE_VERSION, zones: {}, statuses: {}, nextAuditId: 1 };
}

function statusKey(zone: string, view: string): string {
  return `${zone}\u0000${view}`;
}

function isZone(value: Zone | ApplyStatus): value is Zone {
  return "views" in value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Reads either shape.
 *
 * A version 1 document carries its revisions and audit log inside it, and this
 * returns them as `legacy` rather than throwing: the store must stay readable
 * before anybody writes to it, and the split happens on the next write, under
 * the lock.
 */
function readStateDocument(value: unknown): StateView {
  const candidate = readObject(value, "state document");
  if (candidate.version === 1) return readLegacyDocument(candidate);
  if (candidate.version !== STATE_VERSION) throw new Error("unsupported state document version");

  const zones = readZoneMap(candidate.zones);
  const statuses = readStatusMap(candidate.statuses);
  const nextAuditId = readPositiveInteger(candidate.nextAuditId, "nextAuditId");
  const state: PersistedState = { version: STATE_VERSION, zones, statuses, nextAuditId };
  if (candidate.auditOldestAt !== undefined) {
    state.auditOldestAt = readTimestamp(candidate.auditOldestAt, "auditOldestAt");
  }
  return { state };
}

function readLegacyDocument(candidate: Record<string, unknown>): StateView {
  const zones = readZoneMap(candidate.zones);
  const statuses = readStatusMap(candidate.statuses);

  if (!Array.isArray(candidate.audit)) throw new Error("audit must be an array");
  const audit = candidate.audit.map(readAuditEntry);
  const auditIds = new Set(audit.map((entry) => entry.id));
  if (auditIds.size !== audit.length) throw new Error("audit ids must be unique");

  // Version 1 predated stored revisions; a document without them has exactly
  // one per zone, which is the current snapshot.
  const revisions = candidate.revisions === undefined
    ? Object.fromEntries(Object.entries(zones).map(([name, zone]) => [name, { [String(zone.revision)]: clone(zone) }]))
    : readRevisionMap(candidate.revisions);
  const nextAuditId = readPositiveInteger(candidate.nextAuditId, "nextAuditId");
  const greatestAuditId = audit.reduce((greatest, entry) => Math.max(greatest, entry.id), 0);
  if (nextAuditId <= greatestAuditId) throw new Error("nextAuditId must be greater than every stored audit id");

  const state: PersistedState = { version: STATE_VERSION, zones, statuses, nextAuditId };
  const oldest = oldestAt(audit);
  if (oldest !== undefined) state.auditOldestAt = oldest;
  return { state, legacy: { audit, revisions } };
}

function readZoneMap(value: unknown): Record<string, Zone> {
  const raw = readObject(value, "zones");
  return Object.fromEntries(Object.entries(raw).map(([key, rawZone]) => {
    const zone = readZoneSnapshot(rawZone);
    if (zone.name !== key) throw new Error(`zone key ${key} does not match snapshot name ${zone.name}`);
    return [key, zone] as const;
  }));
}

function readStatusMap(value: unknown): Record<string, ApplyStatus> {
  const raw = readObject(value, "statuses");
  return Object.fromEntries(Object.entries(raw).map(([key, rawStatus]) => {
    const status = readApplyStatus(rawStatus);
    if (statusKey(status.zone, status.view) !== key) throw new Error("status key does not match its zone and view");
    return [key, status] as const;
  }));
}

function readRevisionDocument(value: unknown): PersistedRevisions {
  const candidate = readObject(value, "revision document");
  const zone = readString(candidate.zone, "revision document zone");
  if (normalizeZoneName(zone) !== zone) throw new Error("revision document zone is not normalized");
  return { zone, revisions: readZoneRevisions(zone, candidate.revisions) };
}

function readRevisionMap(value: unknown): Record<string, Record<string, ZoneRevision>> {
  const rawRevisions = readObject(value, "revisions");
  return Object.fromEntries(Object.entries(rawRevisions).map(([zoneName, rawZoneRevisions]) => {
    if (normalizeZoneName(zoneName) !== zoneName) throw new Error(`revision zone key ${zoneName} is not normalized`);
    return [zoneName, readZoneRevisions(zoneName, rawZoneRevisions)] as const;
  }));
}

function readZoneRevisions(zoneName: string, value: unknown): Record<string, ZoneRevision> {
  return Object.fromEntries(Object.entries(readObject(value, `revisions for ${zoneName}`))
    .map(([revisionKey, rawRevision]) => {
      const snapshot = readZoneSnapshot(rawRevision);
      if (snapshot.name !== zoneName || String(snapshot.revision) !== revisionKey) {
        throw new Error(`revision key ${zoneName}/${revisionKey} does not match its snapshot`);
      }
      return [revisionKey, snapshot] as const;
    }));
}

function readZoneSnapshot(value: unknown): Zone {
  const zone = readObject(value, "zone snapshot");
  const name = readString(zone.name, "zone name");
  if (normalizeZoneName(name) !== name) throw new Error("zone name is not normalized");
  const revision = readPositiveInteger(zone.revision, "zone revision");
  const createdAt = readTimestamp(zone.createdAt, "zone createdAt");
  const updatedAt = readTimestamp(zone.updatedAt, "zone updatedAt");
  if (!Array.isArray(zone.views)) throw new Error("zone views must be an array");
  const viewNames = new Set<string>();
  const views = zone.views.map((rawView, viewIndex) => {
    const view = readObject(rawView, `zone view ${viewIndex}`);
    const name = readPersistedViewName(readString(view.name, "view name"));
    if (viewNames.has(name)) throw new Error(`duplicate view ${name}`);
    viewNames.add(name);
    if (!Array.isArray(view.records)) throw new Error(`records for view ${name} must be an array`);
    const recordIds = new Set<string>();
    const records = view.records.map((rawRecord, recordIndex) => {
      const record = readObject(rawRecord, `record ${recordIndex}`);
      const id = readString(record.id, "record id");
      if (recordIds.has(id)) throw new Error(`duplicate record ${id}`);
      recordIds.add(id);
      // Reading, not accepting. A stored record that today's rules would refuse
      // stays readable so an operator can delete it; refusing here would take
      // the whole zone away instead.
      return createDesiredRecord(id, record, { rehydrate: true });
    });
    return { name, records };
  });
  assertPersistedDesiredViewsValid(views);
  return { name, revision, views, createdAt, updatedAt };
}

function readAuditEntry(value: unknown): AuditEntry {
  const audit = readObject(value, "audit entry");
  const action = readString(audit.action, "audit action");
  if (!AUDIT_ACTIONS.some((candidate) => candidate === action)) throw new Error(`unknown audit action ${action}`);
  const zone = readString(audit.zone, "audit zone");
  if (normalizeZoneName(zone) !== zone) throw new Error("audit zone is not normalized");
  const actor = readString(audit.actor, "audit actor");
  if (/[\u0000-\u001f\u007f]/u.test(actor)) throw new Error("audit actor contains control characters");
  const entry: AuditEntry = {
    id: readPositiveInteger(audit.id, "audit id"),
    zone,
    revision: readPositiveInteger(audit.revision, "audit revision"),
    action: action as AuditEntry["action"],
    actor,
    at: readTimestamp(audit.at, "audit timestamp"),
    detail: clone(readObject(audit.detail, "audit detail")),
  };
  for (const field of ["added", "removed", "changed"] as const) {
    if (audit[field] !== undefined) entry[field] = readNonNegativeInteger(audit[field], `audit ${field}`);
  }
  return entry;
}

function readApplyStatus(value: unknown): ApplyStatus {
  const raw = readObject(value, "apply status");
  const zone = readString(raw.zone, "status zone");
  if (normalizeZoneName(zone) !== zone) throw new Error("status zone is not normalized");
  const view = readPersistedViewName(readString(raw.view, "status view"));
  const state = readString(raw.state, "status state");
  if (state !== "pending" && state !== "applied" && state !== "failed") throw new Error(`unknown status state ${state}`);
  const status: ApplyStatus = {
    zone,
    view,
    desiredRevision: readNonNegativeInteger(raw.desiredRevision, "desired revision"),
    appliedRevision: readNonNegativeInteger(raw.appliedRevision, "applied revision"),
    state,
  };
  if (status.appliedRevision > status.desiredRevision) throw new Error("applied revision exceeds desired revision");
  if (raw.lastAttemptAt !== undefined) status.lastAttemptAt = readTimestamp(raw.lastAttemptAt, "last attempt timestamp");
  if (raw.error !== undefined) status.error = readString(raw.error, "status error");
  if (raw.completedOperations !== undefined) {
    status.completedOperations = readNonNegativeInteger(raw.completedOperations, "completed operations");
  }
  if (raw.plannedOperations !== undefined) {
    status.plannedOperations = readNonNegativeInteger(raw.plannedOperations, "planned operations");
  }
  if ((status.completedOperations === undefined) !== (status.plannedOperations === undefined)
    || (status.completedOperations ?? 0) > (status.plannedOperations ?? 0)) {
    throw new Error("invalid apply operation progress");
  }
  return status;
}

function readObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function readNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function readTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be an ISO timestamp`);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${field} must be an ISO timestamp`);
  return date.toISOString();
}
