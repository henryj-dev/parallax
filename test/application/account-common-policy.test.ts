import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { passwordComposition } from "../../src/application/accounts/service.ts";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { readAccountPolicy, type AccountPolicy } from "../../src/domain/account-policy.ts";
import { createApiHandler } from "../../src/http/api.ts";
import { InMemoryAccountStateStore } from "../../src/infrastructure/account-state.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";
import { accountFixture, accountTestPolicy, enrolledAdministrator } from "../support/accounts.ts";

const failed = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => "ok", (error: { code?: string }) => error.code);

async function deployment(policy: AccountPolicy = accountTestPolicy) {
  const store = new InMemoryAccountStateStore();
  const f = accountFixture(store, policy);
  const service = await f.create();
  const admin = await enrolledAdministrator(service, f);
  await service.invite(admin.actor, "member@example.com", "viewer");
  await service.acceptInvite(new URL(f.messages.at(-1)!.link).searchParams.get("token")!, "member@example.com", "test-password-2", "Member", "198.51.100.200");
  return { store, f, service, admin };
}

describe("the shared password rule", () => {
  it("wants eight characters and three of four kinds, judged after NFC", () => {
    assert.equal(passwordComposition("abcdefgH", 8), false, "two kinds");
    assert.equal(passwordComposition("abcdefg1", 8), false, "two kinds");
    assert.equal(passwordComposition("abcdef1H", 8), true, "three kinds");
    assert.equal(passwordComposition("abc 1def", 8), true, "a space is the fourth kind");
    assert.equal(passwordComposition("비밀번호를길게12", 8), false, "Hangul and digits are two kinds");
    assert.equal(passwordComposition("비밀번호를길게12a", 8), true, "Hangul counts as anything else: with digits and lower case, three");
    assert.equal(passwordComposition("Ab1defg", 8), false, "seven characters");
    // e + combining acute is two code points before NFC and one after.
    assert.equal(passwordComposition("Abc1xyé", 8), false, "eight code points raw, seven after NFC");
    assert.equal(passwordComposition("Abc1xyzé", 8), true, "eight after NFC");
    assert.equal(passwordComposition("Abc1def\ud800", 8), false, "malformed UTF-16");
  });

  it("refuses a weak password before hashing on every path that sets one, and answers it as such", async () => {
    const { f, service, admin, store } = await deployment();
    await service.invite(admin.actor, "weak@example.com", "viewer");
    const token = new URL(f.messages.at(-1)!.link).searchParams.get("token")!;
    assert.equal(await failed(service.acceptInvite(token, "weak@example.com", "alllowercase", "Weak", "198.51.100.1")), "weak-password");
    assert.equal((await store.read()).users.some((u) => u.canonicalLoginKey === "weak@example.com"), false);
    assert.equal(await failed(service.changePassword(admin.actor, "test-password-1", "alllowercase", "198.51.100.4")), "weak-password");
    await service.requestPasswordReset("member@example.com", "198.51.100.2");
    await new Promise((done) => setImmediate(done));
    const reset = new URL(f.messages.at(-1)!.link).searchParams.get("token")!;
    assert.equal(await failed(service.resetPassword(reset, "ALLUPPERCASE", "198.51.100.3")), "weak-password");
    const adapters = createInMemoryAdapters();
    const handler = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), accounts: service },
      { enabled: true, tokens: [], accountSessions: service, disableTokenExchange: true });
    const csrf = await handler(new Request("https://dns.example.com/api/v1/account/csrf"));
    const nonce = csrf.headers.getSetCookie()[0]!.split(";")[0]!;
    const response = await handler(new Request("https://dns.example.com/api/v1/account/password/reset", { method: "POST",
      headers: { origin: "https://dns.example.com", cookie: nonce, "x-parallax-csrf": (await csrf.json() as { csrf: string }).csrf, "content-type": "application/json" },
      body: JSON.stringify({ token: reset, password: "ALLUPPERCASE" }) }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "weak-password" });
  });

  it("takes request bodies up to 64 KiB and refuses larger ones", async () => {
    const { service } = await deployment();
    const adapters = createInMemoryAdapters();
    const handler = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), accounts: service },
      { enabled: true, tokens: [], accountSessions: service, disableTokenExchange: true });
    const csrf = await handler(new Request("https://dns.example.com/api/v1/account/csrf"));
    const nonce = csrf.headers.getSetCookie()[0]!.split(";")[0]!, token = (await csrf.json() as { csrf: string }).csrf;
    const post = (body: string) => handler(new Request("https://dns.example.com/api/v1/account/login", { method: "POST",
      headers: { origin: "https://dns.example.com", cookie: nonce, "x-parallax-csrf": token, "content-type": "application/json" }, body }));
    const near = JSON.stringify({ email: "member@example.com", password: "x".repeat(65536 - 60) });
    assert.ok(Buffer.byteLength(near) <= 65536);
    assert.equal((await post(near)).status, 403, "read and judged: a wrong password, not a refused body");
    assert.equal((await post(JSON.stringify({ email: "member@example.com", password: "x".repeat(65536) }))).status, 400);
  });
});

describe("attempt delays", () => {
  const delayed: AccountPolicy = { ...accountTestPolicy, rateLimit: { ...accountTestPolicy.rateLimit,
    login: { attempts: 3, windowSeconds: 600, baseDelaySeconds: 10, maxDelaySeconds: 40 } } };

  it("waits base × 2^(n−1) after the allowed attempts, allows one attempt after each wait, caps it, and starts over after the window", async () => {
    const { f, service } = await deployment(delayed);
    const wrong = (ip: string) => service.login("member@example.com", "wrong-password-1", ip).then(() => "ok", (error: { code?: string; retryAfterSeconds?: number }) =>
      error.code === "rate-limited" ? `wait ${error.retryAfterSeconds}` : error.code);
    let ip = 0; const next = () => `198.51.100.${++ip}`;
    assert.deepEqual([await wrong(next()), await wrong(next()), await wrong(next())], ["denied", "denied", "denied"]);
    assert.equal(await wrong(next()), "wait 10", "after the allowed attempts, the first wait is the base");
    f.advance(9_000);
    assert.equal(await wrong(next()), "wait 1", "still waiting");
    f.advance(1_000);
    assert.equal(await wrong(next()), "denied", "one attempt after the wait");
    assert.equal(await wrong(next()), "wait 20", "then twice the wait");
    f.advance(20_000); assert.equal(await wrong(next()), "denied");
    assert.equal(await wrong(next()), "wait 40");
    f.advance(40_000); assert.equal(await wrong(next()), "denied");
    assert.equal(await wrong(next()), "wait 40", "capped");
    // The right password waits like any attempt, and nothing locks for good.
    f.advance(40_000);
    assert.equal(await failed(service.login("member@example.com", "test-password-2", next())), "ok");
    f.advance(600_000 + 1);
    assert.deepEqual([await wrong(next()), await wrong(next()), await wrong(next())], ["denied", "denied", "denied"], "the window after the last attempt starts it over");
  });

  it("tells a browser when to try again", async () => {
    const { service } = await deployment(delayed);
    const adapters = createInMemoryAdapters();
    const handler = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), accounts: service },
      { enabled: true, tokens: [], accountSessions: service, disableTokenExchange: true });
    const csrf = await handler(new Request("https://dns.example.com/api/v1/account/csrf"));
    const nonce = csrf.headers.getSetCookie()[0]!.split(";")[0]!, token = (await csrf.json() as { csrf: string }).csrf;
    let last: Response | undefined;
    for (let index = 0; index < 4; index += 1) {
      last = await handler(new Request("https://dns.example.com/api/v1/account/login", { method: "POST",
        headers: { origin: "https://dns.example.com", cookie: nonce, "x-parallax-csrf": token, "content-type": "application/json" },
        body: JSON.stringify({ email: "member@example.com", password: "wrong-password-1" }) }));
    }
    assert.equal(last!.status, 429);
    assert.equal(last!.headers.get("retry-after"), "10");
  });
});

describe("enrollment links last longer than sign-in codes", () => {
  it("keeps an enrollment challenge for enrollmentSeconds while a code challenge expires after challengeSeconds", async () => {
    const policy: AccountPolicy = { ...accountTestPolicy, tokens: { ...accountTestPolicy.tokens, challengeSeconds: 120, enrollmentSeconds: 86_400 } };
    const store = new InMemoryAccountStateStore();
    const f = accountFixture(store, policy);
    const service = await f.create();
    await service.enable();
    const boot = await service.bootstrap("admin@example.com", "test-password-1", "Admin");
    assert.ok("challenge" in boot);
    f.advance(23 * 3_600_000);
    const enrollment = await service.beginEnrollment({ challenge: boot.challenge });
    const done = await service.confirmEnrollment({ challenge: boot.challenge, otp: f.otp(enrollment.secretBase32), ip: "198.51.100.1" });
    assert.ok(done.token, "an enrollment challenge still works after 23 hours");
    const step = await service.login("admin@example.com", "test-password-1", "198.51.100.2");
    assert.ok("challenge" in step && !step.enrollmentRequired);
    f.advance(121_000);
    assert.equal(await failed(service.completeMfa(step.challenge, f.otp(enrollment.secretBase32), "198.51.100.2")), "denied", "a code challenge is gone after 120 seconds");
  });
});

describe("leaving and deletion", () => {
  async function linked() {
    const context = await deployment();
    const memberId = (await context.store.read()).users.find((u) => u.canonicalLoginKey === "member@example.com")!.userId;
    await context.store.transact((t) => { t.state.identities.push({ issuer: "https://idp.example.com", subject: "member-sub", userId: memberId, kind: "linked" }); });
    return { ...context, memberId };
  }

  it("removes an administrator-deleted member's personal data at once, keeps issuer and subject, and lets the address be invited again", async () => {
    const { store, f, service, admin, memberId } = await linked();
    await service.login("wrong@example.com", "wrong-password-1", "198.51.100.1").catch(() => undefined);
    const member = (await service.listMembers(admin.actor)).find((u) => u.userId === memberId)!;
    await service.changeMember(admin.actor, memberId, member.version, { status: "deleted" });
    const state = await store.read();
    const tombstone = state.users.find((u) => u.userId === memberId)!;
    assert.equal(tombstone.status, "deleted");
    assert.match(tombstone.canonicalLoginKey, /@deleted\.invalid$/u);
    assert.equal(tombstone.displayName, "Deleted member");
    assert.equal(tombstone.emailVerifiedAt, null);
    assert.deepEqual([state.passwords[memberId], state.factors[memberId], state.memberThrottle[memberId]], [undefined, undefined, undefined]);
    assert.equal(state.sessions.some((s) => s.userId === memberId) || state.tokens.some((t) => t.userId === memberId), false);
    assert.ok(state.identities.some((i) => i.userId === memberId && i.subject === "member-sub"), "issuer and subject stay");
    const { audit } = await store.snapshot();
    assert.equal(JSON.stringify(audit).includes("member@example.com"), false, "the audit trail holds no address");
    await service.invite(admin.actor, "member@example.com", "viewer");
    await service.acceptInvite(new URL(f.messages.at(-1)!.link).searchParams.get("token")!, "member@example.com", "test-password-3", "Member Again", "198.51.100.2");
    assert.ok((await store.read()).users.some((u) => u.canonicalLoginKey === "member@example.com" && u.status === "active"));
  });

  it("lets a member leave with a fresh code and the password, and refuses the last administrator", async () => {
    const { store, f, service, admin, memberId } = await linked();
    const member = await service.login("member@example.com", "test-password-2", "198.51.100.3");
    assert.ok("token" in member);
    const seed = await service.beginEnrollment({ actor: { token: member.token }, password: "test-password-2", ip: "198.51.100.3" });
    f.advance();
    const fresh = await service.confirmEnrollment({ actor: { token: member.token }, otp: f.otp(seed.secretBase32), ip: "198.51.100.3" });
    assert.equal(await failed(service.deleteSelf({ token: fresh.token }, "wrong-password-1", "198.51.100.5")), "denied");
    await service.deleteSelf({ token: fresh.token }, "test-password-2", "198.51.100.6");
    const state = await store.read();
    assert.equal(state.users.find((u) => u.userId === memberId)!.status, "deleted");
    assert.equal(state.passwords[memberId], undefined);
    assert.equal((await service.resolve(fresh.token, new AbortController().signal)).status, "rejected");
    assert.equal(await failed(service.deleteSelf(admin.actor, "test-password-1", "198.51.100.7")), "last-admin");
  });
});

describe("enrollment from a password step", () => {
  it("lasts as long as a sign-in step on the server, and lives only for the browser session", async () => {
    const policy: AccountPolicy = { ...accountTestPolicy, tokens: { ...accountTestPolicy.tokens, challengeSeconds: 120, enrollmentSeconds: 86_400 } };
    const store = new InMemoryAccountStateStore();
    const f = accountFixture(store, policy);
    const service = await f.create();
    await service.enable();
    await service.bootstrap("admin@example.com", "test-password-1", "Admin");
    // The browser gets its enrollment challenge from the password step, not from the bootstrap.
    const step = await service.login("admin@example.com", "test-password-1", "198.51.100.1");
    assert.ok("challenge" in step && step.enrollmentRequired);
    f.advance(121_000);
    assert.equal(await failed(service.beginEnrollment({ challenge: step.challenge })), "denied", "past challengeSeconds the password is needed again");
    const again = await service.login("admin@example.com", "test-password-1", "198.51.100.2");
    assert.ok("challenge" in again);
    const seed = await service.beginEnrollment({ challenge: again.challenge });
    assert.ok((await service.confirmEnrollment({ challenge: again.challenge, otp: f.otp(seed.secretBase32), ip: "198.51.100.2" })).token);
  });

  it("sets the enrollment challenge cookie without Max-Age", async () => {
    const store = new InMemoryAccountStateStore();
    const f = accountFixture(store);
    const service = await f.create();
    await service.enable();
    await service.bootstrap("admin@example.com", "test-password-1", "Admin");
    const adapters = createInMemoryAdapters();
    const handler = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), accounts: service },
      { enabled: true, tokens: [], accountSessions: service, disableTokenExchange: true });
    const csrf = await handler(new Request("https://dns.example.com/api/v1/account/csrf"));
    const nonce = csrf.headers.getSetCookie()[0]!.split(";")[0]!;
    const login = await handler(new Request("https://dns.example.com/api/v1/account/login", { method: "POST",
      headers: { origin: "https://dns.example.com", cookie: nonce, "x-parallax-csrf": (await csrf.json() as { csrf: string }).csrf, "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "test-password-1" }) }));
    assert.deepEqual(await login.json(), { mfaRequired: true, enrollmentRequired: true });
    const cookie = login.headers.getSetCookie().find((line) => line.startsWith("__Host-parallax_member_challenge="))!;
    assert.ok(cookie);
    assert.doesNotMatch(cookie, /Max-Age|Expires/iu);
  });
});

describe("checking the current password", () => {
  it("counts wrong current passwords like sign-in attempts and takes back a right one", async () => {
    const policy: AccountPolicy = { ...accountTestPolicy, rateLimit: { ...accountTestPolicy.rateLimit, login: { attempts: 3, windowSeconds: 600, baseDelaySeconds: 600, maxDelaySeconds: 600 } } };
    const right = await deployment(policy);
    const rightId = (await right.store.read()).users.find((u) => u.canonicalLoginKey === "admin@example.com")!.userId;
    assert.equal(await failed(right.service.changePassword(right.admin.actor, "test-password-1", "test-password-9", "198.51.100.1")), "ok");
    assert.equal((await right.store.read()).memberThrottle[rightId]?.login?.count ?? 0, 0, "a right current password is taken back");
    const wrong = await deployment(policy);
    const codes = [];
    for (let index = 0; index < 4; index += 1) codes.push(await failed(wrong.service.changePassword(wrong.admin.actor, "wrong-password-1", "test-password-8", `198.51.100.${index + 10}`)));
    assert.deepEqual(codes, ["denied", "denied", "denied", "rate-limited"]);
    assert.equal(await failed(wrong.service.deleteSelf(wrong.admin.actor, "test-password-1", "198.51.100.20")), "rate-limited", "leaving checks the same counter");
  });
});

describe("the common hashing values", () => {
  it("are accepted by the policy, with verify limits that admit them", () => {
    const policy = readAccountPolicy({ ...accountTestPolicy, password: { minLength: 8, maxBytes: 65536, maxConcurrent: 2, maxQueued: 16,
      scrypt: { N: 65536, r: 8, p: 2, maxmem: 100663296, keylen: 32 }, verifyLimits: { maxMemoryBytes: 100663296, maxWork: 1048576, maxKeylen: 32 } } });
    assert.equal(policy.password.scrypt.N, 65536);
  });
});
