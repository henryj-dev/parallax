import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPasswordHasher, PasswordError, type PasswordPolicy } from "../../src/security/accounts/passwords.ts";

// Cheap parameters are test fixtures, not deployment policy.
const POLICY: PasswordPolicy = { minLength: 8, maxBytes: 128,
  scrypt: { N: 1024, r: 8, p: 1, maxmem: 4 * 1024 * 1024, keylen: 32 },
  verifyLimits: { maxMemoryBytes: 32 * 1024 * 1024, maxWork: 2 ** 18, maxKeylen: 64 }, maxConcurrent: 1, maxQueued: 1 };
const unavailable = (error: unknown): boolean => error instanceof PasswordError && error.code === "unavailable";
const aborted = (error: unknown): boolean => error instanceof PasswordError && error.code === "aborted";

describe("bounded account password hashing", () => {
  it("salts hashes, compares exactly, handles dummy accounts and never trims or case-folds passwords", async () => {
    const hasher = await createPasswordHasher(POLICY);
    const password = "  Pässword  ";
    const first = await hasher.hash(password), second = await hasher.hash(password);
    assert.notEqual(first, second);
    assert.match(first, /^scrypt\$v1\$1024\$8\$1\$/u);
    assert.equal(Buffer.from(first.split("$")[5]!, "base64url").length, 16);
    assert.equal(hasher.isSafeHash(first), true);
    assert.equal(hasher.needsRehash(first), false);
    assert.equal(await hasher.verify(password, first), true);
    for (const wrong of [password.trim(), password.toLowerCase(), "not-the-password"]) {
      assert.equal(await hasher.verify(wrong, first), false);
    }
    assert.equal(await hasher.verify(password), false);
    assert.equal(await hasher.verify(password, "not-a-hash"), false);
  });

  it("checks UTF-8 byte limits and explicit policy, without leaking submitted values", async () => {
    const hasher = await createPasswordHasher(POLICY);
    for (const password of ["short", "é".repeat(65), "password\ud800"]) {
      await assert.rejects(hasher.hash(password), (error: unknown) => {
        assert.ok(error instanceof PasswordError);
        assert.equal(error.code, "invalid-password");
        assert.equal(error.message.includes(password), false);
        return true;
      });
    }
    assert.equal(await hasher.verify("x".repeat(129)), false);
    for (const policy of [
      { ...POLICY, maxConcurrent: 0 }, { ...POLICY, maxQueued: Infinity },
      { ...POLICY, minLength: 1.5 }, { ...POLICY, scrypt: { ...POLICY.scrypt, N: 1000 } },
      { ...POLICY, scrypt: { ...POLICY.scrypt, p: 0 } },
      { ...POLICY, scrypt: { ...POLICY.scrypt, maxmem: 1024 } },
      { ...POLICY, verifyLimits: { ...POLICY.verifyLimits, maxMemoryBytes: 1024 } },
      { ...POLICY, verifyLimits: { ...POLICY.verifyLimits, maxWork: 1 } },
      { ...POLICY, verifyLimits: { ...POLICY.verifyLimits, maxKeylen: 16 } },
    ]) await assert.rejects(createPasswordHasher(policy), { code: "invalid-policy" });
  });

  it("applies Unicode NFC before length checks and derivation, without other normalization", async () => {
    const hasher = await createPasswordHasher(POLICY);
    const nfc = "Pässwörd-Ångström", nfd = nfc.normalize("NFD");
    assert.notEqual(nfc, nfd);
    const fromNfc = await hasher.hash(nfc), fromNfd = await hasher.hash(nfd);
    for (const stored of [fromNfc, fromNfd]) {
      assert.equal(await hasher.verify(nfc, stored), true);
      assert.equal(await hasher.verify(nfd, stored), true);
      assert.equal(await hasher.verify(nfc.toUpperCase(), stored), false);
      assert.equal(await hasher.verify(` ${nfc}`, stored), false);
    }
    // Compatibility forms (NFKC) are not applied: the ligature stays distinct from "fi".
    assert.equal(await hasher.verify("ﬁ-password-fixture", await hasher.hash("fi-password-fixture")), false);
    // minLength counts NFC code points: 7 composed characters are 14 code points in NFD.
    const sevenComposed = "ä".repeat(7);
    assert.equal(Array.from(sevenComposed.normalize("NFD")).length, 14);
    await assert.rejects(hasher.hash(sevenComposed.normalize("NFD")), { code: "invalid-password" });
    // maxBytes counts NFC UTF-8 bytes: 64 x "ä" is 128 bytes in NFC but 192 bytes in NFD.
    const atLimit = "ä".repeat(64);
    assert.equal(Buffer.byteLength(atLimit.normalize("NFD"), "utf8"), 192);
    const limitHash = await hasher.hash(atLimit.normalize("NFD"));
    assert.equal(await hasher.verify(atLimit, limitHash), true);
    await assert.rejects(hasher.hash("ä".repeat(65)), { code: "invalid-password" });
    // Ill-formed UTF-16 is rejected before normalization, and oversized raw input before any normalization work.
    await assert.rejects(hasher.hash("password\udc00ä"), { code: "invalid-password" });
    await assert.rejects(hasher.hash("a".repeat(POLICY.maxBytes * 4 + 1)), { code: "invalid-password" });
    assert.equal(await hasher.verify("password\udc00ä", fromNfc), false);
  });

  it("accepts the shared baseline scrypt parameters and verify limits", { timeout: 30000 }, async () => {
    const baseline: PasswordPolicy = { minLength: 8, maxBytes: 128,
      scrypt: { N: 65536, r: 8, p: 2, maxmem: 100663296, keylen: 32 },
      verifyLimits: { maxMemoryBytes: 100663296, maxWork: 65536 * 8 * 2, maxKeylen: 32 }, maxConcurrent: 1, maxQueued: 0 };
    assert.ok(128 * 8 * (65536 + 2 + 2) <= baseline.scrypt.maxmem);
    const hasher = await createPasswordHasher(baseline);
    const stored = await hasher.hash("baseline-password-fixture");
    assert.match(stored, /^scrypt\$v1\$65536\$8\$2\$/u);
    assert.equal(hasher.isSafeHash(stored), true);
    assert.equal(hasher.needsRehash(stored), false);
    await assert.rejects(createPasswordHasher({ ...baseline, verifyLimits: { ...baseline.verifyLimits, maxMemoryBytes: 100663295 } }),
      { code: "invalid-policy" });
    await assert.rejects(createPasswordHasher({ ...baseline, verifyLimits: { ...baseline.verifyLimits, maxWork: 65536 * 8 * 2 - 1 } }),
      { code: "invalid-policy" });
  });

  it("rejects noncanonical, oversized and over-policy hashes without trusting their cost", async () => {
    const hasher = await createPasswordHasher(POLICY);
    const valid = await hasher.hash("password-fixture");
    const overLimit = valid.replace("$1024$", "$1048576$");
    assert.equal(hasher.isSafeHash(overLimit), false);
    await assert.rejects(hasher.verify("password-fixture", overLimit), { code: "unavailable" });
    const invalid = [valid.replace("$8$", "$33$"), valid.replace("$1024$", "$01024$"), valid.replace("$v1$", "$v2$"), `${valid}=`,
      valid.replace(valid.split("$")[5]!, "abc"), "x".repeat(1024)];
    for (const encoded of invalid) {
      assert.equal(hasher.isSafeHash(encoded), false);
      assert.equal(await hasher.verify("password-fixture", encoded), false);
      assert.equal(hasher.needsRehash(encoded), true);
    }
    const older = await createPasswordHasher({ ...POLICY, scrypt: { ...POLICY.scrypt, N: 512 } });
    const oldHash = await older.hash("password-fixture");
    assert.equal(await hasher.verify("password-fixture", oldHash), true);
    assert.equal(hasher.needsRehash(oldHash), true);
    assert.equal(await older.verify("password-fixture", valid), true);
    assert.equal(older.needsRehash(valid), true);
    const longHash = await (await createPasswordHasher({ ...POLICY, scrypt: { ...POLICY.scrypt, keylen: 64 } })).hash("password-fixture");
    assert.equal(await hasher.verify("password-fixture", longHash), true);
    const constrained = await createPasswordHasher({ ...POLICY, verifyLimits: { ...POLICY.verifyLimits, maxWork: 8192 } });
    const overWork = valid.replace("$1$", "$2$");
    await assert.rejects(constrained.verify("password-fixture", overWork), { code: "unavailable" });
  });

  it("bounds running and queued work and keeps an aborted running slot until crypto completes", async () => {
    const hasher = await createPasswordHasher({ ...POLICY, scrypt: { ...POLICY.scrypt, N: 16384, maxmem: 32 * 1024 * 1024 } });
    const runningAbort = new AbortController(), queuedAbort = new AbortController();
    const running = hasher.hash("password-fixture", { signal: runningAbort.signal });
    const runningResult = assert.rejects(running, aborted);
    const queued = hasher.hash("password-fixture", { signal: queuedAbort.signal });
    const queuedResult = assert.rejects(queued, aborted);
    await assert.rejects(hasher.hash("password-fixture"), unavailable);
    runningAbort.abort();
    await assert.rejects(hasher.hash("password-fixture"), unavailable);
    queuedAbort.abort();
    await queuedResult;
    const accepted = hasher.hash("password-fixture");
    await runningResult;
    assert.equal(hasher.isSafeHash(await accepted), true);
    await assert.rejects(hasher.hash("password-fixture", { signal: AbortSignal.abort() }), aborted);
    assert.equal(hasher.isSafeHash(await hasher.hash("password-fixture")), true);
  });
});
