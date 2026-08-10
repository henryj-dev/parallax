import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { createApiHandler, createNodeHandler } from "../../src/http/api.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";

function setup(): ReturnType<typeof createApiHandler> {
  const adapters = createInMemoryAdapters();
  return createApiHandler(new ControlPlane(adapters.zones, adapters.statuses, adapters.provider));
}

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

describe("HTTP API", () => {
  it("rejects oversized request bodies before buffering them", async () => {
    const adapters = createInMemoryAdapters();
    const handler = createNodeHandler(new ControlPlane(adapters.zones, adapters.statuses, adapters.provider));
    const incoming = Readable.from([]) as IncomingMessage;
    incoming.method = "POST";
    incoming.url = "/api/v1/zones";
    incoming.headers = { host: "localhost", "content-length": String(1_048_577) };
    let status = 0;
    let responseBody = "";
    const response = {
      writeHead(code: number) { status = code; return this; },
      end(value?: string) { responseBody = value ?? ""; return this; },
    } as unknown as ServerResponse;

    await handler(incoming, response);
    assert.equal(status, 413);
    assert.match(responseBody, /payload_too_large/);
  });

  it("returns the non-global publication acknowledgement contract through the API", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const unsafe = { name: "app", type: "A", content: "192.0.2.10", ttl: 60 };
    const blocked = await api(request("/api/v1/zones/example.com/views/external/records/app", "PUT", unsafe));
    assert.equal(blocked.status, 400);
    assert.match(JSON.stringify(await blocked.json()), /acknowledgeNonGlobalIp/);
    const accepted = await api(request("/api/v1/zones/example.com/views/external/records/app", "PUT", {
      ...unsafe, acknowledgeNonGlobalIp: true,
    }));
    assert.equal(accepted.status, 200);
  });

  it("previews a complete synthesized internal view and rejects cross-view DNS conflicts", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const candidate = {
      views: [
        { name: "external", records: [
          { id: "root", name: "@", type: "A", content: "8.8.8.8", ttl: 60, proxied: true },
          { id: "www", name: "www", type: "CNAME", content: "example.com", ttl: 300, proxied: true },
        ] },
        { name: "internal", records: [
          { id: "root-override", name: "@", type: "A", content: "10.0.0.8", ttl: 30 },
        ] },
      ],
    };
    const preview = await api(request("/api/v1/zones/example.com/preview?view=internal", "POST", candidate));
    assert.equal(preview.status, 200);
    const body = await preview.json() as { views: { internal: { operations: Array<{ desired: { content: string; proxied?: boolean } }> } } };
    assert.deepEqual(body.views.internal.operations.map((operation) => operation.desired.content).sort(), ["10.0.0.8", "example.com"]);
    assert.ok(body.views.internal.operations.every((operation) => operation.desired.proxied === undefined));

    const conflict = await api(request("/api/v1/zones/example.com", "PUT", {
      views: [
        { name: "external", records: [{ id: "address", name: "www", type: "A", content: "8.8.8.8", ttl: 60 }] },
        { name: "internal", records: [{ id: "alias", name: "www", type: "CNAME", content: "internal.example.com", ttl: 60 }] },
      ],
    }));
    assert.equal(conflict.status, 400);
    assert.match(JSON.stringify(await conflict.json()), /cannot coexist/);
  });

  it("supports zone CRUD, record CRUD, preview, apply, status and history", async () => {
    const api = setup();
    assert.equal((await api(request("/api/v1/zones", "POST", { name: "example.com" }))).status, 201);
    const put = await api(request("/api/v1/zones/example.com/views/external/records/root", "PUT", {
      name: "@", type: "A", content: "8.8.8.10", ttl: 60, proxied: true,
    }));
    assert.equal(put.status, 200);

    const preview = await (await api(request("/api/v1/zones/example.com/preview", "POST"))).json() as { views: { external: { summary: { create: number } } } };
    assert.equal(preview.views.external.summary.create, 1);
    assert.equal((await api(request("/api/v1/zones/example.com/apply", "POST"))).status, 200);
    const status = await (await api(request("/api/v1/zones/example.com/status"))).json() as { statuses: Array<{ state: string }> };
    assert.equal(status.statuses[0]?.state, "applied");
    const history = await (await api(request("/api/v1/zones/example.com/history"))).json() as { entries: unknown[] };
    assert.equal(history.entries.length, 2);
    assert.equal((await api(request("/api/v1/zones/example.com/views/external/records/root", "DELETE"))).status, 200);
    assert.equal((await api(request("/api/v1/zones/example.com", "DELETE"))).status, 204);
  });

  it("keeps individual RRset values addressable through record CRUD", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    for (const [id, content] of [["mx-one", "8.8.8.8"], ["mx-two", "8.8.4.4"]]) {
      assert.equal((await api(request(`/api/v1/zones/example.com/views/external/records/${id}`, "PUT", {
        name: "mail", type: "A", content, ttl: 60,
      }))).status, 200);
    }
    const removed = await api(request("/api/v1/zones/example.com/views/external/records/mx-one", "DELETE"));
    const zone = await removed.json() as { views: Array<{ name: string; records: Array<{ id: string; content: string }> }> };
    assert.deepEqual(zone.views.find((view) => view.name === "external")?.records, [
      { id: "mx-two", name: "mail", type: "A", content: "8.8.4.4", ttl: 60 },
    ]);
  });

  it("accepts a whole desired state with PUT and previews an unsaved candidate", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const desired = { views: { external: { records: [{ id: "root", name: "@", type: "A", content: "8.8.8.20", ttl: 300 }] } } };
    const previewResponse = await api(request("/api/v1/zones/example.com/preview", "POST", desired));
    const preview = await previewResponse.json() as { views: { external: { summary: { create: number } } } };
    assert.equal(preview.views.external.summary.create, 1);
    const before = await (await api(request("/api/v1/zones/example.com"))).json() as { revision: number; views: unknown[] };
    assert.equal(before.views.length, 0);
    const replaced = await (await api(request("/api/v1/zones/example.com", "PUT", desired))).json() as { revision: number };
    assert.equal(replaced.revision, 2);
  });

  it("returns actionable validation errors", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const response = await api(request("/api/v1/zones/example.com/views/external/records/root", "PUT", {
      name: "@", type: "A", content: "999.1.1.1", ttl: 0,
    }));
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string; issues: string[] };
    assert.equal(body.error, "validation_failed");
    assert.ok(body.issues.length >= 2);
  });

  it("normalizes proxied external TTL to Auto and rejects unsupported DNS-only TTLs", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const proxied = await api(request("/api/v1/zones/example.com/views/external/records/web", "PUT", {
      name: "www", type: "A", content: "8.8.8.8", ttl: 3600, proxied: true,
    }));
    assert.equal(proxied.status, 200);
    const zone = await proxied.json() as { views: Array<{ name: string; records: Array<{ ttl: number }> }> };
    assert.equal(zone.views.find((view) => view.name === "external")?.records[0]?.ttl, 1);

    for (const ttl of [59, 86_401]) {
      const rejected = await api(request("/api/v1/zones/example.com/views/external/records/dns", "PUT", {
        name: "dns", type: "A", content: "8.8.4.4", ttl, proxied: false,
      }));
      assert.equal(rejected.status, 400, String(ttl));
      assert.match(JSON.stringify(await rejected.json()), /Auto.*60.*86400/);
    }
  });

  it("uses revision ETags to reject stale desired-state writes", async () => {
    const api = setup();
    const created = await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    assert.equal(created.headers.get("etag"), '"1"');
    const fetched = await api(request("/api/v1/zones/example.com"));
    assert.equal(fetched.headers.get("etag"), '"1"');

    const desired = { views: [{ name: "external", records: [] }] };
    const first = await api(request("/api/v1/zones/example.com", "PUT", desired, { "if-match": '"1"' }));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("etag"), '"2"');

    const stale = await api(request("/api/v1/zones/example.com", "PUT", desired, { "if-match": '"1"' }));
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
      error: "conflict",
      message: "expected revision 1 for zone example.com, but the current revision is 2",
    });
    assert.equal((await (await api(request("/api/v1/zones/example.com"))).json() as { revision: number }).revision, 2);
  });

  it("requires If-Match to be one quoted positive integer when supplied", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const desired = { views: [] };
    for (const value of ["1", "*", 'W/"1"', '"0"', '"1", "2"']) {
      const response = await api(request("/api/v1/zones/example.com", "PUT", desired, { "if-match": value }));
      assert.equal(response.status, 400, value);
    }
  });

  it("checks If-Match on record writes and deletes", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const record = { name: "@", type: "A", content: "8.8.8.10", ttl: 60 };
    const created = await api(request(
      "/api/v1/zones/example.com/views/external/records/root",
      "PUT",
      record,
      { "if-match": '"1"' },
    ));
    assert.equal(created.headers.get("etag"), '"2"');
    assert.equal((await api(request(
      "/api/v1/zones/example.com/views/external/records/root",
      "DELETE",
      undefined,
      { "if-match": '"1"' },
    ))).status, 409);
    const deleted = await api(request(
      "/api/v1/zones/example.com/views/external/records/root",
      "DELETE",
      undefined,
      { "if-match": '"2"' },
    ));
    assert.equal(deleted.status, 200);
    assert.equal(deleted.headers.get("etag"), '"3"');
  });

  it("checks If-Match when restoring revisions and deleting zones", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    await api(request(
      "/api/v1/zones/example.com/views/external/records/root",
      "PUT",
      { name: "@", type: "A", content: "8.8.8.10", ttl: 60 },
      { "if-match": '"1"' },
    ));

    assert.equal((await api(request(
      "/api/v1/zones/example.com/revisions/1/restore",
      "POST",
      undefined,
      { "if-match": '"1"' },
    ))).status, 409);
    const restored = await api(request(
      "/api/v1/zones/example.com/revisions/1/restore",
      "POST",
      undefined,
      { "if-match": '"2"' },
    ));
    assert.equal(restored.headers.get("etag"), '"3"');
    assert.equal((await api(request("/api/v1/zones/example.com", "DELETE", undefined, { "if-match": '"2"' }))).status, 409);
    assert.equal((await api(request("/api/v1/zones/example.com", "DELETE", undefined, { "if-match": '"3"' }))).status, 204);
  });

  it("rejects apply when desired state changed after preview without touching the provider", async () => {
    const adapters = createInMemoryAdapters();
    const api = createApiHandler(new ControlPlane(adapters.zones, adapters.statuses, adapters.provider));
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const preview = await api(request("/api/v1/zones/example.com/preview", "POST"));
    assert.equal((await preview.json() as { revision: number }).revision, 1);
    await api(request(
      "/api/v1/zones/example.com/views/external/records/root",
      "PUT",
      { name: "@", type: "A", content: "8.8.8.10", ttl: 60 },
      { "if-match": '"1"' },
    ));

    const staleApply = await api(request(
      "/api/v1/zones/example.com/apply",
      "POST",
      undefined,
      { "if-match": '"1"' },
    ));
    assert.equal(staleApply.status, 409);
    assert.equal(adapters.provider.calls.length, 0);
    assert.equal((await adapters.statuses.list("example.com")).length, 2);
    assert.ok((await adapters.statuses.list("example.com")).every((status) => status.state === "pending"));
  });

  it("lists, reads and restores revision snapshots", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    await api(request("/api/v1/zones/example.com/views/external/records/root", "PUT", {
      name: "@", type: "A", content: "8.8.8.10", ttl: 60,
    }));
    await api(request("/api/v1/zones/example.com/views/external/records/root", "PUT", {
      name: "@", type: "A", content: "8.8.8.20", ttl: 60,
    }));

    const listedResponse = await api(request("/api/v1/zones/example.com/revisions"));
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json() as { revisions: Array<{ revision: number }> };
    assert.deepEqual(listed.revisions.map((item) => item.revision), [1, 2, 3]);

    const snapshot = await (await api(request("/api/v1/zones/example.com/revisions/2"))).json() as { revision: number; views: Array<{ records: Array<{ content: string }> }> };
    assert.equal(snapshot.views[0]?.records[0]?.content, "8.8.8.10");
    const restored = await (await api(request("/api/v1/zones/example.com/revisions/2/restore", "POST"))).json() as { revision: number };
    assert.equal(restored.revision, 4);
    assert.equal((await api(request("/api/v1/zones/example.com/revisions/not-a-number"))).status, 400);
    assert.equal((await api(request("/api/v1/zones/example.com/revisions/99"))).status, 404);
  });
});
