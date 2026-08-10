import {
  createDesiredRecord,
  concreteDnsTtl,
  DomainValidationError,
  normalizeExternalRecords,
  normalizeZoneName,
  validateExternalRecords,
  validateViewName,
  type AuditEntry,
  type DesiredRecord,
  type Zone,
  type ZoneRevision,
} from "../domain/dns.ts";
import { buildReconcilePlan, type ReconcilePlan } from "../domain/reconciliation.ts";
import { RevisionConflictError, type ApplyLock, type ApplyStatus, type ProviderAdapter, type StatusRepository, type ZoneRepository } from "./ports.ts";

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export interface Clock {
  now(): Date;
}

export class ControlPlane {
  readonly #zones: ZoneRepository;
  readonly #statuses: StatusRepository;
  readonly #provider: ProviderAdapter;
  readonly #clock: Clock;
  readonly #applyLock: ApplyLock;
  readonly #operationTails = new Map<string, Promise<void>>();

  constructor(
    zones: ZoneRepository,
    statuses: StatusRepository,
    provider: ProviderAdapter,
    clock: Clock = { now: () => new Date() },
    applyLock: ApplyLock = { withZoneLock: (_zone, operation) => operation() },
  ) {
    this.#zones = zones;
    this.#statuses = statuses;
    this.#provider = provider;
    this.#clock = clock;
    this.#applyLock = applyLock;
  }

  listZones(): Promise<Zone[]> {
    return this.#zones.list();
  }

  async getZone(zoneName: string): Promise<Zone> {
    const name = normalizeZoneName(zoneName);
    const zone = await this.#zones.get(name);
    if (!zone) throw new NotFoundError(`zone ${name} was not found`);
    return zone;
  }

  createZone(zoneName: string, actor = "system"): Promise<Zone> {
    return this.#exclusive(zoneName, () => this.#createZone(zoneName, actor));
  }

  async #createZone(zoneName: string, actor: string): Promise<Zone> {
    const name = normalizeZoneName(zoneName);
    if (await this.#zones.get(name)) throw new ConflictError(`zone ${name} already exists`);
    const at = this.#clock.now().toISOString();
    const zone: Zone = { name, revision: 1, views: [], createdAt: at, updatedAt: at };
    await this.#commitDesiredChange(undefined, zone, "zone.created", actor, {}, []);
    return zone;
  }

  deleteZone(zoneName: string, actor = "system", expectedRevision?: number): Promise<void> {
    return this.#exclusive(zoneName, () => this.#deleteZone(zoneName, actor, expectedRevision));
  }

  async #deleteZone(zoneName: string, actor: string, expectedRevision?: number): Promise<void> {
    const zone = await this.getZone(zoneName);
    this.#assertExpectedRevision(zone, expectedRevision);
    const revision = zone.revision + 1;
    try {
      await this.#zones.commitZoneDeletion({
        zone: zone.name,
        expectedRevision: zone.revision,
        audit: {
          zone: zone.name,
          revision,
          action: "zone.deleted",
          actor,
          at: this.#clock.now().toISOString(),
          detail: { before: desiredState(zone), after: null },
        },
      });
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error;
      const current = await this.#zones.get(zone.name);
      if (expectedRevision !== undefined && current) {
        throw new ConflictError(`expected revision ${expectedRevision} for zone ${zone.name}, but the current revision is ${current.revision}`);
      }
      throw new ConflictError(`zone ${zone.name} changed while it was being deleted`);
    }
  }

  upsertRecord(zoneName: string, viewName: string, id: string, input: unknown, actor = "system", expectedRevision?: number): Promise<Zone> {
    return this.#exclusive(zoneName, () => this.#upsertRecord(zoneName, viewName, id, input, actor, expectedRevision));
  }

  async #upsertRecord(zoneName: string, viewName: string, id: string, input: unknown, actor: string, expectedRevision?: number): Promise<Zone> {
    const zone = await this.getZone(zoneName);
    this.#assertExpectedRevision(zone, expectedRevision);
    const view = validateViewName(viewName);
    let record = createDesiredRecord(id, input);
    if (view === "external") [record] = normalizeExternalRecords([record]) as [DesiredRecord];
    const views = zone.views.map(cloneView);
    let target = views.find((candidate) => candidate.name === view);
    if (!target) {
      target = { name: view, records: [] };
      views.push(target);
    }
    const existingIndex = target.records.findIndex((candidate) => candidate.id === record.id);
    if (existingIndex >= 0) target.records[existingIndex] = record;
    else target.records.push(record);
    ensureUniqueRecordKeys(target.records);
    if (view === "external") validateExternalRecords(target.records);
    target.records.sort((left, right) => left.id.localeCompare(right.id));
    views.sort((left, right) => left.name.localeCompare(right.name));
    materializeProviderViews(views);
    const updated = this.#nextRevision(zone, views);
    await this.#commitDesiredChange(zone, updated, "record.upserted", actor, { view, record }, [view], expectedRevision);
    return updated;
  }

  deleteRecord(zoneName: string, viewName: string, id: string, actor = "system", expectedRevision?: number): Promise<Zone> {
    return this.#exclusive(zoneName, () => this.#deleteRecord(zoneName, viewName, id, actor, expectedRevision));
  }

  async #deleteRecord(zoneName: string, viewName: string, id: string, actor: string, expectedRevision?: number): Promise<Zone> {
    const zone = await this.getZone(zoneName);
    this.#assertExpectedRevision(zone, expectedRevision);
    const view = validateViewName(viewName);
    const views = zone.views.map(cloneView);
    const target = views.find((candidate) => candidate.name === view);
    const record = target?.records.find((candidate) => candidate.id === id);
    if (!target || !record) throw new NotFoundError(`record ${id} was not found in view ${view}`);
    target.records = target.records.filter((candidate) => candidate.id !== id);
    materializeProviderViews(views);
    const updated = this.#nextRevision(zone, views);
    await this.#commitDesiredChange(zone, updated, "record.deleted", actor, { view, record }, [view], expectedRevision);
    return updated;
  }

  replaceDesiredState(zoneName: string, input: unknown, actor = "system", expectedRevision?: number): Promise<Zone> {
    return this.#exclusive(zoneName, () => this.#replaceDesiredState(zoneName, input, actor, expectedRevision));
  }

  async #replaceDesiredState(zoneName: string, input: unknown, actor: string, expectedRevision?: number): Promise<Zone> {
    const zone = await this.getZone(zoneName);
    this.#assertExpectedRevision(zone, expectedRevision);
    const views = parseDesiredViews(input);
    materializeProviderViews(views);
    const updated = this.#nextRevision(zone, views);
    const affected = new Set([...zone.views.map((view) => view.name), ...views.map((view) => view.name)]);
    await this.#commitDesiredChange(zone, updated, "desired.replaced", actor, {}, affected, expectedRevision);
    return updated;
  }

  async listRevisions(zoneName: string): Promise<ZoneRevision[]> {
    const zone = await this.getZone(zoneName);
    return this.#zones.listRevisions(zone.name);
  }

  async getRevision(zoneName: string, revision: number): Promise<ZoneRevision> {
    const zone = await this.getZone(zoneName);
    const validRevision = validateRevision(revision);
    const snapshot = await this.#zones.getRevision(zone.name, validRevision);
    if (!snapshot) throw new NotFoundError(`revision ${validRevision} was not found for zone ${zone.name}`);
    return snapshot;
  }

  restoreRevision(zoneName: string, revision: number, actor = "system", expectedRevision?: number): Promise<Zone> {
    return this.#exclusive(zoneName, () => this.#restoreRevision(zoneName, revision, actor, expectedRevision));
  }

  async #restoreRevision(zoneName: string, revision: number, actor: string, expectedRevision?: number): Promise<Zone> {
    const zone = await this.getZone(zoneName);
    this.#assertExpectedRevision(zone, expectedRevision);
    const validRevision = validateRevision(revision);
    const snapshot = await this.#zones.getRevision(zone.name, validRevision);
    if (!snapshot) throw new NotFoundError(`revision ${validRevision} was not found for zone ${zone.name}`);
    validateExternalView(snapshot.views);
    const restoredViews = snapshot.views.map(cloneView);
    const restoredExternal = restoredViews.find((view) => view.name === "external");
    if (restoredExternal) restoredExternal.records = normalizeExternalRecords(restoredExternal.records);
    const updated = this.#nextRevision(zone, restoredViews);
    materializeProviderViews(updated.views);
    const affected = new Set([...zone.views.map((view) => view.name), ...updated.views.map((view) => view.name)]);
    await this.#commitDesiredChange(zone, updated, "desired.restored", actor, { restoredRevision: validRevision }, affected, expectedRevision);
    return updated;
  }

  async preview(zoneName: string, viewName?: string, desiredInput?: unknown): Promise<{ zone: string; revision: number; views: Record<string, ReconcilePlan> }> {
    const zone = await this.getZone(zoneName);
    const candidateViews = desiredInput === undefined ? zone.views : parseDesiredViews(desiredInput);
    validateExternalView(candidateViews);
    const effectiveViews = materializeProviderViews(candidateViews);
    const selected = viewName ? [findView(effectiveViews, validateViewName(viewName))] : effectiveViews;
    const views: Record<string, ReconcilePlan> = {};
    for (const view of selected) {
      const actual = await this.#provider.list(targetKey(zone.name, view.name));
      views[view.name] = buildReconcilePlan(view.records, actual);
    }
    return { zone: zone.name, revision: zone.revision, views };
  }

  apply(zoneName: string, viewName?: string, expectedRevision?: number): Promise<{ zone: string; revision: number; statuses: ApplyStatus[] }> {
    return this.#exclusive(zoneName, () => {
      const zone = normalizeZoneName(zoneName);
      return this.#applyLock.withZoneLock(zone, () => this.#apply(zone, viewName, expectedRevision));
    });
  }

  async #apply(zoneName: string, viewName?: string, expectedRevision?: number): Promise<{ zone: string; revision: number; statuses: ApplyStatus[] }> {
    const zone = await this.getZone(zoneName);
    this.#assertExpectedRevision(zone, expectedRevision);
    validateExternalView(zone.views);
    const storedStatuses = await this.#statuses.list(zone.name);
    const removedPendingViews = storedStatuses
      .filter((status) => !zone.views.some((view) => view.name === status.view) && status.desiredRevision === zone.revision && status.state !== "applied")
      .map((status) => ({ name: status.view, records: [] as DesiredRecord[] }));
    const availableViews = mergeRemovedViews(materializeProviderViews(zone.views), removedPendingViews);
    const selected = viewName ? [findView(availableViews, validateViewName(viewName))] : availableViews;
    const results: ApplyStatus[] = [];
    for (const view of selected) {
      const key = targetKey(zone.name, view.name);
      const attemptedAt = this.#clock.now().toISOString();
      try {
        const plan = buildReconcilePlan(view.records, await this.#provider.list(key));
        if (plan.summary.conflict > 0) throw new ConflictError("unmanaged provider records conflict with desired state");
        for (const operation of plan.operations) {
          if (operation.kind !== "conflict") await this.#provider.apply(key, operation);
        }
        const status: ApplyStatus = {
          zone: zone.name,
          view: view.name,
          desiredRevision: zone.revision,
          appliedRevision: zone.revision,
          state: "applied",
          lastAttemptAt: attemptedAt,
        };
        await this.#statuses.save(status);
        results.push(status);
      } catch (error) {
        const publicError = error instanceof ConflictError ? error.message : "provider operation failed";
        if (!(error instanceof ConflictError)) {
          console.error("provider operation failed", { zone: zone.name, view: view.name, errorName: error instanceof Error ? error.name : "unknown" });
        }
        const status: ApplyStatus = {
          zone: zone.name,
          view: view.name,
          desiredRevision: zone.revision,
          appliedRevision: (await this.#statuses.get(zone.name, view.name))?.appliedRevision ?? 0,
          state: "failed",
          lastAttemptAt: attemptedAt,
          error: publicError,
        };
        await this.#statuses.save(status);
        results.push(status);
      }
    }
    return { zone: zone.name, revision: zone.revision, statuses: results };
  }

  async status(zoneName: string): Promise<{ zone: string; desiredRevision: number; statuses: ApplyStatus[] }> {
    const zone = await this.getZone(zoneName);
    const stored = await this.#statuses.list(zone.name);
    const effectiveViews = materializeProviderViews(zone.views);
    const statuses: ApplyStatus[] = stored.filter((status) =>
      !effectiveViews.some((view) => view.name === status.view)
      && status.desiredRevision === zone.revision
      && (status.state !== "applied" || status.appliedRevision !== zone.revision),
    ).map((status) => status.state === "applied" ? pendingForRevision(status, zone.revision) : status);
    for (const view of effectiveViews) {
      const current = stored.find((status) => status.view === view.name);
      const coherent = current?.desiredRevision === zone.revision
        && (current.state !== "applied" || current.appliedRevision === zone.revision);
      statuses.push(coherent ? current : pendingForRevision(current ?? {
        zone: zone.name, view: view.name, desiredRevision: 0, appliedRevision: 0, state: "pending",
      }, zone.revision));
    }
    return { zone: zone.name, desiredRevision: zone.revision, statuses };
  }

  audit(zoneName?: string): Promise<AuditEntry[]> {
    return this.#zones.audit(zoneName ? normalizeZoneName(zoneName) : undefined);
  }

  #nextRevision(zone: Zone, views: Zone["views"]): Zone {
    return { ...zone, revision: zone.revision + 1, views, updatedAt: this.#clock.now().toISOString() };
  }

  #assertExpectedRevision(zone: Zone, expectedRevision: number | undefined): void {
    if (expectedRevision !== undefined && zone.revision !== expectedRevision) {
      throw new ConflictError(`expected revision ${expectedRevision} for zone ${zone.name}, but the current revision is ${zone.revision}`);
    }
  }

  async #commitDesiredChange(
    before: Zone | undefined,
    zone: Zone,
    action: AuditEntry["action"],
    actor: string,
    metadata: Record<string, unknown>,
    affectedViews: Iterable<string>,
    expectedRevision?: number,
  ): Promise<void> {
    const expandedViews = new Set(affectedViews);
    if (expandedViews.has("external")) expandedViews.add("internal");
    const statuses: ApplyStatus[] = [];
    for (const view of expandedViews) statuses.push(await this.#pendingStatus(zone, view));
    try {
      await this.#zones.commitDesiredChange({
        snapshot: zone,
        audit: {
          zone: zone.name,
          revision: zone.revision,
          action,
          actor,
          at: this.#clock.now().toISOString(),
          detail: {
            ...metadata,
            before: before ? desiredState(before) : null,
            after: desiredState(zone),
          },
        },
        statuses,
      });
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error;
      const current = await this.#zones.get(zone.name);
      if (expectedRevision !== undefined && current) {
        throw new ConflictError(`expected revision ${expectedRevision} for zone ${zone.name}, but the current revision is ${current.revision}`);
      }
      throw new ConflictError(`zone ${zone.name} changed while the desired state was being saved`);
    }
  }

  #findView(zone: Zone, viewName: string): Zone["views"][number] {
    const view = zone.views.find((candidate) => candidate.name === viewName);
    if (!view) throw new NotFoundError(`view ${viewName} was not found`);
    return view;
  }

  async #pendingStatus(zone: Zone, view: string): Promise<ApplyStatus> {
    const current = await this.#statuses.get(zone.name, view);
    return {
      zone: zone.name,
      view,
      desiredRevision: zone.revision,
      appliedRevision: Math.min(current?.appliedRevision ?? 0, Math.max(0, zone.revision - 1)),
      state: "pending",
      ...(current?.lastAttemptAt ? { lastAttemptAt: current.lastAttemptAt } : {}),
    };
  }

  async #exclusive<T>(zoneName: string, operation: () => Promise<T>): Promise<T> {
    const key = normalizeZoneName(zoneName);
    const preceding = this.#operationTails.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#operationTails.set(key, current);
    await preceding;
    try {
      return await operation();
    } finally {
      release();
      if (this.#operationTails.get(key) === current) this.#operationTails.delete(key);
    }
  }
}

function targetKey(zone: string, view: string): string {
  return `${zone}/${view}`;
}

function cloneView(view: Zone["views"][number]): Zone["views"][number] {
  return { name: view.name, records: view.records.map((record) => ({ ...record })) };
}

function desiredState(zone: Zone): { views: Zone["views"] } {
  return { views: zone.views.map(cloneView) };
}

function pendingForRevision(status: ApplyStatus, desiredRevision: number): ApplyStatus {
  return {
    zone: status.zone,
    view: status.view,
    desiredRevision,
    appliedRevision: Math.min(status.appliedRevision, Math.max(0, desiredRevision - 1)),
    state: "pending",
  };
}

function ensureUniqueRecordKeys(records: DesiredRecord[]): void {
  const seenValues = new Map<string, string>();
  const seenIds = new Set<string>();
  const byName = new Map<string, DesiredRecord[]>();
  for (const record of records) {
    if (seenIds.has(record.id)) throw new DomainValidationError([`record id ${record.id} is used more than once in the same view`]);
    seenIds.add(record.id);
    const key = `${record.name}\u0000${record.type}\u0000${record.content}`;
    const previous = seenValues.get(key);
    if (previous && previous !== record.id) {
      throw new DomainValidationError([`records ${previous} and ${record.id} have duplicate normalized content in the same name and type RRset`]);
    }
    seenValues.set(key, record.id);
    const siblings = byName.get(record.name) ?? [];
    siblings.push(record);
    byName.set(record.name, siblings);
  }
  for (const [name, siblings] of byName) {
    if (siblings.length > 1 && siblings.some((record) => record.type === "CNAME")) {
      throw new DomainValidationError([`CNAME record at ${name} cannot coexist with another record`]);
    }
  }
}

/** Builds the complete internal view from the external baseline and sparse internal overrides. */
export function materializeProviderViews(views: Zone["views"]): Zone["views"] {
  const external = views.find((view) => view.name === "external");
  const overrides = views.find((view) => view.name === "internal");
  const result = views.filter((view) => view.name !== "internal").map(cloneView);
  const normalizedExternal = result.find((view) => view.name === "external");
  if (normalizedExternal) normalizedExternal.records = normalizeExternalRecords(normalizedExternal.records);
  if (!external && !overrides) return result;
  const effective = new Map<string, DesiredRecord[]>();
  for (const record of normalizedExternal?.records ?? []) {
    const key = recordOwnerType(record);
    const group = effective.get(key) ?? [];
    group.push(asInternalRecord(record));
    effective.set(key, group);
  }
  const overriddenKeys = new Set((overrides?.records ?? []).map(recordOwnerType));
  for (const key of overriddenKeys) effective.set(key, []);
  for (const record of overrides?.records ?? []) {
    const key = recordOwnerType(record);
    const group = effective.get(key) ?? [];
    group.push(asInternalRecord(record));
    effective.set(key, group);
  }
  const records = [...effective.values()].flat().sort((left, right) => left.id.localeCompare(right.id));
  ensureUniqueRecordKeys(records);
  result.push({ name: "internal", records });
  result.sort((left, right) => left.name.localeCompare(right.name));
  return result;
}

function recordOwnerType(record: DesiredRecord): string {
  return `${record.name}\u0000${record.type}`;
}

function asInternalRecord(record: DesiredRecord): DesiredRecord {
  return {
    id: deterministicInternalRecordId(record),
    name: record.name,
    type: record.type,
    content: record.content,
    ttl: concreteDnsTtl(record.ttl),
  };
}

function deterministicInternalRecordId(record: DesiredRecord): string {
  const { name, type } = record;
  const owner = name === "@" ? "root" : name.replace(/^\*$/, "wildcard").replace(/[^a-z0-9_-]+/g, "-");
  const key = `${name}\u0000${type}\u0000${record.id}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const suffix = `-${type.toLowerCase()}-${(hash >>> 0).toString(36)}`;
  return `internal-${owner.slice(0, 63 - suffix.length - 9)}${suffix}`;
}

function mergeRemovedViews(current: Zone["views"], removed: Zone["views"]): Zone["views"] {
  const existing = new Set(current.map((view) => view.name));
  return [...current, ...removed.filter((view) => !existing.has(view.name))];
}

function validateExternalView(views: Zone["views"]): void {
  const external = views.find((view) => view.name === "external");
  if (external) validateExternalRecords(external.records);
}

function parseDesiredViews(input: unknown): Zone["views"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DomainValidationError(["desired state must be an object"]);
  }
  const root = input as Record<string, unknown>;
  const rawViews = root.views;
  const entries: Array<[string, unknown]> = [];
  if (Array.isArray(rawViews)) {
    for (const rawView of rawViews) {
      if (!rawView || typeof rawView !== "object" || Array.isArray(rawView)) {
        throw new DomainValidationError(["each view must be an object"]);
      }
      const object = rawView as Record<string, unknown>;
      if (typeof object.name !== "string") throw new DomainValidationError(["each view requires a name"]);
      entries.push([object.name, object.records]);
    }
  } else if (rawViews && typeof rawViews === "object") {
    for (const [name, value] of Object.entries(rawViews as Record<string, unknown>)) {
      const records = value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).records
        : value;
      entries.push([name, records]);
    }
  } else {
    throw new DomainValidationError(["views must be an array or object"]);
  }

  const views = entries.map(([name, rawRecords]) => {
    const viewName = validateViewName(name);
    if (!Array.isArray(rawRecords)) throw new DomainValidationError([`view ${viewName} records must be an array`]);
    let records = rawRecords.map((rawRecord) => {
      if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) {
        throw new DomainValidationError([`view ${viewName} records must be objects`]);
      }
      const object = rawRecord as Record<string, unknown>;
      if (typeof object.id !== "string") throw new DomainValidationError([`view ${viewName} records require an id`]);
      return createDesiredRecord(object.id, object);
    });
    ensureUniqueRecordKeys(records);
    if (viewName === "external") records = normalizeExternalRecords(records);
    records.sort((left, right) => left.id.localeCompare(right.id));
    return { name: viewName, records };
  });
  if (new Set(views.map((view) => view.name)).size !== views.length) {
    throw new DomainValidationError(["view names must be unique"]);
  }
  views.sort((left, right) => left.name.localeCompare(right.name));
  return views;
}

function findView(views: Zone["views"], viewName: string): Zone["views"][number] {
  const view = views.find((candidate) => candidate.name === viewName);
  if (!view) throw new NotFoundError(`view ${viewName} was not found`);
  return view;
}

function validateRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new DomainValidationError(["revision must be a positive integer"]);
  return value;
}
