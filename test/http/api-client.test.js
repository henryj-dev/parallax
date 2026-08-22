import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError, createApiClient } from "../../public/api-client.js";

describe("portal API client", () => {
  it("reads every bounded zone page instead of hiding zones after the first page", async () => {
    const paths = [];
    const client = createApiClient({
      root: "https://portal.example/api/v1",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        paths.push(`${url.pathname}${url.search}`);
        const offset = Number(url.searchParams.get("offset"));
        return Response.json(offset === 0
          ? { zones: [{ name: "a.example" }], limit: 500, offset: 0, hasMore: true }
          : { zones: [{ name: "b.example" }], limit: 500, offset: 1, hasMore: false });
      },
    });

    assert.deepEqual(await client.listZones(), {
      zones: [{ name: "a.example" }, { name: "b.example" }],
    });
    assert.deepEqual(paths, [
      "/api/v1/zones?limit=500&offset=0",
      "/api/v1/zones?limit=500&offset=1",
    ]);
  });

  it("fails a non-advancing page instead of looping forever", async () => {
    const client = createApiClient({
      fetchImpl: async () => Response.json({ zones: [], limit: 500, offset: 0, hasMore: true }),
    });
    await assert.rejects(client.listZones(), (error) =>
      error instanceof ApiError && error.status === 502 && /did not advance/u.test(error.message));
  });

  it("walks every status page the same way it walks zone pages", async () => {
    const paths = [];
    const client = createApiClient({
      root: "https://portal.example/api/v1",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        paths.push(`${url.pathname}${url.search}`);
        const offset = Number(url.searchParams.get("offset"));
        return Response.json(offset === 0
          ? { zones: [{ zone: "a.example", state: "applied" }], limit: 500, offset: 0, hasMore: true }
          : { zones: [{ zone: "b.example", state: "pending" }], limit: 500, offset: 1, hasMore: false });
      },
    });

    assert.deepEqual(await client.statusOverview(), {
      zones: [{ zone: "a.example", state: "applied" }, { zone: "b.example", state: "pending" }],
    });
    assert.deepEqual(paths, [
      "/api/v1/status?limit=500&offset=0",
      "/api/v1/status?limit=500&offset=1",
    ]);
  });

  it("walks every history and revision page instead of stopping at one", async () => {
    const paths = [];
    const client = createApiClient({
      root: "https://portal.example/api/v1",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        paths.push(`${url.pathname}${url.search}`);
        const offset = Number(url.searchParams.get("offset"));
        if (url.pathname.endsWith("/history")) {
          return Response.json(offset === 0
            ? { entries: [{ action: "zone.created" }], limit: 500, offset: 0, hasMore: true }
            : { entries: [{ action: "record.upserted" }], limit: 500, offset: 1, hasMore: false });
        }
        return Response.json(offset === 0
          ? { revisions: [{ revision: 1 }], limit: 500, offset: 0, hasMore: true }
          : { revisions: [{ revision: 2 }], limit: 500, offset: 1, hasMore: false });
      },
    });

    assert.deepEqual(await client.history("example.com"), {
      entries: [{ action: "zone.created" }, { action: "record.upserted" }],
      limit: 500,
      offset: 1,
      hasMore: false,
    });
    assert.deepEqual(await client.listRevisions("example.com"), {
      revisions: [{ revision: 1 }, { revision: 2 }],
      limit: 500,
      offset: 1,
      hasMore: false,
    });
    assert.deepEqual(paths, [
      "/api/v1/zones/example.com/history?limit=500&offset=0",
      "/api/v1/zones/example.com/history?limit=500&offset=1",
      "/api/v1/zones/example.com/revisions?limit=500&offset=0",
      "/api/v1/zones/example.com/revisions?limit=500&offset=1",
    ]);
  });

  it("sets and deletes a fallback suffix on the existing HTTP routes", async () => {
    const calls = [];
    const client = createApiClient({
      root: "https://portal.example/api/v1",
      fetchImpl: async (input, init = {}) => {
        calls.push({ url: String(input), method: init.method ?? "GET", body: init.body });
        return Response.json({ outcome: "added" });
      },
    });
    await client.setFallbackSuffix("main", "example.com", "10.0.0.11");
    await client.deleteFallbackSuffix("main", "example.com");
    assert.equal(calls[0]?.method, "PUT");
    assert.equal(calls[0]?.url, "https://portal.example/api/v1/fallback/main/domains/example.com");
    assert.equal(JSON.parse(String(calls[0]?.body)).dnsServer, "10.0.0.11");
    assert.equal(calls[1]?.method, "DELETE");
    assert.equal(calls[1]?.url, "https://portal.example/api/v1/fallback/main/domains/example.com");
  });

  it("walks zoneless history pages from GET /history", async () => {
    const paths = [];
    const client = createApiClient({
      root: "https://portal.example/api/v1",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        paths.push(`${url.pathname}${url.search}`);
        const offset = Number(url.searchParams.get("offset"));
        return Response.json(offset === 0
          ? { entries: [{ action: "zone.created" }], limit: 500, offset: 0, hasMore: true }
          : { entries: [{ action: "desired.replaced" }], limit: 500, offset: 1, hasMore: false });
      },
    });
    assert.deepEqual(await client.globalHistory(), {
      entries: [{ action: "zone.created" }, { action: "desired.replaced" }],
      limit: 500,
      offset: 1,
      hasMore: false,
    });
    assert.deepEqual(paths, [
      "/api/v1/history?limit=500&offset=0",
      "/api/v1/history?limit=500&offset=1",
    ]);
  });
});
