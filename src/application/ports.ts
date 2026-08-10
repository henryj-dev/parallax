import type { AuditEntry, Zone, ZoneRevision } from "../domain/dns.ts";
import type { ProviderRecord, ReconcileOperation } from "../domain/reconciliation.ts";

export class RevisionConflictError extends Error {}

/** No provider implementation is wired for a `<zone>/<view>` target. */
export class ProviderNotConfiguredError extends Error {}

export interface DesiredChange {
  snapshot: ZoneRevision;
  audit: Omit<AuditEntry, "id">;
  statuses: ApplyStatus[];
}

export interface ZoneDeletion {
  zone: string;
  expectedRevision: number;
  audit: Omit<AuditEntry, "id">;
}

export interface ZoneRepository {
  list(): Promise<Zone[]>;
  get(name: string): Promise<Zone | undefined>;
  save(zone: Zone): Promise<void>;
  /** Atomically stores a new immutable snapshot and makes it the current zone. */
  saveRevision(snapshot: ZoneRevision): Promise<void>;
  /** Atomically commits the desired snapshot, audit event, and pending apply statuses. */
  commitDesiredChange(change: DesiredChange): Promise<void>;
  /** Atomically records the deletion audit event and removes the zone, revisions, and apply statuses. */
  commitZoneDeletion(deletion: ZoneDeletion): Promise<void>;
  listRevisions(zone: string): Promise<ZoneRevision[]>;
  getRevision(zone: string, revision: number): Promise<ZoneRevision | undefined>;
  delete(name: string): Promise<void>;
  appendAudit(entry: Omit<AuditEntry, "id">): Promise<AuditEntry>;
  audit(zone?: string): Promise<AuditEntry[]>;
}

export interface ProviderAdapter {
  list(target: string): Promise<ProviderRecord[]>;
  apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void>;
}

/** Coordinates provider reconciliation for a zone across control-plane instances. */
export interface ApplyLock {
  withZoneLock<T>(zone: string, operation: () => Promise<T>): Promise<T>;
}

export interface ApplyStatus {
  zone: string;
  view: string;
  desiredRevision: number;
  appliedRevision: number;
  state: "pending" | "applied" | "failed";
  lastAttemptAt?: string;
  error?: string;
}

export interface StatusRepository {
  get(zone: string, view: string): Promise<ApplyStatus | undefined>;
  list(zone: string): Promise<ApplyStatus[]>;
  /** Saves unless a newer desired revision is already present for this zone/view. */
  save(status: ApplyStatus): Promise<void>;
  deleteZone(zone: string): Promise<void>;
}
