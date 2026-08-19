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
    await store.saveSettings({ fallbackResolver: "10.17.192.11" });
    assert.equal(bodies[0]?.fallbackResolver, "10.17.192.11");
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
});
