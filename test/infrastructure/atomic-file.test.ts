import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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

  it("reclaims a lock whose recorded pid is gone on this host without waiting out the timeout", async () => {
    const parent = await mkdtemp(join(tmpdir(), "parallax-dead-lock-"));
    try {
      await chmod(parent, 0o700);
      const target = join(parent, "state.json");
      const lockPath = join(parent, ".state.json.lock");
      await writeFile(lockPath, `${JSON.stringify({ hostname: hostname(), pid: 2_147_483_647, nonce: "dead" })}\n`, { mode: 0o600 });

      let ran = false;
      await withFileLock(target, async () => { ran = true; }, { timeoutMs: 40, retryMs: 1 });
      assert.equal(ran, true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  /**
   * A pid is not an identity, and in a container it is barely a hint.
   *
   * The server is pid 1 every time and the hostname is the pod's, so a lock
   * left behind by a crash named exactly the process that came back to find it.
   * `pidAlive` answered "held", and every write failed from then on until
   * somebody removed the file by hand -- one OOMKill away, on the file backend,
   * which is the default. Verified in a container before the fix: refused for
   * the full timeout. After: reclaimed in 3ms.
   *
   * The kernel's start time for the pid is what settles it, and only Linux
   * offers it. Elsewhere the pid check stands alone exactly as before, so this
   * case has nothing to assert and says so rather than pretending.
   */
  it("reclaims a lock from a pid that has been handed to a different process", { skip: linuxOnly() }, async () => {
    const parent = await mkdtemp(join(tmpdir(), "parallax-reused-pid-"));
    try {
      await chmod(parent, 0o700);
      const target = join(parent, "state.json");
      // This process's own pid, so `pidAlive` says yes -- the container case.
      // Only `startedAt` says the holder was somebody else.
      await writeFile(join(parent, ".state.json.lock"),
        `${JSON.stringify({ hostname: hostname(), pid: process.pid, nonce: "crashed", startedAt: "1" })}\n`,
        { mode: 0o600 });

      let ran = false;
      await withFileLock(target, async () => { ran = true; }, { timeoutMs: 200, retryMs: 5 });
      assert.equal(ran, true, "a lock from a previous incarnation of this pid is dead");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("still refuses a lock the running process really does hold", { skip: linuxOnly() }, async () => {
    const parent = await mkdtemp(join(tmpdir(), "parallax-live-pid-"));
    try {
      await chmod(parent, 0o700);
      const target = join(parent, "state.json");
      await writeFile(join(parent, ".state.json.lock"),
        `${JSON.stringify({ hostname: hostname(), pid: process.pid, nonce: "alive", startedAt: selfStartedAt() })}\n`,
        { mode: 0o600 });

      await assert.rejects(
        withFileLock(target, async () => undefined, { timeoutMs: 60, retryMs: 5 }),
        /timed out acquiring file lock/u,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

/** The kernel's start time for this process, in the units the lock records. */
function selfStartedAt(): string {
  const stat = readFileSync("/proc/self/stat", "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
}

/** A reason to skip, or `false` to run. Only Linux publishes process start times. */
function linuxOnly(): string | false {
  return existsSync("/proc/self/stat") ? false : "needs /proc, which only Linux has";
}
