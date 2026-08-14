import {
  canBeProxied,
  createDesiredRecord,
  concreteDnsTtl,
  DomainValidationError,
  isProviderView,
  normalizeExternalRecords,
  normalizeZoneName,
  readPersistedViewName,
  validateExternalRecords,
  validateViewName,
  type AuditEntry,
  type DesiredRecord,
  type DnsView,
  type Zone,
  type ZoneRevision,
} from "../domain/dns.ts";
import { buildReconcilePlan, type ProviderRecord, type ReconcilePlan } from "../domain/reconciliation.ts";
import { ProviderConstraintError, ProviderNotConfiguredError, RevisionConflictError, type ApplyLock, type ApplyStatus, type PageRequest, type ProviderAdapter, type RetentionPolicy, type StatusRepository, type ZoneRepository } from "./ports.ts";

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}
export class ConflictError extends Error {
  override readonly name = "ConflictError";
}

/**
 * A view's plan, or the reason there is none. An empty plan with no error means
 * nothing to do; an empty plan with one means nothing could be read -- which
 * must never be mistaken for the first.
 */
export interface PreviewPlan extends ReconcilePlan {
  error?: string;
}

export const DEFAULT_HISTORY_PAGE_SIZE = 50;
export const MAX_HISTORY_PAGE_SIZE = 500;

export interface DeleteZoneOptions {
  /**
   * Leave published records at the provider instead of withdrawing them. Needed
   * only when the provider is gone for good and the zone must still be removed.
   */
  readonly abandonProviderRecords?: boolean;
}

export interface RemovedProviderRecord {
  view: string;
  id: string;
  name: string;
  type: string;
  content: string;
}

export interface ZoneDeletionResult {
  zone: string;
  removedProviderRecords: RemovedProviderRecord[];
}

export type Paged<Key extends string, Item> = { [K in Key]: Item[] } & {
  limit: number;
  offset: number;
  hasMore: boolean;
};

/** Clamps caller-supplied paging so one request can never read an unbounded history. */
function boundedPage(page: PageRequest | undefined): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Math.trunc(page?.limit ?? DEFAULT_HISTORY_PAGE_SIZE), 1), MAX_HISTORY_PAGE_SIZE);
  const offset = Math.max(Math.trunc(page?.offset ?? 0), 0);
  return { limit, offset };
}

export interface Clock {
  now(): Date;
}

/** Operator-facing retention settings; the repository sees resolved values. */
export interface RetentionSettings {
  /** Newest snapshots kept per zone. 0 keeps every revision. */
  readonly maxRevisionsPerZone?: number;
  /** Days of audit history kept per zone. 0 keeps every entry. */
  readonly auditRetentionDays?: number;
}

export class ControlPlane {
  readonly #zones: ZoneRepository;
  readonly #statuses: StatusRepository;
  readonly #provider: ProviderAdapter;
  readonly #clock: Clock;
  readonly #applyLock: ApplyLock;
  readonly #retention: RetentionSettings;
  readonly #operationTails = new Map<string, Promise<void>>();

  constructor(
    zones: ZoneRepository,
    statuses: StatusRepository,
    provider: ProviderAdapter,
    clock: Clock = { now: () => new Date() },
    applyLock: ApplyLock = { withZoneLock: (_zone, operation) => operation() },
    retention: RetentionSettings = {},
  ) {
    this.#zones = zones;
    this.#statuses = statuses;
    this.#provider = provider;
    this.#clock = clock;
    this.#applyLock = applyLock;
    this.#retention = retention;
  }

  /** Resolves the operator's settings against the current clock for one commit. */
  #retentionPolicy(): RetentionPolicy | undefined {
    const maxRevisionsPerZone = this.#retention.maxRevisionsPerZone ?? 0;
    const auditRetentionDays = this.#retention.auditRetentionDays ?? 0;
    if (maxRevisionsPerZone <= 0 && auditRetentionDays <= 0) return undefined;
    return {
      ...(maxRevisionsPerZone > 0 ? { maxRevisionsPerZone } : {}),
      ...(auditRetentionDays > 0
        ? { deleteAuditBefore: new Date(this.#clock.now().getTime() - auditRetentionDays * 86_400_000).toISOString() }
        : {}),
    };
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

  deleteZone(zoneName: string, actor = "system", expectedRevision?: number, options: DeleteZoneOptions = {}): Promise<ZoneDeletionResult> {
    return this.#exclusive(zoneName, () => {
      const zone = normalizeZoneName(zoneName);
      // Deleting now removes provider records, so it takes the same cross-instance
      // lock as apply and cannot interleave with a concurrent reconciliation.
      return this.#applyLock.withZoneLock(zone, () => this.#deleteZone(zone, actor, expectedRevision, options));
    });
  }

  async #deleteZone(zoneName: string, actor: string, expectedRevision: number | undefined, options: DeleteZoneOptions): Promise<ZoneDeletionResult> {
    const zone = await this.getZone(zoneName);
    this.#assertExpectedRevision(zone, expectedRevision);
    // Withdraw published records first: if that fails the zone stays in place so
    // the operator can retry instead of being left with records nothing tracks.
    const removedRecords = options.abandonProviderRecords === true
      ? []
      : await this.#purgeProviderRecords(zone);
    const revision = zone.revision + 1;
    const retention = this.#retentionPolicy();
    try {
      await this.#zones.commitZoneDeletion({
        zone: zone.name,
        expectedRevision: zone.revision,
        ...(retention ? { retention } : {}),
        audit: {
          zone: zone.name,
          revision,
          action: "zone.deleted",
          actor,
          at: this.#clock.now().toISOString(),
          detail: {
            before: desiredState(zone),
            after: null,
            providerRecordsRemoved: removedRecords.length,
            providerRecordsAbandoned: options.abandonProviderRecords === true,
          },
        },
      });
      return { zone: zone.name, removedProviderRecords: removedRecords };
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error;
      const current = await this.#zones.get(zone.name);
      if (expectedRevision !== undefined && current) {
        throw new ConflictError(`expected revision ${expectedRevision} for zone ${zone.name}, but the current revision is ${current.revision}`);
      }
      throw new ConflictError(`zone ${zone.name} changed while it was being deleted`);
    }
  }

  /**
   * Reconciles every target this zone ever published to down to an empty desired
   * state. Only records carrying Parallax's ownership marker are removed, so
   * foreign records at the same names survive exactly as they do during apply.
   */
  async #purgeProviderRecords(zone: Zone): Promise<RemovedProviderRecord[]> {
    // Only the views an apply was actually attempted against. `lastAttemptAt` is
    // written by an attempt and by nothing else -- a view that merely has desired
    // state carries a pending status without one -- so it marks exactly the
    // targets that can be holding records to withdraw, including a first attempt
    // that failed part-way through.
    //
    // Deriving the set from the zone's views instead would always include
    // `internal`, because split-horizon materializes it from `external` whether
    // or not a provider backs it. Asking an unconfigured provider to list its
    // records is how deleting a zone came to fail outright on any deployment
    // that publishes to Cloudflare alone.
    const published = [...new Set(
      (await this.#statuses.list(zone.name))
        .filter((status) => status.lastAttemptAt !== undefined && isProviderView(status.view))
        .map((status) => status.view),
    )].sort();

    // Every target is read before any is written. The ordering above promises
    // that a failure leaves the zone in place to retry, and that promise is only
    // kept if nothing has been withdrawn by the time it breaks -- withdrawing
    // one view and then failing on the next reports failure over records that
    // are already gone.
    const planned: Array<{ view: string; key: string; plan: ReconcilePlan }> = [];
    for (const view of published) {
      const key = targetKey(zone.name, view);
      planned.push({ view, key, plan: buildReconcilePlan([], await this.#provider.list(key)) });
    }

    const removed: RemovedProviderRecord[] = [];
    for (const { view, key, plan } of planned) {
      for (const operation of plan.operations) {
        if (operation.kind !== "delete") continue;
        await this.#provider.apply(key, operation);
        removed.push({
          view,
          id: operation.actual.id,
          name: operation.actual.name,
          type: operation.actual.type,
          content: operation.actual.content,
        });
      }
    }
    return removed;
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

  /**
   * Brings records that already exist at a provider into the desired state.
   *
   * An authoritative server cannot say "I do not know this name" -- it answers
   * NXDOMAIN, which a forwarder treats as an answer and does not fall back on.
   * So an internal view that inherits from a public zone has to be complete, and
   * it can only inherit what the desired state describes. Records created
   * directly at the provider are invisible to it.
   *
   * Adopting does not take them over. A desired record identical to an unmanaged
   * one produces no operation, so the provider's copy stays exactly as it is and
   * whoever maintains it keeps doing so; if it later changes there, the
   * difference surfaces as a conflict rather than being overwritten. What
   * changes is that Parallax now knows the record exists, which is what the
   * internal view needs in order to derive from it.
   */
  adoptProviderRecords(zoneName: string, viewName: string, actor = "system", expectedRevision?: number): Promise<AdoptionResult> {
    return this.#exclusive(zoneName, () => this.#adoptProviderRecords(zoneName, viewName, actor, expectedRevision));
  }

  async #adoptProviderRecords(zoneName: string, viewName: string, actor: string, expectedRevision?: number): Promise<AdoptionResult> {
    const zone = await this.getZone(zoneName);
    this.#assertExpectedRevision(zone, expectedRevision);
    const view = validateViewName(viewName);
    const actual = await this.#provider.list(targetKey(zone.name, view));

    const views = zone.views.map(cloneView);
    let target = views.find((candidate) => candidate.name === view);
    if (!target) {
      target = { name: view, records: [] };
      views.push(target);
    }
    const taken = new Set(views.flatMap((candidate) => candidate.records.map((record) => record.id)));
    const adopted: DesiredRecord[] = [];
    for (const record of actual) {
      // Already Parallax's, or already described by a record that matches it.
      if (record.managed) continue;
      if (target.records.some((desired) => describesSameValue(desired, record))) continue;
      const id = adoptedId(record, taken);
      taken.add(id);
      const desired = describeAdopted(id, record);
      adopted.push(desired);
      target.records.push(desired);
    }
    if (adopted.length === 0) return { zone, adopted, seen: actual.length };

    if (view === "external") target.records = normalizeExternalRecords(target.records);
    ensureUniqueRecordKeys(target.records);
    const updated = this.#nextRevision(zone, views);
    await this.#commitDesiredChange(zone, updated, "records.adopted", actor, { view, adopted: adopted.length },
      new Set(views.map((candidate) => candidate.name)), expectedRevision);
    return { zone: updated, adopted, seen: actual.length };
  }

  async listRevisions(zoneName: string, page?: PageRequest): Promise<Paged<"revisions", ZoneRevision>> {
    const zone = await this.getZone(zoneName);
    const bounds = boundedPage(page);
    const fetched = await this.#zones.listRevisions(zone.name, { limit: bounds.limit + 1, offset: bounds.offset });
    // Revisions come back ascending, so the extra probe row is the oldest one.
    const hasMore = fetched.length > bounds.limit;
    return { revisions: hasMore ? fetched.slice(1) : fetched, ...bounds, hasMore };
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

  /**
   * Reports what applying would do, one view at a time.
   *
   * A view whose provider cannot be read reports why instead of failing the
   * whole preview. Split-horizon materializes `internal` from `external`
   * whether or not a provider backs it, so on a deployment that publishes to
   * Cloudflare alone one unreadable view would otherwise hide the plan for the
   * one the operator came to look at -- and preview is the step that exists so
   * nothing is applied unseen.
   */
  async preview(zoneName: string, viewName?: string, desiredInput?: unknown): Promise<{ zone: string; revision: number; views: Record<string, PreviewPlan> }> {
    const zone = await this.getZone(zoneName);
    const candidateViews = desiredInput === undefined ? zone.views : parseDesiredViews(desiredInput);
    validateExternalView(candidateViews);
    const effectiveViews = reconcilableViews(materializeProviderViews(candidateViews));
    const selected = viewName ? [findView(effectiveViews, validateViewName(viewName))] : effectiveViews;
    const views: Record<string, PreviewPlan> = {};
    let firstFailure: unknown;
    for (const view of selected) {
      try {
        const actual = await this.#provider.list(targetKey(zone.name, view.name));
        views[view.name] = buildReconcilePlan(view.records, actual);
      } catch (error) {
        // Asking for one view by name is asking about that view, so a failure
        // there is the answer to the question and belongs to the caller.
        if (viewName) throw error;
        firstFailure ??= error;
        const expected = error instanceof ConflictError || error instanceof ProviderNotConfiguredError;
        views[view.name] = {
          operations: [],
          summary: { create: 0, update: 0, delete: 0, conflict: 0 },
          error: expected ? (error as Error).message : "provider could not be read",
        };
      }
    }
    // Nothing was read, so there is no plan to report. Answering with empty
    // summaries would read as "no changes needed" to anything that checks the
    // counts before the errors -- which is most things.
    if (firstFailure !== undefined && Object.values(views).every((plan) => plan.error)) throw firstFailure;
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
      .filter((status) => isProviderView(status.view)
        && !zone.views.some((view) => view.name === status.view)
        && status.desiredRevision === zone.revision
        && status.state !== "applied")
      .map((status) => ({ name: status.view, records: [] as DesiredRecord[] }));
    const availableViews = mergeRemovedViews(reconcilableViews(materializeProviderViews(zone.views)), removedPendingViews);
    const selected = viewName ? [findView(availableViews, validateViewName(viewName))] : availableViews;
    const results: ApplyStatus[] = [];
    for (const view of selected) {
      const key = targetKey(zone.name, view.name);
      const attemptedAt = this.#clock.now().toISOString();
      try {
        const plan = buildReconcilePlan(view.records, await this.#provider.list(key));
        if (plan.summary.conflict > 0) throw new ConflictError("unmanaged provider records conflict with desired state");
        const planned = plan.operations.filter((operation) => operation.kind !== "conflict");
        for (const [index, operation] of planned.entries()) {
          try {
            await this.#provider.apply(key, operation);
          } catch (error) {
            throw new PartialApplyError(error, index, planned.length);
          }
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
        const progress = error instanceof PartialApplyError ? error : undefined;
        const cause = progress ? progress.cause : error;
        // Parallax's own sentences are safe to repeat: they describe Parallax's
        // data against a limit Parallax knows. What a provider returned is not,
        // because it can quote the request that carried a token or a path.
        const expected = cause instanceof ConflictError || cause instanceof ProviderNotConfiguredError
          || cause instanceof ProviderConstraintError;
        const publicError = expected ? (cause as Error).message : "provider operation failed";
        if (!expected) {
          // The message stays hidden -- a provider error can carry a token or a
          // path. A system error's `code` carries neither: it names the syscall
          // failure class, which is the difference between "read-only volume"
          // and "provider rejected it" for whoever reads this line.
          const code = (cause as NodeJS.ErrnoException | undefined)?.code;
          console.error("provider operation failed", {
            zone: zone.name,
            view: view.name,
            errorName: cause instanceof Error ? cause.name : "unknown",
            ...(typeof code === "string" ? { errorCode: code } : {}),
          });
        }
        const status: ApplyStatus = {
          zone: zone.name,
          view: view.name,
          desiredRevision: zone.revision,
          appliedRevision: (await this.#statuses.get(zone.name, view.name))?.appliedRevision ?? 0,
          state: "failed",
          lastAttemptAt: attemptedAt,
          error: publicError,
          ...(progress ? { completedOperations: progress.completed, plannedOperations: progress.planned } : {}),
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

  async audit(zoneName?: string, page?: PageRequest): Promise<Paged<"entries", AuditEntry>> {
    const bounds = boundedPage(page);
    const zone = zoneName ? normalizeZoneName(zoneName) : undefined;
    const fetched = await this.#zones.audit(zone, { limit: bounds.limit + 1, offset: bounds.offset });
    const hasMore = fetched.length > bounds.limit;
    const entries = fetched.slice(0, bounds.limit).map((entry) => ({ ...entry, ...summarizeDesiredChange(entry) }));
    return { entries, ...bounds, hasMore };
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
    const retention = this.#retentionPolicy();
    try {
      await this.#zones.commitDesiredChange({
        snapshot: zone,
        ...(retention ? { retention } : {}),
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

/**
 * Counts what a revision did to the desired state, by view and record id:
 * records that appeared, records that are gone, and records that kept their id
 * while saying something else.
 *
 * Read from the before and after snapshots the entry already carries, so an
 * entry written before this existed still reports it. A deleted zone has a
 * before and no after, which counts every record it held as removed. An entry
 * with no snapshots at all reports nothing rather than zeroes, which would
 * read as "this changed nothing".
 */
function summarizeDesiredChange(entry: AuditEntry): { added: number; removed: number; changed: number } | undefined {
  const detail = entry.detail as { before?: { views?: DnsView[] } | null; after?: { views?: DnsView[] } } | undefined;
  if (!detail || typeof detail !== "object" || !("after" in detail)) return undefined;
  const index = (views: DnsView[] | undefined): Map<string, DesiredRecord> => {
    const records = new Map<string, DesiredRecord>();
    for (const view of views ?? []) {
      for (const record of view.records) records.set(`${view.name}/${record.id}`, record);
    }
    return records;
  };
  const previous = index(detail.before?.views);
  const current = index(detail.after?.views);
  let added = 0;
  let changed = 0;
  for (const [key, record] of current) {
    const was = previous.get(key);
    if (!was) added += 1;
    else if (!sameDesiredRecord(was, record)) changed += 1;
  }
  let removed = 0;
  for (const key of previous.keys()) if (!current.has(key)) removed += 1;
  return { added, removed, changed };
}

/**
 * Whether two records with the same id say the same thing.
 *
 * Compares every field rather than a list of them. A list has to be extended
 * whenever the record gains one, and nothing makes that happen: the version
 * that named its fields would have reported `changed: 0` for a revision that
 * altered a field added later -- a wrong zero, which is worse than no number,
 * because a wrong zero is read as "nothing happened".
 *
 * Absent and `false` are the same answer for the optional booleans, so they are
 * normalized before comparing; without that, rewriting a record with an
 * explicit `proxied: false` would look like a change to a record that had left
 * it out.
 */
function sameDesiredRecord(left: DesiredRecord, right: DesiredRecord): boolean {
  return comparableRecord(left) === comparableRecord(right);
}

function comparableRecord(record: DesiredRecord): string {
  const { id: _matchedOn, proxied, acknowledgeNonGlobalIp, ...rest } = record;
  const fields: Record<string, unknown> = {
    ...rest,
    proxied: proxied ?? false,
    acknowledgeNonGlobalIp: acknowledgeNonGlobalIp ?? false,
  };
  return JSON.stringify(Object.keys(fields).sort().map((key) => [key, fields[key]]));
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
/**
 * Carries how far a view got before the provider refused, so the status can say
 * so. Nothing outside this module sees it: the cause is unwrapped where the
 * status is built.
 */
class PartialApplyError extends Error {
  readonly cause: unknown;
  readonly completed: number;
  readonly planned: number;
  constructor(cause: unknown, completed: number, planned: number) {
    super("provider operation failed");
    this.cause = cause;
    this.completed = completed;
    this.planned = planned;
  }
}

/** What one adoption run found and what it changed. */
export interface AdoptionResult {
  readonly zone: Zone;
  /** Records now described that were not before. */
  readonly adopted: DesiredRecord[];
  /**
   * How many records the provider listed for this view. Counting only the types
   * this control plane supports, so comparing it against the provider's own
   * total is how the type gap becomes visible. `seen` above zero with nothing
   * adopted means the view was already complete -- not that adoption did
   * nothing because it could not see anything.
   */
  readonly seen: number;
}

/**
 * Turns one provider record into a desired record, naming the record when it
 * cannot. Adoption commits the whole view at once, so a single record this
 * control plane will not describe stops all of them -- and an error that only
 * says which rule was broken leaves the operator to find the record by hand.
 */
function describeAdopted(id: string, record: ProviderRecord): DesiredRecord {
  try {
    return createDesiredRecord(id, {
      name: record.name,
      type: record.type,
      content: record.content,
      ttl: record.ttl,
      ...(record.proxied !== undefined && canBeProxied(record.type) ? { proxied: record.proxied } : {}),
      // A zone holds whatever it already holds, including addresses this would
      // otherwise refuse to publish. That guard is for deciding to expose an
      // address; here the address is already exposed, and refusing to describe
      // it would leave the internal view incomplete for exactly those names.
      ...(record.type === "A" || record.type === "AAAA" ? { acknowledgeNonGlobalIp: true } : {}),
    });
  } catch (error) {
    if (!(error instanceof DomainValidationError)) throw error;
    throw new DomainValidationError(error.issues.map((issue) =>
      `${record.name} ${record.type} ${record.content}: ${issue}`));
  }
}

/** Whether a desired record already says what a provider record says. */
function describesSameValue(desired: DesiredRecord, actual: ProviderRecord): boolean {
  return desired.name.toLowerCase() === actual.name.toLowerCase()
    && desired.type === actual.type
    && desired.content === actual.content;
}

/**
 * A stable, readable id for a record that arrived without one. Derived from what
 * the record is, so adopting twice reuses the same id rather than accumulating
 * duplicates under new names.
 */
function adoptedId(record: ProviderRecord, taken: ReadonlySet<string>): string {
  const base = `${record.name === "@" ? "root" : record.name}-${record.type}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 30) || "adopted";
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

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

/**
 * Views a provider can actually reconcile. Snapshots written before views were
 * restricted may still carry other names; they stay in the stored desired state
 * so an operator can remove them, but they are never handed to a provider.
 */
function reconcilableViews(views: Zone["views"]): Zone["views"] {
  return views.filter((view) => isProviderView(view.name));
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
