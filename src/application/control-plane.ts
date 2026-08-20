import {
  canBeProxied,
  createDesiredRecord,
  concreteDnsTtl,
  DomainValidationError,
  isProviderView,
  normalizeExternalRecords,
  normalizeZoneName,
  providerManagement,
  readPersistedViewName,
  validateExternalRecords,
  validateViewName,
  type AuditEntry,
  type DesiredRecord,
  type DnsView,
  type ManagedByService,
  type ProviderManagement,
  type Zone,
  type ZoneRevision,
} from "../domain/dns.ts";
import { formatZoneFile, parseZoneFile } from "../domain/zone-file.ts";
import { buildReconcilePlan, type ProviderRecord, type ReconcilePlan } from "../domain/reconciliation.ts";
import { ProviderConstraintError, ProviderNotConfiguredError, RevisionConflictError, type ApplyLock, type ApplyStatus, type AuditRetentionPolicy, type PageRequest, type ProviderAdapter, type RetentionPolicy, type StatusRepository, type ZoneRepository } from "./ports.ts";

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}
export class ConflictError extends Error {
  override readonly name = "ConflictError";
}
export class ProviderManagedRecordError extends Error {
  override readonly name = "ProviderManagedRecordError";
}

/**
 * Refuses a change that would alter or remove a record the provider owns.
 *
 * Checked against the whole external view rather than at each call site, so
 * every way in is covered by the same rule: editing one record, deleting one,
 * and replacing the desired state wholesale all arrive here. A guard that only
 * watched the two obvious doors would be one `PUT /desired` away from useless.
 *
 * The internal view is closed for the same names, but only against being
 * written. An override is a second answer for a name whose first answer this
 * process cannot describe, and a name it cannot describe is one it should not
 * be quietly answering differently either -- that is a split nobody can see
 * from the provider's side and nobody can correct from this one. Removing an
 * override is still allowed: it moves the name back to what the provider
 * serves, which is the direction that cannot break anything.
 */
function assertProviderManagedIntact(before: readonly DnsView[], after: readonly DnsView[]): void {
  const externalBefore = before.find((view) => view.name === "external");
  if (!externalBefore) return;
  const externalAfter = after.find((view) => view.name === "external");
  const managed: Array<{ record: DesiredRecord; management: ProviderManagement }> = [];
  for (const record of externalBefore.records) {
    const management = providerManagement(record);
    if (!management) continue;
    managed.push({ record, management });
    const survivor = externalAfter?.records.find((candidate) => candidate.id === record.id);
    // The binding counts as part of the record here, though reconciliation
    // ignores it. It is the whole reason this record cannot be edited, so a
    // request that simply left it out would be the one edit that always
    // worked -- and it would unlock every other edit after it.
    if (survivor && survivor.name === record.name && survivor.type === record.type
      && survivor.content === record.content && sameService(record.managedBy, survivor.managedBy)) continue;
    const what = survivor ? "changed" : "deleted";
    throw new ProviderManagedRecordError(
      `${record.type} ${record.name} cannot be ${what} here: ${management.reason}. Change it where it was created, and adopt the zone again`,
    );
  }
  if (managed.length === 0) return;
  const internalBefore = before.find((view) => view.name === "internal")?.records ?? [];
  const internalAfter = after.find((view) => view.name === "internal")?.records ?? [];
  const answersFor = (records: readonly DesiredRecord[], record: DesiredRecord): DesiredRecord[] =>
    records.filter((candidate) => candidate.name === record.name && candidate.type === record.type);
  for (const { record, management } of managed) {
    const was = answersFor(internalBefore, record);
    for (const answer of answersFor(internalAfter, record)) {
      if (was.some((candidate) => candidate.id === answer.id && candidate.content === answer.content)) continue;
      throw new ProviderManagedRecordError(
        `${record.type} ${record.name} cannot be answered differently inside: ${management.reason}. Change it where it was created, and adopt the zone again`,
      );
    }
  }
}

/**
 * A view's plan, or the reason there is none. An empty plan with no error means
 * nothing to do; an empty plan with one means nothing could be read -- which
 * must never be mistaken for the first.
 */
export interface PreviewPlan extends ReconcilePlan {
  error?: string;
  /**
   * What the provider holds for this view, and which of it this control plane
   * owns.
   *
   * The plan says what would change; this says who each record belongs to, and
   * they are different questions. A record that produces no operation is either
   * one of ours that already matches or somebody else's that happens to say the
   * same thing -- identical in a plan, and the difference decides whether an
   * operator may touch it. Ownership lives in a marker on the provider's copy,
   * so nothing but a provider read can answer it, and the read has already
   * happened here: this is the answer being carried instead of discarded.
   */
  actual?: ProviderOwnership[];
}

/** One record the provider holds, reduced to what identifies and claims it. */
export interface ProviderOwnership {
  readonly name: string;
  readonly type: string;
  readonly content: string;
  /** True when it carries this control plane's ownership marker. */
  readonly managed: boolean;
}

export const DEFAULT_HISTORY_PAGE_SIZE = 50;
export const MAX_HISTORY_PAGE_SIZE = 500;

export interface DeleteZoneOptions {
  /**
   * Permit deletion to continue when a published target can no longer be read.
   * Targets that remain reachable are still withdrawn; only the unreachable
   * targets are explicitly abandoned.
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
  abandonedProviderTargets: Array<{ view: string; target: string }>;
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
  readonly #answeredHere: (target: string) => boolean;
  readonly #operationTails = new Map<string, Promise<void>>();

  constructor(
    zones: ZoneRepository,
    statuses: StatusRepository,
    provider: ProviderAdapter,
    clock: Clock = { now: () => new Date() },
    applyLock: ApplyLock = { withZoneLock: (_zone, operation) => operation() },
    retention: RetentionSettings = {},
    /**
     * Whether this process answers a target itself and publishes it nowhere.
     *
     * The built-in listener reads the desired state and answers from it, so
     * there is nothing to reconcile and no lag between wanting a record and
     * serving it. Without this, applying such a view finds no provider and
     * records a failure -- which says the system is broken while it is doing
     * exactly what it was configured to do, and says it on the front page.
     *
     * Both halves of that question -- is anything publishing this, and does the
     * listener answer for it -- are answered where the process is assembled.
     * Asking here would mean this knowing which adapter is routed where, which
     * is the router's business and not the control plane's.
     */
    answeredHere: (target: string) => boolean = () => false,
  ) {
    this.#zones = zones;
    this.#statuses = statuses;
    this.#provider = provider;
    this.#clock = clock;
    this.#applyLock = applyLock;
    this.#retention = retention;
    this.#answeredHere = answeredHere;
  }

  /** Resolves the operator's settings against the current clock for one commit. */
  #retentionPolicy(): RetentionPolicy | undefined {
    const maxRevisionsPerZone = this.#retention.maxRevisionsPerZone ?? 0;
    const audit = this.#auditRetentionPolicy();
    if (maxRevisionsPerZone <= 0 && !audit) return undefined;
    return {
      ...(maxRevisionsPerZone > 0 ? { maxRevisionsPerZone } : {}),
      ...audit,
    };
  }

  #auditRetentionPolicy(): AuditRetentionPolicy | undefined {
    const auditRetentionDays = this.#retention.auditRetentionDays ?? 0;
    return auditRetentionDays > 0
      ? { deleteAuditBefore: new Date(this.#clock.now().getTime() - auditRetentionDays * 86_400_000).toISOString() }
      : undefined;
  }

  listZones(): Promise<Zone[]> {
    return this.#zones.list();
  }

  async listZonePage(page?: PageRequest): Promise<Paged<"zones", Zone>> {
    const bounds = boundedPage(page);
    const fetched = await this.#zones.list({ limit: bounds.limit + 1, offset: bounds.offset });
    const hasMore = fetched.length > bounds.limit;
    return { zones: fetched.slice(0, bounds.limit), ...bounds, hasMore };
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
    return this.#exclusive(zoneName, () => this.#deleteZone(zoneName, actor, expectedRevision, options));
  }

  async #deleteZone(zoneName: string, actor: string, expectedRevision: number | undefined, options: DeleteZoneOptions): Promise<ZoneDeletionResult> {
    const zone = await this.getZone(zoneName);
    this.#assertExpectedRevision(zone, expectedRevision);
    // Withdraw published records first: if that fails the zone stays in place so
    // the operator can retry instead of being left with records nothing tracks.
    const purge = await this.#purgeProviderRecords(zone, actor, options.abandonProviderRecords === true);
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
            providerRecordsRemoved: purge.removed.length,
            providerRecordsAbandoned: purge.abandoned.length > 0,
            providerTargetsAbandoned: purge.abandoned.map((target) => target.target),
          },
        },
      });
      return {
        zone: zone.name,
        removedProviderRecords: purge.removed,
        abandonedProviderTargets: purge.abandoned,
      };
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
  async #purgeProviderRecords(
    zone: Zone,
    actor: string,
    abandonUnreadable: boolean,
  ): Promise<{ removed: RemovedProviderRecord[]; abandoned: Array<{ view: string; target: string }> }> {
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
    //
    // A view this process answers out of the desired state is not in that set
    // either. It has a status like any other, but nothing was ever published
    // through a provider for it, so there is nothing to withdraw -- and asking
    // would fail for want of a provider, turning "delete this zone" into a
    // demand to acknowledge abandoning records that never existed.
    const published = [...new Set(
      (await this.#statuses.list(zone.name))
        .filter((status) => status.lastAttemptAt !== undefined && isProviderView(status.view))
        .map((status) => status.view),
    )].sort().filter((view) => !this.#answeredHere(targetKey(zone.name, view)));

    // Every target is read before any is written. The ordering above promises
    // that a failure leaves the zone in place to retry, and that promise is only
    // kept if nothing has been withdrawn by the time it breaks -- withdrawing
    // one view and then failing on the next reports failure over records that
    // are already gone.
    const planned: Array<{ view: string; key: string; plan: ReconcilePlan }> = [];
    const abandoned: Array<{ view: string; target: string }> = [];
    for (const view of published) {
      const key = targetKey(zone.name, view);
      try {
        planned.push({ view, key, plan: buildReconcilePlan([], await this.#provider.list(key)) });
      } catch (error) {
        if (!abandonUnreadable) throw error;
        abandoned.push({ view, target: key });
      }
    }

    const removed: RemovedProviderRecord[] = [];
    for (const { view, key, plan } of planned) {
      const deletions = plan.operations.filter((operation) => operation.kind === "delete");
      await this.#appendProviderAudit("provider.apply.started", zone, view, actor, {
        operation: "zone-delete",
        target: key,
        plannedOperations: deletions.length,
      });
      let completedOperations = 0;
      try {
        for (const operation of deletions) {
          await this.#provider.apply(key, operation);
          completedOperations += 1;
          removed.push({
            view,
            id: operation.actual.id,
            name: operation.actual.name,
            type: operation.actual.type,
            content: operation.actual.content,
          });
        }
        await this.#appendProviderAudit("provider.apply.completed", zone, view, actor, {
          operation: "zone-delete",
          target: key,
          completedOperations,
          plannedOperations: deletions.length,
        });
      } catch (error) {
        await this.#appendProviderAudit("provider.apply.failed", zone, view, actor, {
          operation: "zone-delete",
          target: key,
          completedOperations,
          plannedOperations: deletions.length,
          error: publicProviderError(error),
        });
        throw error;
      }
    }
    return { removed, abandoned };
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
    assertProviderManagedIntact(zone.views, views);
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
    assertProviderManagedIntact(zone.views, views);
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
    assertProviderManagedIntact(zone.views, views);
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
  adoptProviderRecords(zoneName: string, viewName: string, actor = "system", expectedRevision?: number, dryRun = false): Promise<AdoptionResult> {
    return this.#exclusive(zoneName, () => this.#adoptProviderRecords(zoneName, viewName, actor, expectedRevision, dryRun));
  }

  async #adoptProviderRecords(zoneName: string, viewName: string, actor: string, expectedRevision?: number, dryRun = false): Promise<AdoptionResult> {
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
    // Records the provider owns are refreshed in place rather than left behind.
    //
    // Every other record is the operator's, and adoption deliberately does not
    // take those over: a later difference is a conflict for a person to settle.
    // These have no person to settle it. They cannot be edited here -- that is
    // the point of them -- so if the provider changes one and this only ever
    // added, the desired state would keep a value the world no longer has, with
    // no way left to correct it. Refusing to edit them is only honest if
    // adopting again is the way to catch up, which is what the refusal says.
    //
    // Matched on name and type, and only where each side has exactly one record
    // there. A name may hold a whole RRset, and picking one of several to carry
    // somebody else's value would silently rewrite the wrong one -- so an
    // ambiguous case is left alone and surfaces as a conflict, which is a person's
    // to settle.
    const refreshed: DesiredRecord[] = [];
    for (const record of actual) {
      if (record.managed) continue;
      const desiredHere = target.records.filter((desired) => desired.name === record.name && desired.type === record.type);
      const actualHere = actual.filter((candidate) => candidate.name === record.name && candidate.type === record.type);
      if (desiredHere.length !== 1 || actualHere.length !== 1) continue;
      const existing = desiredHere[0] as DesiredRecord;
      // The stored copy is the locked one; what the provider now holds may be
      // anything, including an ordinary address that is no longer locked at all.
      if (!providerManagement(existing)) continue;
      if (existing.content === record.content && existing.ttl === record.ttl) continue;
      existing.content = record.content;
      existing.ttl = record.ttl;
      refreshed.push(existing);
    }
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
    // Which of these names a provider service publishes for itself, asked of
    // the services rather than of DNS, because a record does not say.
    //
    // Applied to every record in the view and not only the new ones: a name
    // becomes a Worker custom domain, or stops being one, without its DNS
    // record changing at all, and adoption is the one thing that catches up.
    // Only a read that succeeded may unlock a record -- an ownership lookup
    // that failed says nothing about who owns what, and treating silence as
    // "nobody" would hand an operator the edit that breaks the binding.
    const ownership = await this.#serviceOwnership(zone.name, view);
    if (ownership.owned) {
      for (const record of target.records) {
        // Only the types a service can stand in front of. A name may hold a
        // TXT beside its Worker custom domain, and that record is nobody's but
        // the operator's -- matching on the name alone would lock it too.
        const owner = canBeProxied(record.type) ? ownership.owned.get(record.name) : undefined;
        if (sameService(record.managedBy, owner)) continue;
        if (owner) record.managedBy = owner;
        else delete record.managedBy;
        if (!refreshed.includes(record) && !adopted.includes(record)) refreshed.push(record);
      }
    }
    if (adopted.length === 0 && refreshed.length === 0) {
      return { zone, adopted, refreshed, warnings: ownership.warnings, seen: actual.length };
    }

    if (view === "external") target.records = normalizeExternalRecords(target.records);
    ensureUniqueRecordKeys(target.records);
    materializeProviderViews(views);
    const updated = this.#nextRevision(zone, views);
    const warnings = [...ownership.warnings, ...authorityWarnings(zone, updated, dryRun)];
    // Everything above decided what would happen; nothing has been written yet.
    // A dry run stops here, which is the whole point: adopting is what turns a
    // forwarded zone into one this process is the authority for, so finding that
    // out should not require doing it. The zone reported back is the unchanged
    // one, because that is what is still stored.
    if (dryRun) return { zone, adopted, refreshed, warnings, seen: actual.length };
    await this.#commitDesiredChange(zone, updated, "records.adopted", actor,
      { view, adopted: adopted.length, ...(refreshed.length > 0 ? { refreshed: refreshed.length } : {}) },
      new Set(views.map((candidate) => candidate.name)), expectedRevision);
    return { zone: updated, adopted, refreshed, warnings, seen: actual.length };
  }

  /**
   * Asks the provider which names its own services publish.
   *
   * Never fails adoption. A provider that cannot answer -- one with no such
   * services, a token without the permission, an account id nobody filled in --
   * leaves every stored label exactly as it was and says so where the operator
   * is already reading. The alternative, refusing to adopt, would make
   * describing a zone depend on a lookup that has nothing to do with the
   * records being described.
   */
  async #serviceOwnership(zoneName: string, view: string): Promise<{
    owned?: Map<string, ManagedByService>;
    warnings: string[];
  }> {
    if (!this.#provider.serviceOwnership) return { warnings: [] };
    try {
      const hostnames = await this.#provider.serviceOwnership(targetKey(zoneName, view));
      if (!hostnames) return { warnings: [] };
      const owned = new Map<string, ManagedByService>();
      for (const hostname of hostnames) {
        owned.set(hostname.name, { service: hostname.service, resource: hostname.resource });
      }
      return { owned, warnings: [] };
    } catch (error) {
      return {
        warnings: [`which names Workers and R2 own could not be read, so records already marked as theirs keep that mark and no new ones gained it: ${error instanceof Error ? error.message : String(error)}. A refusal here usually means the token lacks Account -> Workers Scripts -> Read or Account -> Workers R2 Storage -> Read`],
      };
    }
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
      const key = targetKey(zone.name, view.name);
      // Nothing is published for a view this process answers out of the desired
      // state, so there is no provider to compare against and no plan to make.
      // Reporting that as an unreadable view says the operator cannot see what
      // would happen, when what would happen is nothing.
      if (this.#answeredHere(key)) {
        views[view.name] = { operations: [], summary: { create: 0, update: 0, delete: 0, conflict: 0, untouched: 0 } };
        continue;
      }
      try {
        const actual = await this.#provider.list(key);
        views[view.name] = {
          ...buildReconcilePlan(view.records, actual),
          actual: actual.map((record) => ({
            name: record.name, type: record.type, content: record.content, managed: record.managed,
          })),
        };
      } catch (error) {
        // Asking for one view by name is asking about that view, so a failure
        // there is the answer to the question and belongs to the caller.
        if (viewName) throw error;
        firstFailure ??= error;
        const expected = error instanceof ConflictError || error instanceof ProviderNotConfiguredError;
        views[view.name] = {
          operations: [],
          summary: { create: 0, update: 0, delete: 0, conflict: 0, untouched: 0 },
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

  apply(zoneName: string, viewName?: string, expectedRevision?: number, actor = "system"): Promise<{ zone: string; revision: number; statuses: ApplyStatus[] }> {
    return this.#exclusive(zoneName, () => this.#apply(zoneName, viewName, expectedRevision, actor));
  }

  /**
   * Applies every pending zone from the overview. Applied zones are skipped.
   * A zone that is already failed, or that fails this run, is reported and the
   * rest still run -- one broken zone must not hide the ones behind it.
   */
  async applyPending(actor = "system"): Promise<{
    applied: string[];
    failed: { zone: string; error: string }[];
    skipped: string[];
  }> {
    const applied: string[] = [];
    const failed: { zone: string; error: string }[] = [];
    const skipped: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.statusOverview({ limit: 500, offset });
      for (const row of page.zones) {
        if (row.state === "applied" || row.state === "") {
          skipped.push(row.zone);
          continue;
        }
        if (row.state === "failed") {
          failed.push({ zone: row.zone, error: "zone apply previously failed" });
          continue;
        }
        try {
          await this.apply(row.zone, undefined, undefined, actor);
          applied.push(row.zone);
        } catch (error) {
          failed.push({ zone: row.zone, error: error instanceof Error ? error.message : "apply failed" });
        }
      }
      if (!page.hasMore) break;
      if (page.zones.length === 0) break;
      offset += page.zones.length;
    }
    return { applied, failed, skipped };
  }

  exportZoneFile(zoneName: string, viewName = "external"): Promise<string> {
    return this.getZone(zoneName).then((zone) => {
      const view = zone.views.find((candidate) => candidate.name === validateViewName(viewName));
      return formatZoneFile(zone.name, view?.records ?? []);
    });
  }

  importZoneFile(zoneName: string, viewName: string, text: string, actor = "system", expectedRevision?: number): Promise<Zone> {
    return this.#exclusive(zoneName, async () => {
      const zone = await this.getZone(zoneName);
      this.#assertExpectedRevision(zone, expectedRevision);
      const records = parseZoneFile(text, zone.name);
      const view = validateViewName(viewName);
      const views = zone.views.filter((candidate) => candidate.name !== view);
      views.push({ name: view, records });
      assertProviderManagedIntact(zone.views, views);
      materializeProviderViews(views);
      const updated = this.#nextRevision(zone, views);
      await this.#commitDesiredChange(zone, updated, "desired.replaced", actor, { view, imported: records.length }, [view], expectedRevision);
      return updated;
    });
  }

  async #apply(zoneName: string, viewName: string | undefined, expectedRevision: number | undefined, actor: string): Promise<{ zone: string; revision: number; statuses: ApplyStatus[] }> {
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
      let auditStarted = false;
      let completedOperations = 0;
      let plannedOperations = 0;
      try {
        // Nothing is published for a view this process answers out of the
        // desired state, so what is served is that revision already. Recording
        // it as applied is not a convenience: `appliedRevision` is the revision
        // being answered, and here it equals the desired one by construction.
        if (this.#answeredHere(key)) {
          const served: ApplyStatus = {
            zone: zone.name,
            view: view.name,
            desiredRevision: zone.revision,
            appliedRevision: zone.revision,
            state: "applied",
            lastAttemptAt: attemptedAt,
          };
          await this.#statuses.save(served);
          results.push(served);
          continue;
        }
        const plan = buildReconcilePlan(view.records, await this.#provider.list(key));
        if (plan.summary.conflict > 0) throw new ConflictError("unmanaged provider records conflict with desired state");
        const planned = plan.operations.filter((operation) => operation.kind !== "conflict");
        plannedOperations = planned.length;
        await this.#appendProviderAudit("provider.apply.started", zone, view.name, actor, {
          operation: "reconcile",
          target: key,
          plannedOperations,
          summary: plan.summary,
        });
        auditStarted = true;
        for (const [index, operation] of planned.entries()) {
          try {
            await this.#provider.apply(key, operation);
            completedOperations = index + 1;
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
        await this.#appendProviderAudit("provider.apply.completed", zone, view.name, actor, {
          operation: "reconcile",
          target: key,
          completedOperations,
          plannedOperations,
        });
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
          ...(progress
            ? { completedOperations: progress.completed, plannedOperations: progress.planned }
            : auditStarted ? { completedOperations, plannedOperations } : {}),
        };
        await this.#statuses.save(status);
        if (auditStarted) {
          await this.#appendProviderAudit("provider.apply.failed", zone, view.name, actor, {
            operation: "reconcile",
            target: key,
            completedOperations: progress?.completed ?? completedOperations,
            plannedOperations: progress?.planned ?? plannedOperations,
            error: publicError,
          });
        }
        results.push(status);
      }
    }
    return { zone: zone.name, revision: zone.revision, statuses: results };
  }

  async status(zoneName: string): Promise<{ zone: string; desiredRevision: number; statuses: ApplyStatus[] }> {
    return this.#statusFor(await this.getZone(zoneName));
  }

  /**
   * One line per zone: how far it is applied overall.
   *
   * For a list, where asking each zone in turn is one request per row and the
   * page would draw itself a row at a time. Every zone's verdict comes from the
   * same routine one zone's own status page uses, rather than a second reading
   * of the same rows -- two answers to "is this zone applied?" is exactly the
   * kind of pair that drifts, and the disagreement would show as a dot that
   * contradicts the panel beside it.
   *
   * Bounded by the same paging as the zone list, so it reads a page of zones,
   * never every zone there is.
   */
  async statusOverview(page?: PageRequest): Promise<Paged<"zones", { zone: string; desiredRevision: number; state: string }>> {
    const listed = await this.listZonePage(page);
    const zones = await Promise.all(listed.zones.map(async (zone) => ({
      zone: zone.name,
      desiredRevision: zone.revision,
      state: overallApplyState((await this.#statusFor(zone)).statuses),
    })));
    return { zones, limit: listed.limit, offset: listed.offset, hasMore: listed.hasMore };
  }

  async #statusFor(zone: Zone): Promise<{ zone: string; desiredRevision: number; statuses: ApplyStatus[] }> {
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

  async #appendProviderAudit(
    action: "provider.apply.started" | "provider.apply.completed" | "provider.apply.failed",
    zone: Zone,
    view: string,
    actor: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.#zones.appendAudit({
      zone: zone.name,
      revision: zone.revision,
      action,
      actor,
      at: this.#clock.now().toISOString(),
      detail: { view, ...detail },
    }, this.#auditRetentionPolicy());
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
    const statuses = await this.#statusesForDesiredChange(before, zone, expandedViews);
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

  /**
   * Advances every provider view and every outstanding removed-view tombstone to
   * the zone's new global revision. A change to one view must not make another
   * view's status disappear merely because their desired revisions no longer
   * equal the zone revision.
   */
  async #statusesForDesiredChange(
    before: Zone | undefined,
    zone: Zone,
    affectedViews: ReadonlySet<string>,
  ): Promise<ApplyStatus[]> {
    const stored = before ? await this.#statuses.list(zone.name) : [];
    // Only names are needed here. Do not materialize the previous snapshot: a
    // deployment upgrading from a version that admitted an invalid combination
    // must still be able to replace or delete the offending record.
    const previousViews = providerViewNames(before?.views ?? []);
    const nextViews = providerViewNames(zone.views);
    const names = new Set<string>([
      ...previousViews,
      ...nextViews,
      ...stored.filter((status) => isProviderView(status.view)).map((status) => status.view),
    ]);

    const statuses: ApplyStatus[] = [];
    for (const view of [...names].sort()) {
      const current = stored.find((status) => status.view === view);
      const removedNow = previousViews.has(view) && !nextViews.has(view);
      const addedNow = !previousViews.has(view) && nextViews.has(view);
      if (!current || affectedViews.has(view) || removedNow || addedNow) {
        statuses.push(pendingForRevision(current ?? {
          zone: zone.name,
          view,
          desiredRevision: 0,
          appliedRevision: 0,
          state: "pending",
        }, zone.revision, true));
        continue;
      }

      // A completed removal remains completed across unrelated revisions. It is
      // retained as a hidden tombstone so apply does not withdraw it again.
      const completed = current.state === "applied"
        && current.desiredRevision === current.appliedRevision
        && current.desiredRevision <= (before?.revision ?? 0);
      if (completed && (!nextViews.has(view) || current.desiredRevision === before?.revision)) {
        statuses.push({
          zone: zone.name,
          view,
          desiredRevision: zone.revision,
          appliedRevision: zone.revision,
          state: "applied",
          ...(current.lastAttemptAt ? { lastAttemptAt: current.lastAttemptAt } : {}),
        });
        continue;
      }

      if (current.desiredRevision === before?.revision) {
        statuses.push({ ...current, desiredRevision: zone.revision });
        continue;
      }

      statuses.push(pendingForRevision(current, zone.revision, true));
    }
    return statuses;
  }

  async #exclusive<T>(zoneName: string, operation: () => Promise<T>): Promise<T> {
    const key = normalizeZoneName(zoneName);
    const preceding = this.#operationTails.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#operationTails.set(key, current);
    await preceding;
    try {
      // Provider reconciliation, deletion, and desired edits share one
      // cross-instance lock. Otherwise a replica can advance the desired
      // revision after deletion withdrew records but before its state commit,
      // leaving a live zone whose provider was just emptied.
      return await this.#applyLock.withZoneLock(key, operation);
    } finally {
      release();
      if (this.#operationTails.get(key) === current) this.#operationTails.delete(key);
    }
  }
}

/**
 * What adopting just changed about the names this process answers for.
 *
 * The internal view is materialized from the external one, so filling an empty
 * external view fills the internal one too -- and a zone with a non-empty
 * internal view is one the built-in listener claims authority for. That is a
 * large change hidden inside a small-sounding one: `seen` and `adopted` describe
 * records, and the thing that moved is which questions this process will answer
 * for a whole domain.
 *
 * Two consequences are worth naming separately because they are the two that
 * were actually met. A name nobody adopted is now NXDOMAIN inside, since an
 * authority does not forward what it does not hold. And a record the provider
 * proxies now answers with its origin inside, because the origin is what the
 * desired state holds -- the edge address was never ours to know.
 */
function authorityWarnings(before: Zone, after: Zone, wouldBe: boolean): string[] {
  const internalRecords = (zone: Zone): DesiredRecord[] =>
    materializeProviderViews(zone.views).find((view) => view.name === "internal")?.records ?? [];
  if (internalRecords(before).length > 0) return [];
  const now = internalRecords(after);
  if (now.length === 0) return [];

  // A dry run has changed nothing, so it must not say anything has changed. The
  // whole value of reading before writing is lost if the reading reports the
  // write as done.
  const became = wouldBe ? "would be" : "is now";
  const answer = wouldBe ? "would answer" : "answers";
  const warnings = [
    `${after.name} ${became} answered by this process rather than forwarded:`
    + ` ${now.length} name(s) are described, and any other name under ${after.name} ${answer} NXDOMAIN inside.`
    + " Adopt the rest, or the internal view is incomplete for the names it is missing",
  ];
  const proxied = (after.views.find((view) => view.name === "external")?.records ?? [])
    .filter((record) => record.proxied === true).length;
  if (proxied > 0) {
    warnings.push(
      `${proxied} proxied record(s) ${wouldBe ? "would answer" : "now answer"} with their origin inside`
      + " instead of the provider's edge."
      + " Override them in the internal view if inside traffic is meant to go through the provider",
    );
  }
  return warnings;
}

function targetKey(zone: string, view: string): string {
  return `${zone}/${view}`;
}

function publicProviderError(error: unknown): string {
  return error instanceof ConflictError || error instanceof ProviderNotConfiguredError
    || error instanceof ProviderConstraintError
    ? error.message
    : "provider operation failed";
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

function pendingForRevision(status: ApplyStatus, desiredRevision: number, keepAttempt = false): ApplyStatus {
  return {
    zone: status.zone,
    view: status.view,
    desiredRevision,
    appliedRevision: Math.min(status.appliedRevision, Math.max(0, desiredRevision - 1)),
    state: "pending",
    ...(keepAttempt && status.lastAttemptAt ? { lastAttemptAt: status.lastAttemptAt } : {}),
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

/**
 * Re-applies whole-view invariants when a durable backend opens a snapshot.
 * Per-record parsing alone cannot detect duplicate RR values, CNAME siblings,
 * external proxy constraints that span a view, or collisions introduced while
 * materializing the derived internal view.
 */
export function assertPersistedDesiredViewsValid(views: Zone["views"]): void {
  for (const view of views) ensureUniqueRecordKeys(view.records);
  // Per-record parsing already proves shape. Do not retroactively apply newer
  // operator-acknowledgement policy (for example non-global external IPs) to a
  // snapshot written by an older release; only prove cross-record invariants.
  materializeProviderViews(views, false);
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
   * Records the provider owns whose stored copy was brought back into line with
   * it. Reported separately because nothing was newly described: the count of
   * adopted records stays honest about what it means.
   */
  readonly refreshed: DesiredRecord[];
  /**
   * What adoption changed beyond the desired state, said where the operator is
   * looking. Filling an empty internal view turns the built-in listener into the
   * authority for that whole zone, and nothing about `seen` and `adopted` shows
   * it: a name nobody adopted becomes NXDOMAIN inside, and a proxied name starts
   * answering with its origin instead of the provider's edge.
   */
  readonly warnings: string[];
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

/**
 * One verdict for a zone from its views' statuses.
 *
 * A zone is only as caught up as its furthest-behind view, so one failure makes
 * the zone failed and one pending makes it pending. `""` means there is nothing
 * to reconcile -- a zone with no views has no status, and reporting that as
 * `pending` would say it is behind when there is nothing to be behind on.
 */
export function overallApplyState(statuses: readonly ApplyStatus[]): string {
  if (statuses.length === 0) return "";
  if (statuses.some((status) => status.state === "failed")) return "failed";
  return statuses.every((status) => status.state === "applied") ? "applied" : "pending";
}

/** Whether two records name the same service binding, absence included. */
function sameService(left: ManagedByService | undefined, right: ManagedByService | undefined): boolean {
  if (!left || !right) return left === right;
  return left.service === right.service && left.resource === right.resource;
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

export function materializeProviderViews(views: Zone["views"], enforceExternalPolicy = true): Zone["views"] {
  const external = views.find((view) => view.name === "external");
  const overrides = views.find((view) => view.name === "internal");
  const result = views.filter((view) => view.name !== "internal").map(cloneView);
  const normalizedExternal = result.find((view) => view.name === "external");
  if (normalizedExternal && enforceExternalPolicy) {
    normalizedExternal.records = normalizeExternalRecords(normalizedExternal.records);
  }
  if (!external && !overrides) return result;
  const effective = new Map<string, DesiredRecord[]>();
  for (const record of (normalizedExternal?.records ?? []).filter(isInheritable)) {
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

/**
 * Whether a record in the external view describes something the internal view
 * should say too.
 *
 * Apex NS records name the servers that answer for the zone, which is a fact
 * about each provider and not about the zone's contents. Inheriting them would
 * publish the public nameservers into an internal zone that a different server
 * is authoritative for -- delegating the internal view away from itself.
 */
function isInheritable(record: DesiredRecord): boolean {
  return !(record.type === "NS" && record.name === "@");
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

/** Provider-view names after split-horizon's implicit internal materialization. */
function providerViewNames(views: Zone["views"]): Set<string> {
  const names = new Set(views.filter((view) => isProviderView(view.name)).map((view) => view.name));
  if (names.has("external")) names.add("internal");
  return names;
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
