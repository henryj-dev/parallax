import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccountError, changeAccountSecurity, createLocalAccount } from "../../src/domain/accounts.ts";

const accountInput = {
  userId: "opaque-test-id", canonicalLoginKey: "Mailbox+tag@example.com",
  displayName: "Example", role: "viewer", status: "active",
} as const;

function error(code: string): (cause: unknown) => boolean {
  return (cause) => cause instanceof AccountError && cause.code === code;
}

describe("policy-independent account domain", () => {
  it("preserves the exact canonical login key and separate display name", () => {
    const account = createLocalAccount({ ...accountInput, extra: "not projected" } as typeof accountInput);
    assert.deepEqual(account, { ...accountInput, version: 1, securityEpoch: 1 });
  });

  it("changes only security fields, preserving identity and consuming version/epoch", () => {
    const original = createLocalAccount(accountInput);
    const changed = changeAccountSecurity(original, 1, { role: "editor", status: "suspended" });
    assert.deepEqual(changed, { ...original, role: "editor", status: "suspended", version: 2, securityEpoch: 2 });
    assert.equal(original.version, 1);
    assert.throws(() => changeAccountSecurity(changed, 1, {}), error("version-conflict"));
    const deleted = changeAccountSecurity(changed, 2, { status: "deleted" });
    assert.throws(() => changeAccountSecurity(deleted, 3, { status: "active" }), error("deleted"));
  });

  it("rejects invalid identity/status/role fields and counter overflow", () => {
    assert.throws(() => createLocalAccount({ ...accountInput, userId: "" }), error("invalid-input"));
    assert.throws(() => createLocalAccount({ ...accountInput, canonicalLoginKey: "" }), error("invalid-input"));
    assert.throws(() => createLocalAccount({ ...accountInput, role: "owner" as "viewer" }), error("invalid-input"));
    assert.throws(() => createLocalAccount({ ...accountInput, status: "deleted" as "active" }), error("invalid-input"));
    const account = createLocalAccount(accountInput);
    assert.throws(() => changeAccountSecurity(account, 1, { role: "owner" as "viewer" }), error("invalid-input"));
    assert.throws(() => changeAccountSecurity({ ...account, securityEpoch: Number.MAX_SAFE_INTEGER }, 1, {}), error("invalid-input"));
  });
});
