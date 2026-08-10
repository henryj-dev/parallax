import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoreDnsFileAdapter, type CoreDnsFileOperations } from "../../src/adapters/coredns-file.ts";
import { ownershipComment } from "../../src/adapters/ownership.ts";

const OWNERSHIP_SECRET = "test-ownership-secret-that-is-at-least-32-bytes";

function memoryFiles(initial = ""): { files: CoreDnsFileOperations; read: () => string; reloads: string[] } {
  let contents = initial;
  const reloads: string[] = [];
  return {
    files: {
      read: async () => contents,
      write: async (_path, value) => { contents = value; },
      reload: async (target) => { reloads.push(target); },
    },
    read: () => contents,
    reloads,
  };
}

describe("CoreDnsFileAdapter", () => {
  it("reads generated and foreign records while scoping ownership to the target", async () => {
    const store = memoryFiles(`$ORIGIN example.com.\n@ 60 IN A 192.0.2.1 ; ${ownershipComment("example.com/internal", "root", OWNERSHIP_SECRET)}\nwww 300 IN CNAME origin.example.net.\n`);
    const adapter = new CoreDnsFileAdapter({ files: store.files, pathForTarget: () => "/zones/example.com.db", ownershipSecret: OWNERSHIP_SECRET });

    assert.deepEqual(await adapter.list("example.com/internal"), [
      { id: "root", providerId: "managed:root", managed: true, name: "@", type: "A", content: "192.0.2.1", ttl: 60 },
      { id: "line-3", providerId: "line:3", managed: false, name: "www", type: "CNAME", content: "origin.example.net", ttl: 300 },
    ]);
  });

  it("applies create, update, and delete without altering foreign lines", async () => {
    const store = memoryFiles("$ORIGIN example.com.\nlegacy 60 IN A 192.0.2.99\n");
    const adapter = new CoreDnsFileAdapter({ files: store.files, pathForTarget: () => "/zones/example.com.db", ownershipSecret: OWNERSHIP_SECRET });
    const target = "example.com/internal";

    await adapter.apply(target, { kind: "create", desired: { id: "web", name: "www", type: "A", content: "10.0.0.2", ttl: 60 } });
    const created = (await adapter.list(target)).find((record) => record.id === "web");
    assert.ok(created);
    await adapter.apply(target, { kind: "update", providerId: created.providerId, desired: { id: "web", name: "www", type: "A", content: "10.0.0.3", ttl: 120 } });
    await adapter.apply(target, { kind: "delete", providerId: created.providerId, actual: { ...created, content: "10.0.0.3", ttl: 120 } });

    assert.match(store.read(), /legacy 60 IN A 192\.0\.2\.99/);
    assert.doesNotMatch(store.read(), /10\.0\.0\./);
    assert.deepEqual(store.reloads, [target, target, target]);
  });

  it("bootstraps an authoritative zone and advances its SOA serial for every mutation", async () => {
    const store = memoryFiles();
    const adapter = new CoreDnsFileAdapter({ files: store.files, pathForTarget: () => "/zones/example.com.db", ownershipSecret: OWNERSHIP_SECRET });
    const target = "example.com/internal";

    await adapter.apply(target, { kind: "create", desired: { id: "web", name: "www", type: "A", content: "10.0.0.2", ttl: 60 } });
    assert.match(store.read(), /^\$ORIGIN example\.com\.$/m);
    assert.match(store.read(), /^@ 3600 IN SOA ns1\.example\.com\. hostmaster\.example\.com\. 1 3600 600 604800 300$/m);
    assert.match(store.read(), /^@ 3600 IN NS ns1\.example\.com\.$/m);

    const created = (await adapter.list(target)).find((record) => record.id === "web");
    assert.ok(created);
    await adapter.apply(target, { kind: "update", providerId: created.providerId, desired: { id: "web", name: "www", type: "A", content: "10.0.0.3", ttl: 120 } });
    assert.match(store.read(), /SOA ns1\.example\.com\. hostmaster\.example\.com\. 2 3600 600 604800 300/);
    await adapter.apply(target, { kind: "delete", providerId: created.providerId, actual: { ...created, content: "10.0.0.3", ttl: 120 } });
    assert.match(store.read(), /SOA ns1\.example\.com\. hostmaster\.example\.com\. 3 3600 600 604800 300/);
  });

  it("preserves foreign zone content while advancing a multiline SOA serial", async () => {
    const original = `$ORIGIN example.com.\n@ 3600 IN SOA ns.example.net. hostmaster.example.com. (\n  42 ; serial\n  3600 600 604800 300 )\n@ 3600 IN NS ns.example.net.\nlegacy 60 IN A 192.0.2.99 ; keep this comment\n`;
    const store = memoryFiles(original);
    const adapter = new CoreDnsFileAdapter({ files: store.files, pathForTarget: () => "/zones/example.com.db", ownershipSecret: OWNERSHIP_SECRET });

    await adapter.apply("example.com/internal", { kind: "create", desired: { id: "web", name: "www", type: "A", content: "10.0.0.2", ttl: 60 } });

    assert.match(store.read(), /\n  43 ; serial\n/);
    assert.match(store.read(), /legacy 60 IN A 192\.0\.2\.99 ; keep this comment/);
    assert.equal((store.read().match(/ IN NS /g) ?? []).length, 1);
  });

  it("fails without writing or reloading when the SOA serial cannot advance", async () => {
    const original = "$ORIGIN example.com.\n@ 3600 IN SOA ns.example.net. hostmaster.example.com. 4294967295 3600 600 604800 300\n@ 3600 IN NS ns.example.net.\n";
    const store = memoryFiles(original);
    const adapter = new CoreDnsFileAdapter({ files: store.files, pathForTarget: () => "/zones/example.com.db", ownershipSecret: OWNERSHIP_SECRET });

    await assert.rejects(
      () => adapter.apply("example.com/internal", { kind: "create", desired: { id: "web", name: "www", type: "A", content: "10.0.0.2", ttl: 60 } }),
      /serial is exhausted/,
    );
    assert.equal(store.read(), original);
    assert.deepEqual(store.reloads, []);
  });

  it("quotes and round-trips TXT content", async () => {
    const store = memoryFiles();
    const adapter = new CoreDnsFileAdapter({ files: store.files, pathForTarget: () => "/zones/example.com.db", ownershipSecret: OWNERSHIP_SECRET });
    await adapter.apply("example.com/internal", {
      kind: "create",
      desired: { id: "txt", name: "@", type: "TXT", content: "hello \\\"dns\\\"", ttl: 300 },
    });
    assert.equal((await adapter.list("example.com/internal"))[0]?.content, "hello \\\"dns\\\"");
  });

  it("splits TXT character-strings at 255 UTF-8 bytes without splitting code points", async () => {
    const store = memoryFiles();
    const adapter = new CoreDnsFileAdapter({ files: store.files, pathForTarget: () => "/zones/example.com.db", ownershipSecret: OWNERSHIP_SECRET });
    const content = "😀".repeat(100);

    await adapter.apply("example.com/internal", {
      kind: "create",
      desired: { id: "txt", name: "@", type: "TXT", content, ttl: 300 },
    });

    const txtLine = store.read().split("\n").find((line) => line.includes(" IN TXT ")) ?? "";
    const strings = [...txtLine.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
    assert.equal(strings.length, 2);
    assert.ok(strings.every((value) => Buffer.byteLength(value, "utf8") <= 255));
    assert.equal(strings.join(""), content);
    assert.equal((await adapter.list("example.com/internal")).find((record) => record.id === "txt")?.content, content);
  });

  it("does not treat semicolons or escapes inside foreign TXT strings as comments", async () => {
    const store = memoryFiles('@ 60 IN TXT "a;b" " and \\097 quote: \\"" ; owner note\n');
    const adapter = new CoreDnsFileAdapter({ files: store.files, pathForTarget: () => "/zones/example.com.db", ownershipSecret: OWNERSHIP_SECRET });
    assert.deepEqual(await adapter.list("example.com/internal"), [{
      id: "line-1", providerId: "line:1", managed: false, name: "@", type: "TXT", content: 'a;b and a quote: "', ttl: 60,
    }]);
  });

  it("refuses to mutate unmanaged provider ids", async () => {
    const store = memoryFiles("www 60 IN A 192.0.2.1\n");
    const adapter = new CoreDnsFileAdapter({ files: store.files, pathForTarget: () => "/zones/example.com.db", ownershipSecret: OWNERSHIP_SECRET });
    await assert.rejects(
      () => adapter.apply("example.com/internal", { kind: "delete", providerId: "line:1", actual: { id: "line-1", providerId: "line:1", managed: false, name: "www", type: "A", content: "192.0.2.1", ttl: 60 } }),
      /unmanaged/,
    );
  });
});
