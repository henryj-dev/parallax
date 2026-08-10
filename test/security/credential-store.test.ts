import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { CredentialInUseError, EncryptedCredentialStore } from "../../src/security/credential-store.ts";

const directories: string[] = [];

async function fixture(key = randomBytes(32)) {
  const directory = await mkdtemp(join(tmpdir(), "parallax-credentials-"));
  directories.push(directory);
  const filePath = join(directory, "credentials.json");
  return { filePath, key, store: new EncryptedCredentialStore({ filePath, masterKey: key }) };
}

/** Writes a store file in the pre-profile layout so migration can be exercised. */
async function writeLegacyDocument(filePath: string, key: Buffer, credentials: unknown[]): Promise<void> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("parallax:credential-store:v1", "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ credentials }), "utf8"), cipher.final()]);
  await writeFile(filePath, `${JSON.stringify({
    version: 1,
    algorithm: "AES-256-GCM",
    nonce: nonce.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  })}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("EncryptedCredentialStore", () => {
  it("stores a reusable profile and binds apex domains to it without exposing the token", async () => {
    const { filePath, store } = await fixture();
    const profile = await store.upsertProfile("Shared-Account", {
      accountId: "cloudflare-account-id",
      token: "highly-sensitive-api-token",
    });

    assert.deepEqual(profile, {
      name: "shared-account",
      accountId: "cloudflare-account-id",
      updatedAt: profile.updatedAt,
    });
    assert.equal("token" in profile, false);

    const binding = await store.bindZone("Example.COM.", { zoneId: "cloudflare-zone-id", profile: "shared-account" });
    assert.deepEqual(binding, {
      zone: "example.com",
      zoneId: "cloudflare-zone-id",
      profile: "shared-account",
      accountId: "cloudflare-account-id",
      updatedAt: binding.updatedAt,
    });
    assert.equal("token" in binding, false);
    assert.deepEqual(await store.listProfiles(), [profile]);
    assert.deepEqual(await store.listBindings(), [binding]);
    assert.equal((await store.getSecret("example.com"))?.token, "highly-sensitive-api-token");

    const persisted = await readFile(filePath, "utf8");
    assert.doesNotMatch(persisted, /highly-sensitive-api-token|cloudflare-zone-id|example\.com|shared-account/);
    assert.equal(JSON.parse(persisted).version, 1);
  });

  it("reuses one profile across several apex domains", async () => {
    const { filePath, key, store } = await fixture();
    await store.upsertProfile("account-a", { accountId: "acct-a", token: "token-a" });
    for (const zone of ["one.example", "two.example", "three.example"]) {
      await store.bindZone(zone, { zoneId: `zone-${zone}`, profile: "account-a" });
    }

    const restarted = new EncryptedCredentialStore({ filePath, masterKey: key });
    assert.deepEqual((await restarted.listBindings()).map((binding) => binding.zone), ["one.example", "three.example", "two.example"]);
    // Every binding resolves to the same token, so rotating it once is enough.
    for (const zone of ["one.example", "two.example", "three.example"]) {
      const secret = await restarted.getSecret(zone);
      assert.equal(secret?.token, "token-a");
      assert.equal(secret?.zoneId, `zone-${zone}`);
    }

    await restarted.upsertProfile("account-a", { accountId: "acct-a", token: "rotated" });
    assert.equal((await restarted.getSecret("two.example"))?.token, "rotated");
  });

  it("refuses to delete a profile that apex domains still use", async () => {
    const { store } = await fixture();
    await store.upsertProfile("shared", { token: "token" });
    await store.bindZone("one.example", { zoneId: "z1", profile: "shared" });
    await store.bindZone("two.example", { zoneId: "z2", profile: "shared" });

    await assert.rejects(
      store.deleteProfile("shared"),
      (error: unknown) => error instanceof CredentialInUseError
        && error.zones.join(",") === "one.example,two.example",
    );

    assert.equal(await store.unbindZone("one.example"), true);
    assert.equal(await store.unbindZone("two.example"), true);
    assert.equal(await store.deleteProfile("shared"), true);
    assert.equal(await store.deleteProfile("shared"), false);
  });

  it("rejects a binding that names a profile which does not exist", async () => {
    const { store } = await fixture();
    await assert.rejects(
      store.bindZone("example.com", { zoneId: "z1", profile: "missing" }),
      /credential profile missing does not exist/,
    );
  });

  it("migrates a pre-profile file, sharing one profile per distinct token", async () => {
    const { filePath, key } = await fixture();
    await writeLegacyDocument(filePath, key, [
      { zone: "one.example", zoneId: "z1", token: "shared-token", updatedAt: "2026-01-01T00:00:00.000Z" },
      { zone: "two.example", zoneId: "z2", token: "shared-token", updatedAt: "2026-01-02T00:00:00.000Z" },
      { zone: "three.example", zoneId: "z3", token: "other-token", updatedAt: "2026-01-03T00:00:00.000Z" },
    ]);

    const store = new EncryptedCredentialStore({ filePath, masterKey: key });
    assert.deepEqual((await store.listProfiles()).map((profile) => profile.name), ["one-example", "three-example"]);
    assert.deepEqual((await store.listBindings()).map((binding) => `${binding.zone}=${binding.profile}`), [
      "one.example=one-example",
      "three.example=three-example",
      "two.example=one-example",
    ]);
    assert.equal((await store.getSecret("two.example"))?.token, "shared-token");
    assert.equal((await store.getSecret("three.example"))?.token, "other-token");
  });

  it("persists updates and deletions across restarts", async () => {
    const { filePath, key, store } = await fixture();
    await store.upsertProfile("p", { token: "token-1" });
    await store.bindZone("example.com", { zoneId: "zone-1", profile: "p" });
    await store.bindZone("example.com", { zoneId: "zone-2", profile: "p" });

    const restarted = new EncryptedCredentialStore({ filePath, masterKey: key });
    assert.equal((await restarted.getSecret("example.com"))?.zoneId, "zone-2");
    assert.equal(await restarted.unbindZone("example.com"), true);
    assert.equal(await restarted.unbindZone("example.com"), false);

    const restartedAgain = new EncryptedCredentialStore({ filePath, masterKey: key });
    assert.deepEqual(await restartedAgain.listBindings(), []);
    assert.equal(await restartedAgain.getSecret("example.com"), undefined);
  });

  it("serializes concurrent mutations without losing credentials", async () => {
    const { filePath, key, store } = await fixture();
    await store.upsertProfile("shared", { token: "token" });
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.bindZone(`zone-${index}.example.com`, {
      zoneId: `zone-id-${index}`,
      profile: "shared",
    })));

    const restarted = new EncryptedCredentialStore({ filePath, masterKey: key });
    const listed = await restarted.listBindings();
    assert.equal(listed.length, 20);
    assert.deepEqual(listed.map(({ zone }) => zone), Array.from(
      { length: 20 },
      (_, index) => `zone-${index}.example.com`,
    ).sort((left, right) => left.localeCompare(right)));
  });

  it("fails closed for a wrong key without exposing secrets", async () => {
    const { filePath, store } = await fixture();
    const secret = "must-never-appear-in-an-error";
    await store.upsertProfile("p", { token: secret });

    const wrongKeyStore = new EncryptedCredentialStore({ filePath, masterKey: randomBytes(32) });
    await assert.rejects(
      wrongKeyStore.listProfiles(),
      (error: unknown) => error instanceof Error
        && error.message === "credential store could not be opened"
        && !error.message.includes(secret),
    );
  });

  it("fails closed for corrupt or unsupported files without leaking file contents", async () => {
    const { filePath, key, store } = await fixture();
    await store.upsertProfile("p", { token: "secret-token" });

    const corruptContent = "corrupt-content-secret";
    await writeFile(filePath, corruptContent, "utf8");
    const corruptStore = new EncryptedCredentialStore({ filePath, masterKey: key });
    await assert.rejects(
      corruptStore.getProfile("p"),
      (error: unknown) => error instanceof Error
        && error.message === "credential store could not be opened"
        && !error.message.includes(corruptContent),
    );
  });

  it("requires an exact 32-byte master key and rejects invalid credentials safely", async () => {
    assert.throws(
      () => new EncryptedCredentialStore({ filePath: "/tmp/unused", masterKey: randomBytes(31) }),
      /master key must be exactly 32 bytes/,
    );

    const { store } = await fixture();
    const suppliedSecret = "invalid-secret-value";
    await store.upsertProfile("p", { token: suppliedSecret });
    await assert.rejects(
      store.bindZone("invalid zone", { zoneId: "zone-id", profile: "p" }),
      (error: unknown) => error instanceof Error && !error.message.includes(suppliedSecret),
    );
    await assert.rejects(store.upsertProfile("Not A Name", { token: "t" }), /profile name must contain/);
  });
});
