import { randomBytes, randomUUID } from "node:crypto";
import { DomainValidationError } from "../domain/dns.ts";
import { tokenDigest, type Role, type SecurityConfig, type TokenDigestRecord, type TokenRecord } from "../security/http-authorization.ts";
import type { AccessTokenRepository, StoredAccessToken } from "./ports.ts";

/** Safe to return from an admin API: identifies a token without revealing it. */
export interface AccessTokenMetadata {
  readonly id: string;
  readonly subject: string;
  readonly role: Role;
  readonly createdAt: string;
  /** True for a token supplied by the environment, which the API cannot revoke. */
  readonly managed: boolean;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly metadata: AccessTokenMetadata;
}

/**
 * How long a token issued or revoked in another process may take to take
 * effect here. Short enough that an operator does not conclude the command
 * failed, long enough that the query is nothing next to serving traffic.
 */
export const TOKEN_REFRESH_INTERVAL_MS = 5_000;
/** Cached stored tokens stop authenticating after this long without a successful read. */
export const TOKEN_MAX_STALENESS_MS = 60_000;

export interface AccessTokenReadiness {
  readonly ready: boolean;
  readonly status: "fresh" | "degraded" | "stale";
  readonly staleForMs: number;
  readonly maxStalenessMs: number;
  readonly lastSuccessfulRefreshAt?: string;
}

const SUBJECT_PATTERN = /^[^\u0000-\u001f\u007f]{1,128}$/u;

/**
 * Owns who may call the control plane. Tokens are generated here and stored
 * only as digests, so the store can verify a presented token but never produce
 * one. Environment tokens remain readable as a break-glass path for a
 * deployment that has locked itself out.
 */
export class AccessTokenService {
  readonly #repository: AccessTokenRepository;
  readonly #bootstrap: readonly TokenRecord[];
  readonly #now: () => Date;
  #stored: StoredAccessToken[] = [];
  #authenticationRequired: boolean;
  #lastSuccessfulLoadAt: number | undefined;
  #lastLoadFailed = false;
  readonly #maxStalenessMs: number;
  readonly #readTimeoutMs: number;
  /** Replaced on every change so the security layer can cache by identity. */
  #security: SecurityConfig;
  #securityIsStale = false;
  /** Serializes repository I/O and publication of the resulting local view. */
  #operationTail: Promise<void> = Promise.resolve();
  /** Coalesces timer ticks while a queued or active repository read exists. */
  #loadInFlight: Promise<void> | undefined;
  /** Keeps a timed-out driver query from being duplicated until it settles. */
  #repositoryReadPending: {
    promise: Promise<StoredAccessToken[]>;
    readonly generation: number;
    expired: boolean;
  } | undefined;
  /** Invalidates repository snapshots that began before a local durable mutation. */
  #repositoryMutationGeneration = 0;

  constructor(
    repository: AccessTokenRepository,
    bootstrap: readonly TokenRecord[] = [],
    now: () => Date = () => new Date(),
    maxStalenessMs = TOKEN_MAX_STALENESS_MS,
  ) {
    if (!Number.isSafeInteger(maxStalenessMs) || maxStalenessMs < 1) throw new TypeError("token max staleness must be a positive integer");
    this.#repository = repository;
    this.#bootstrap = bootstrap;
    this.#now = now;
    this.#maxStalenessMs = maxStalenessMs;
    this.#readTimeoutMs = Math.min(TOKEN_REFRESH_INTERVAL_MS, maxStalenessMs);
    this.#authenticationRequired = bootstrap.length > 0;
    this.#security = this.#buildSecurity();
  }

  load(): Promise<void> {
    if (this.#loadInFlight) return this.#loadInFlight;
    const request = this.#enqueue(() => this.#loadFromRepository());
    this.#loadInFlight = request;
    const clear = (): void => {
      if (this.#loadInFlight === request) this.#loadInFlight = undefined;
    };
    void request.then(clear, clear);
    return request;
  }

  async #loadFromRepository(): Promise<void> {
    try {
      this.#stored = await this.#readFromRepository();
    } catch (error) {
      this.#lastLoadFailed = true;
      this.#refreshSecurity();
      throw error;
    }
    if (this.#stored.length > 0) this.#authenticationRequired = true;
    this.#lastSuccessfulLoadAt = this.#now().valueOf();
    this.#lastLoadFailed = false;
    this.#refreshSecurity();
  }

  async #readFromRepository(): Promise<StoredAccessToken[]> {
    if (!this.#repositoryReadPending) {
      const raw = this.#repository.list();
      const pending = {
        promise: raw,
        generation: this.#repositoryMutationGeneration,
        expired: false,
      };
      pending.promise = raw.finally(() => {
        if (this.#repositoryReadPending === pending) this.#repositoryReadPending = undefined;
      });
      this.#repositoryReadPending = pending;
    }
    const pending = this.#repositoryReadPending;
    if (pending.expired || pending.generation !== this.#repositoryMutationGeneration) {
      throw new Error("access-token repository read predates the most recent mutation");
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      const stored = await Promise.race([
        pending.promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            pending.expired = true;
            reject(new Error("access-token repository read timed out"));
          }, this.#readTimeoutMs);
          timeout.unref?.();
        }),
      ]);
      if (pending.expired || pending.generation !== this.#repositoryMutationGeneration) {
        throw new Error("access-token repository read predates the most recent mutation");
      }
      return stored;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /** Health detail for `/health/ready`; stale cached digests are fail-closed. */
  readiness(): AccessTokenReadiness {
    const staleForMs = this.#staleForMs();
    const stale = this.#isStale();
    return {
      ready: !stale,
      status: stale ? "stale" : this.#lastLoadFailed ? "degraded" : "fresh",
      staleForMs,
      maxStalenessMs: this.#maxStalenessMs,
      ...(this.#lastSuccessfulLoadAt === undefined
        ? {}
        : { lastSuccessfulRefreshAt: new Date(this.#lastSuccessfulLoadAt).toISOString() }),
    };
  }

  /**
   * Keeps this process's view of the tokens close to the store's.
   *
   * Issuing and revoking through this instance updates it immediately, but a
   * token issued anywhere else -- the command line in a `kubectl exec`, another
   * replica, a second server -- is written to the store and nowhere else. A
   * process that only ever loaded at startup would refuse a valid token, and,
   * worse, would keep accepting one that had been revoked. Both look like the
   * store lying, and the second is a revocation that does not revoke.
   *
   * A store read on a fixed interval bounds that window regardless of how much
   * traffic the process is taking. A read that fails leaves the previous view
   * in place: the store being briefly unreachable should not lock out everyone
   * holding a valid token.
   */
  startRefreshing(intervalMs = TOKEN_REFRESH_INTERVAL_MS, onError: (error: unknown) => void = () => {}): () => void {
    const timer = setInterval(() => {
      this.load().catch(onError);
    }, intervalMs);
    // Refreshing is not a reason for the process to stay alive.
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** A stable object while nothing changes, so prepared digests stay cached. */
  security(): SecurityConfig {
    // Crossing the staleness deadline does not require a timer callback at the
    // exact millisecond. The next request observes it and drops stored digests.
    if (this.#securityIsStale !== this.#isStale()) this.#refreshSecurity();
    return this.#security;
  }

  list(): AccessTokenMetadata[] {
    return [
      ...this.#bootstrap.map((record, index) => ({
        id: `environment-${index + 1}`,
        subject: record.subject,
        role: record.role,
        createdAt: new Date(0).toISOString(),
        managed: true,
      })),
      ...this.#stored.map((token) => ({
        id: token.id,
        subject: token.subject,
        role: token.role,
        createdAt: token.createdAt,
        managed: false,
      })),
    ];
  }

  /** Returns the token exactly once; only its digest is persisted. */
  async issue(subject: unknown, role: unknown): Promise<IssuedAccessToken> {
    const issues: string[] = [];
    if (typeof subject !== "string" || !SUBJECT_PATTERN.test(subject.trim()) || subject.trim().length === 0) {
      issues.push("subject must be a non-empty single-line string");
    }
    if (role !== "admin" && role !== "editor" && role !== "viewer") {
      issues.push("role must be admin, editor or viewer");
    }
    if (issues.length > 0) throw new DomainValidationError(issues);

    const token = randomBytes(32).toString("base64url");
    const record: StoredAccessToken = {
      id: randomUUID(),
      subject: (subject as string).trim(),
      role: role as Role,
      digest: tokenDigest(token),
      createdAt: this.#now().toISOString(),
    };
    return this.#enqueue(async () => {
      await this.#repository.create(record);
      this.#repositoryMutationGeneration += 1;
      // A successful durable create is authoritative even if the follow-up list
      // fails. Make the new token usable here immediately and let readiness expose
      // the failed refresh rather than returning a token that this replica rejects.
      this.#stored = [...this.#stored.filter((existing) => existing.id !== record.id), record];
      this.#authenticationRequired = true;
      this.#refreshSecurity();
      await this.#loadFromRepository().catch(() => undefined);
      return {
        token,
        metadata: { id: record.id, subject: record.subject, role: record.role, createdAt: record.createdAt, managed: false },
      };
    });
  }

  /** Refuses to remove the last administrator so a deployment cannot lock itself out. */
  async revoke(id: string): Promise<boolean> {
    const retainedAdministrators = this.#bootstrap.filter((record) => record.role === "admin").length;
    return this.#enqueue(async () => {
      const result = await this.#repository.revoke(id, retainedAdministrators);
      if (result === "not-found") return false;
      if (result === "last-admin") {
        throw new DomainValidationError(["the last administrator token cannot be revoked"]);
      }
      this.#repositoryMutationGeneration += 1;
      // Discard locally before the best-effort reload. A read failure after the
      // durable delete must never keep the revoked digest active or turn success
      // into a misleading 500 followed by a 404 on retry.
      this.#stored = this.#stored.filter((token) => token.id !== id);
      this.#refreshSecurity();
      await this.#loadFromRepository().catch(() => undefined);
      return true;
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation);
    this.#operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #buildSecurity(): SecurityConfig {
    const stale = this.#isStale();
    const digests: TokenDigestRecord[] = (stale ? [] : this.#stored).map((token) => ({
      digest: token.digest,
      role: token.role,
      subject: token.subject,
    }));
    return {
      // Open mode is a startup decision. Once this process has observed any
      // token, an empty/corrupt/stale store can only fail closed, never turn a
      // running non-loopback deployment into authentication-disabled admin.
      enabled: this.#authenticationRequired,
      tokens: this.#bootstrap,
      digests,
    };
  }

  #refreshSecurity(): void {
    this.#securityIsStale = this.#isStale();
    this.#security = this.#buildSecurity();
  }

  #staleForMs(): number {
    if (this.#lastSuccessfulLoadAt === undefined) return 0;
    return Math.max(0, this.#now().valueOf() - this.#lastSuccessfulLoadAt);
  }

  #isStale(): boolean {
    return this.#lastSuccessfulLoadAt !== undefined && this.#staleForMs() >= this.#maxStalenessMs;
  }
}

/**
 * Bootstrap tokens have no generator to vouch for their entropy, so accept
 * only the canonical format produced by `randomBytes(32).toString("base64url")`.
 * Configuration parsing can use this helper before constructing the service.
 */
export function isStrongBootstrapToken(token: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  const decoded = Buffer.from(token, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === token;
}
