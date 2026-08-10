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
  /** Replaced on every change so the security layer can cache by identity. */
  #security: SecurityConfig;

  constructor(repository: AccessTokenRepository, bootstrap: readonly TokenRecord[] = [], now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#bootstrap = bootstrap;
    this.#now = now;
    this.#security = this.#buildSecurity();
  }

  async load(): Promise<void> {
    this.#stored = await this.#repository.list();
    this.#security = this.#buildSecurity();
  }

  /** A stable object while nothing changes, so prepared digests stay cached. */
  security(): SecurityConfig {
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
    await this.#repository.create(record);
    await this.load();
    return {
      token,
      metadata: { id: record.id, subject: record.subject, role: record.role, createdAt: record.createdAt, managed: false },
    };
  }

  /** Refuses to remove the last administrator so a deployment cannot lock itself out. */
  async revoke(id: string): Promise<boolean> {
    const target = this.#stored.find((token) => token.id === id);
    if (!target) return false;
    if (target.role === "admin" && this.#remainingAdmins(id) === 0) {
      throw new DomainValidationError(["the last administrator token cannot be revoked"]);
    }
    const removed = await this.#repository.delete(id);
    await this.load();
    return removed;
  }

  #remainingAdmins(excludedId: string): number {
    return this.#bootstrap.filter((record) => record.role === "admin").length
      + this.#stored.filter((token) => token.role === "admin" && token.id !== excludedId).length;
  }

  #buildSecurity(): SecurityConfig {
    const digests: TokenDigestRecord[] = this.#stored.map((token) => ({
      digest: token.digest,
      role: token.role,
      subject: token.subject,
    }));
    return {
      // With no token anywhere the control plane is open, exactly as before any
      // token existed; the server refuses proxied requests in that state.
      enabled: this.#bootstrap.length > 0 || digests.length > 0,
      tokens: this.#bootstrap,
      digests,
    };
  }
}
