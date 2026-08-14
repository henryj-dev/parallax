import type { AuditEntry, Zone, ZoneRevision } from "../domain/dns.ts";
import type { ProviderRecord, ReconcileOperation } from "../domain/reconciliation.ts";

export class RevisionConflictError extends Error {
  override readonly name = "RevisionConflictError";
}

/** No provider implementation is wired for a `<zone>/<view>` target. */
export class ProviderNotConfiguredError extends Error {
  override readonly name = "ProviderNotConfiguredError";
}

/**
 * A limit of the provider that Parallax checked itself, before or while
 * writing: the record is valid, and this particular provider cannot hold it.
 *
 * Separate from an error the provider returned, which is withheld from callers
 * because it can quote a request that carried a token or a path. This message
 * is Parallax's own sentence about Parallax's own data, so hiding it only costs
 * the reader the one thing that would have explained the failure.
 */
export class ProviderConstraintError extends Error {
  override readonly name = "ProviderConstraintError";
}

/**
 * Bounds what a zone's history keeps. Applied inside the same atomic commit as
 * the change that produced it, so storage cannot grow without limit.
 */
export interface RetentionPolicy {
  /** Newest snapshots to keep for the zone. Omit or use 0 to keep every one. */
  readonly maxRevisionsPerZone?: number;
  /** ISO timestamp; audit entries for the zone recorded before it are removed. */
  readonly deleteAuditBefore?: string;
}

export interface DesiredChange {
  snapshot: ZoneRevision;
  audit: Omit<AuditEntry, "id">;
  statuses: ApplyStatus[];
  retention?: RetentionPolicy;
}

export interface ZoneDeletion {
  zone: string;
  expectedRevision: number;
  audit: Omit<AuditEntry, "id">;
  retention?: RetentionPolicy;
}

/** Key/value persistence for operator-owned settings. */
export interface SettingsRepository {
  read(): Promise<Record<string, unknown>>;
  /** Writes only the supplied keys, leaving every other setting untouched. */
  write(values: Record<string, unknown>): Promise<void>;
}

/**
 * Persists the sealed credential document. Implementations move an opaque
 * string; the encryption key never leaves the application, so neither backend
 * can read what it stores.
 */
export interface CredentialRepository {
  read(): Promise<string | undefined>;
  write(document: string): Promise<void>;
}

export interface StoredAccessToken {
  readonly id: string;
  readonly subject: string;
  readonly role: "admin" | "editor" | "viewer";
  /** Base64url SHA-256 of the token; the token itself is never stored. */
  readonly digest: string;
  readonly createdAt: string;
}

export interface AccessTokenRepository {
  list(): Promise<StoredAccessToken[]>;
  create(token: StoredAccessToken): Promise<void>;
  delete(id: string): Promise<boolean>;
}

/** A bounded window over an otherwise unbounded history listing. */
export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
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
  /** Ascending by revision. With a page, returns the newest window, still ascending. */
  listRevisions(zone: string, page?: PageRequest): Promise<ZoneRevision[]>;
  getRevision(zone: string, revision: number): Promise<ZoneRevision | undefined>;
  delete(name: string): Promise<void>;
  appendAudit(entry: Omit<AuditEntry, "id">): Promise<AuditEntry>;
  /** Newest first. Without a page the complete history is returned. */
  audit(zone?: string, page?: PageRequest): Promise<AuditEntry[]>;
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
  /**
   * On a failure, how many of the plan's operations the provider had already
   * accepted. A provider is reached one record at a time over a network, so a
   * view that fails part way through is left part applied and its resolver
   * answers for part of it. `failed` alone does not say that, and the operator
   * has to know it before deciding whether to retry or to look at what is live.
   */
  completedOperations?: number;
  plannedOperations?: number;
}

export interface StatusRepository {
  get(zone: string, view: string): Promise<ApplyStatus | undefined>;
  list(zone: string): Promise<ApplyStatus[]>;
  /** Saves unless a newer desired revision is already present for this zone/view. */
  save(status: ApplyStatus): Promise<void>;
  deleteZone(zone: string): Promise<void>;
}
