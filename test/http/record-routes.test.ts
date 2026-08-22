import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { createApiHandler } from "../../src/http/api.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";

type Handler = ReturnType<typeof createApiHandler>;

function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json", "x-parallax-actor": "test-user" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A zone with records in both views, reached only through the HTTP surface. */
async function setup(): Promise<Handler> {
  const adapters = createInMemoryAdapters();
  const service = new ControlPlane(adapters.zones, adapters.statuses, adapters.provider);
  await service.createZone("example.com");
  await service.upsertRecord("example.com", "external", "root", { name: "@", type: "A", content: "8.8.8.10", ttl: 300 });
  await service.upsertRecord("example.com", "external", "mail", { name: "mail", type: "MX", content: "10 mx.example.com", ttl: 60 });
  await service.upsertRecord("example.com", "internal", "www-inside", { name: "www", type: "A", content: "10.0.0.5", ttl: 60 });
  return createApiHandler({ controlPlane: service });
}

describe("record routes", () => {
  it("lists every view of a zone and carries the revision as an ETag", async () => {
    const handler = await setup();
    const response = await handler(request("/api/v1/zones/example.com/records"));
    assert.equal(response.status, 200);
    const body = await response.json() as { records: { id: string; view: string }[]; total: number; revision: number };
    assert.deepEqual(body.records.map((record) => `${record.view}/${record.id}`), [
      "external/mail", "external/root", "internal/www-inside",
    ]);
    assert.equal(body.total, 3);
    assert.equal(response.headers.get("etag"), `"${body.revision}"`);
  });

  it("takes the filters from the query string", async () => {
    const handler = await setup();
    const response = await handler(request("/api/v1/zones/example.com/records?type=A&view=external"));
    const body = await response.json() as { records: { id: string }[] };
    assert.deepEqual(body.records.map((record) => record.id), ["root"]);
  });

  it("pages a listing", async () => {
    const handler = await setup();
    const response = await handler(request("/api/v1/zones/example.com/records?limit=2&offset=1"));
    const body = await response.json() as { records: { id: string }[]; hasMore: boolean; total: number };
    assert.deepEqual(body.records.map((record) => record.id), ["root", "www-inside"]);
    assert.equal(body.total, 3);
    assert.equal(body.hasMore, false);
  });

  it("keeps a query string from widening a listing the path already scoped", async () => {
    const handler = await setup();
    const response = await handler(request("/api/v1/zones/example.com/views/external/records?view=internal"));
    const body = await response.json() as { records: { view: string }[] };
    assert.ok(body.records.length > 0);
    assert.ok(body.records.every((record) => record.view === "external"));
  });

  it("refuses a filter it cannot read", async () => {
    const handler = await setup();
    const badBoolean = await handler(request("/api/v1/zones/example.com/records?proxied=yes"));
    assert.equal(badBoolean.status, 400);
    const badType = await handler(request("/api/v1/zones/example.com/records?type=AAA"));
    assert.equal(badType.status, 400);
    assert.equal((await badType.json() as { error: string }).error, "validation_failed");
  });

  it("creates a record and answers with the identifier it derived", async () => {
    const handler = await setup();
    const response = await handler(request("/api/v1/zones/example.com/views/external/records", "POST", {
      name: "api", type: "A", content: "8.8.8.30", ttl: 60,
    }));
    assert.equal(response.status, 201);
    const body = await response.json() as { record: { id: string; view: string }; revision: number };
    assert.equal(body.record.id, "api-a");
    assert.equal(body.record.view, "external");
    assert.equal(response.headers.get("etag"), `"${body.revision}"`);

    const read = await handler(request("/api/v1/zones/example.com/views/external/records/api-a"));
    assert.equal(read.status, 200);
    assert.equal((await read.json() as { record: { content: string } }).record.content, "8.8.8.30");
  });

  it("refuses a create whose identifier is already taken", async () => {
    const handler = await setup();
    const response = await handler(request("/api/v1/zones/example.com/views/external/records", "POST", {
      id: "root", name: "api", type: "A", content: "8.8.8.30", ttl: 60,
    }));
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: string }).error, "conflict");
  });

  it("patches only the fields the body names", async () => {
    const handler = await setup();
    const response = await handler(request("/api/v1/zones/example.com/views/external/records/mail", "PATCH", { ttl: 120 }));
    assert.equal(response.status, 200);
    const body = await response.json() as { record: { ttl: number; content: string; type: string } };
    assert.equal(body.record.ttl, 120);
    assert.equal(body.record.content, "10 mx.example.com");
    assert.equal(body.record.type, "MX");
  });

  it("applies a batch as one revision", async () => {
    const handler = await setup();
    const before = await (await handler(request("/api/v1/zones/example.com/records"))).json() as { revision: number };
    const response = await handler(request("/api/v1/zones/example.com/views/external/records/batch", "POST", {
      deletes: [{ id: "mail" }],
      patches: [{ id: "root", ttl: 900 }],
      posts: [{ name: "api", type: "A", content: "8.8.8.30", ttl: 60 }],
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as { records: { id: string }[]; deleted: string[]; revision: number };
    assert.equal(body.revision, before.revision + 1);
    assert.deepEqual(body.deleted, ["mail"]);
    assert.deepEqual(body.records.map((record) => record.id).sort(), ["api-a", "root"]);
  });

  it("still reaches a record whose identifier happens to be `batch`", async () => {
    const handler = await setup();
    const created = await handler(request("/api/v1/zones/example.com/views/external/records/batch", "PUT", {
      name: "batch", type: "A", content: "8.8.8.60", ttl: 60,
    }));
    assert.equal(created.status, 200);
    const read = await handler(request("/api/v1/zones/example.com/views/external/records/batch"));
    assert.equal(read.status, 200);
    assert.equal((await read.json() as { record: { name: string } }).record.name, "batch");
    assert.equal((await handler(request("/api/v1/zones/example.com/views/external/records/batch", "DELETE"))).status, 200);
  });

  it("reports an unknown record as not found", async () => {
    const handler = await setup();
    const response = await handler(request("/api/v1/zones/example.com/views/external/records/absent"));
    assert.equal(response.status, 404);
    assert.equal((await response.json() as { error: string }).error, "not_found");
  });

  it("refuses a write against a revision the zone has moved past", async () => {
    const handler = await setup();
    for (const [path, method, body] of [
      ["/api/v1/zones/example.com/views/external/records", "POST", { name: "api", type: "A", content: "8.8.8.30", ttl: 60 }],
      ["/api/v1/zones/example.com/views/external/records/mail", "PATCH", { ttl: 120 }],
      ["/api/v1/zones/example.com/views/external/records/batch", "POST", { deletes: [{ id: "mail" }] }],
    ] as const) {
      const response = await handler(request(path, method, body, { "if-match": '"1"' }));
      assert.equal(response.status, 409, `${method} ${path}`);
    }
  });

  it("leaves a method it does not serve on that path unrouted", async () => {
    const handler = await setup();
    assert.equal((await handler(request("/api/v1/zones/example.com/records", "POST", {}))).status, 404);
    assert.equal((await handler(request("/api/v1/zones/example.com/views/external/records", "PATCH", {}))).status, 404);
  });
});
