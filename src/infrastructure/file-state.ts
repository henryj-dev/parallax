import { createHash, randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { mergeApplyStatus, RevisionConflictError, type ApplyLock, type ApplyStatus, type AuditRetentionPolicy, type DesiredChange, type PageRequest, type RetentionPolicy, type StatusRepository, type ZoneDeletion, type ZoneRepository } from "../application/ports.ts";
import { assertPersistedDesiredViewsValid } from "../application/control-plane.ts";
import { AUDIT_ACTIONS, createDesiredRecord, normalizeZoneName, readPersistedViewName, type AuditEntry, type Zone, type ZoneRevision } from "../domain/dns.ts";
import { ensurePrivateDirectory, withFileLock } from "./atomic-file.ts";

interface PersistedState {
  version: 1;
  zones: Record<string, Zone>;
  audit: AuditEntry[];
  statuses: Record<string, ApplyStatus>;
  revisions: Record<string, Record<string, ZoneRevision>>;
  nextAuditId: number;
}

/**
 * A dependency-free, durable repository for file-backed Parallax processes.
 *
 * A local queue and a cross-process file lock serialize zone/status changes;
 * every mutation re-reads under the lock and makes one atomic replacement.
 */
export class FileStateRepository implements ZoneRepository, StatusRepository {
  readonly #path: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error("state file path must not be empty");
    this.#path = path;
  }

  list(page?: PageRequest): Promise<Zone[]>;
  list(zone: string): Promise<ApplyStatus[]>;
  async list(zoneOrPage?: string | PageRequest): Promise<Zone[] | ApplyStatus[]> {
    const state = await this.#readState();
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
    const state = await this.#readState();
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
    await this.#mutate((state) => {
      if (isZone(value)) state.zones[value.name] = clone(value);
      else {
        const key = statusKey(value.zone, value.view);
        state.statuses[key] = mergeApplyStatus(state.statuses[key], clone(value));
      }
    });
  }

  async saveRevision(snapshot: ZoneRevision): Promise<void> {
    await this.#mutate((state) => {
      const revisions = state.revisions[snapshot.name] ?? {};
      const key = String(snapshot.revision);
      if (revisions[key]) throw new Error(`revision ${snapshot.revision} already exists for zone ${snapshot.name}`);
      revisions[key] = clone(snapshot);
      state.revisions[snapshot.name] = revisions;
      state.zones[snapshot.name] = clone(snapshot);
    });
  }

  async commitDesiredChange(change: DesiredChange): Promise<void> {
    await this.#mutate((state) => {
      const snapshot = clone(change.snapshot);
      const revisions = state.revisions[snapshot.name] ?? {};
      const key = String(snapshot.revision);
      const current = state.zones[snapshot.name];
      if (current && current.revision >= snapshot.revision) {
        throw new RevisionConflictError(`revision ${snapshot.revision} already exists or is stale for zone ${snapshot.name}`);
      }
      const entry: AuditEntry = clone({ ...change.audit, id: state.nextAuditId });
      const statuses = change.statuses.map(clone);

      revisions[key] = snapshot;
      state.revisions[snapshot.name] = revisions;
      state.zones[snapshot.name] = clone(snapshot);
      state.audit.push(entry);
      state.nextAuditId += 1;
      for (const status of statuses) state.statuses[statusKey(status.zone, status.view)] = status;
      applyRetention(state, snapshot.name, change.retention);
    });
  }

  async commitZoneDeletion(deletion: ZoneDeletion): Promise<void> {
    await this.#mutate((state) => {
      const current = state.zones[deletion.zone];
      if (!current || current.revision !== deletion.expectedRevision) {
        throw new RevisionConflictError(`expected revision ${deletion.expectedRevision} for zone ${deletion.zone}`);
      }
      const entry: AuditEntry = clone({ ...deletion.audit, id: state.nextAuditId });

      delete state.zones[deletion.zone];
      delete state.revisions[deletion.zone];
      for (const [key, status] of Object.entries(state.statuses)) {
        if (status.zone === deletion.zone) delete state.statuses[key];
      }
      state.audit.push(entry);
      state.nextAuditId += 1;
      applyRetention(state, deletion.zone, deletion.retention);
    });
  }

  async listRevisions(zone: string, page?: PageRequest): Promise<ZoneRevision[]> {
    const state = await this.#readState();
    const ascending = Object.values(state.revisions[zone] ?? {}).map(clone).sort((left, right) => left.revision - right.revision);
    if (!page) return ascending;
    const end = Math.max(0, ascending.length - page.offset);
    return ascending.slice(Math.max(0, end - page.limit), end);
  }

  async getRevision(zone: string, revision: number): Promise<ZoneRevision | undefined> {
    const state = await this.#readState();
    const snapshot = state.revisions[zone]?.[String(revision)];
    return snapshot ? clone(snapshot) : undefined;
  }

  async delete(name: string): Promise<void> {
    await this.#mutate((state) => {
      delete state.zones[name];
      delete state.revisions[name];
    });
  }

  async appendAudit(input: Omit<AuditEntry, "id">, retention?: AuditRetentionPolicy): Promise<AuditEntry> {
    return this.#mutate((state) => {
      const entry = clone({ ...input, id: state.nextAuditId });
      state.nextAuditId += 1;
      state.audit.push(entry);
      applyAuditRetention(state, input.zone, retention);
      return clone(entry);
    });
  }

  async audit(zone?: string, page?: PageRequest): Promise<AuditEntry[]> {
    const state = await this.#readState();
    const newestFirst = state.audit
      .filter((entry) => zone === undefined || entry.zone === zone)
      .map(clone)
      .sort((left, right) => right.id - left.id);
    return page ? newestFirst.slice(page.offset, page.offset + page.limit) : newestFirst;
  }

  async deleteZone(zone: string): Promise<void> {
    await this.#mutate((state) => {
      for (const [key, status] of Object.entries(state.statuses)) {
        if (status.zone === zone) delete state.statuses[key];
      }
    });
  }

  async #readState(): Promise<PersistedState> {
    await this.#writeTail;
    return this.#readFile();
  }

  #mutate<T>(operation: (state: PersistedState) => T): Promise<T> {
    const result = this.#writeTail.then(() => withFileLock(this.#path, async () => {
      // Always re-read after the cross-process lock is held. A cached snapshot
      // here turns a successful CLI/replica write into the next writer's loss.
      const draft = clone(await this.#readFile());
      const value = operation(draft);
      await this.#writeAtomically(draft);
      return value;
    }));
    this.#writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #readFile(): Promise<PersistedState> {
    await ensurePrivateDirectory(dirname(this.#path));
    let source: string;
    try {
      await chmod(this.#path, 0o600);
      source = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyState();
      throw error;
    }
    const parsed: unknown = JSON.parse(source);
    try {
      return readPersistedState(parsed);
    } catch (error) {
      throw new Error(`unsupported or invalid state file: ${this.#path}`, { cause: error });
    }
  }

  async #writeAtomically(state: PersistedState): Promise<void> {
    const directory = dirname(this.#path);
    await ensurePrivateDirectory(directory);
    const temporaryPath = join(directory, `.${basename(this.#path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      // Flush the replacement and the directory entry so a crash after this
      // call cannot leave a truncated or missing state file behind.
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.#path);
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
class FileApplyLock implements ApplyLock {
  readonly #statePath: string;
  constructor(statePath: string) { this.#statePath = statePath; }

  withZoneLock<T>(zone: string, operation: () => Promise<T>): Promise<T> {
    const key = createHash("sha256").update(zone, "utf8").digest("hex");
    return withFileLock(`${this.#statePath}.zone-${key}`, operation);
  }
}

/** Trims a single zone's history in the same replacement as the change itself. */
function applyRetention(state: PersistedState, zone: string, retention: RetentionPolicy | undefined): void {
  if (!retention) return;
  const maxRevisions = retention.maxRevisionsPerZone ?? 0;
  if (maxRevisions > 0) {
    const revisions = state.revisions[zone];
    if (revisions) {
      const keep = Object.keys(revisions)
        .map(Number)
        .sort((left, right) => right - left)
        .slice(0, maxRevisions);
      state.revisions[zone] = Object.fromEntries(keep.map((revision) => [String(revision), revisions[String(revision)] as ZoneRevision]));
    }
  }
  applyAuditRetention(state, zone, retention);
}

function applyAuditRetention(state: PersistedState, zone: string, retention: AuditRetentionPolicy | undefined): void {
  const before = retention?.deleteAuditBefore;
  if (before) state.audit = state.audit.filter((entry) => entry.zone !== zone || entry.at >= before);
}

function emptyState(): PersistedState {
  return { version: 1, zones: {}, audit: [], statuses: {}, revisions: {}, nextAuditId: 1 };
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

function readPersistedState(value: unknown): PersistedState {
  const candidate = readObject(value, "state document");
  if (candidate.version !== 1) throw new Error("unsupported state document version");

  const rawZones = readObject(candidate.zones, "zones");
  const zoneEntries = Object.entries(rawZones).map(([key, rawZone]) => {
    const zone = readZoneSnapshot(rawZone);
    if (zone.name !== key) throw new Error(`zone key ${key} does not match snapshot name ${zone.name}`);
    return [key, zone] as const;
  });
  const zones = Object.fromEntries(zoneEntries);

  if (!Array.isArray(candidate.audit)) throw new Error("audit must be an array");
  const audit = candidate.audit.map(readAuditEntry);
  const auditIds = new Set(audit.map((entry) => entry.id));
  if (auditIds.size !== audit.length) throw new Error("audit ids must be unique");

  const rawStatuses = readObject(candidate.statuses, "statuses");
  const statusEntries = Object.entries(rawStatuses).map(([key, rawStatus]) => {
    const status = readApplyStatus(rawStatus);
    if (statusKey(status.zone, status.view) !== key) throw new Error("status key does not match its zone and view");
    return [key, status] as const;
  });
  const statuses = Object.fromEntries(statusEntries);

  const revisions = candidate.revisions === undefined
    ? Object.fromEntries(zoneEntries.map(([name, zone]) => [name, { [String(zone.revision)]: clone(zone) }]))
    : readRevisionMap(candidate.revisions);
  const nextAuditId = readPositiveInteger(candidate.nextAuditId, "nextAuditId");
  const greatestAuditId = audit.reduce((greatest, entry) => Math.max(greatest, entry.id), 0);
  if (nextAuditId <= greatestAuditId) throw new Error("nextAuditId must be greater than every stored audit id");

  return { version: 1, zones, audit, statuses, revisions, nextAuditId };
}

function readRevisionMap(value: unknown): Record<string, Record<string, ZoneRevision>> {
  const rawRevisions = readObject(value, "revisions");
  return Object.fromEntries(Object.entries(rawRevisions).map(([zoneName, rawZoneRevisions]) => {
    if (normalizeZoneName(zoneName) !== zoneName) throw new Error(`revision zone key ${zoneName} is not normalized`);
    const revisions = Object.fromEntries(Object.entries(readObject(rawZoneRevisions, `revisions for ${zoneName}`))
      .map(([revisionKey, rawRevision]) => {
        const snapshot = readZoneSnapshot(rawRevision);
        if (snapshot.name !== zoneName || String(snapshot.revision) !== revisionKey) {
          throw new Error(`revision key ${zoneName}/${revisionKey} does not match its snapshot`);
        }
        return [revisionKey, snapshot] as const;
      }));
    return [zoneName, revisions] as const;
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
      return createDesiredRecord(id, record);
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
