import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { describe, it } from "node:test";

import { ensurePrivateDirectory, withFileLock } from "../../src/infrastructure/atomic-file.ts";

describe("private file directories", () => {
  it("creates a missing dedicated directory with mode 0700", async () => {
    const parent = await mkdtemp(join(tmpdir(), "parallax-private-parent-"));
    try {
      const directory = join(parent, "private", "state");
      await ensurePrivateDirectory(directory);
      assert.equal((await stat(directory)).mode & 0o7777, 0o700);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects an existing shared directory without changing its permissions", async () => {
    const parent = await mkdtemp(join(tmpdir(), "parallax-shared-parent-"));
    try {
      const directory = join(parent, "shared");
      await mkdir(directory, { mode: 0o755 });
      await chmod(directory, 0o755);

      await assert.rejects(ensurePrivateDirectory(directory), /must already have mode 0700/);
      assert.equal((await stat(directory)).mode & 0o7777, 0o755);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects the filesystem root without changing its permissions", async () => {
    const root = parse(process.cwd()).root;
    const before = (await stat(root)).mode;
    await assert.rejects(ensurePrivateDirectory(root), /refusing to use filesystem root/);
    assert.equal((await stat(root)).mode, before);
  });

  it("does not make /tmp private when a data file is configured directly beneath it", async () => {
    if (process.platform === "win32") return;
    const before = (await stat("/tmp")).mode;
    await assert.rejects(
      ensurePrivateDirectory("/tmp"),
      /must already have mode 0700|must be a real directory/,
    );
    assert.equal((await stat("/tmp")).mode, before);
  });

  it("never unlinks a pre-existing lock while timing out", async () => {
    const parent = await mkdtemp(join(tmpdir(), "parallax-stale-lock-"));
    try {
      await chmod(parent, 0o700);
      const target = join(parent, "state.json");
      const lockPath = join(parent, ".state.json.lock");
      const marker = '{"nonce":"belongs-to-another-writer"}\n';
      await writeFile(lockPath, marker, { mode: 0o600 });

      await assert.rejects(
        withFileLock(target, async () => undefined, { timeoutMs: 20, retryMs: 1 }),
        /timed out acquiring file lock/,
      );
      assert.equal(await readFile(lockPath, "utf8"), marker,
        "a waiter must not reclaim a pathname that a live replacement writer may own");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
