import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApiClient } from "../../public/api-client.js";
import { createStore, desiredState } from "../../public/store.js";

const policy = {
  name: "app",
  type: "A",
  enabled: true,
  probe: { kind: "http", port: 8080, path: "/health/ready" },
  responseTtlSeconds: 30,
};

const record = (content) => ({ id: "r1", name: "app", type: "A", content, ttl: 300, proxied: false });

/**
 * A fake API that keeps one zone, answers the routes the portal uses, and
 * records every request. Writes move the revision the way the server does.
 */
function fakeApi({ healthChecks = [policy], statusFails = false, carryEmpty = false } = {}) {
  const zone = {
    name: "example.com",
    revision: 7,
    views: [
      { name: "external", records: [] },
      { name: "internal", records: [record("10.0.0.11")], ...(healthChecks.length > 0 || carryEmpty ? { healthChecks } : {}) },
    ],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const seen = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input), "http://portal.example.com");
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    seen.push({ path: url.pathname, method, headers: init.headers ?? {}, body });
    const path = url.pathname.replace(/^\/api\/v1/u, "");
    if (path === "/zones/example.com" && method === "GET") return Response.json(zone);
    if (path === "/zones/example.com" && method === "PUT") {
      // The two refusals the server makes for a full replace: a stale revision,
      // and a body that leaves out the policies the zone holds.
      const ifMatch = (init.headers ?? {})["If-Match"];
      if (ifMatch !== undefined && ifMatch !== `"${zone.revision}"`) {
        return Response.json({ error: "the zone changed since it was read" }, { status: 409 });
      }
      const held = zone.views.find((view) => view.name === "internal")?.healthChecks ?? [];
      if (held.length > 0 && body.views.find((view) => view.name === "internal")?.healthChecks === undefined) {
        return Response.json({ error: "the internal view carries health checks this request leaves out" }, { status: 409 });
      }
      zone.revision += 1;
      zone.views = body.views;
      return Response.json(zone);
    }
    if (path === "/zones/example.com/status") return Response.json({ zone: "example.com", desiredRevision: zone.revision, statuses: [] });
    if (path === "/zones/example.com/history") return Response.json({ entries: [] });
    if (path === "/zones/example.com/health-check-status") {
      if (statusFails) return Response.json({ error: "status unavailable" }, { status: 503 });
      return Response.json({
        zone: "example.com",
        revision: zone.revision,
        probing: true,
        servedHere: true,
        transfers: "refused",
        healthChecks: (zone.views[1].healthChecks ?? []).map((entry) => ({
          ...entry,
          answer: "filtered",
          ttl: 30,
          healthyAddresses: 1,
          targets: [{ address: "10.0.0.11", status: "healthy", checkedAt: "2026-01-01T00:00:10.000Z" }],
        })),
      });
    }
    const single = /^\/zones\/example\.com\/views\/internal\/health-checks\/([^/]+)\/([^/]+)$/u.exec(path);
    if (single && method === "PUT") {
      const saved = { ...body, name: decodeURIComponent(single[1]), type: decodeURIComponent(single[2]) };
      const internal = zone.views[1];
      internal.healthChecks = [...(internal.healthChecks ?? []).filter((entry) => entry.name !== saved.name), saved];
      zone.revision += 1;
      return Response.json({ healthCheck: saved, revision: zone.revision });
    }
    if (single && method === "DELETE") {
      if (zone.views[1].healthChecks === undefined) return Response.json({ error: "no such check" }, { status: 404 });
      delete zone.views[1].healthChecks;
      zone.revision += 1;
      return Response.json({ revision: zone.revision });
    }
    return Response.json({});
  };
  return { zone, seen, client: createApiClient({ fetchImpl }) };
}

async function openZone(api) {
  const store = createStore(api.client);
  store.getState().zones = [{ name: "example.com", revision: api.zone.revision }];
  await store.selectZone("example.com");
  return store;
}

/** Stages an edit to the one record, so the editor holds unsaved work. */
function stageEdit(store, content) {
  const row = structuredClone(store.getState().records[0]);
  row.views.internal.content = content;
  assert.equal(store.stageRecord(row, 0), true);
}

describe("portal health checks", () => {
  it("keeps the internal view's policies in the desired state, and adds none when there are none", () => {
    const rows = [];
    const withPolicies = desiredState(rows, [policy]);
    assert.deepEqual(withPolicies.views.find((view) => view.name === "internal").healthChecks, [policy]);
    assert.equal("healthChecks" in withPolicies.views.find((view) => view.name === "external"), false);
    const without = desiredState(rows);
    assert.equal("healthChecks" in without.views.find((view) => view.name === "internal"), false);
    assert.equal("healthChecks" in desiredState(rows, []).views.find((view) => view.name === "internal"), false);
    // A page that knows the list is empty says so: that is the removal.
    assert.deepEqual(desiredState(rows, [], { explicit: true }).views.find((view) => view.name === "internal").healthChecks, []);
  });

  it("sends the emptied list as the removal when the last policy goes while edits are staged", async () => {
    const api = fakeApi();
    const store = await openZone(api);
    stageEdit(store, "10.0.0.12");
    assert.equal(await store.deleteHealthCheck("app", "A"), true);
    assert.equal(store.getState().dirty, true, "the staged edit is still staged");
    assert.deepEqual(store.getState().healthChecks, []);

    assert.equal(await store.apply(), true);
    const put = api.seen.find((call) => call.path.endsWith("/zones/example.com") && call.method === "PUT");
    assert.equal(put.headers["If-Match"], '"8"');
    assert.deepEqual(put.body.views.find((view) => view.name === "internal").healthChecks, []);
    assert.deepEqual(api.zone.views.find((view) => view.name === "internal").healthChecks, []);
  });

  it("sends back the empty list a read carried, which the server takes as valid", async () => {
    const api = fakeApi({ healthChecks: [], carryEmpty: true });
    const store = await openZone(api);
    assert.equal(store.getState().healthChecksKnown, true);
    stageEdit(store, "10.0.0.12");
    assert.equal(await store.apply(), true);
    const put = api.seen.find((call) => call.path.endsWith("/zones/example.com") && call.method === "PUT");
    assert.deepEqual(put.body.views.find((view) => view.name === "internal").healthChecks, []);
  });

  it("leaves the field out from a tab that never saw it, so a policy written since is refused rather than wiped", async () => {
    const api = fakeApi({ healthChecks: [] });
    const stale = await openZone(api);
    assert.equal(stale.getState().healthChecksKnown, false);
    stageEdit(stale, "10.0.0.12");
    // Another tab adds a policy after this one read the zone.
    api.zone.views.find((view) => view.name === "internal").healthChecks = [policy];
    api.zone.revision += 1;

    assert.equal(await stale.apply(), false);
    const put = api.seen.find((call) => call.path.endsWith("/zones/example.com") && call.method === "PUT");
    assert.equal(put.headers["If-Match"], '"7"');
    assert.equal("healthChecks" in put.body.views.find((view) => view.name === "internal"), false,
      "an empty list here would remove a policy this tab never saw");
    assert.deepEqual(api.zone.views.find((view) => view.name === "internal").healthChecks, [policy]);
    assert.equal(stale.getState().dirty, true, "the refused edit stays staged");
  });

  it("saves a record edit without dropping the zone's policies", async () => {
    const api = fakeApi();
    const store = await openZone(api);
    assert.deepEqual(store.getState().healthChecks, [policy]);
    stageEdit(store, "10.0.0.12");
    await store.apply();
    const put = api.seen.find((call) => call.path.endsWith("/zones/example.com") && call.method === "PUT");
    assert.ok(put, "the edit must be saved as a full replace");
    assert.deepEqual(put.body.views.find((view) => view.name === "internal").healthChecks, [policy]);
  });

  it("reads this process's verdicts only for a zone that has policies", async () => {
    const withPolicies = fakeApi();
    const store = await openZone(withPolicies);
    assert.equal(withPolicies.seen.filter((call) => call.path.endsWith("/health-check-status")).length, 1);
    assert.equal(store.getState().healthStatus?.healthChecks[0].answer, "filtered");
    assert.equal(store.getState().healthStatus?.transfers, "refused");

    const without = fakeApi({ healthChecks: [] });
    const plain = await openZone(without);
    assert.equal(without.seen.some((call) => call.path.endsWith("/health-check-status")), false);
    assert.deepEqual(plain.getState().healthChecks, []);
    assert.equal(plain.getState().healthStatus, null);
  });

  it("does not fail the zone when the status read fails", async () => {
    const api = fakeApi({ statusFails: true });
    const store = await openZone(api);
    assert.equal(store.getState().activeZone?.name, "example.com");
    assert.deepEqual(store.getState().healthChecks, [policy]);
    assert.equal(store.getState().healthStatus, null);
    assert.match(store.getState().healthStatusError, /status unavailable/u);
    assert.equal(await store.refreshHealthStatus(), false);
  });

  it("writes one policy at the loaded revision and reloads a clean editor", async () => {
    const api = fakeApi({ healthChecks: [] });
    const store = await openZone(api);
    const notices = [];
    store.onNotice((entry) => notices.push(entry));
    const apex = { ...policy, name: "@", probe: { kind: "tcp", port: 443 } };
    assert.equal(await store.saveHealthCheck(apex), true);
    const put = api.seen.find((call) => call.path.includes("/health-checks/") && call.method === "PUT");
    assert.equal(put.path, "/api/v1/zones/example.com/views/internal/health-checks/%40/A");
    assert.equal(put.headers["If-Match"], '"7"');
    assert.deepEqual(put.body.probe, { kind: "tcp", port: 443 });
    // Nothing was staged, so the zone is read again and carries the new revision.
    assert.equal(store.getState().activeZone?.revision, 8);
    assert.deepEqual(store.getState().healthChecks.map((entry) => entry.name), ["@"]);
    assert.ok(notices.some((entry) => entry.key === "health.saved"), "a saved check is announced");
  });

  it("keeps staged record edits across a policy write and saves them at the new revision", async () => {
    const api = fakeApi();
    const store = await openZone(api);
    stageEdit(store, "10.0.0.12");
    const changed = { ...policy, responseTtlSeconds: 10 };
    assert.equal(await store.saveHealthCheck(changed), true);
    assert.equal(store.getState().dirty, true, "the staged edit is still staged");
    assert.equal(store.getState().records[0].views.internal.content, "10.0.0.12");
    assert.equal(store.getState().activeZone?.revision, 8);

    await store.apply();
    const put = api.seen.find((call) => call.path.endsWith("/zones/example.com") && call.method === "PUT");
    assert.equal(put.headers["If-Match"], '"8"');
    assert.deepEqual(put.body.views.find((view) => view.name === "internal").healthChecks, [changed]);
  });

  it("deletes a policy with If-Match, and reports a refused delete instead of throwing", async () => {
    const api = fakeApi();
    const store = await openZone(api);
    assert.equal(await store.deleteHealthCheck("app", "A"), true);
    const removal = api.seen.find((call) => call.method === "DELETE");
    assert.equal(removal.path, "/api/v1/zones/example.com/views/internal/health-checks/app/A");
    assert.equal(removal.headers["If-Match"], '"7"');
    assert.deepEqual(store.getState().healthChecks, []);

    const notices = [];
    store.onNotice((entry) => notices.push(entry));
    assert.equal(await store.deleteHealthCheck("app", "A"), false);
    assert.ok(notices.some((entry) => entry.key === "health.deleteFailed" && entry.level === "error"));
  });

  it("refuses a policy write with the form's error and leaves the policies alone", async () => {
    const api = fakeApi();
    const failing = createApiClient({
      fetchImpl: async (input, init = {}) => {
        if (String(input).includes("/health-checks/") && init.method === "PUT") {
          return Response.json({ error: "port 22 is not in dnsHealthCheckAllowPorts" }, { status: 400 });
        }
        return Response.json({});
      },
    });
    const store = await openZone(api);
    const client = Object.assign(api.client, { setHealthCheck: failing.setHealthCheck });
    assert.equal(client.setHealthCheck, failing.setHealthCheck);
    assert.equal(await store.saveHealthCheck({ ...policy, probe: { kind: "tcp", port: 22 } }), false);
    assert.deepEqual(store.getState().healthChecks, [policy]);
    assert.equal(store.getState().errors.health?.key, "health.saveFailed");
    assert.match(String(store.getState().errors.health?.values.error), /dnsHealthCheckAllowPorts/u);
  });
});
