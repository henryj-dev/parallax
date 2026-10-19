import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKUP_FORMAT, BackupError, exportBackup, importBackup, readBackupDocument, type BackupStores } from "../../src/application/backup.ts";
import { createFileStateAdapters } from "../../src/infrastructure/file-state.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";
import { InMemoryAccountStateStore } from "../../src/infrastructure/account-state.ts";
import type { CredentialRepository } from "../../src/application/ports.ts";
import {
  createInMemoryAdapters, InMemoryAccessTokenRepository, InMemorySettingsRepository,
} from "../../src/infrastructure/in-memory.ts";
import { accountFixture, enrolledAdministrator } from "../support/accounts.ts";

const directories: string[] = [];
class InMemoryCredentialRepository implements CredentialRepository {
  #document: string | undefined;
  async read(): Promise<string | undefined> { return this.#document; }
  async write(document: string): Promise<void> { this.#document = document; }
  async update<T>(operation: (document: string | undefined) => { document: string; result: T }): Promise<T> {
    const { document, result } = operation(this.#document); this.#document = document; return result;
  }
}
after(async () => { await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fileStores(): Promise<BackupStores & { accounts: NonNullable<BackupStores["accounts"]> }> {
  const directory = await mkdtemp(join(tmpdir(), "parallax-account-backup-"));
  directories.push(directory);
  const persisted = createFileStateAdapters(join(directory, "state.json"));
  const configuration = new FileConfigurationStore(join(directory, "config.json"));
  return {
    zones: persisted.zones, statuses: persisted.statuses, settings: configuration.settings,
    accessTokens: configuration.accessTokens, credentials: configuration.credentials, accounts: configuration.accounts,
  };
}
function memoryStores(withAccounts = true): BackupStores {
  const persisted = createInMemoryAdapters();
  return {
    zones: persisted.zones, statuses: persisted.statuses, settings: new InMemorySettingsRepository(),
    accessTokens: new InMemoryAccessTokenRepository(), credentials: new InMemoryCredentialRepository(),
    ...(withAccounts ? { accounts: new InMemoryAccountStateStore() } : {}),
  };
}

/** A source with an enrolled administrator, an invited member, live sessions and an unused reset link. */
async function populatedSource() {
  const stores = await fileStores();
  const f = accountFixture(stores.accounts);
  const service = await f.create();
  const admin = await enrolledAdministrator(service, f);
  await service.invite(admin.actor, "member@example.com", "editor");
  const invitation = new URL(f.messages.at(-1)!.link).searchParams.get("token")!;
  await service.acceptInvite(invitation, "member@example.com", "test-password-2", "Member", "203.0.113.7");
  const member = await service.login("member@example.com", "test-password-2", "203.0.113.7");
  assert.ok("token" in member);
  await service.requestPasswordReset("member@example.com", "203.0.113.7");
  const reset = new URL(f.messages.at(-1)!.link).searchParams.get("token")!;
  return { stores, f, admin, member, reset };
}

describe("member accounts in backups", () => {
  it("carries members, hashes, factors and audit, and never sessions, links or counters", async () => {
    const { stores, admin, member, reset } = await populatedSource();
    const document = await exportBackup(stores);
    assert.equal(document.format, BACKUP_FORMAT);
    assert.equal(BACKUP_FORMAT, 2);
    const accounts = document.accounts!;
    assert.equal(accounts.state.users.length, 2);
    assert.deepEqual([accounts.state.sessions, accounts.state.tokens, accounts.state.throttle], [[], [], []]);
    assert.ok(accounts.audit.length > 0);
    const text = JSON.stringify(document);
    for (const secret of [admin.token, member.token, reset, admin.secret, "test-password-1", "test-password-2", ...admin.recoveryCodes]) {
      assert.equal(text.includes(secret), false, "a live secret or plaintext reached the backup");
    }

    const target = memoryStores();
    const summary = await importBackup(target, readBackupDocument(JSON.parse(text)));
    assert.equal(summary.members, 2);
    const restored = await target.accounts!.read();
    assert.equal(restored.enabled, true);
    assert.equal(restored.sessions.length, 0);
    assert.deepEqual(restored.users.map((user) => user.canonicalLoginKey).sort(), ["admin@example.com", "member@example.com"]);

    // Same key, same people: the password still verifies and the admin still needs the factor; old sessions and links do not exist.
    const g = accountFixture(target.accounts!);
    const service = await g.create();
    assert.deepEqual(await service.resolve(member.token, new AbortController().signal), { status: "rejected" });
    await assert.rejects(service.resetPassword(reset, "test-password-9", "203.0.113.7"));
    const login = await service.login("admin@example.com", "test-password-1", "203.0.113.7");
    assert.ok("challenge" in login && login.enrollmentRequired === false);
  });

  it("refuses a document with accounts where this process has no account store, before writing anything", async () => {
    const { stores } = await populatedSource();
    const document = readBackupDocument(JSON.parse(JSON.stringify(await exportBackup(stores))));
    const target = memoryStores(false);
    await assert.rejects(importBackup(target, document), (error: unknown) => error instanceof BackupError && /PARALLAX_AUTH_MODE=accounts/u.test(error.message));
    assert.deepEqual(await target.zones.list(), []);
  });

  it("refuses an account store that is already enabled, before any zone is written", async () => {
    const { stores } = await populatedSource();
    await stores.zones.commitDesiredChange({
      snapshot: { name: "alpha.example", revision: 1, views: [{ name: "internal", records: [{ id: "root", name: "@", type: "A" as const, content: "192.0.2.1", ttl: 60 }] }], createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:01:00.000Z" },
      audit: { zone: "alpha.example", revision: 1, action: "record.upserted" as const, actor: "alice", at: "2026-08-08T00:01:00.000Z", detail: {} },
      statuses: [],
    });
    const document = readBackupDocument(JSON.parse(JSON.stringify(await exportBackup(stores))));
    assert.equal(document.zones.length, 1);
    const target = memoryStores();
    const t = accountFixture(target.accounts!);
    await (await t.create()).enable();
    await assert.rejects(importBackup(target, document), /already enabled or populated/u);
    assert.deepEqual(await target.zones.list(), []);
  });

  it("reads the account section strictly", async () => {
    const { stores } = await populatedSource();
    const base = JSON.parse(JSON.stringify(await exportBackup(stores)));
    const variants: [string, (document: any) => void][] = [
      ["unknown section field", (d) => { d.accounts.extra = true; }],
      ["unknown state field", (d) => { d.accounts.state.extra = true; }],
      ["a session", (d) => { d.accounts.state.sessions = [{ digest: "x".repeat(43), userId: d.accounts.state.users[0].userId, epoch: 1, createdAt: 1, lastSeenAt: 1, absoluteExpiresAt: 2, idleExpiresAt: 2, mfaAt: null, kind: "account" }]; }],
      ["a member with a duplicate address", (d) => { d.accounts.state.users[1].canonicalLoginKey = d.accounts.state.users[0].canonicalLoginKey; }],
      ["accounts never enabled", (d) => { d.accounts.state.enabled = false; }],
      ["accounts in format 1", (d) => { d.format = 1; }],
    ];
    for (const [label, change] of variants) {
      const document = structuredClone(base);
      change(document);
      assert.throws(() => readBackupDocument(document), BackupError, label);
    }
  });

  it("restores every activation stage as it was taken, with sign-in still closed until the administrator enrolls", async () => {
    for (const stage of ["enabled", "enrolling", "recovering"] as const) {
      const stores = await fileStores();
      const f = accountFixture(stores.accounts);
      const service = await f.create();
      if (stage === "enabled") await service.enable();
      else if (stage === "enrolling") { await service.enable(); await service.bootstrap("admin@example.com", "test-password-1", "Admin"); }
      else {
        await enrolledAdministrator(service, f);
        await service.recoverAdministratorHost((await stores.accounts.read()).users[0]!.userId);
      }
      const taken = await stores.accounts.read();
      const document = readBackupDocument(JSON.parse(JSON.stringify(await exportBackup(stores))));
      assert.equal(document.format, 2, stage);
      const target = memoryStores();
      await importBackup(target, document);
      const restored = await target.accounts!.read();
      assert.deepEqual([restored.enabled, restored.bootstrap, restored.users.length, restored.tokens.length, restored.sessions.length],
        [true, taken.bootstrap, taken.users.length, 0, 0], stage);
      const g = accountFixture(target.accounts!);
      const next = await g.create();
      if (stage === "enabled") {
        const result = await next.bootstrap("admin@example.com", "test-password-1", "Admin");
        assert.ok("challenge" in result, "a restored, enabled but empty store still bootstraps on the host");
        continue;
      }
      // No challenge came back. The administrator's password sign-in issues a fresh enrollment challenge,
      // and no member session works until that enrollment completes.
      const login = await next.login("admin@example.com", "test-password-1", "203.0.113.7");
      assert.ok("challenge" in login && login.enrollmentRequired, stage);
      const enrollment = await next.beginEnrollment({ challenge: login.challenge });
      const done = await next.confirmEnrollment({ challenge: login.challenge, otp: g.otp(enrollment.secretBase32), ip: "203.0.113.7" });
      assert.equal((await target.accounts!.read()).bootstrap, "ready", stage);
      assert.equal((await next.resolve(done.token, new AbortController().signal)).status, "active", stage);
    }
  });

  it("still restores a format 1 document, which carries no accounts", async () => {
    const target = memoryStores();
    const summary = await importBackup(target, readBackupDocument({ format: 1, takenAt: "2026-08-24T00:00:00.000Z", zones: [], audit: [], statuses: [], settings: {}, accessTokens: [] }));
    assert.equal(summary.members, 0);
    assert.equal((await target.accounts!.read()).enabled, false);
  });
});
