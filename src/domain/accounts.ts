// Type-only reuse: no dependency on the HTTP authentication runtime is emitted.
import type { Role } from "../security/http-authorization.ts";

export type AccountStatus = "active" | "suspended" | "deleted";

/** Public account projection. Credentials and session identifiers never belong here. */
export interface Account {
  readonly userId: string;
  /** Already validated by the caller's normalizer; compared exactly, never rewritten here. */
  readonly canonicalLoginKey: string;
  readonly displayName: string;
  readonly role: Role;
  readonly status: AccountStatus;
  readonly version: number;
  readonly securityEpoch: number;
}


export type AccountErrorCode =
  | "invalid-input" | "duplicate-id" | "duplicate-login-key" | "not-found"
  | "version-conflict" | "deleted" | "last-admin" | "inactive"
  | "stale-epoch" | "mfa-required" | "duplicate-session";

/** Fixed messages deliberately exclude login keys, hashes and session digests. */
export class AccountError extends Error {
  override readonly name = "AccountError";
  readonly code: AccountErrorCode;

  constructor(code: AccountErrorCode) {
    super(`account operation rejected: ${code}`);
    this.code = code;
  }
}

export function requireAccountText(value: string): void {
  if (typeof value !== "string" || value.length === 0) throw new AccountError("invalid-input");
}

export function requireAccountRole(value: Role): void {
  if (!["viewer", "editor", "admin"].includes(value)) throw new AccountError("invalid-input");
}

export function createLocalAccount(input: {
  readonly userId: string;
  readonly canonicalLoginKey: string;
  readonly displayName: string;
  readonly role: Role;
  readonly status: Exclude<AccountStatus, "deleted">;
}): Account {
  requireAccountText(input.userId);
  requireAccountText(input.canonicalLoginKey);
  requireAccountText(input.displayName);
  requireAccountRole(input.role);
  if (!["active", "suspended"].includes(input.status)) throw new AccountError("invalid-input");
  return {
    userId: input.userId,
    canonicalLoginKey: input.canonicalLoginKey,
    displayName: input.displayName,
    role: input.role,
    status: input.status,
    version: 1,
    securityEpoch: 1,
  };
}

/** Every successful security mutation consumes one version and invalidates authentication work. */
export function changeAccountSecurity(
  account: Account,
  expectedVersion: number,
  patch: { readonly role?: Role; readonly status?: AccountStatus },
): Account {
  if (account.version !== expectedVersion) throw new AccountError("version-conflict");
  if (account.status === "deleted") throw new AccountError("deleted");
  if ((patch.role !== undefined && !["viewer", "editor", "admin"].includes(patch.role))
    || (patch.status !== undefined && !["active", "suspended", "deleted"].includes(patch.status))
    || account.version >= Number.MAX_SAFE_INTEGER
    || account.securityEpoch >= Number.MAX_SAFE_INTEGER) throw new AccountError("invalid-input");
  return {
    ...account,
    ...(patch.role === undefined ? {} : { role: patch.role }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    version: account.version + 1,
    securityEpoch: account.securityEpoch + 1,
  };
}
