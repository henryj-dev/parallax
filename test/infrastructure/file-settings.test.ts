import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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
