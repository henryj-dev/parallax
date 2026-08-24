import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createApiClient } from "../../public/api-client.js";
import { syncPanel } from "../../public/panels.js";
import { adminControlsVisible, createStore, editorControlsVisible } from "../../public/store.js";

describe("portal mapping", () => {
  it("sends If-Match from the loaded zone revision when adopting", async () => {
    const seen = [];
    const client = createApiClient({
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        seen.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
        if (url.endsWith("/zones/example.com") && (init.method ?? "GET") === "GET") {
          return Response.json({
            name: "example.com",
            revision: 7,
            views: [{ name: "external", records: [] }, { name: "internal", records: [] }],
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        }
        if (url.includes("/zones/example.com/status")) {
          return Response.json({ zone: "example.com", desiredRevision: 7, statuses: [] });
        }
        if (url.includes("/zones/example.com/history")) {
          return Response.json({ entries: [] });
        }
        if (url.includes("/adopt")) {
          return Response.json({ seen: 0, adopted: [], warnings: [] });
        }
        return Response.json({});
      },
    });
    const store = createStore(client);
    store.getState().zones = [{ name: "example.com", revision: 7 }];
    await store.selectZone("example.com");
    await store.adopt();
    const adopt = seen.find((call) => String(call.url).includes("/adopt"));
    assert.ok(adopt, "adopt must go through the API client");
    assert.equal(adopt.headers["If-Match"], '"7"');
  });

  it("hides editor and admin mutation controls from a viewer", async () => {
    const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
    const app = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
    assert.match(html, /id="adopt-button"/);
    assert.match(html, /id="apply-button"/);
    assert.match(html, /id="delete-zone-button"/);
    assert.match(app, /editorControlsVisible/);
    assert.match(app, /adminControlsVisible/);
    assert.equal(editorControlsVisible({ authRequired: true, role: "viewer" }), false);
    assert.equal(adminControlsVisible({ authRequired: true, role: "viewer" }), false);
    assert.equal(adminControlsVisible({ authRequired: true, role: "editor" }), false);
    assert.equal(editorControlsVisible({ authRequired: true, role: "editor" }), true);
  });

  it("persists fallbackResolver through the settings command", async () => {
    const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
    assert.match(html, /name="fallbackResolver"/);
    const bodies = [];
    const client = createApiClient({
      fetchImpl: async (input, init = {}) => {
        if (String(input).includes("/settings") && init.method === "PUT") {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({ settings: JSON.parse(String(init.body)) });
        }
        return Response.json({ settings: {} });
      },
    });
    const store = createStore(client);
    await store.saveSettings({ fallbackResolver: "10.0.0.11" });
    assert.equal(bodies[0]?.fallbackResolver, "10.0.0.11");
  });

  it("does not treat a failed status or history fetch as pending or empty", async () => {
    const client = createApiClient({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/zones/example.com")) {
          return Response.json({
            name: "example.com",
            revision: 3,
            views: [{
              name: "external",
              records: [{ id: "web", name: "www", type: "A", content: "192.0.2.1", ttl: 300 }],
            }],
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        }
        if (url.includes("/status")) return new Response(JSON.stringify({ error: "unavailable" }), { status: 502 });
        if (url.includes("/history")) return new Response(JSON.stringify({ error: "unavailable" }), { status: 502 });
        return Response.json({});
      },
    });
    const store = createStore(client);
    store.getState().zones = [{ name: "example.com", revision: 3 }];
    await store.selectZone("example.com");
    const state = store.getState();
    assert.match(state.statusError, /unavailable|502/);
    assert.match(state.historyError, /unavailable|502/);
    assert.equal(state.history.length, 0);
    const panel = syncPanel(state);
    assert.equal(panel.kind, "error");
    assert.notEqual(panel.overall, "pending");
  });

  it("sends abandonProviderRecords when deleting a zone", async () => {
    const seen = [];
    const client = createApiClient({
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        seen.push({ url, method: init.method ?? "GET" });
        if ((init.method ?? "GET") === "DELETE" && url.includes("/zones/example.com")) {
          return Response.json({ removedProviderRecords: [] });
        }
        return Response.json({ zones: [] });
      },
    });
    const store = createStore(client);
    store.getState().activeZone = { name: "example.com", revision: 4 };
    await store.deleteActiveZone();
    const deleted = seen.find((call) => call.method === "DELETE");
    assert.ok(deleted);
    assert.match(deleted.url, /abandonProviderRecords=true/);
  });

  it("opens sign-in when administration load is unauthorized", async () => {
    const intents = [];
    const client = createApiClient({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/credentials/")) return Response.json({ profiles: [], credentials: [] });
        if (url.includes("/settings") || url.includes("/tokens")) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        return Response.json({});
      },
    });
    const store = createStore(client);
    store.onIntent((event) => intents.push(event.type));
    await store.loadAdministration();
    assert.ok(intents.includes("auth-required"));
    assert.equal(store.getState().authenticated, false);
  });

  it("sets and deletes one fallback suffix over the existing HTTP routes", async () => {
    const seen = [];
    const client = createApiClient({
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        seen.push({ url, method: init.method ?? "GET", body: init.body });
        if (url.includes("/fallback/main/coverage")) return Response.json({ zones: [] });
        if (url.includes("/fallback/main/preview")) return Response.json({ add: [], update: [], remove: [], adopt: [], conflict: [] });
        if (url.includes("/fallback/main") && !url.includes("/domains/")) return Response.json({ domains: [] });
        return Response.json({ outcome: "added", domains: [] });
      },
    });
    const store = createStore(client);
    store.getState().profiles = [{ name: "main" }];
    assert.equal(await store.setFallbackSuffix("main", "example.com", "10.0.0.11"), true);
    const put = seen.find((call) => call.method === "PUT");
    assert.ok(put, "set must PUT the suffix");
    assert.match(put.url, /\/fallback\/main\/domains\/example.com$/);
    assert.equal(JSON.parse(String(put.body)).dnsServer, "10.0.0.11");

    seen.length = 0;
    assert.equal(await store.deleteFallbackSuffix("main", "example.com"), true);
    const deleted = seen.find((call) => call.method === "DELETE");
    assert.ok(deleted, "delete must DELETE the suffix");
    assert.match(deleted.url, /\/fallback\/main\/domains\/example.com$/);
  });

  /**
   * ⚠️ This used to assert the walk: two requests on open, `limit=500` each,
   * until `hasMore` went false. That was the defect -- a year of audit pulled
   * into the browser the moment the panel opened -- so the expectation is
   * inverted rather than deleted. One page on open, the rest on request.
   */
  it("loads zoneless history one page at a time, and only asks again when told to", async () => {
    const paths = [];
    const client = createApiClient({
      fetchImpl: async (input) => {
        const url = new URL(String(input), "https://portal.example");
        paths.push(`${url.pathname}${url.search}`);
        const offset = Number(url.searchParams.get("offset"));
        return Response.json(offset === 0
          ? { entries: [{ action: "zone.created" }], limit: 50, offset: 0, hasMore: true }
          : { entries: [{ action: "record.upserted" }], limit: 50, offset: 1, hasMore: false });
      },
    });
    const store = createStore(client);

    assert.equal(await store.loadGlobalHistory(), true);
    assert.deepEqual(store.getState().history.map((entry) => entry.action), ["zone.created"]);
    assert.equal(store.getState().historyScope, "global");
    assert.deepEqual(paths, ["/api/v1/history?limit=50&offset=0"], "one request, not a walk");

    assert.equal(await store.loadMoreHistory(), true);
    assert.deepEqual(store.getState().history.map((entry) => entry.action), ["zone.created", "record.upserted"]);
    assert.deepEqual(paths, [
      "/api/v1/history?limit=50&offset=0",
      "/api/v1/history?limit=50&offset=1",
    ]);
  });

  it("posts same-origin identity logout as well as deleting the token session", async () => {
    const seen = [];
    const client = createApiClient({
      fetchImpl: async (input, init = {}) => {
        seen.push({ url: String(input), method: init.method ?? "GET", redirect: init.redirect });
        return new Response(null, { status: 204 });
      },
    });
    const store = createStore(client);
    await store.signOut();
    const identity = seen.find((call) => call.url.includes("/auth/logout"));
    assert.ok(identity, "sign-out must POST /auth/logout");
    assert.equal(identity.method, "POST");
    assert.equal(identity.redirect, "manual");
    const session = seen.find((call) => call.url.includes("/session") && call.method === "DELETE");
    assert.ok(session, "sign-out must still clear the token session");
  });
});

/**
 * The API caps a page at 500 rows; the client used to defeat that with a loop
 * that walked to the end. On a deployment with the default 365-day audit
 * retention, opening the history panel pulled the whole trail into the browser
 * and made the server walk it with a growing OFFSET, which slows as it goes.
 *
 * So the assertion is about *requests*, not rows: one page on open, one more
 * per press, and never a second request nobody asked for.
 */
describe("portal paging", () => {
  function pagingClient(pages) {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(String(url));
      const offset = Number(new URL(String(url), "http://localhost").searchParams.get("offset"));
      const page = pages[offset] ?? { entries: [], hasMore: false };
      return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { asked, client: createApiClient({ fetchImpl }) };
  }

  it("asks for one page of history when a zone is opened", async () => {
    const { asked, client } = pagingClient({
      0: { entries: [{ id: 3 }, { id: 2 }], hasMore: true },
      2: { entries: [{ id: 1 }], hasMore: false },
    });
    const store = createStore({
      ...client,
      getZone: async () => ({ name: "example.com", revision: 1, views: [] }),
      zoneStatus: async () => ({ statuses: [] }),
    });

    await store.selectZone("example.com");

    const historyRequests = asked.filter((url) => url.includes("/history"));
    assert.equal(historyRequests.length, 1, "one request, not a walk to the end");
    assert.match(historyRequests[0], /offset=0/u);
    assert.equal(store.getState().history.length, 2);
    assert.equal(store.getState().historyHasMore, true, "and it says there is more");
  });

  it("appends exactly one further page per press, then stops offering", async () => {
    const { asked, client } = pagingClient({
      0: { entries: [{ id: 3 }, { id: 2 }], hasMore: true },
      2: { entries: [{ id: 1 }], hasMore: false },
    });
    const store = createStore({
      ...client,
      getZone: async () => ({ name: "example.com", revision: 1, views: [] }),
      zoneStatus: async () => ({ statuses: [] }),
    });
    await store.selectZone("example.com");

    await store.loadMoreHistory();

    assert.equal(asked.filter((url) => url.includes("/history")).length, 2);
    assert.deepEqual(store.getState().history.map((entry) => entry.id), [3, 2, 1]);
    assert.equal(store.getState().historyHasMore, false);

    // Nothing left to ask for, so the next press must not reach the server.
    assert.equal(await store.loadMoreHistory(), false);
    assert.equal(asked.filter((url) => url.includes("/history")).length, 2);
  });

  it("does not leave the button forever when a page claims more but delivers none", async () => {
    const { client } = pagingClient({
      0: { entries: [{ id: 1 }], hasMore: true },
      1: { entries: [], hasMore: true },
    });
    const store = createStore({
      ...client,
      getZone: async () => ({ name: "example.com", revision: 1, views: [] }),
      zoneStatus: async () => ({ statuses: [] }),
    });
    await store.selectZone("example.com");

    await store.loadMoreHistory();

    assert.equal(store.getState().historyHasMore, false, "believe the rows, not the flag");
  });
});
