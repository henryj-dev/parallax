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
});
