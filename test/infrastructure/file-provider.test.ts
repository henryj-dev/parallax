import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { FileProviderAdapter } from "../../src/infrastructure/file-provider.ts";

describe("FileProviderAdapter", () => {
  it("persists provider records across adapter restarts", async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-provider-"));
    context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });
    const path = join(directory, "provider.json");
    const first = new FileProviderAdapter({ path });

    await first.apply("Example.COM./external", {
      kind: "create",
      desired: { id: "root", name: "@", type: "A", content: "192.0.2.1", ttl: 60 },
    });

    assert.deepEqual(await new FileProviderAdapter({ path }).list("example.com/external"), [{
      id: "root", providerId: "file-1", managed: true, name: "@", type: "A", content: "192.0.2.1", ttl: 60,
    }]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      version: 1,
      nextId: 2,
      targets: {
        "example.com/external": [{ id: "root", providerId: "file-1", managed: true, name: "@", type: "A", content: "192.0.2.1", ttl: 60 }],
      },
    });
  });

  it("serializes concurrent changes without losing records or leaving temporary files", async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-provider-"));
    context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });
    const path = join(directory, "provider.json");
    const adapter = new FileProviderAdapter({ path });

    await Promise.all(Array.from({ length: 12 }, (_, index) => adapter.apply("example.com/external", {
      kind: "create",
      desired: { id: `record-${index}`, name: `host-${index}`, type: "A", content: `192.0.2.${index + 1}`, ttl: 60 },
    })));

    assert.equal((await adapter.list("example.com/external")).length, 12);
    assert.deepEqual((await readdir(directory)).sort(), ["provider.json"]);
  });

  it("locks and re-reads changes made by independent adapter instances", async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-provider-shared-"));
    context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });
    const path = join(directory, "private", "provider.json");
    const left = new FileProviderAdapter({ path });
    const right = new FileProviderAdapter({ path });
    await Promise.all([left.list("example.com/external"), right.list("example.com/external")]);

    await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? left : right).apply("example.com/external", {
      kind: "create",
      desired: { id: `record-${index}`, name: `host-${index}`, type: "A", content: `192.0.2.${index + 1}`, ttl: 60 },
    })));

    const records = await left.list("example.com/external");
    assert.equal(records.length, 16);
    assert.equal(new Set(records.map((record) => record.providerId)).size, 16);
    assert.equal((await stat(join(directory, "private"))).mode & 0o777, 0o700);
    assert.deepEqual((await readdir(join(directory, "private"))).sort(), ["provider.json"]);
  });

  it("rejects corrupt persisted state instead of silently discarding it", async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-provider-"));
    context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });
    const path = join(directory, "provider.json");
    await writeFile(path, "not-json", "utf8");

    await assert.rejects(() => new FileProviderAdapter({ path }).list("example.com/external"), /invalid file provider state/i);
  });

  it("updates and deletes only managed records", async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-provider-"));
    context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });
    const adapter = new FileProviderAdapter({ path: join(directory, "provider.json") });
    await adapter.apply("example.com/external", { kind: "create", desired: { id: "root", name: "@", type: "A", content: "192.0.2.1", ttl: 60 } });
    const [created] = await adapter.list("example.com/external");
    assert.ok(created);
    await adapter.apply("example.com/external", { kind: "update", providerId: created.providerId, desired: { ...created, content: "192.0.2.2", ttl: 120 } });
    assert.equal((await adapter.list("example.com/external"))[0]?.content, "192.0.2.2");
    await adapter.apply("example.com/external", { kind: "delete", providerId: created.providerId, actual: { ...created, content: "192.0.2.2", ttl: 120 } });
    assert.deepEqual(await adapter.list("example.com/external"), []);
    await assert.rejects(() => adapter.apply("example.com/external", { kind: "delete", providerId: "foreign", actual: { ...created, providerId: "foreign", managed: false } }), /unmanaged/);
  });
});
