import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAccountStateStore } from "../../src/infrastructure/account-state.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";
import { accountFixture, enrolledAdministrator } from "../support/accounts.ts";
import { canonicalAccountEmail, readAccountPolicy } from "../../src/domain/account-policy.ts";
import { accountTestPolicy } from "../support/accounts.ts";
import { createAccountRoutes } from "../../src/http/account-routes.ts";

for (const backend of ["memory", "file"] as const) describe(`member accounts (${backend}, two service instances)`, () => {
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "parallax-members-"));
    const path = join(directory, "configuration.json");
    const store = backend === "memory" ? new InMemoryAccountStateStore() : new FileConfigurationStore(path).accounts;
    const f = accountFixture(store), a = await f.create();
    const second = backend === "file" ? new FileConfigurationStore(path).accounts : store;
    const b = await accountFixture(second).create();
    return { ...f, a, b, store, path, close: () => rm(directory, { recursive: true, force: true }) };
  }
  it("activation is explicit and bootstrap only issues an enrollment challenge", async () => {
    const f = await fixture();
    try {
      assert.equal(await f.a.enabled(), false);
      await assert.rejects(f.a.login("admin@example.com", "test-password-1", "203.0.113.7"), { code: "not-enabled" });
      await f.a.enable();
      const outcomes = await Promise.allSettled([f.a.bootstrap("admin@example.com", "test-password-1", "Admin"), f.b.bootstrap("other@example.com", "test-password-2", "Other")]);
      assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
      const state = (await f.store.snapshot()).state; assert.equal(state.users.length, 1); assert.equal(state.sessions.length, 0); assert.equal(state.bootstrap, "enrollment");
    } finally { await f.close(); }
  });
  it("rejects concurrent OTP replay and single-use recovery replay across instances", async () => {
    const f = await fixture();
    try {
      const admin = await enrolledAdministrator(f.a, f); f.advance();
      const challenges = await Promise.all([f.a.login("admin@example.com", "test-password-1", "203.0.113.7"), f.a.login("admin@example.com", "test-password-1", "10.0.0.11")]);
      assert.ok("challenge" in challenges[0]! && "challenge" in challenges[1]!);
      const first = challenges[0] as { challenge: string }, second = challenges[1] as { challenge: string };
      const replay = await Promise.allSettled([f.a.completeMfa(first.challenge, f.otp(admin.secret), "203.0.113.7"), f.a.completeMfa(second.challenge, f.otp(admin.secret), "10.0.0.11")]);
      assert.equal(replay.filter((x) => x.status === "fulfilled").length, 1);
      const next = await f.a.login("admin@example.com", "test-password-1", "203.0.113.7"); assert.ok("challenge" in next);
      const recovery = await Promise.allSettled([f.a.completeMfa(next.challenge, admin.recoveryCodes[0]!, "203.0.113.7"), f.b.completeMfa(next.challenge, admin.recoveryCodes[0]!, "10.0.0.11")]);
      assert.equal(recovery.filter((x) => x.status === "fulfilled").length, 1);
    } finally { await f.close(); }
  });
  it("binds invitations to exact normalized email, sends outside transactions and never logs in on reset", async () => {
    const f = await fixture();
    try {
      const admin = await enrolledAdministrator(f.a, f);
      await f.a.invite(admin.actor, "Member+tag@example.com", "editor");
      const token = new URL(f.messages.at(-1)!.link).searchParams.get("token")!;
      await assert.rejects(f.a.acceptInvite(token, "member@example.com", "test-password-2", "Member", "203.0.113.7"));
      await f.a.acceptInvite(token, "MEMBER+TAG@EXAMPLE.COM", "test-password-2", "Member", "203.0.113.7");
      await assert.rejects(f.b.acceptInvite(token, "member+tag@example.com", "test-password-2", "Member", "203.0.113.7"));
      const login = await f.b.login("member+tag@example.com", "test-password-2", "203.0.113.7"); assert.ok("token" in login);
      await f.a.requestPasswordReset("member+tag@example.com", "203.0.113.7");
      const reset = new URL(f.messages.at(-1)!.link).searchParams.get("token")!;
      await f.b.resetPassword(reset, "test-password-3", "203.0.113.7");
      assert.deepEqual(await f.a.resolve(login.token, new AbortController().signal), { status: "rejected" });
      const administratorId = (await f.a.context(admin.token)).user.userId;
      assert.equal((await f.store.snapshot()).state.sessions.filter((s) => s.userId !== administratorId).length, 0);
      await assert.rejects(f.a.resetPassword(reset, "test-password-4", "203.0.113.7"));
    } finally { await f.close(); }
  });
  it("revokes on the next request and protects the last enrolled password administrator atomically", async () => {
    const f = await fixture();
    try {
      const admin = await enrolledAdministrator(f.a, f);
      await f.a.invite(admin.actor, "second@example.com", "admin");
      await f.a.acceptInvite(new URL(f.messages.at(-1)!.link).searchParams.get("token")!, "second@example.com", "test-password-2", "Second", "203.0.113.7");
      const challenge = await f.b.login("second@example.com", "test-password-2", "10.0.0.11"); assert.ok("challenge" in challenge);
      const enrollment = await f.b.beginEnrollment({ challenge: challenge.challenge });
      const second = await f.b.confirmEnrollment({ challenge: challenge.challenge, otp: f.otp(enrollment.secretBase32), ip: "10.0.0.11" });
      const members = await f.a.listMembers(admin.actor), firstUser = members.find((u) => u.canonicalLoginKey === "admin@example.com")!, secondUser = members.find((u) => u.canonicalLoginKey === "second@example.com")!;
      const changes = await Promise.allSettled([f.a.changeMember(admin.actor, firstUser.userId, firstUser.version, { status: "suspended" }), f.b.changeMember({ token: second.token }, secondUser.userId, secondUser.version, { status: "deleted" })]);
      assert.equal(changes.filter((x) => x.status === "fulfilled").length, 1);
      const state = (await f.store.snapshot()).state; assert.equal(state.users.filter((u) => u.status === "active" && u.role === "admin").length, 1);
      const removed = state.users.find((u) => u.status !== "active")!;
      assert.deepEqual(await f.a.resolve(removed.userId === firstUser.userId ? admin.token : second.token, new AbortController().signal), { status: "rejected" });
    } finally { await f.close(); }
  });
  it("invalidates tokens on mail failure without storing plaintext tokens or OTP seeds", async () => {
    const f = await fixture();
    try {
      const admin = await enrolledAdministrator(f.a, f); f.failMail();
      await assert.rejects(f.a.invite(admin.actor, "member@example.com", "viewer"), { code: "unavailable" });
      const snapshot = await f.store.snapshot(); assert.equal(snapshot.state.tokens.length, 0);
      const serialized = JSON.stringify(snapshot); assert.ok(!serialized.includes(admin.token)); assert.ok(!serialized.includes(admin.secret)); assert.ok(!serialized.includes(admin.recoveryCodes[0]!));
      if (backend === "file") {
        await new FileConfigurationStore(f.path).settings.write({ revisionRetention: 10 });
        const raw = JSON.parse(await readFile(f.path, "utf8")); assert.equal(raw.version, 2); assert.deepEqual(raw.authFeatures, ["member-accounts-v1"]); assert.equal(raw.accounts.users.length, 1);
      }
    } finally { await f.close(); }
  });
  it("rejects asynchronous transaction callbacks before commit", async () => {
    const f = await fixture(); try { await assert.rejects(f.store.transact(async (t) => { t.state.enabled = true; }), /synchronous/u); assert.equal((await f.store.snapshot()).state.enabled, false); } finally { await f.close(); }
  });
});

describe("account policy and HTTP CSRF", () => {
  it("requires every policy key, rejects unknown keys and never merges email aliases", () => {
    assert.deepEqual(readAccountPolicy(accountTestPolicy), accountTestPolicy);
    for (const key of Object.keys(accountTestPolicy)) { const value = { ...accountTestPolicy } as Record<string, unknown>; delete value[key]; assert.throws(() => readAccountPolicy(value)); }
    assert.throws(() => readAccountPolicy({ ...accountTestPolicy, implicitDefault: true }));
    assert.equal(canonicalAccountEmail("A.B+tag@EXAMPLE.COM"), "a.b+tag@example.com"); assert.notEqual(canonicalAccountEmail("ab@example.com"), canonicalAccountEmail("a.b@example.com"));
  });
  it("requires same-origin and explicit CSRF header even for password login", async () => {
    const store = new InMemoryAccountStateStore(), f = accountFixture(store), service = await f.create(); await enrolledAdministrator(service, f);
    const routes = createAccountRoutes(service, () => "203.0.113.7"), url = "https://dns.example.com/api/v1/account";
    const csrf = await routes.handle(new Request(`${url}/csrf`)); assert.ok(csrf);
    const cookie = csrf.headers.get("set-cookie")!.split(";")[0]!, token = ((await csrf.json()) as { csrf: string }).csrf;
    const headers = { cookie, origin: "https://dns.example.com", "content-type": "application/json" };
    const payload = JSON.stringify({ email: "admin@example.com", password: "test-password-1" });
    assert.equal((await routes.handle(new Request(`${url}/login`, { method: "POST", headers, body: payload })))!.status, 403);
    assert.equal((await routes.handle(new Request(`${url}/login`, { method: "POST", headers: { ...headers, "x-parallax-csrf": "bad" }, body: payload })))!.status, 403);
    assert.equal((await routes.handle(new Request(`${url}/login`, { method: "POST", headers: { ...headers, "x-parallax-csrf": token }, body: payload })))!.status, 200);
    assert.equal((await routes.handle(new Request(`${url}/login`, { method: "POST", headers: { ...headers, origin: "https://other.example.com", "x-parallax-csrf": token }, body: payload })))!.status, 403);
  });
});
