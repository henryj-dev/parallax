import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { CredentialRepository } from "../../src/application/ports.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";
import { CredentialInUseError, EncryptedCredentialStore } from "../../src/security/credential-store.ts";

const directories: string[] = [];

/** Stands in for any backend; the store only ever hands it a sealed string. */
class MemoryCredentialRepository implements CredentialRepository {
  document: string | undefined;
  async read(): Promise<string | undefined> { return this.document; }
  async write(document: string): Promise<void> { this.document = document; }
  async update<T>(operation: (document: string | undefined) => { document: string; result: T }): Promise<T> {
    const replacement = operation(this.document);
    this.document = replacement.document;
    return replacement.result;
  }
}

async function fixture(key = randomBytes(32)) {
  const repository = new MemoryCredentialRepository();
  return { repository, key, store: new EncryptedCredentialStore({ repository, masterKey: key }) };
}

async function fileFixture(key = randomBytes(32)) {
  const directory = await mkdtemp(join(tmpdir(), "parallax-credentials-"));
  directories.push(directory);
  const filePath = join(directory, "configuration.json");
  const configuration = new FileConfigurationStore(filePath);
  return { filePath, key, store: new EncryptedCredentialStore({ repository: configuration.credentials, masterKey: key }) };
}

/** Builds a sealed document in the pre-profile layout so migration is exercised. */
function legacyDocument(key: Buffer, credentials: unknown[]): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("parallax:credential-store:v1", "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ credentials }), "utf8"), cipher.final()]);
  return `${JSON.stringify({
    version: 1,
    algorithm: "AES-256-GCM",
    nonce: nonce.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  })}\n`;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("EncryptedCredentialStore", () => {
  it("stores a reusable profile and binds apex domains to it without exposing the token", async () => {
    const { filePath, store } = await fileFixture();
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
    assert.equal(JSON.parse(JSON.parse(persisted).credentials).version, 1);
  });

  it("reuses one profile across several apex domains", async () => {
    const { repository, key, store } = await fixture();
    await store.upsertProfile("account-a", { accountId: "acct-a", token: "token-a" });
    for (const zone of ["one.example", "two.example", "three.example"]) {
      await store.bindZone(zone, { zoneId: `zone-${zone}`, profile: "account-a" });
    }

    const restarted = new EncryptedCredentialStore({ repository, masterKey: key });
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

  it("migrates a pre-profile document, sharing one profile per distinct token", async () => {
    const { repository, key } = await fixture();
    repository.document = legacyDocument(key, [
      { zone: "one.example", zoneId: "z1", token: "shared-token", updatedAt: "2026-01-01T00:00:00.000Z" },
      { zone: "two.example", zoneId: "z2", token: "shared-token", updatedAt: "2026-01-02T00:00:00.000Z" },
      { zone: "three.example", zoneId: "z3", token: "other-token", updatedAt: "2026-01-03T00:00:00.000Z" },
    ]);

    const store = new EncryptedCredentialStore({ repository, masterKey: key });
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
    const { repository, key, store } = await fixture();
    await store.upsertProfile("p", { token: "token-1" });
    await store.bindZone("example.com", { zoneId: "zone-1", profile: "p" });
    await store.bindZone("example.com", { zoneId: "zone-2", profile: "p" });

    const restarted = new EncryptedCredentialStore({ repository, masterKey: key });
    assert.equal((await restarted.getSecret("example.com"))?.zoneId, "zone-2");
    assert.equal(await restarted.unbindZone("example.com"), true);
    assert.equal(await restarted.unbindZone("example.com"), false);

    const restartedAgain = new EncryptedCredentialStore({ repository, masterKey: key });
    assert.deepEqual(await restartedAgain.listBindings(), []);
    assert.equal(await restartedAgain.getSecret("example.com"), undefined);
  });

  it("serializes concurrent mutations without losing credentials", async () => {
    const { repository, key, store } = await fixture();
    await store.upsertProfile("shared", { token: "token" });
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.bindZone(`zone-${index}.example.com`, {
      zoneId: `zone-id-${index}`,
      profile: "shared",
    })));

    const restarted = new EncryptedCredentialStore({ repository, masterKey: key });
    const listed = await restarted.listBindings();
    assert.equal(listed.length, 20);
    assert.deepEqual(listed.map(({ zone }) => zone), Array.from(
      { length: 20 },
      (_, index) => `zone-${index}.example.com`,
    ).sort((left, right) => left.localeCompare(right)));
  });

  it("reads replica changes fresh and atomically merges cross-instance mutations", async () => {
    const { repository, key, store: left } = await fixture();
    const right = new EncryptedCredentialStore({ repository, masterKey: key });
    await left.upsertProfile("shared", { token: "first" });
    assert.equal((await left.getProfileSecret("shared"))?.token, "first");

    await right.upsertProfile("shared", { token: "rotated" });
    assert.equal((await left.getProfileSecret("shared"))?.token, "rotated",
      "a reader must not retain decrypted replica state indefinitely");

    await Promise.all([
      left.bindZone("one.example", { zoneId: "z1", profile: "shared" }),
      right.bindZone("two.example", { zoneId: "z2", profile: "shared" }),
    ]);
    assert.deepEqual((await left.listBindings()).map((binding) => binding.zone), ["one.example", "two.example"]);
  });

  it("uses the file repository lock for credential mutations from separate stores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-credential-lock-"));
    directories.push(directory);
    const path = join(directory, "private", "configuration.json");
    const key = randomBytes(32);
    const left = new EncryptedCredentialStore({ repository: new FileConfigurationStore(path).credentials, masterKey: key });
    const right = new EncryptedCredentialStore({ repository: new FileConfigurationStore(path).credentials, masterKey: key });
    await left.upsertProfile("shared", { token: "token" });
    await Promise.all([
      left.bindZone("one.example", { zoneId: "z1", profile: "shared" }),
      right.bindZone("two.example", { zoneId: "z2", profile: "shared" }),
    ]);
    assert.deepEqual((await right.listBindings()).map((binding) => binding.zone), ["one.example", "two.example"]);
  });

  it("detects an authenticated envelope rollback after observing a newer revision", async () => {
    const { repository, key, store } = await fixture();
    await store.upsertProfile("p", { token: "first" });
    const older = repository.document;
    await store.upsertProfile("p", { token: "second" });
    await store.listProfiles();
    repository.document = older;

    await assert.rejects(store.listProfiles(), /credential store could not be opened/);
    // There is no external monotonic trust anchor in either supported backend.
    // A cold process has not observed the newer revision and therefore cannot
    // distinguish this valid old ciphertext from the current document.
    const cold = new EncryptedCredentialStore({ repository, masterKey: key });
    assert.equal((await cold.getProfileSecret("p"))?.token, "first");
  });

  it("fails closed for a wrong key without exposing secrets", async () => {
    const { repository, store } = await fixture();
    const secret = "must-never-appear-in-an-error";
    await store.upsertProfile("p", { token: secret });

    const wrongKeyStore = new EncryptedCredentialStore({ repository, masterKey: randomBytes(32) });
    await assert.rejects(
      wrongKeyStore.listProfiles(),
      (error: unknown) => error instanceof Error
        && error.message === "credential store could not be opened"
        && !error.message.includes(secret),
    );
  });

  it("fails closed for corrupt or unsupported documents without leaking their contents", async () => {
    const { repository, key, store } = await fixture();
    await store.upsertProfile("p", { token: "secret-token" });

    const corruptContent = "corrupt-content-secret";
    repository.document = corruptContent;
    const corruptStore = new EncryptedCredentialStore({ repository, masterKey: key });
    await assert.rejects(
      corruptStore.getProfile("p"),
      (error: unknown) => error instanceof Error
        && error.message === "credential store could not be opened"
        && !error.message.includes(corruptContent),
    );
  });

  it("requires an exact 32-byte master key and rejects invalid credentials safely", async () => {
    assert.throws(
      () => new EncryptedCredentialStore({ repository: new MemoryCredentialRepository(), masterKey: randomBytes(31) }),
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
