import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { AccessTokenService } from "../../src/application/access-tokens.ts";
import { AccountService } from "../../src/application/accounts/service.ts";
import { createPasswordHasher } from "../../src/security/accounts/passwords.ts";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { createApiHandler, createNodeHandler } from "../../src/http/api.ts";
import { InMemoryAccountStateStore } from "../../src/infrastructure/account-state.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";
import { readAccountState } from "../../src/application/accounts/state.ts";
import { createInMemoryAdapters, InMemoryAccessTokenRepository } from "../../src/infrastructure/in-memory.ts";
import type { SecurityConfig } from "../../src/security/http-authorization.ts";
import { clientBucket } from "../../src/security/client-bucket.ts";
import { counter, render } from "../../src/observability/metrics.ts";
import { assertStorableCookies } from "../support/cookies.ts";
import { accountFixture, accountTestPolicy, enrolledAdministrator } from "../support/accounts.ts";

const servers: Server[] = [];
after(async () => { await Promise.all(servers.map((server) => new Promise((done) => server.close(done)))); });

async function serve(handler: ReturnType<typeof createNodeHandler>): Promise<string> {
  const server = createServer((request, response) => { void handler(request, response); });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A browser over a real socket: the cookies are whatever the Node transport actually wrote. */
function wireBrowser(host: string) {
  const jar = new Map<string, string>();
  const seen: string[] = [];
  let csrf = "";
  const send = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> => {
    const headers: Record<string, string> = { origin: `https://${host}`, ...extra };
    if (jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    if (csrf && method !== "GET") headers["x-parallax-csrf"] = csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`http://${host}${path}`, { method, headers, redirect: "manual", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const lines = response.headers.getSetCookie();
    seen.push(...lines);
    assertStorableCookies(lines, `${method} ${path}`);
    for (const line of lines) {
      const [pair] = line.split(";"); const index = pair!.indexOf("=");
      const name = pair!.slice(0, index), value = pair!.slice(index + 1);
      if (/Max-Age=0/u.test(line) || value === "") jar.delete(name); else jar.set(name, value);
    }
    return response;
  };
  return { send, jar, seen, setCsrf: (value: string) => { csrf = value; } };
}

describe("cookies a browser will actually store", () => {
  it("rejects the cookie shape that kept every browser from signing in", () => {
    assert.throws(() => assertStorableCookies(["__Host-parallax_member_challenge=x; Path=/api/v1/account; HttpOnly; SameSite=Strict; Secure"]), /Path=\//u);
    assert.throws(() => assertStorableCookies(["__Host-parallax_account=x; Path=/; HttpOnly"]), /Secure/u);
    assert.throws(() => assertStorableCookies(["__Host-x=1; Path=/; Secure; Domain=example.com"]), /Domain/u);
    assert.throws(() => assertStorableCookies(["__Secure-x=1; Path=/"]), /Secure/u);
  });

  it("issues only storable cookies across member sign-in, enrollment, challenge and sign-out over the Node transport", async () => {
    const store = new InMemoryAccountStateStore();
    const f = accountFixture(store);
    const service = await f.create();
    await service.enable();
    await service.bootstrap("admin@example.com", "test-password-1", "Admin");
    const adapters = createInMemoryAdapters();
    const host = await serve(createNodeHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), accounts: service },
      { enabled: true, tokens: [], accountSessions: service, disableTokenExchange: true }, { terminatesTls: true }));
    const browser = wireBrowser(host);
    browser.setCsrf((await (await browser.send("GET", "/api/v1/account/csrf")).json() as { csrf: string }).csrf);
    const login = await browser.send("POST", "/api/v1/account/login", { email: "admin@example.com", password: "test-password-1" });
    assert.deepEqual(await login.json(), { mfaRequired: true, enrollmentRequired: true });
    assert.ok(browser.jar.has("__Host-parallax_member_challenge"), "the challenge cookie is stored");
    const seed = await (await browser.send("POST", "/api/v1/account/mfa/enroll", {})).json() as { secretBase32: string };
    const confirmed = await browser.send("POST", "/api/v1/account/mfa/confirm", { otp: f.otp(seed.secretBase32) });
    assert.equal(confirmed.status, 200);
    assert.equal(browser.jar.has("__Host-parallax_member_challenge"), false, "issuing a session clears the challenge");
    browser.setCsrf((await confirmed.json() as { csrf: string }).csrf);
    f.advance();
    const retry = await browser.send("POST", "/api/v1/account/login", { email: "admin@example.com", password: "test-password-1" });
    assert.equal(retry.status, 403, "a member session's CSRF token is not the sign-in one");
    assert.equal((await browser.send("POST", "/api/v1/account/logout", {})).status, 200);
    for (const name of ["__Host-parallax_login_csrf", "__Host-parallax_member_challenge", "__Host-parallax_account"]) {
      assert.ok(browser.seen.some((line) => line.startsWith(`${name}=`)), `${name} was issued`);
    }
  });

  it("issues only storable cookies on the token session route too", async () => {
    const adapters = createInMemoryAdapters();
    const security: SecurityConfig = { enabled: true, tokens: [{ token: "t".repeat(43), role: "admin", subject: "owner" }], tokenSessionSecret: "token-session-secret-that-is-at-least-32-bytes" };
    const host = await serve(createNodeHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) }, security, { terminatesTls: true }));
    const browser = wireBrowser(host);
    assert.equal((await browser.send("POST", "/api/v1/session", { token: "t".repeat(43) })).status, 200);
    assert.equal((await browser.send("DELETE", "/api/v1/session")).status, 204);
    assert.ok(browser.seen.length >= 3);
  });
});

describe("the unit an attempt limit counts by", () => {
  it("counts IPv6 by /64, IPv4 by address, and a mapped IPv4 as that IPv4", () => {
    assert.equal(clientBucket("2001:db8:1:2::1"), clientBucket("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    assert.equal(clientBucket("2001:DB8:1:2::1"), clientBucket("2001:db8:0001:0002:0:0:0:9"));
    assert.equal(clientBucket("fe80::1%eth0"), clientBucket("fe80::2"));
    assert.notEqual(clientBucket("2001:db8:1:2::1"), clientBucket("2001:db8:1:3::1"));
    assert.equal(clientBucket("::ffff:203.0.113.7"), clientBucket("203.0.113.7"));
    assert.equal(clientBucket("::ffff:cb00:7107"), "ipv4:203.0.113.7");
    assert.notEqual(clientBucket("203.0.113.7"), clientBucket("203.0.113.8"));
    assert.equal(clientBucket("203.0.113.7:80"), clientBucket("203.0.113.7"));
    assert.equal(clientBucket("[2001:db8:1:2::1]:443"), clientBucket("2001:db8:1:2::9"));
    assert.equal(clientBucket("[2001:db8:1:2::1]"), clientBucket("2001:db8:1:2::9"));
    assert.equal(clientBucket("direct-fetch-client"), "other");
    assert.equal(clientBucket("forged, 10.0.0.11"), "other", "a value that is not an address shares one bucket");
  });

  it("only lets a counter go up, in whole steps", () => {
    const step = counter("parallax_test_steps_total", "Test counter.");
    step();
    step({}, 2);
    for (const by of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => step({}, by), TypeError, String(by));
  });
});

describe("account hardening", () => {
  const tight = { ...accountTestPolicy, rateLimit: { login: { attempts: 3, windowSeconds: 60, baseDelaySeconds: 60, maxDelaySeconds: 60 }, mfa: { attempts: 3, windowSeconds: 60, baseDelaySeconds: 60, maxDelaySeconds: 60 }, reset: { attempts: 3, windowSeconds: 60, baseDelaySeconds: 60, maxDelaySeconds: 60 },
    link: { attempts: 2, windowSeconds: 60, baseDelaySeconds: 60, maxDelaySeconds: 60 }, maxEntries: 8 } };
  const failed = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => "ok", (error: { code?: string }) => error.code);
  async function withMember(policy = tight) {
    const store = new InMemoryAccountStateStore();
    const f = accountFixture(store, policy);
    const service = await f.create();
    const admin = await enrolledAdministrator(service, f);
    await service.invite(admin.actor, "member@example.com", "viewer");
    await service.acceptInvite(new URL(f.messages.at(-1)!.link).searchParams.get("token")!, "member@example.com", "test-password-2", "Member", "198.51.100.200");
    return { store, f, service, admin };
  }

  it("keeps counting a real account's guesses however many addresses and unknown accounts an attacker sprays", async () => {
    const { store, service } = await withMember();
    for (const ip of ["2001:db8:a::1", "2001:db8:b::1"]) assert.equal(await failed(service.login("member@example.com", "wrong-password-1", ip)), "denied");
    // Thirty /64 buckets, each spending all but one attempt on accounts that do not exist, so the
    // address table keeps rotating instead of locking (a fully locked table is the overflow test below).
    for (let bucket = 0; bucket < 30; bucket += 1) {
      for (let index = 0; index < 2; index += 1) await failed(service.login(`spray-${bucket}-${index}@example.com`, "wrong-password-1", `2001:db8:${(bucket + 16).toString(16)}::1`));
    }
    const state = await store.read();
    assert.ok(state.throttle.filter((x) => x.key.startsWith("login:ip:")).length <= tight.rateLimit.maxEntries, "the address table stays bounded");
    assert.ok(state.throttle.filter((x) => x.key.startsWith("login:ghost:")).length <= tight.rateLimit.maxEntries, "unknown accounts share bounded slots");
    assert.equal(await failed(service.login("member@example.com", "wrong-password-1", "2001:db8:ffff::1")), "denied");
    assert.equal(await failed(service.login("member@example.com", "test-password-2", "2001:db8:fffe::1")), "rate-limited", "the member's own count was never crowded out");
  });

  it("keeps a locked /64 locked when more buckets than the table holds are rotated through it", async () => {
    const { service } = await withMember();
    for (let index = 0; index < 3; index += 1) await failed(service.login(`a${index}@example.com`, "wrong-password-1", `2001:db8:1:1::${index + 1}`));
    for (let bucket = 0; bucket <= tight.rateLimit.maxEntries; bucket += 1) {
      await failed(service.login(`rotate-${bucket}@example.com`, "wrong-password-1", `2001:db8:2:${bucket.toString(16)}::1`));
    }
    assert.equal(await failed(service.login("member@example.com", "test-password-2", "2001:db8:1:1::99")), "rate-limited", "a bucket at its limit is never pushed out");
  });

  it("decides sign-in by the account alone once every client slot is locked, so a flood locks out nobody else", async () => {
    const { store, service } = await withMember();
    for (let bucket = 0; bucket < tight.rateLimit.maxEntries; bucket += 1) {
      for (let index = 0; index < 3; index += 1) await failed(service.login(`lock-${bucket}-${index}@example.com`, "wrong-password-1", `203.0.113.${bucket + 1}`));
    }
    // Every slot is locked; new clients are not pooled into one shared allowance: each is decided by
    // its own account, so a flood cannot use up anybody else's attempts.
    for (let index = 0; index < 6; index += 1) {
      assert.equal(await failed(service.login(`newcomer-${index}@example.com`, "wrong-password-1", `192.0.2.${index + 1}`)), "denied", `new client ${index} is not pooled`);
    }
    assert.equal(await failed(service.login("member@example.com", "test-password-2", "192.0.2.50")), "ok", "a person signs in during the flood");
    assert.equal((await store.read()).throttle.some((x) => x.key === "login:ovf"), false, "sign-in keeps no shared overflow");
    // Repeated failures on one account are still limited, by the account.
    const attacked = await withMember();
    for (let bucket = 0; bucket < tight.rateLimit.maxEntries; bucket += 1) {
      for (let index = 0; index < 3; index += 1) await failed(attacked.service.login(`lock-${bucket}-${index}@example.com`, "wrong-password-1", `203.0.113.${bucket + 1}`));
    }
    const codes = [];
    for (let index = 0; index < 4; index += 1) codes.push(await failed(attacked.service.login("member@example.com", "wrong-password-1", `192.0.2.${index + 100}`)));
    assert.deepEqual(codes, ["denied", "denied", "denied", "rate-limited"]);
  });

  it("keeps provider sign-in starts limited per client once every slot is locked, so other clients are unaffected", async () => {
    // A long link window, so the address slots stay locked after the sign-in states themselves expire.
    const { f, service } = await withMember({ ...tight, rateLimit: { ...tight.rateLimit, link: { attempts: 2, windowSeconds: 3600, baseDelaySeconds: 3600, maxDelaySeconds: 3600 } } });
    const start = (ip: string) => failed(service.beginOidc({ issuer: "https://idp.example.com", purpose: "login", verifier: "v".repeat(43), nonce: "n".repeat(43),
      state: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"), ip }));
    for (let bucket = 0; bucket < tight.rateLimit.maxEntries; bucket += 1) {
      for (let index = 0; index < 2; index += 1) await start(`203.0.113.${bucket + 1}`);
      f.advance((accountTestPolicy.tokens.challengeSeconds + 1) * 1000);
    }
    // Every slot is locked: each new client is still counted on its own.
    assert.deepEqual([await start("192.0.2.1"), await start("192.0.2.1"), await start("192.0.2.1")], ["ok", "ok", "rate-limited"]);
    assert.deepEqual([await start("192.0.2.2"), await start("192.0.2.3")], ["ok", "ok"], "another client is not affected");
  });

  it("limits mailed-link guesses per client once every slot is locked", async () => {
    const { service } = await withMember();
    const guess = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    for (let bucket = 0; bucket < tight.rateLimit.maxEntries; bucket += 1) {
      for (let index = 0; index < 3; index += 1) await failed(service.resetPassword(guess(), "test-password-5", `203.0.113.${bucket + 1}`));
    }
    const same = [];
    for (let index = 0; index < 4; index += 1) same.push(await failed(service.resetPassword(guess(), "test-password-5", "192.0.2.10")));
    assert.deepEqual(same, ["denied", "denied", "denied", "rate-limited"]);
    assert.equal(await failed(service.resetPassword(guess(), "test-password-5", "192.0.2.11")), "denied", "another client is not affected");
  });

  it("answers a missing address on its first attempt as it answers a real account, even with every unknown-address slot locked", async () => {
    const { service } = await withMember();
    for (let slot = 0; slot < tight.rateLimit.maxEntries; slot += 1) {
      for (let index = 0; index < 3; index += 1) await failed(service.login(`missing-${slot}@example.com`, "wrong-password-1", `198.51.100.${slot * 3 + index + 1}`));
    }
    assert.equal(await failed(service.login("never-seen@example.com", "wrong-password-1", "2001:db8:9::1")), "denied");
    assert.equal(await failed(service.login("member@example.com", "wrong-password-1", "2001:db8:9:1::1")), "denied");
    // And repeated, both are limited at the same attempt.
    const missing = [], real = [];
    for (let index = 0; index < 3; index += 1) {
      missing.push(await failed(service.login("never-seen@example.com", "wrong-password-1", `2001:db8:a:${index}::1`)));
      real.push(await failed(service.login("member@example.com", "wrong-password-1", `2001:db8:b:${index}::1`)));
    }
    assert.deepEqual(missing, ["denied", "denied", "rate-limited"]);
    assert.deepEqual(real, missing);
  });

  it("refuses a locked client before hashing anything, with every slot locked", async () => {
    const store = new InMemoryAccountStateStore();
    const f = accountFixture(store, tight);
    await enrolledAdministrator(await f.create(), f);
    const real = await createPasswordHasher(tight.password);
    let verified = 0;
    const counting = { ...real, hash: real.hash.bind(real), needsRehash: real.needsRehash.bind(real), isSafeHash: real.isSafeHash.bind(real),
      verify: (...args: Parameters<typeof real.verify>) => { verified += 1; return real.verify(...args); } };
    const service = await AccountService.create({ store, policy: tight, key: Buffer.alloc(32, 7), publicOrigin: "https://dns.example.com", now: f.now,
      passwordHasher: counting, mailer: { send: async () => {}, sendSecurityNotification: async () => {} } });
    for (let bucket = 0; bucket < tight.rateLimit.maxEntries; bucket += 1) {
      for (let index = 0; index < 3; index += 1) await failed(service.login(`lock-${bucket}-${index}@example.com`, "wrong-password-1", `203.0.113.${bucket + 1}`));
    }
    const before = verified;
    const codes = [];
    for (let index = 0; index < 10; index += 1) codes.push(await failed(service.login(`spray-${index}@example.com`, "wrong-password-1", "192.0.2.20")));
    assert.deepEqual(codes, ["denied", "denied", "denied", ...Array.from({ length: 7 }, () => "rate-limited")]);
    assert.equal(verified - before, 3, "only the attempts the limit allowed were hashed");
    const login = await service.login("admin@example.com", "test-password-1", "192.0.2.21");
    assert.ok("challenge" in login, "a person on another client signs in");
  });

  it("answers an existing and a missing address alike, limited at the same step", async () => {
    const { service } = await withMember();
    const existing = [], missing = [];
    for (let index = 0; index < 4; index += 1) {
      existing.push(await failed(service.login("member@example.com", "wrong-password-1", `198.51.100.${index + 1}`)));
      missing.push(await failed(service.login("nobody-here@example.com", "wrong-password-1", `198.51.100.${index + 11}`)));
    }
    assert.deepEqual(existing, ["denied", "denied", "denied", "rate-limited"]);
    assert.deepEqual(missing, existing);
  });

  it("caps reset mail per member whatever the number of addresses asking", async () => {
    const { f, service } = await withMember();
    const before = f.messages.length;
    for (let index = 0; index < 10; index += 1) await failed(service.requestPasswordReset("member@example.com", `198.51.100.${index + 1}`));
    await new Promise((done) => setImmediate(done));
    assert.equal(f.messages.length - before, tight.rateLimit.reset.attempts);
  });

  it("limits provider sign-in starts under their own policy, apart from resets", async () => {
    const { service } = await withMember();
    const start = (ip: string) => service.beginOidc({ issuer: "https://idp.example.com", purpose: "login", verifier: "v".repeat(43), nonce: "n".repeat(43),
      state: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"), ip });
    // Several people behind one address start SSO; the reset allowance for that address is untouched.
    for (let index = 0; index < tight.rateLimit.link.attempts; index += 1) await start("203.0.113.50");
    assert.equal(await failed(start("203.0.113.50")), "rate-limited");
    for (let index = 0; index < tight.rateLimit.reset.attempts; index += 1) assert.equal(await failed(service.requestPasswordReset(`r${index}@example.com`, "203.0.113.50")), "ok");
    assert.equal(await failed(service.requestPasswordReset("r9@example.com", "203.0.113.50")), "rate-limited", "and resets keep their own limit");
    await start("10.0.0.11");
    const login = await service.login("admin@example.com", "test-password-1", "10.0.0.12");
    assert.ok("challenge" in login, "sign-in challenges are not crowded out by provider states");
  });

  it("counts every address in one IPv6 /64 as one client", async () => {
    const store = new InMemoryAccountStateStore();
    const f = accountFixture(store, tight);
    const service = await f.create();
    await enrolledAdministrator(service, f);
    const codes = [];
    for (const suffix of ["1", "2", "3", "4"]) {
      codes.push(await service.login(`x${suffix}@example.com`, "wrong-password-1", `2001:db8:1:2::${suffix}`).then(() => "ok", (error: { code?: string }) => error.code));
    }
    assert.deepEqual(codes, ["denied", "denied", "denied", "rate-limited"]);
  });

  it("does not count a verified password or code against the member", async () => {
    const { f, service, admin } = await withMember();
    // More successful sign-ins than the limit allows failures, from different addresses: none is refused.
    for (let index = 0; index < tight.rateLimit.login.attempts * 2; index += 1) {
      assert.equal(await failed(service.login("member@example.com", "test-password-2", `198.51.100.${index + 1}`)), "ok", `sign-in ${index}`);
    }
    // The same for codes.
    for (let index = 0; index < tight.rateLimit.mfa.attempts * 2; index += 1) {
      f.advance();
      assert.equal(await failed(service.reauthenticate(admin.actor, f.otp(admin.secret), `198.51.100.${index + 50}`)), "ok", `code ${index}`);
    }
  });

  it("counts every attempt from one address, successes included, while the member keeps only its failures", async () => {
    const { store, service } = await withMember();
    const memberId = (await store.read()).users.find((u) => u.canonicalLoginKey === "member@example.com")!.userId;
    // One address: the address limit counts successes too, so mixing in sign-ins to one's own account
    // cannot stretch the address's allowance for guesses at other accounts.
    const same = [];
    for (let index = 0; index <= tight.rateLimit.login.attempts; index += 1) same.push(await failed(service.login("member@example.com", "test-password-2", "198.51.100.77")));
    assert.deepEqual(same, [...Array.from({ length: tight.rateLimit.login.attempts }, () => "ok"), "rate-limited"]);
    // Other addresses: the member's own counter took each success back, so they sign in.
    assert.equal((await store.read()).memberThrottle[memberId]?.login?.count ?? 0, 0);
    for (let index = 0; index < tight.rateLimit.login.attempts + 1; index += 1) {
      assert.equal(await failed(service.login("member@example.com", "test-password-2", `198.51.100.${index + 100}`)), "ok");
    }
  });

  it("takes back the password step of a member with a factor too, so only the address limit can stop it", async () => {
    const { store, service } = await withMember();
    const adminId = (await store.read()).users.find((u) => u.canonicalLoginKey === "admin@example.com")!.userId;
    // The administrator has a factor: each correct password answers with a code challenge, not a session.
    // Well past the limit, from different addresses.
    for (let index = 0; index < tight.rateLimit.login.attempts * 2; index += 1) {
      const result = await service.login("admin@example.com", "test-password-1", `198.51.100.${index + 1}`);
      assert.ok("challenge" in result, `password step ${index}`);
    }
    assert.equal((await store.read()).memberThrottle[adminId]?.login?.count ?? 0, 0, "the member's sign-in counter holds no successes");
    // From one address the same steps stop at the address limit, which is what a 429 here means.
    const same = [];
    for (let index = 0; index <= tight.rateLimit.login.attempts; index += 1) same.push(await failed(service.login("admin@example.com", "test-password-1", "198.51.100.88")));
    assert.deepEqual(same, [...Array.from({ length: tight.rateLimit.login.attempts }, () => "ok"), "rate-limited"]);
  });

  it("keeps one open challenge per member, so repeated password steps cannot block anyone else's code sign-in", async () => {
    const { store, f, service, admin } = await withMember();
    // Give the second member a factor, so both sign in with a code.
    const member = await service.login("member@example.com", "test-password-2", "198.51.100.200");
    assert.ok("token" in member);
    const seed = await service.beginEnrollment({ actor: { token: member.token }, password: "test-password-2", ip: "198.51.100.200" });
    f.advance();
    await service.confirmEnrollment({ actor: { token: member.token }, otp: f.otp(seed.secretBase32), ip: "198.51.100.200" });
    // Far more password steps than the bound on open challenges, from as many addresses.
    const challenges: string[] = [];
    for (let index = 0; index < tight.rateLimit.maxEntries * 2; index += 1) {
      const step = await service.login("admin@example.com", "test-password-1", `203.0.113.${index + 1}`);
      assert.ok("challenge" in step, `step ${index}`);
      challenges.push(step.challenge);
    }
    const adminId = (await store.read()).users.find((u) => u.canonicalLoginKey === "admin@example.com")!.userId;
    assert.equal((await store.read()).tokens.filter((t) => t.purpose === "challenge" && t.userId === adminId).length, 1, "one open challenge per member");
    // Another member's code sign-in still works.
    const other = await service.login("member@example.com", "test-password-2", "192.0.2.1");
    assert.ok("challenge" in other);
    f.advance();
    assert.ok("token" in await service.completeMfa(other.challenge, f.otp(seed.secretBase32), "192.0.2.1"));
    // An earlier challenge no longer works; the last one does.
    f.advance();
    assert.equal(await failed(service.completeMfa(challenges[0]!, f.otp(admin.secret), "192.0.2.2")), "denied");
    assert.ok("token" in await service.completeMfa(challenges.at(-1)!, f.otp(admin.secret), "192.0.2.3"));
  });

  it("tells the owner when a recovery code is used and when the replacement factor is confirmed, and only then", async () => {
    const { f, service, admin } = await withMember();
    const events = () => f.notices.filter((n) => n.to === "admin@example.com").map((n) => n.event);
    const before = events().length;
    // An ordinary sign-in with a code sends nothing.
    const plain = await service.login("admin@example.com", "test-password-1", "198.51.100.1");
    assert.ok("challenge" in plain);
    f.advance();
    assert.ok("token" in await service.completeMfa(plain.challenge, f.otp(admin.secret), "198.51.100.1"));
    assert.deepEqual(events().slice(before), []);
    // A recovery code: one notice. Confirming the replacement: one more.
    const step = await service.login("admin@example.com", "test-password-1", "198.51.100.2");
    assert.ok("challenge" in step);
    const recovered = await service.completeMfa(step.challenge, admin.recoveryCodes[0]!, "198.51.100.2");
    assert.ok("challenge" in recovered);
    assert.deepEqual(events().slice(before), ["recovery-code-used"]);
    const seed = await service.beginEnrollment({ challenge: recovered.challenge });
    f.advance();
    await service.confirmEnrollment({ challenge: recovered.challenge, otp: f.otp(seed.secretBase32), ip: "198.51.100.2" });
    assert.deepEqual(events().slice(before), ["recovery-code-used", "mfa-replaced"]);
  });

  it("sends no factor notice for a first enrollment", async () => {
    const { f } = await withMember();
    assert.deepEqual(f.notices.filter((n) => n.event === "mfa-replaced" || n.event === "recovery-code-used"), []);
  });

  it("keeps a re-enrollment challenge open while the member signs in again with the password", async () => {
    const { f, service, admin } = await withMember();
    const step = await service.login("admin@example.com", "test-password-1", "198.51.100.1");
    assert.ok("challenge" in step);
    const recovered = await service.completeMfa(step.challenge, admin.recoveryCodes[0]!, "198.51.100.1");
    assert.ok("challenge" in recovered && recovered.enrollmentRequired);
    // Signing in with the password again, several times, issues ordinary challenges only.
    for (let index = 0; index < 4; index += 1) {
      assert.ok("challenge" in await service.login("admin@example.com", "test-password-1", `198.51.100.${index + 10}`));
    }
    // The re-enrollment challenge still enrolls the new factor.
    const seed = await service.beginEnrollment({ challenge: recovered.challenge });
    f.advance();
    const done = await service.confirmEnrollment({ challenge: recovered.challenge, otp: f.otp(seed.secretBase32), ip: "198.51.100.20" });
    assert.ok(done.token && done.recoveryCodes.length === tight.mfa.recoveryCodeCount);
  });

  it("still refuses the right password once the member's failures reach the limit, for the rest of the window", async () => {
    const { f, service } = await withMember();
    for (let index = 0; index < tight.rateLimit.login.attempts; index += 1) {
      assert.equal(await failed(service.login("member@example.com", "wrong-password-1", `198.51.100.${index + 1}`)), "denied");
    }
    assert.equal(await failed(service.login("member@example.com", "test-password-2", "198.51.100.9")), "rate-limited");
    f.advance(tight.rateLimit.login.windowSeconds * 1000 + 1);
    assert.equal(await failed(service.login("member@example.com", "test-password-2", "198.51.100.10")), "ok", "the window's end lifts it");
  });

  it("lets the host lift an administrator's attempt limit that someone else ran up", async () => {
    const { store, service } = await withMember();
    for (let index = 0; index < tight.rateLimit.login.attempts; index += 1) await failed(service.login("admin@example.com", "wrong-password-1", `198.51.100.${index + 1}`));
    assert.equal(await failed(service.login("admin@example.com", "test-password-1", "198.51.100.20")), "rate-limited");
    const adminId = (await store.read()).users.find((u) => u.canonicalLoginKey === "admin@example.com")!.userId;
    await service.recoverAdministratorHost(adminId);
    const login = await failed(service.login("admin@example.com", "test-password-1", "198.51.100.21"));
    assert.equal(login, "ok", "the host's recovery lifts it; the next sign-in asks for a new authenticator");
  });

  it("lets a success take back only its own attempt, never the failures before it", async () => {
    const { store, service } = await withMember();
    const memberId = (await store.read()).users.find((u) => u.canonicalLoginKey === "member@example.com")!.userId;
    const count = async () => (await store.read()).memberThrottle[memberId]?.login?.count ?? 0;
    await failed(service.login("member@example.com", "wrong-password-1", "198.51.100.1"));
    await failed(service.login("member@example.com", "wrong-password-1", "198.51.100.2"));
    assert.equal(await count(), 2);
    assert.equal(await failed(service.login("member@example.com", "test-password-2", "198.51.100.3")), "ok");
    assert.equal(await count(), 2, "the two failures are still counted");
    assert.equal(await failed(service.login("member@example.com", "wrong-password-1", "198.51.100.4")), "denied");
    assert.equal(await failed(service.login("member@example.com", "test-password-2", "198.51.100.5")), "rate-limited");
  });

  it("counts the password check on the session enrollment path with sign-in attempts", async () => {
    const store = new InMemoryAccountStateStore();
    const f = accountFixture(store, tight);
    const service = await f.create();
    const admin = await enrolledAdministrator(service, f);
    await service.invite(admin.actor, "member@example.com", "viewer");
    await service.acceptInvite(new URL(f.messages.at(-1)!.link).searchParams.get("token")!, "member@example.com", "test-password-2", "Member", "203.0.113.7");
    const member = await service.login("member@example.com", "test-password-2", "203.0.113.7");
    assert.ok("token" in member);
    // The successful sign-in above took its own attempt back; three wrong passwords here use up the member's allowance.
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
      await assert.rejects(service.beginEnrollment({ actor: { token: member.token }, password: "wrong-password-9", ip }), (error: { code?: string }) => error.code === "denied");
    }
    await assert.rejects(service.beginEnrollment({ actor: { token: member.token }, password: "test-password-2", ip: "198.51.100.4" }),
      (error: { code?: string }) => error.code === "rate-limited", "guesses against one member are limited across addresses");
  });

  it("answers a reset request without waiting for the mail server, whether or not the address exists", async () => {
    const store = new InMemoryAccountStateStore();
    const f = accountFixture(store);
    const first = await f.create();
    const admin = await enrolledAdministrator(first, f);
    await first.invite(admin.actor, "member@example.com", "viewer");
    await first.acceptInvite(new URL(f.messages.at(-1)!.link).searchParams.get("token")!, "member@example.com", "test-password-2", "Member", "203.0.113.7");
    let sent = 0;
    const hanging = await AccountService.create({ store, policy: accountTestPolicy, key: Buffer.alloc(32, 7), publicOrigin: "https://dns.example.com", now: f.now,
      mailer: { send: () => { sent += 1; return new Promise<never>(() => {}); }, sendSecurityNotification: async () => {} } });
    const within = (promise: Promise<void>) => Promise.race([promise.then(() => "answered"), new Promise((done) => setTimeout(() => done("waited on SMTP"), 500))]);
    assert.equal(await within(hanging.requestPasswordReset("member@example.com", "203.0.113.7")), "answered");
    assert.equal(await within(hanging.requestPasswordReset("nobody@example.com", "203.0.113.7")), "answered");
    assert.equal(sent, 1, "only the existing address gets mail, after the answer");
  });

  it("needs the current password to enroll from a session, and accepts no code from an unconfirmed factor", async () => {
    const store = new InMemoryAccountStateStore();
    const f = accountFixture(store);
    const service = await f.create();
    const admin = await enrolledAdministrator(service, f);
    await service.invite(admin.actor, "member@example.com", "viewer");
    await service.acceptInvite(new URL(f.messages.at(-1)!.link).searchParams.get("token")!, "member@example.com", "test-password-2", "Member", "203.0.113.7");
    const member = await service.login("member@example.com", "test-password-2", "203.0.113.7");
    assert.ok("token" in member);
    const stolen = { token: member.token };
    await assert.rejects(service.beginEnrollment({ actor: stolen }), (error: { code?: string }) => error.code === "denied", "a cookie alone cannot attach a factor");
    await assert.rejects(service.beginEnrollment({ actor: stolen, password: "wrong-password-9" }), (error: { code?: string }) => error.code === "denied");
    const seed = await service.beginEnrollment({ actor: stolen, password: "test-password-2" });
    f.advance();
    await assert.rejects(service.reauthenticate(stolen, f.otp(seed.secretBase32), "203.0.113.7"), (error: { code?: string }) => error.code === "denied",
      "an unconfirmed factor earns no fresh-code session");
    assert.equal((await service.context(member.token)).recentMfa, false);
    const confirmed = await service.confirmEnrollment({ actor: stolen, otp: f.otp(seed.secretBase32), ip: "203.0.113.7" });
    assert.equal((await service.context(confirmed.token)).recentMfa, true);
  });

  it("checks a mailed link before any password work, and limits guesses per address", async () => {
    const store = new InMemoryAccountStateStore();
    const f = accountFixture(store, tight);
    const service = await f.create();
    await enrolledAdministrator(service, f);
    const guess = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    for (let index = 0; index < 3; index += 1) {
      await assert.rejects(service.resetPassword(guess(), "test-password-5", "203.0.113.9"), (error: { code?: string }) => error.code === "denied");
    }
    await assert.rejects(service.acceptInvite(guess(), "x@example.com", "test-password-5", "X", "203.0.113.9"), (error: { code?: string }) => error.code === "rate-limited");
    await assert.rejects(service.resetPassword(guess(), "test-password-5", "10.0.0.11"), (error: { code?: string }) => error.code === "denied", "another address is unaffected");
  });

  it("reads back every attempt counter it writes, for every kind and axis, through a fresh file store", async () => {
    const dropped = () => [...render().matchAll(/^parallax_account_throttle_entries_dropped_total(?:\{[^}]*\})? (\d+)$/gmu)].reduce((sum, match) => sum + Number(match[1]), 0);
    const directory = await mkdtemp(join(tmpdir(), "parallax-throttle-roundtrip-"));
    try {
      const path = join(directory, "config.json");
      const store = new FileConfigurationStore(path);
      const f = accountFixture(store.accounts, tight);
      const service = await f.create();
      const admin = await enrolledAdministrator(service, f);
      await service.invite(admin.actor, "member@example.com", "viewer");
      await service.acceptInvite(new URL(f.messages.at(-1)!.link).searchParams.get("token")!, "member@example.com", "test-password-2", "Member", "198.51.100.200");
      const member = await service.login("member@example.com", "test-password-2", "198.51.100.1");
      assert.ok("token" in member);
      const before = dropped();
      // Every kind on both axes: member and unknown-address counters, client buckets, and the per-process fallback.
      await failed(service.login("nobody@example.com", "wrong-password-1", "2001:db8:1::1"));
      await failed(service.reauthenticate(admin.actor, "000000", "198.51.100.2"));
      await failed(service.requestPasswordReset("member@example.com", "198.51.100.3"));
      await failed(service.requestPasswordReset("nobody@example.com", "198.51.100.4"));
      await failed(service.resetPassword(Buffer.alloc(32, 1).toString("base64url"), "test-password-9", "198.51.100.5"));
      await failed(service.acceptInvite(Buffer.alloc(32, 2).toString("base64url"), "x@example.com", "test-password-9", "X", "198.51.100.6"));
      await failed(service.beginOidc({ issuer: "https://idp.example.com", purpose: "login", verifier: "v".repeat(43), nonce: "n".repeat(43), state: Buffer.alloc(32, 3).toString("base64url"), ip: "198.51.100.7" }));
      await failed(service.beginEnrollment({ actor: { token: member.token }, password: "wrong-password-9", ip: "198.51.100.8" }));
      for (let bucket = 0; bucket <= tight.rateLimit.maxEntries + 2; bucket += 1) {
        for (let index = 0; index < 3; index += 1) await failed(service.login(`fill-${bucket}-${index}@example.com`, "wrong-password-1", `203.0.113.${bucket + 1}`));
      }
      await failed(service.login("member@example.com", "test-password-2", "192.0.2.1"));
      const written = await store.accounts.read();
      const kinds = new Set(written.throttle.map((entry) => entry.key.split(":").slice(0, 2).join(":")));
      for (const expected of ["login:ip", "login:ghost", "mfa:ip", "reset:ip", "reset:ghost", "token:ip", "link:ip"]) assert.ok(kinds.has(expected), expected);
      assert.ok(Object.values(written.memberThrottle).some((counters) => counters.login && counters.reset), "member counters were written");
      assert.ok(Object.values(written.memberThrottle).some((counters) => counters.mfa), "member code counters were written");
      // A new process: a fresh store reads the file as it was written.
      const reread = await new FileConfigurationStore(path).accounts.read();
      assert.deepEqual(reread.throttle, written.throttle);
      assert.deepEqual(reread.memberThrottle, written.memberThrottle);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")).accounts.throttle, written.throttle);
      assert.equal(dropped() - before, 0, "nothing this build writes is dropped on reading");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("names why it dropped a counter: a repeated key, or a member no longer there, counted once per document", async () => {
    const byReason = (reason: string) => Number(new RegExp(`^parallax_account_throttle_entries_dropped_total\\{reason="${reason}"\\} (\\d+)$`, "mu").exec(render())?.[1] ?? 0);
    const { store, f } = await withMember();
    const state = structuredClone(await store.read());
    const key = `login:ip:${"C".repeat(43)}`;
    state.throttle = [{ key, count: 1, expiresAt: f.now() + 60_000 }, { key, count: 2, expiresAt: f.now() + 60_000 }];
    state.memberThrottle = { ["G".repeat(43)]: { login: { count: 1, expiresAt: f.now() + 60_000 } } };
    const before = { duplicate: byReason("duplicate"), member: byReason("member") };
    const read = readAccountState(JSON.parse(JSON.stringify(state)));
    assert.deepEqual(read.throttle.map((entry) => entry.count), [1], "the first of a repeated key is kept");
    assert.deepEqual(read.memberThrottle, {});
    assert.deepEqual({ duplicate: byReason("duplicate") - before.duplicate, member: byReason("member") - before.member }, { duplicate: 1, member: 1 });
    readAccountState(JSON.parse(JSON.stringify(state)));
    assert.deepEqual({ duplicate: byReason("duplicate") - before.duplicate, member: byReason("member") - before.member }, { duplicate: 1, member: 1 },
      "reading the same document again does not count it again");
  });

  it("removes a member's counters with the member", async () => {
    const { f, service, store, admin } = await withMember();
    await service.setLegacyHost(new Date(f.now() + 600_000).toISOString(), "viewer");
    const legacy = await service.finishOidc({ issuer: "https://idp.example.com", subject: "old", legacyRole: "viewer",
      state: { issuer: "https://idp.example.com", purpose: "login", verifier: "v", nonce: "n", userId: null, epoch: null, sessionDigest: null } });
    assert.ok("token" in legacy);
    const legacyId = (await store.read()).users.find((u) => u.canonicalLoginKey.endsWith("@legacy.invalid"))!.userId;
    await failed(service.reauthenticate({ token: legacy.token }, "000000", "198.51.100.9"));
    assert.ok((await store.read()).memberThrottle[legacyId], "the legacy record has a counter");
    // Absorbing the legacy record into an account (the real link path) removes it, and its counters with it.
    // Removed by the service, not left for the parser to throw away as a counter for a missing member.
    const memberDrops = () => Number(/^parallax_account_throttle_entries_dropped_total\{reason="member"\} (\d+)$/mu.exec(render())?.[1] ?? 0);
    const dropsBefore = memberDrops();
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    await service.beginOidc({ issuer: "https://idp.example.com", purpose: "link", actor: admin.actor, verifier: "v".repeat(43), nonce: "n".repeat(43), state, ip: "198.51.100.10" });
    const handshake = await service.consumeOidcState(state, admin.actor.token);
    assert.deepEqual(await service.finishOidc({ issuer: "https://idp.example.com", subject: "old", state: handshake, actorToken: admin.actor.token }), { linked: true });
    assert.equal((await store.read()).users.some((u) => u.userId === legacyId), false, "the legacy record was absorbed");
    assert.equal((await store.read()).memberThrottle[legacyId], undefined);
    assert.equal(memberDrops() - dropsBefore, 0, "the counters were deleted with the member, not dropped on reading");
  });

  it("opens a store whose attempt counters are of an older shape, dropping only those counters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-throttle-shape-"));
    try {
      const path = join(directory, "config.json");
      const first = new FileConfigurationStore(path);
      const f = accountFixture(first.accounts);
      await enrolledAdministrator(await f.create(), f);
      // What an earlier build wrote: shared account-axis keys, and no per-member counters at all.
      const document = JSON.parse(await readFile(path, "utf8"));
      document.accounts.throttle = [{ key: `login:acct:${"A".repeat(43)}`, count: 2, expiresAt: f.now() + 60_000 },
        { key: `login:${"B".repeat(43)}`, count: 1, expiresAt: f.now() + 60_000 }, { key: "nonsense", count: -1 }];
      delete document.accounts.memberThrottle;
      await writeFile(path, JSON.stringify(document), { mode: 0o600 });
      const reopened = new FileConfigurationStore(path);
      const state = await reopened.accounts.read();
      assert.deepEqual([state.throttle, state.memberThrottle], [[], {}]);
      assert.equal(state.users.length, 1, "everything else is read as it was");
      const g = accountFixture(reopened.accounts);
      const login = await (await g.create()).login("admin@example.com", "test-password-1", "203.0.113.7");
      assert.ok("challenge" in login);
      // The rest of the document is still strict.
      document.accounts.users[0].role = "owner";
      await writeFile(path, JSON.stringify(document), { mode: 0o600 });
      await assert.rejects(new FileConfigurationStore(path).accounts.read());
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("records which member issued or revoked a machine token, without tying the token to that member", async () => {
    const store = new InMemoryAccountStateStore();
    const f = accountFixture(store);
    const service = await f.create();
    const admin = await enrolledAdministrator(service, f);
    const adapters = createInMemoryAdapters();
    const handler = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider), accounts: service,
      accessTokens: new AccessTokenService(new InMemoryAccessTokenRepository()) }, { enabled: true, tokens: [], accountSessions: service, disableTokenExchange: true });
    const issued = await handler(new Request("https://dns.example.com/api/v1/tokens", { method: "POST",
      headers: { origin: "https://dns.example.com", cookie: `__Host-parallax_account=${admin.token}`, "x-parallax-csrf": admin.csrf, "content-type": "application/json" },
      body: JSON.stringify({ subject: "ci", role: "viewer" }) }));
    assert.equal(issued.status, 201);
    const { audit } = await store.snapshot();
    const userId = (await service.context(admin.token)).user.userId;
    assert.ok(audit.some((entry) => entry.action === "token-issue-requested" && entry.userId === userId && entry.actor === `account:${userId}`));
  });
});
