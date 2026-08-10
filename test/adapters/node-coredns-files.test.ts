import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { NodeCoreDnsFileOperations } from "../../src/adapters/node-coredns-files.ts";

describe("NodeCoreDnsFileOperations", () => {
  it("atomically writes and reads files within its root", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "parallax-coredns-"));
    context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
    const files = new NodeCoreDnsFileOperations({ root });

    assert.equal(await files.read("zones/example.com.db"), undefined);
    await files.write("zones/example.com.db", "$ORIGIN example.com.\n");

    assert.equal(await files.read("zones/example.com.db"), "$ORIGIN example.com.\n");
    assert.deepEqual(await readdir(join(root, "zones")), ["example.com.db"]);
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
});
