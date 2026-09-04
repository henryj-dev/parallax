import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { StoredAccessToken } from "../../src/application/ports.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";

describe("FileConfigurationStore", () => {
  it("locks and re-reads whole-document mutations across independent instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-settings-lock-"));
    try {
      const privateDirectory = join(directory, "private");
      const path = join(privateDirectory, "configuration.json");
      const left = new FileConfigurationStore(path);
      const right = new FileConfigurationStore(path);
      await Promise.all([left.settings.read(), right.settings.read()]);

      await Promise.all([
        left.settings.write({ auditRetentionDays: 30 }),
        right.settings.write({ publicOrigin: "https://dns.example" }),
      ]);

      assert.deepEqual(await left.settings.read(), {
        auditRetentionDays: 30,
        publicOrigin: "https://dns.example",
      });
      assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.doesNotMatch(await readFile(path, "utf8"), /\.tmp/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a permissive pre-existing directory without changing the shared parent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-settings-mode-"));
    try {
      const privateDirectory = join(directory, "existing");
      const path = join(privateDirectory, "configuration.json");
      await mkdir(privateDirectory, { mode: 0o755 });
      await writeFile(path, '{"version":1,"settings":{},"accessTokens":[]}\n', { mode: 0o644 });
      await chmod(privateDirectory, 0o755);
      await chmod(path, 0o644);

      await assert.rejects(
        new FileConfigurationStore(path).settings.read(),
        /private data directory must already have mode 0700/,
      );
      assert.equal((await stat(privateDirectory)).mode & 0o777, 0o755);
      assert.equal((await stat(path)).mode & 0o777, 0o644);

      await chmod(privateDirectory, 0o700);
      await new FileConfigurationStore(path).settings.read();
      assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/**
 * The last-administrator invariant, asked of the backend that ships by default.
 *
 * ⚠️ This rule has no single home. It is written out once per repository --
 * `postgres.ts`, `in-memory.ts` and here -- because the check and the delete
 * have to be one atomic act, and what makes them atomic is different in each:
 * a `FOR UPDATE` inside a transaction there, the cross-process file lock here.
 * There is no shared function to test once.
 *
 * 🔑 So a service-level test cannot stand in for this one, and the service-level
 * test that existed was measuring its own fake: `MemoryAccessTokenRepository`
 * implements the invariant itself, so `access-tokens.test.ts` asserted the rule
 * against an object that would have satisfied it whatever the real backends did.
 * The Postgres repository has its own case. **This one had none at all** -- and
 * it is the backend a deployment gets when it configures no database, which is
 * the deployment most likely to hold exactly one administrator token.
 *
 * What a break costs: the only administrator revokes themselves, the file is
 * rewritten without them, and the control plane is left with no credential that
 * can issue another. It is not recoverable through the API -- that is the whole
 * point of the invariant -- so it ends in editing the JSON by hand, on a
 * deployment whose operator chose the file backend to avoid running a database.
 */
describe("FileConfigurationStore access tokens", () => {
  /** A stored row shaped the way `readAccessToken` insists on: 32 bytes, base64url. */
  function storedToken(subject: string, role: StoredAccessToken["role"]): StoredAccessToken {
    return {
      id: `${subject}-id`,
      subject,
      role,
      digest: randomBytes(32).toString("base64url"),
      createdAt: new Date().toISOString(),
    };
  }

  async function store(): Promise<{ path: string; directory: string }> {
    const directory = await mkdtemp(join(tmpdir(), "parallax-file-tokens-"));
    return { directory, path: join(directory, "private", "configuration.json") };
  }

  it("refuses to revoke the last administrator, and leaves it in the file", async () => {
    const { directory, path } = await store();
    try {
      const tokens = new FileConfigurationStore(path).accessTokens;
      await tokens.create(storedToken("owner", "admin"));
      await tokens.create(storedToken("reader", "viewer"));

      // The control: a non-administrator goes, so the refusal below is about
      // the role and not about the repository refusing to delete anything.
      assert.equal(await tokens.revoke("reader-id", 0), "deleted");

      assert.equal(await tokens.revoke("owner-id", 0), "last-admin");
      // Read through a second instance, which re-reads the file rather than any
      // in-memory draft: the row has to still be on disk, not merely reported.
      const remaining = await new FileConfigurationStore(path).accessTokens.list();
      assert.deepEqual(remaining.map((token) => [token.subject, token.role]), [["owner", "admin"]]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("counts an administrator the file does not hold, and an id it does not know", async () => {
    const { directory, path } = await store();
    try {
      const tokens = new FileConfigurationStore(path).accessTokens;
      await tokens.create(storedToken("owner", "admin"));

      // An id nobody stored is neither a deletion nor a lockout. Reporting
      // `last-admin` here would tell an operator their token is protected when
      // it is simply not there.
      assert.equal(await tokens.revoke("nobody-id", 0), "not-found");

      // `retainedAdministratorCount` is the environment break-glass token: an
      // administrator this repository cannot see and cannot lose. With one of
      // those standing, revoking the stored administrator locks nobody out --
      // and a backend that ignored the argument would refuse here, stranding a
      // deployment that has exactly the credential the rule exists to protect.
      assert.equal(await tokens.revoke("owner-id", 1), "deleted");
      assert.deepEqual(await new FileConfigurationStore(path).accessTokens.list(), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /**
   * A second administrator makes the first one revocable, which is the half of
   * the rule that keeps it from being "administrators are permanent".
   */
  it("lets an administrator go once another one exists", async () => {
    const { directory, path } = await store();
    try {
      const tokens = new FileConfigurationStore(path).accessTokens;
      await tokens.create(storedToken("owner", "admin"));
      assert.equal(await tokens.revoke("owner-id", 0), "last-admin");

      await tokens.create(storedToken("deputy", "admin"));
      assert.equal(await tokens.revoke("owner-id", 0), "deleted");
      const remaining = await new FileConfigurationStore(path).accessTokens.list();
      assert.deepEqual(remaining.map((token) => token.subject), ["deputy"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
