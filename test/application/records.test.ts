import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictError, ControlPlane, NotFoundError, ProviderManagedRecordError } from "../../src/application/control-plane.ts";
import { DomainValidationError } from "../../src/domain/dns.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";

function setup(): ControlPlane {
  const adapters = createInMemoryAdapters();
  const clock = { now: () => new Date("2026-08-22T00:00:00.000Z") };
  return new ControlPlane(adapters.zones, adapters.statuses, adapters.provider, clock);
}

/** A zone with a few records in each view, for the reading tests to narrow. */
async function populated(): Promise<ControlPlane> {
  const service = setup();
  await service.createZone("example.com");
  await service.upsertRecord("example.com", "external", "root", {
    name: "@", type: "A", content: "8.8.8.10", ttl: 300,
  });
  await service.upsertRecord("example.com", "external", "www", {
    name: "www", type: "A", content: "8.8.8.11", ttl: 300, proxied: true,
  });
  await service.upsertRecord("example.com", "external", "mail", {
    name: "mail", type: "MX", content: "10 mx.example.com", ttl: 60,
  });
  await service.upsertRecord("example.com", "internal", "www-inside", {
    name: "www", type: "A", content: "10.0.0.5", ttl: 60,
  });
  return service;
}

describe("record listing", () => {
  it("reads every view at once and says which view each record came from", async () => {
    const service = await populated();
    const page = await service.listRecords("example.com");
    assert.deepEqual(page.records.map((record) => [record.view, record.id]), [
      ["external", "mail"],
      ["external", "root"],
      ["external", "www"],
      ["internal", "www-inside"],
    ]);
    assert.ok(page.records.every((record) => record.zone === "example.com"));
    assert.equal(page.total, 4);
    assert.equal(page.hasMore, false);
  });

  it("narrows by view, name, type, content and proxied together", async () => {
    const service = await populated();
    assert.deepEqual((await service.listRecords("example.com", { view: "external" })).records.map((record) => record.id), ["mail", "root", "www"]);
    assert.deepEqual((await service.listRecords("example.com", { name: "www" })).records.map((record) => record.view), ["external", "internal"]);
    assert.deepEqual((await service.listRecords("example.com", { type: "a" })).records.map((record) => record.id), ["root", "www", "www-inside"]);
    assert.deepEqual((await service.listRecords("example.com", { content: "mx.example.com" })).records.map((record) => record.id), ["mail"]);
    assert.deepEqual((await service.listRecords("example.com", { proxied: true })).records.map((record) => record.id), ["www"]);
    assert.deepEqual((await service.listRecords("example.com", { view: "external", type: "A", proxied: false })).records.map((record) => record.id), ["root"]);
  });

  it("searches the name and the content, and does not match across the two", async () => {
    const service = await populated();
    assert.deepEqual((await service.listRecords("example.com", { search: "10.0.0" })).records.map((record) => record.id), ["www-inside"]);
    // "www" ends one field and "8.8" begins the other; a search spanning them
    // would be reporting a record that contains the text in neither.
    assert.deepEqual((await service.listRecords("example.com", { search: "www8.8" })).records, []);
  });

  it("pages the matches and reports how many there were before paging", async () => {
    const service = await populated();
    const first = await service.listRecords("example.com", {}, { limit: 3, offset: 0 });
    assert.deepEqual(first.records.map((record) => record.id), ["mail", "root", "www"]);
    assert.equal(first.total, 4);
    assert.equal(first.hasMore, true);
    const second = await service.listRecords("example.com", {}, { limit: 3, offset: 3 });
    assert.deepEqual(second.records.map((record) => record.id), ["www-inside"]);
    assert.equal(second.hasMore, false);
  });

  it("refuses a type it does not know rather than reporting an empty zone", async () => {
    const service = await populated();
    await assert.rejects(service.listRecords("example.com", { type: "AAA" }), DomainValidationError);
  });

  it("reports a view the zone does not have as missing, not as empty", async () => {
    const service = setup();
    await service.createZone("example.com");
    await assert.rejects(service.listRecords("example.com", { view: "internal" }), NotFoundError);
  });

  it("carries the revision the records were read at", async () => {
    const service = await populated();
    const zone = await service.getZone("example.com");
    assert.equal((await service.listRecords("example.com")).revision, zone.revision);
  });
});

describe("reading one record", () => {
  it("returns the record with its view and the zone's revision", async () => {
    const service = await populated();
    const { record, revision } = await service.getRecord("example.com", "external", "www");
    assert.equal(record.content, "8.8.8.11");
    assert.equal(record.view, "external");
    assert.equal(record.zone, "example.com");
    assert.equal(revision, (await service.getZone("example.com")).revision);
  });

  it("reports an unknown id as missing", async () => {
    const service = await populated();
    await assert.rejects(service.getRecord("example.com", "external", "absent"), NotFoundError);
  });
});

describe("creating a record", () => {
  it("derives a readable identifier from the name and type", async () => {
    const service = setup();
    await service.createZone("example.com");
    const created = await service.createRecord("example.com", "external", {
      name: "api", type: "A", content: "8.8.8.30", ttl: 60,
    });
    assert.equal(created.record.id, "api-a");
    assert.equal(created.record.view, "external");
    assert.equal(created.revision, 2);
  });

  it("steps around an identifier already in use", async () => {
    const service = setup();
    await service.createZone("example.com");
    await service.createRecord("example.com", "external", { name: "api", type: "A", content: "8.8.8.30", ttl: 60 });
    const second = await service.createRecord("example.com", "external", { name: "api", type: "A", content: "8.8.8.31", ttl: 60 });
    assert.equal(second.record.id, "api-a-2");
  });

  it("refuses a repeat of a record it already holds", async () => {
    const service = setup();
    await service.createZone("example.com");
    const body = { name: "api", type: "A", content: "8.8.8.30", ttl: 60 };
    await service.createRecord("example.com", "external", body);
    // The derived id steps around the first record, so what refuses the repeat
    // is the RRset rule -- and it refuses rather than storing a second copy.
    await assert.rejects(service.createRecord("example.com", "external", body), DomainValidationError);
    assert.equal((await service.listRecords("example.com")).total, 1);
  });

  it("takes an identifier the caller chose, and refuses one that is taken", async () => {
    const service = setup();
    await service.createZone("example.com");
    const created = await service.createRecord("example.com", "external", {
      id: "chosen", name: "api", type: "A", content: "8.8.8.30", ttl: 60,
    });
    assert.equal(created.record.id, "chosen");
    // Creating is not replacing: an id that exists is a conflict, not an edit.
    await assert.rejects(service.createRecord("example.com", "external", {
      id: "chosen", name: "other", type: "A", content: "8.8.8.31", ttl: 60,
    }), ConflictError);
  });

  it("normalizes an external record the way the provider will hold it", async () => {
    const service = setup();
    await service.createZone("example.com");
    const created = await service.createRecord("example.com", "external", {
      name: "api", type: "A", content: "8.8.8.30", ttl: 300, proxied: true,
    });
    assert.equal(created.record.ttl, 1);
  });

  it("refuses a create against a revision the zone has moved past", async () => {
    const service = setup();
    await service.createZone("example.com");
    await assert.rejects(service.createRecord("example.com", "external", {
      name: "api", type: "A", content: "8.8.8.30", ttl: 60,
    }, "operator", 99), ConflictError);
  });
});

describe("patching a record", () => {
  it("changes only the field it names", async () => {
    const service = await populated();
    const { record } = await service.patchRecord("example.com", "external", "mail", { ttl: 120 });
    assert.equal(record.ttl, 120);
    assert.equal(record.content, "10 mx.example.com");
    assert.equal(record.type, "MX");
    assert.equal(record.name, "mail");
  });

  it("removes an optional field when the patch sets it to null", async () => {
    const service = await populated();
    const { record } = await service.patchRecord("example.com", "external", "www", { proxied: null, ttl: 300 });
    assert.equal(record.proxied, undefined);
    assert.equal(record.ttl, 300);
  });

  it("refuses an unknown field and a change of identity", async () => {
    const service = await populated();
    await assert.rejects(service.patchRecord("example.com", "external", "mail", { comment: "hello" }), DomainValidationError);
    await assert.rejects(service.patchRecord("example.com", "external", "mail", { id: "renamed" }), DomainValidationError);
  });

  it("validates the whole record, not only what changed", async () => {
    const service = await populated();
    // A CNAME cannot sit beside the A record already stored under `www` in the
    // internal view; the merged record is what has to be legal, not the patch.
    await assert.rejects(service.patchRecord("example.com", "internal", "www-inside", { type: "CNAME", content: "example.com" }), DomainValidationError);
  });

  it("keeps what a provider service owns locked, while its TTL stays editable", async () => {
    const service = setup();
    await service.createZone("example.com");
    await service.replaceDesiredState("example.com", {
      views: [{
        name: "external",
        records: [{
          id: "worker", name: "app", type: "A", content: "8.8.8.50", ttl: 1, proxied: true,
          managedBy: { service: "worker", resource: "api-worker" },
        }],
      }],
    });
    await assert.rejects(service.patchRecord("example.com", "external", "worker", { content: "8.8.8.51" }), ProviderManagedRecordError);
    // The lock is over what the service answers -- name, type, content and the
    // binding itself. A TTL is not, so the patch is accepted; the record is
    // proxied, so it settles on Cloudflare's Auto rather than the number sent.
    assert.equal((await service.patchRecord("example.com", "external", "worker", { ttl: 300 })).record.ttl, 1);
  });

  it("reports an unknown id as missing", async () => {
    const service = await populated();
    await assert.rejects(service.patchRecord("example.com", "external", "absent", { ttl: 60 }), NotFoundError);
  });
});

describe("batching record changes", () => {
  it("commits deletes, patches, puts and posts as one revision", async () => {
    const service = await populated();
    const before = (await service.getZone("example.com")).revision;
    const result = await service.batchRecords("example.com", "external", {
      deletes: [{ id: "mail" }],
      patches: [{ id: "root", ttl: 900 }],
      puts: [{ id: "www", name: "www", type: "A", content: "8.8.8.99", ttl: 300 }],
      posts: [{ name: "api", type: "A", content: "8.8.8.40", ttl: 60 }],
    });
    assert.equal(result.revision, before + 1);
    assert.deepEqual(result.deleted, ["mail"]);
    assert.deepEqual(result.records.map((record) => record.id).sort(), ["api-a", "root", "www"]);
    const external = await service.listRecords("example.com", { view: "external" });
    assert.deepEqual(external.records.map((record) => record.id), ["api-a", "root", "www"]);
    assert.equal(external.records.find((record) => record.id === "root")?.ttl, 900);
    assert.equal(external.records.find((record) => record.id === "www")?.content, "8.8.8.99");
  });

  it("lets a batch delete a record and reuse what it occupied", async () => {
    const service = await populated();
    // One at a time this is two revisions with a gap between them where the
    // name resolves to nothing. As a batch there is no such revision.
    await service.batchRecords("example.com", "external", {
      deletes: [{ id: "root" }],
      posts: [{ name: "@", type: "A", content: "8.8.8.10", ttl: 60 }],
    });
    const external = await service.listRecords("example.com", { view: "external", name: "@" });
    assert.deepEqual(external.records.map((record) => [record.id, record.content]), [["root-a", "8.8.8.10"]]);
  });

  it("commits nothing when one operation in the batch is refused", async () => {
    const service = await populated();
    const before = await service.getZone("example.com");
    await assert.rejects(service.batchRecords("example.com", "external", {
      patches: [{ id: "root", ttl: 900 }],
      deletes: [{ id: "absent" }],
    }), NotFoundError);
    const after = await service.getZone("example.com");
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.views, before.views);
  });

  it("refuses a batch that carries no operation, an unknown section or a bad entry", async () => {
    const service = await populated();
    await assert.rejects(service.batchRecords("example.com", "external", {}), DomainValidationError);
    await assert.rejects(service.batchRecords("example.com", "external", { upserts: [] }), DomainValidationError);
    await assert.rejects(service.batchRecords("example.com", "external", { patches: [{ ttl: 60 }] }), DomainValidationError);
    await assert.rejects(service.batchRecords("example.com", "external", { deletes: "mail" }), DomainValidationError);
  });

  it("refuses a batch larger than one request may rewrite", async () => {
    const service = await populated();
    const posts = Array.from({ length: 501 }, (_unused, index) => ({
      name: `host${index}`, type: "A", content: `8.8.${index % 200}.${index % 250}`, ttl: 60,
    }));
    await assert.rejects(service.batchRecords("example.com", "external", { posts }), DomainValidationError);
  });

  it("honours the expected revision like every other write", async () => {
    const service = await populated();
    await assert.rejects(service.batchRecords("example.com", "external", {
      deletes: [{ id: "mail" }],
    }, "operator", 99), ConflictError);
  });
});
