import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { NodeCoreDnsFileOperations } from "../../src/adapters/node-coredns-files.ts";

describe("NodeCoreDnsFileOperations", () => {
  it("atomically writes and reads files within its root", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "parallax-coredns-"));
    context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
    const durability: string[] = [];
    const files = new NodeCoreDnsFileOperations({ root, onDurabilityStep: (step) => durability.push(step) });

    assert.equal(await files.read("zones/example.com.db"), undefined);
    await files.write("zones/example.com.db", "$ORIGIN example.com.\n");

    assert.equal(await files.read("zones/example.com.db"), "$ORIGIN example.com.\n");
    assert.deepEqual(await readdir(join(root, "zones")), ["example.com.db"]);
    assert.deepEqual(durability, ["file-synced", "renamed", "directory-synced"]);
    assert.equal((await stat(join(root, "zones/example.com.db"))).mode & 0o777, 0o644);
  });

  it("accepts absolute paths only when they remain inside the configured root", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "parallax-coredns-"));
    context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
    const files = new NodeCoreDnsFileOperations({ root });
    const path = join(root, "example.com.db");
    await files.write(path, "safe");
    assert.equal(await readFile(path, "utf8"), "safe");
    await assert.rejects(() => files.write(join(root, "..", "escaped.db"), "unsafe"), /outside/i);
    await assert.rejects(() => files.read("../escaped.db"), /outside/i);
  });

  it("calls the injected reload hook after the adapter requests reload", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "parallax-coredns-"));
    context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
    const calls: Array<{ target: string; path: string }> = [];
    const files = new NodeCoreDnsFileOperations({ root, reload: async (target, path) => { calls.push({ target, path }); } });
    await files.reload("example.com/internal", "zones/example.com.db");
    assert.deepEqual(calls, [{ target: "example.com/internal", path: join(root, "zones/example.com.db") }]);
  });

  it("rejects zone-file symlinks that escape the configured root", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "parallax-coredns-"));
    const outside = await mkdtemp(join(tmpdir(), "parallax-coredns-outside-"));
    context.after(async () => {
      const { rm } = await import("node:fs/promises");
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    });
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "outside");
    await symlink(secret, join(root, "example.com.zone"));
    const files = new NodeCoreDnsFileOperations({ root });
    await assert.rejects(() => files.read("example.com.zone"), /symbolic link/);
    await assert.rejects(() => files.write("example.com.zone", "changed"), /symbolic link/);
    assert.equal(await readFile(secret, "utf8"), "outside");
  });

  it("does not follow a parent directory swapped to an external symlink during read", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "parallax-coredns-"));
    const outside = await mkdtemp(join(tmpdir(), "parallax-coredns-outside-"));
    context.after(async () => {
      const { rm } = await import("node:fs/promises");
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    });
    await mkdir(join(root, "zones"));
    await writeFile(join(root, "zones/example.com.zone"), "inside");
    await writeFile(join(outside, "example.com.zone"), "outside-secret");
    let swapped = false;
    const files = new NodeCoreDnsFileOperations({
      root,
      beforeReadOpen: async () => {
        if (swapped) return;
        swapped = true;
        await rename(join(root, "zones"), join(root, "zones-safe"));
        await symlink(outside, join(root, "zones"));
      },
    });

    await assert.rejects(() => files.read("zones/example.com.zone"), /outside configured root|changed/);
    assert.equal(await readFile(join(outside, "example.com.zone"), "utf8"), "outside-secret");
  });
});
