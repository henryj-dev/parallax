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

  /**
   * ⚠️ Inverted, not deleted. This asserted the walk -- every page of history
   * and revisions fetched on open until `hasMore` went false -- and that was
   * the defect: the API caps a page at 500 precisely so a client does not do
   * this, and a year of audit reached the browser anyway. The caller asks for
   * a page now, and asks again if it wants more.
   */
  it("asks for exactly the page it was given, for history and revisions alike", async () => {
    const paths = [];
    const client = createApiClient({
      root: "https://portal.example/api/v1",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        paths.push(`${url.pathname}${url.search}`);
        const offset = Number(url.searchParams.get("offset"));
        if (url.pathname.endsWith("/history")) {
          return Response.json(offset === 0
            ? { entries: [{ action: "zone.created" }], limit: 50, offset: 0, hasMore: true }
            : { entries: [{ action: "record.upserted" }], limit: 50, offset: 1, hasMore: false });
        }
        return Response.json(offset === 0
          ? { revisions: [{ revision: 1 }], limit: 50, offset: 0, hasMore: true }
          : { revisions: [{ revision: 2 }], limit: 50, offset: 1, hasMore: false });
      },
    });

    assert.deepEqual(await client.history("example.com", { limit: 50, offset: 0 }), {
      entries: [{ action: "zone.created" }],
      limit: 50,
      offset: 0,
      hasMore: true,
    }, "the page, and the flag saying there is more");
    assert.deepEqual(await client.listRevisions("example.com", { limit: 50, offset: 1 }), {
      revisions: [{ revision: 2 }],
      limit: 50,
      offset: 1,
      hasMore: false,
    });
    assert.deepEqual(paths, [
      "/api/v1/zones/example.com/history?limit=50&offset=0",
      "/api/v1/zones/example.com/revisions?limit=50&offset=1",
    ], "one request each");
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

  it("reads one page of zoneless history from GET /history", async () => {
    const paths = [];
    const client = createApiClient({
      root: "https://portal.example/api/v1",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        paths.push(`${url.pathname}${url.search}`);
        const offset = Number(url.searchParams.get("offset"));
        return Response.json(offset === 0
          ? { entries: [{ action: "zone.created" }], limit: 50, offset: 0, hasMore: true }
          : { entries: [{ action: "desired.replaced" }], limit: 50, offset: 1, hasMore: false });
      },
    });
    assert.deepEqual(await client.globalHistory({ limit: 50, offset: 1 }), {
      entries: [{ action: "desired.replaced" }],
      limit: 50,
      offset: 1,
      hasMore: false,
    });
    assert.deepEqual(paths, ["/api/v1/history?limit=50&offset=1"]);
  });
});
