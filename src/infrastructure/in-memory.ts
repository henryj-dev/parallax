import type { AuditEntry, Zone, ZoneRevision } from "../domain/dns.ts";
import type { ProviderRecord, ReconcileOperation } from "../domain/reconciliation.ts";
import { RevisionConflictError, type ApplyLock, type ApplyStatus, type DesiredChange, type PageRequest, type ProviderAdapter, type RetentionPolicy, type StatusRepository, type ZoneDeletion, type ZoneRepository } from "../application/ports.ts";

export class InMemoryApplyLock implements ApplyLock {
  readonly #tails = new Map<string, Promise<void>>();

  async withZoneLock<T>(zone: string, operation: () => Promise<T>): Promise<T> {
    const preceding = this.#tails.get(zone) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#tails.set(zone, current);
    await preceding;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(zone) === current) this.#tails.delete(zone);
    }
  }
}

export class InMemoryZoneRepository implements ZoneRepository, StatusRepository {
  readonly #zones = new Map<string, Zone>();
  readonly #audit: AuditEntry[] = [];
  readonly #revisions = new Map<string, Map<number, ZoneRevision>>();
  readonly #statuses = new Map<string, ApplyStatus>();
  #nextAuditId = 1;

  list(): Promise<Zone[]>;
  list(zone: string): Promise<ApplyStatus[]>;
  async list(zone?: string): Promise<Zone[] | ApplyStatus[]> {
    if (zone !== undefined) {
      return [...this.#statuses.values()].filter((status) => status.zone === zone)
        .map((status) => ({ ...status })).sort((left, right) => left.view.localeCompare(right.view));
    }
    return [...this.#zones.values()].map(cloneZone).sort((left, right) => left.name.localeCompare(right.name));
  }

  get(name: string): Promise<Zone | undefined>;
  get(zone: string, view: string): Promise<ApplyStatus | undefined>;
  async get(name: string, view?: string): Promise<Zone | ApplyStatus | undefined> {
    if (view !== undefined) {
      const status = this.#statuses.get(key(name, view));
      return status ? { ...status } : undefined;
    }
    const zone = this.#zones.get(name);
    return zone ? cloneZone(zone) : undefined;
  }

  save(zone: Zone): Promise<void>;
  save(status: ApplyStatus): Promise<void>;
  async save(value: Zone | ApplyStatus): Promise<void> {
    if ("views" in value) this.#zones.set(value.name, cloneZone(value));
    else {
      const existing = this.#statuses.get(key(value.zone, value.view));
      if (!existing || existing.desiredRevision <= value.desiredRevision) {
        this.#statuses.set(key(value.zone, value.view), { ...value });
      }
    }
  }

  async saveRevision(snapshot: ZoneRevision): Promise<void> {
    const revisions = this.#revisions.get(snapshot.name) ?? new Map<number, ZoneRevision>();
    if (revisions.has(snapshot.revision)) throw new Error(`revision ${snapshot.revision} already exists for zone ${snapshot.name}`);
    revisions.set(snapshot.revision, cloneZone(snapshot));
    this.#revisions.set(snapshot.name, revisions);
    this.#zones.set(snapshot.name, cloneZone(snapshot));
  }

  async commitDesiredChange(change: DesiredChange): Promise<void> {
    const snapshot = cloneZone(change.snapshot);
    const revisions = this.#revisions.get(snapshot.name) ?? new Map<number, ZoneRevision>();
    const current = this.#zones.get(snapshot.name);
    if (current && current.revision >= snapshot.revision) {
      throw new RevisionConflictError(`revision ${snapshot.revision} already exists or is stale for zone ${snapshot.name}`);
    }

    // Validate and clone the complete change before mutating any live collection.
    const audit: AuditEntry = structuredClone({ ...change.audit, id: this.#nextAuditId });
    const statuses = change.statuses.map((status) => ({ ...status }));
    revisions.set(snapshot.revision, cloneZone(snapshot));
    this.#revisions.set(snapshot.name, revisions);
    this.#zones.set(snapshot.name, snapshot);
    this.#audit.push(audit);
    this.#nextAuditId += 1;
    for (const status of statuses) this.#statuses.set(key(status.zone, status.view), status);
    this.#applyRetention(snapshot.name, change.retention);
  }

  async commitZoneDeletion(deletion: ZoneDeletion): Promise<void> {
    const current = this.#zones.get(deletion.zone);
    if (!current || current.revision !== deletion.expectedRevision) {
      throw new RevisionConflictError(`expected revision ${deletion.expectedRevision} for zone ${deletion.zone}`);
    }

    // Clone all new values before mutating live collections so clone failures cannot
    // leave a false deletion audit entry or partially removed state.
    const audit: AuditEntry = structuredClone({ ...deletion.audit, id: this.#nextAuditId });
    this.#zones.delete(deletion.zone);
    this.#revisions.delete(deletion.zone);
    for (const [statusKey, status] of this.#statuses) {
      if (status.zone === deletion.zone) this.#statuses.delete(statusKey);
    }
    this.#audit.push(audit);
    this.#nextAuditId += 1;
    this.#applyRetention(deletion.zone, deletion.retention);
  }

  #applyRetention(zone: string, retention: RetentionPolicy | undefined): void {
    if (!retention) return;
    const maxRevisions = retention.maxRevisionsPerZone ?? 0;
    const revisions = this.#revisions.get(zone);
    if (maxRevisions > 0 && revisions) {
      const drop = [...revisions.keys()].sort((left, right) => right - left).slice(maxRevisions);
      for (const revision of drop) revisions.delete(revision);
    }
    const before = retention.deleteAuditBefore;
    if (!before) return;
    for (let index = this.#audit.length - 1; index >= 0; index -= 1) {
      const entry = this.#audit[index];
      if (entry && entry.zone === zone && entry.at < before) this.#audit.splice(index, 1);
    }
  }

  async listRevisions(zone: string, page?: PageRequest): Promise<ZoneRevision[]> {
    const ascending = [...(this.#revisions.get(zone)?.values() ?? [])]
      .map(cloneZone)
      .sort((left, right) => left.revision - right.revision);
    if (!page) return ascending;
    const end = Math.max(0, ascending.length - page.offset);
    return ascending.slice(Math.max(0, end - page.limit), end);
  }

  async getRevision(zone: string, revision: number): Promise<ZoneRevision | undefined> {
    const snapshot = this.#revisions.get(zone)?.get(revision);
    return snapshot ? cloneZone(snapshot) : undefined;
  }

  async delete(name: string): Promise<void> {
    this.#zones.delete(name);
    this.#revisions.delete(name);
  }

  async appendAudit(input: Omit<AuditEntry, "id">): Promise<AuditEntry> {
    const entry: AuditEntry = structuredClone({ ...input, id: this.#nextAuditId++ });
    this.#audit.push(entry);
    return structuredClone(entry);
  }

  async audit(zone?: string, page?: PageRequest): Promise<AuditEntry[]> {
    const newestFirst = this.#audit
      .filter((entry) => !zone || entry.zone === zone)
      .map((entry) => structuredClone(entry))
      .sort((left, right) => right.id - left.id);
    return page ? newestFirst.slice(page.offset, page.offset + page.limit) : newestFirst;
  }

  async deleteZone(zone: string): Promise<void> {
    for (const [statusKey, status] of this.#statuses) {
      if (status.zone === zone) this.#statuses.delete(statusKey);
    }
  }
}

export class InMemoryStatusRepository implements StatusRepository {
  readonly #statuses = new Map<string, ApplyStatus>();

  async get(zone: string, view: string): Promise<ApplyStatus | undefined> {
    const status = this.#statuses.get(key(zone, view));
    return status ? { ...status } : undefined;
  }

  async list(zone: string): Promise<ApplyStatus[]> {
    return [...this.#statuses.values()]
      .filter((status) => status.zone === zone)
      .map((status) => ({ ...status }))
      .sort((left, right) => left.view.localeCompare(right.view));
  }

  async save(status: ApplyStatus): Promise<void> {
    const existing = this.#statuses.get(key(status.zone, status.view));
    if (!existing || existing.desiredRevision <= status.desiredRevision) {
      this.#statuses.set(key(status.zone, status.view), { ...status });
    }
  }

  async deleteZone(zone: string): Promise<void> {
    for (const [statusKey, status] of this.#statuses) {
      if (status.zone === zone) this.#statuses.delete(statusKey);
    }
  }
}

export class InMemoryProvider implements ProviderAdapter {
  readonly #records = new Map<string, ProviderRecord[]>();
  readonly calls: Array<{ target: string; operation: ReconcileOperation }> = [];
  #nextId = 1;
  failure?: Error;
  listFailure?: Error;

  async list(target: string): Promise<ProviderRecord[]> {
    if (this.listFailure) throw this.listFailure;
    return (this.#records.get(target) ?? []).map((record) => ({ ...record }));
  }

  async apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> {
    if (this.failure) throw this.failure;
    const records = (this.#records.get(target) ?? []).map((record) => ({ ...record }));
    this.calls.push({ target, operation: structuredClone(operation) });
    if (operation.kind === "create") {
      records.push({ ...operation.desired, providerId: `managed-${this.#nextId++}`, managed: true });
    } else if (operation.kind === "update") {
      const index = records.findIndex((record) => record.providerId === operation.providerId);
      if (index < 0) throw new Error(`provider record ${operation.providerId} does not exist`);
      records[index] = { ...operation.desired, providerId: operation.providerId, managed: true };
    } else {
      const index = records.findIndex((record) => record.providerId === operation.providerId);
      if (index < 0) throw new Error(`provider record ${operation.providerId} does not exist`);
      records.splice(index, 1);
    }
    this.#records.set(target, records);
  }

  seed(target: string, records: ProviderRecord[]): void {
    this.#records.set(target, records.map((record) => ({ ...record })));
  }
}

export function createInMemoryAdapters(): {
  zones: InMemoryZoneRepository;
  statuses: InMemoryZoneRepository;
  provider: InMemoryProvider;
  applyLock: InMemoryApplyLock;
} {
  const state = new InMemoryZoneRepository();
  return { zones: state, statuses: state, provider: new InMemoryProvider(), applyLock: new InMemoryApplyLock() };
}

function key(zone: string, view: string): string {
  return `${zone}\u0000${view}`;
}

function cloneZone(zone: Zone): Zone {
  return structuredClone(zone);
}
