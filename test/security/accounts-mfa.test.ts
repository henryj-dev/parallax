import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { Secret, TOTP } from "otpauth";
import { createRecoveryCodes, digestRecoveryCode, TotpAdapter, verifyRecoveryCode, type TotpPolicy } from "../../src/security/accounts/mfa.ts";

const POLICY: TotpPolicy = { digits: 8, periodSeconds: 30, window: 1, algorithm: "SHA1" };
const RFC_SECRET = Secret.fromUTF8("12345678901234567890").base32;

describe("encrypted account TOTP factors", () => {
  it("verifies RFC 6238 vectors and exposes a timestep for atomic replay enforcement", () => {
    const adapter = new TotpAdapter(POLICY, randomBytes(32), "Example");
    const encrypted = adapter.encryptSecret(RFC_SECRET, "user-example");
    assert.equal(encrypted.includes(RFC_SECRET), false);
    for (const [seconds, token] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
      [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]] as const) {
      assert.deepEqual(adapter.verify(encrypted, "user-example", token, seconds * 1000), { counter: Math.floor(seconds / 30) });
    }
    const matched = adapter.verify(encrypted, "user-example", "94287082", 59000)!;
    let lastCounter = -1;
    const consume = (counter: number): boolean => {
      if (counter <= lastCounter) return false;
      lastCounter = counter;
      return true;
    };
    assert.equal(consume(matched.counter), true);
    assert.equal(consume(adapter.verify(encrypted, "user-example", "94287082", 59000)!.counter), false);
  });

  it("accepts only the configured window, digits and algorithm", () => {
    const adapter = new TotpAdapter(POLICY, randomBytes(32), "Example");
    const encrypted = adapter.encryptSecret(RFC_SECRET, "user-example");
    assert.deepEqual(adapter.verify(encrypted, "user-example", "94287082", 89000), { counter: 1 });
    assert.equal(adapter.verify(encrypted, "user-example", "94287082", 119000), undefined);
    assert.equal(adapter.verify(encrypted, "user-example", "94287082 ", 59000), undefined);
    assert.equal(adapter.verify(encrypted, "user-example", "4287082", 59000), undefined);
    const sha256 = new TotpAdapter({ ...POLICY, algorithm: "SHA256" }, randomBytes(32), "Example");
    const seed = Secret.fromUTF8("12345678901234567890123456789012").base32;
    assert.deepEqual(sha256.verify(sha256.encryptSecret(seed, "user-example"), "user-example", "46119246", 59000), { counter: 1 });
  });

  it("binds ciphertext to the user and purpose, rejects tampering and incorrect keys", () => {
    const key = randomBytes(32), adapter = new TotpAdapter(POLICY, key, "Example");
    const encrypted = adapter.encryptSecret(RFC_SECRET, "user-example");
    assert.equal(adapter.verify(encrypted, "other-user", "94287082", 59000), undefined);
    assert.equal(new TotpAdapter(POLICY, randomBytes(32), "Example").verify(encrypted, "user-example", "94287082", 59000), undefined);
    const parts = encrypted.split(".");
    parts[3] = Buffer.alloc(20).toString("base64url");
    assert.equal(adapter.verify(parts.join("."), "user-example", "94287082", 59000), undefined);
    for (const invalid of ["", "v2.invalid", encrypted + "=", "x".repeat(300)]) {
      assert.equal(adapter.verify(invalid, "user-example", "94287082", 59000), undefined);
    }
    assert.equal(adapter.verify(encrypted, "user-example", "94287082", NaN), undefined);
    assert.equal(JSON.stringify(adapter), "{}");
  });

  it("generates independent 256-bit enrollment seeds and a library otpauth URI", () => {
    const adapter = new TotpAdapter(POLICY, randomBytes(32), "Example");
    const first = adapter.createEnrollment("person@example.com"), second = adapter.createEnrollment("person@example.com");
    assert.equal(Secret.fromBase32(first.secretBase32).bytes.length, 32);
    assert.notEqual(first.secretBase32, second.secretBase32);
    assert.match(first.otpauthUri, /^otpauth:\/\/totp\//u);
    assert.equal(new URL(first.otpauthUri).searchParams.get("secret"), first.secretBase32);
    const token = new TOTP({ secret: Secret.fromBase32(first.secretBase32), algorithm: POLICY.algorithm,
      digits: POLICY.digits, period: POLICY.periodSeconds }).generate({ timestamp: 1234567890000 });
    assert.ok(adapter.verify(adapter.encryptSecret(first.secretBase32, "user-example"), "user-example", token, 1234567890000));
  });

  it("rejects invalid explicit policy and malformed seed input", () => {
    for (const policy of [{ ...POLICY, digits: 5 }, { ...POLICY, periodSeconds: 0 }, { ...POLICY, window: 3 }]) {
      assert.throws(() => new TotpAdapter(policy, randomBytes(32), "Example"), { code: "invalid-policy" });
    }
    assert.throws(() => new TotpAdapter(POLICY, randomBytes(16), "Example"), { code: "invalid-policy" });
    const adapter = new TotpAdapter(POLICY, randomBytes(32), "Example");
    assert.throws(() => adapter.encryptSecret("bad secret", "user-example"), { code: "invalid-input" });
    assert.throws(() => adapter.createEnrollment("invalid\nlabel"), { code: "invalid-input" });
  });
});

describe("account recovery codes", () => {
  it("returns one-time presentation values and domain-separated storage digests", () => {
    const { codes, digests } = createRecoveryCodes(4);
    assert.equal(new Set(codes).size, 4);
    assert.equal(new Set(digests).size, 4);
    for (let index = 0; index < codes.length; index++) {
      assert.equal(Buffer.from(codes[index]!, "base64url").length, 32);
      assert.notEqual(codes[index], digests[index]);
      assert.equal(digestRecoveryCode(codes[index]!), digests[index]);
      assert.equal(verifyRecoveryCode(codes[index]!, digests[index]!), true);
      assert.equal(verifyRecoveryCode(codes[(index + 1) % 4]!, digests[index]!), false);
    }
    assert.equal(verifyRecoveryCode("invalid", digests[0]!), false);
    assert.equal(verifyRecoveryCode(codes[0]!, "invalid"), false);
    for (const count of [0, 101, NaN, 1.5]) assert.throws(() => createRecoveryCodes(count), { code: "invalid-input" });
  });
});
