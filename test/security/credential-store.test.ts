import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { EncryptedCredentialStore } from "../../src/security/credential-store.ts";

const directories: string[] = [];

async function fixture(key = randomBytes(32)) {
  const directory = await mkdtemp(join(tmpdir(), "parallax-credentials-"));
  directories.push(directory);
  const filePath = join(directory, "credentials.json");
  return { filePath, key, store: new EncryptedCredentialStore({ filePath, masterKey: key }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("EncryptedCredentialStore", () => {
  it("stores encrypted per-zone Cloudflare credentials and exposes safe metadata", async () => {
    const { filePath, store } = await fixture();
    const metadata = await store.update("Example.COM.", {
      zoneId: "cloudflare-zone-id",
      token: "highly-sensitive-api-token",
    });

    assert.deepEqual(metadata, {
      zone: "example.com",
      zoneId: "cloudflare-zone-id",
      updatedAt: metadata.updatedAt,
    });
    assert.equal("token" in metadata, false);
    assert.deepEqual(await store.list(), [metadata]);
    assert.deepEqual(await store.getMetadata("example.com"), metadata);
    assert.deepEqual(await store.getSecret("example.com"), {
      ...metadata,
      token: "highly-sensitive-api-token",
    });

    const persisted = await readFile(filePath, "utf8");
    assert.doesNotMatch(persisted, /highly-sensitive-api-token|cloudflare-zone-id|example\.com/);
    assert.equal(JSON.parse(persisted).version, 1);
  });

  it("persists updates and deletions across restarts", async () => {
    const { filePath, key, store } = await fixture();
    await store.update("example.com", { zoneId: "zone-1", token: "token-1" });
    await store.update("example.com", { zoneId: "zone-2", token: "token-2" });

    const restarted = new EncryptedCredentialStore({ filePath, masterKey: key });
    assert.equal((await restarted.getSecret("example.com"))?.token, "token-2");
    assert.equal((await restarted.getMetadata("example.com"))?.zoneId, "zone-2");
    assert.equal(await restarted.delete("example.com"), true);
    assert.equal(await restarted.delete("example.com"), false);

    const restartedAgain = new EncryptedCredentialStore({ filePath, masterKey: key });
    assert.deepEqual(await restartedAgain.list(), []);
    assert.equal(await restartedAgain.getSecret("example.com"), undefined);
  });

  it("serializes concurrent mutations without losing credentials", async () => {
    const { filePath, key, store } = await fixture();
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.update(`zone-${index}.example.com`, {
      zoneId: `zone-id-${index}`,
      token: `token-${index}`,
    })));

    const restarted = new EncryptedCredentialStore({ filePath, masterKey: key });
    const listed = await restarted.list();
    assert.equal(listed.length, 20);
    assert.deepEqual(listed.map(({ zone }) => zone), Array.from(
      { length: 20 },
      (_, index) => `zone-${index}.example.com`,
    ).sort((left, right) => left.localeCompare(right)));
  });

  it("fails closed for a wrong key without exposing secrets", async () => {
    const { filePath, store } = await fixture();
    const secret = "must-never-appear-in-an-error";
    await store.update("example.com", { zoneId: "zone-id", token: secret });

    const wrongKeyStore = new EncryptedCredentialStore({ filePath, masterKey: randomBytes(32) });
    await assert.rejects(
      wrongKeyStore.list(),
      (error: unknown) => error instanceof Error
        && error.message === "credential store could not be opened"
        && !error.message.includes(secret),
    );
  });

  it("fails closed for corrupt or unsupported files without leaking file contents", async () => {
    const { filePath, key, store } = await fixture();
    await store.update("example.com", { zoneId: "zone-id", token: "secret-token" });

    const corruptContent = "corrupt-content-secret";
    await writeFile(filePath, corruptContent, "utf8");
    const corruptStore = new EncryptedCredentialStore({ filePath, masterKey: key });
    await assert.rejects(
      corruptStore.getMetadata("example.com"),
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
    await assert.rejects(
      store.update("invalid zone", { zoneId: "zone-id", token: suppliedSecret }),
      (error: unknown) => error instanceof Error && !error.message.includes(suppliedSecret),
    );
  });
});
