import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { RevisionConflictError, type ApplyStatus, type DesiredChange, type PageRequest, type StatusRepository, type ZoneDeletion, type ZoneRepository } from "../application/ports.ts";
import type { AuditEntry, Zone, ZoneRevision } from "../domain/dns.ts";
import { InMemoryApplyLock } from "./in-memory.ts";

interface PersistedState {
  version: 1;
  zones: Record<string, Zone>;
  audit: AuditEntry[];
  statuses: Record<string, ApplyStatus>;
  revisions: Record<string, Record<string, ZoneRevision>>;
  nextAuditId: number;
}

/**
 * A dependency-free, durable repository for a single Parallax process.
 *
 * Zone and apply-status changes share one serialized write queue so every
 * successful method call is represented by one atomic replacement of the
 * state file.
 */
export class FileStateRepository implements ZoneRepository, StatusRepository {
  readonly #path: string;
  #state: PersistedState | undefined;
  #loadPromise: Promise<PersistedState> | undefined;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error("state file path must not be empty");
    this.#path = path;
  }

  list(): Promise<Zone[]>;
  list(zone: string): Promise<ApplyStatus[]>;
  async list(zone?: string): Promise<Zone[] | ApplyStatus[]> {
    const state = await this.#readState();
    if (zone !== undefined) {
      return Object.values(state.statuses)
        .filter((status) => status.zone === zone)
        .map(clone)
        .sort((left, right) => left.view.localeCompare(right.view));
    }
    return Object.values(state.zones).map(clone).sort((left, right) => left.name.localeCompare(right.name));
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
        const existing = state.statuses[statusKey(value.zone, value.view)];
        if (!existing || existing.desiredRevision <= value.desiredRevision) {
          state.statuses[statusKey(value.zone, value.view)] = clone(value);
        }
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

  async appendAudit(input: Omit<AuditEntry, "id">): Promise<AuditEntry> {
    return this.#mutate((state) => {
      const entry = clone({ ...input, id: state.nextAuditId });
      state.nextAuditId += 1;
      state.audit.push(entry);
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
    return this.#load();
  }

  #mutate<T>(operation: (state: PersistedState) => T): Promise<T> {
    const result = this.#writeTail.then(async () => {
      const draft = clone(await this.#load());
      const value = operation(draft);
      await this.#writeAtomically(draft);
      this.#state = draft;
      return value;
    });
    this.#writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #load(): Promise<PersistedState> {
    if (this.#state) return Promise.resolve(this.#state);
    if (!this.#loadPromise) {
      this.#loadPromise = this.#readFile().then((state) => {
        this.#state = state;
        return state;
      }).catch((error: unknown) => {
        this.#loadPromise = undefined;
        throw error;
      });
    }
    return this.#loadPromise;
  }

  async #readFile(): Promise<PersistedState> {
    let source: string;
    try {
      source = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyState();
      throw error;
    }
    const parsed: unknown = JSON.parse(source);
    if (!isPersistedState(parsed)) throw new Error(`unsupported or invalid state file: ${this.#path}`);
    return clone(parsed);
  }

  async #writeAtomically(state: PersistedState): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true });
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
  applyLock: InMemoryApplyLock;
} {
  const repository = new FileStateRepository(path);
  // This backend is intentionally single-process. The shared per-zone lock
  // coordinates ControlPlane instances from this bundle; multi-host
  // deployments must use PostgreSQL for cross-process apply coordination.
  return { zones: repository, statuses: repository, applyLock: new InMemoryApplyLock() };
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

function isPersistedState(value: unknown): value is PersistedState {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedState>;
  if (candidate.version !== 1
    || candidate.zones === null || typeof candidate.zones !== "object" || Array.isArray(candidate.zones)
    || !Array.isArray(candidate.audit)
    || candidate.statuses === null || typeof candidate.statuses !== "object" || Array.isArray(candidate.statuses)
    || typeof candidate.nextAuditId !== "number" || !Number.isSafeInteger(candidate.nextAuditId) || candidate.nextAuditId < 1) return false;
  if (candidate.revisions === undefined) {
    candidate.revisions = Object.fromEntries(Object.values(candidate.zones).map((zone) => {
      const snapshot = zone as Zone;
      return [snapshot.name, { [String(snapshot.revision)]: clone(snapshot) }];
    }));
  }
  return candidate.revisions !== null && typeof candidate.revisions === "object" && !Array.isArray(candidate.revisions);
}
