import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { DEFAULT_SETTINGS, type SettingsService } from "../../src/application/settings.ts";
import { runCommand } from "../../src/cli/commands.ts";
import { createHealthMonitor } from "../../src/dns/health/monitor.ts";
import { servedZones } from "../../src/dns/snapshot.ts";
import { createApiHandler } from "../../src/http/api.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";
import { createAuthorizedHandler, type SecurityConfig } from "../../src/security/http-authorization.ts";

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

const BASE = "/api/v1/zones/example.com/views/internal/health-checks";
const tcp = { kind: "tcp", port: 443 } as const;

async function setup() {
  const adapters = createInMemoryAdapters();
  const service = new ControlPlane(adapters.zones, adapters.statuses, adapters.provider, undefined, undefined, {},
    (target) => target.endsWith("/internal") ? "listener" : "provider");
  await service.createZone("example.com");
  await service.upsertRecord("example.com", "internal", "app-1", { name: "app", type: "A", content: "10.0.0.11", ttl: 300 });
  await service.upsertRecord("example.com", "internal", "root", { name: "@", type: "A", content: "10.0.0.12", ttl: 300 });
  return { service, handler: createApiHandler({ controlPlane: service }) };
}

describe("health check routes", () => {
  it("lets an editor's token write a policy through the role gate, and refuses a viewer's", async () => {
    const { handler } = await setup();
    const security: SecurityConfig = {
      enabled: true,
      tokens: [
        { token: "viewer-secret-0000000000000000000", role: "viewer", subject: "read-only" },
        { token: "editor-secret-0000000000000000000", role: "editor", subject: "operator" },
      ],
    };
    const gated = createAuthorizedHandler(security, handler);
    const as = (token: string, path: string, method = "GET", body?: unknown): Request =>
      request(path, method, body, { authorization: `Bearer ${token}` });
    const viewer = "viewer-secret-0000000000000000000";
    const editor = "editor-secret-0000000000000000000";

    assert.equal((await gated(as(viewer, `${BASE}/app/A`, "PUT", { enabled: true, probe: tcp }))).status, 403);
    const put = await gated(as(editor, `${BASE}/app/A`, "PUT", { enabled: true, probe: tcp }));
    assert.equal(put.status, 200);
    const listed = await gated(as(viewer, BASE));
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json() as { healthChecks: { name: string }[] }).healthChecks.map((policy) => policy.name), ["app"]);
    assert.equal((await gated(as(viewer, "/api/v1/zones/example.com/health-check-status"))).status, 200);
    assert.equal((await gated(as(viewer, `${BASE}/app/A`, "DELETE"))).status, 403);
    const removed = await gated(as(editor, `${BASE}/app/A`, "DELETE"));
    assert.equal(removed.status, 200);
    // Settings stay an administrator's, health checks or not.
    assert.equal((await gated(as(editor, "/api/v1/settings", "PATCH", { dnsHealthChecksEnabled: true }))).status, 403);
  });

  it("puts, lists and deletes a policy, with the revision as the ETag and If-Match honoured", async () => {
    const { handler } = await setup();
    const listed = await handler(request(BASE));
    assert.equal(listed.status, 200);
    const etag = listed.headers.get("etag");
    assert.deepEqual((await listed.json() as { healthChecks: unknown[] }).healthChecks, []);

    const stale = await handler(request(`${BASE}/app/A`, "PUT", { probe: tcp }, { "if-match": '"999"' }));
    assert.equal(stale.status, 409);

    const put = await handler(request(`${BASE}/app/A`, "PUT", { enabled: true, probe: tcp, responseTtlSeconds: 10 }, { "if-match": etag ?? "" }));
    assert.equal(put.status, 200);
    const saved = await put.json() as { healthCheck: Record<string, unknown>; revision: number };
    assert.deepEqual(saved.healthCheck, { name: "app", type: "A", enabled: true, probe: tcp, responseTtlSeconds: 10 });
    assert.equal(put.headers.get("etag"), `"${saved.revision}"`);

    // `@` reaches the route percent-encoded the way a client library sends it.
    const apex = await handler(request(`${BASE}/%40/A`, "PUT", { probe: { kind: "http", port: 8080 } }));
    assert.equal(apex.status, 200);
    assert.equal((await apex.json() as { healthCheck: { name: string } }).healthCheck.name, "@");

    const after = await handler(request(BASE));
    assert.deepEqual((await after.json() as { healthChecks: { name: string }[] }).healthChecks.map((policy) => policy.name), ["@", "app"]);

    const removed = await handler(request(`${BASE}/app/A`, "DELETE"));
    assert.equal(removed.status, 200);
    const again = await handler(request(`${BASE}/app/A`, "DELETE"));
    assert.equal(again.status, 404);
  });

  it("refuses a body that names another RRset than the path, and a policy that does not validate", async () => {
    const { handler } = await setup();
    const mismatch = await handler(request(`${BASE}/app/A`, "PUT", { name: "web", type: "AAAA", probe: tcp }));
    assert.equal(mismatch.status, 400);
    const body = await mismatch.json() as { error: string; issues?: string[] };
    assert.equal(body.error, "validation_failed");
    assert.ok(JSON.stringify(body).includes("does not match the path"));

    const matching = await handler(request(`${BASE}/app/A`, "PUT", { name: "APP", type: "a", probe: tcp }));
    assert.equal(matching.status, 200, "the same RRset written differently is the same RRset");

    const invalid = await handler(request(`${BASE}/app/A`, "PUT", { probe: { kind: "udp", port: 53 } }));
    assert.equal(invalid.status, 400);
    const missing = await handler(request(`${BASE}/web/A`, "PUT", { probe: tcp }));
    assert.equal(missing.status, 400, "no RRset to protect");
  });

  it("stores answer-all through the API, leaves the default out, and refuses a value it does not know", async () => {
    const { handler } = await setup();
    const put = await handler(request(`${BASE}/app/A`, "PUT", { enabled: true, probe: tcp, whenNoneHealthy: "answer-all" }));
    assert.equal(put.status, 200);
    const saved = await put.json() as { healthCheck: Record<string, unknown> };
    assert.deepEqual(saved.healthCheck, { name: "app", type: "A", enabled: true, probe: tcp, responseTtlSeconds: 30, whenNoneHealthy: "answer-all" });
    const listed = await (await handler(request(BASE))).json() as { healthChecks: Record<string, unknown>[] };
    assert.equal(listed.healthChecks[0]?.whenNoneHealthy, "answer-all");

    const back = await handler(request(`${BASE}/app/A`, "PUT", { enabled: true, probe: tcp, whenNoneHealthy: "servfail" }));
    assert.equal(back.status, 200);
    assert.equal("whenNoneHealthy" in (await back.json() as { healthCheck: Record<string, unknown> }).healthCheck, false);

    const invalid = await handler(request(`${BASE}/app/A`, "PUT", { enabled: true, probe: tcp, whenNoneHealthy: "fail-open" }));
    assert.equal(invalid.status, 400);
    assert.ok(JSON.stringify(await invalid.json()).includes("whenNoneHealthy must be servfail or answer-all"));
  });

  it("keeps a policy write an editor's, answer-all or not", async () => {
    const { handler } = await setup();
    const gated = createAuthorizedHandler({
      enabled: true,
      tokens: [
        { token: "viewer-secret-0000000000000000000", role: "viewer", subject: "read-only" },
        { token: "editor-secret-0000000000000000000", role: "editor", subject: "operator" },
      ],
    }, handler);
    const body = { enabled: true, probe: tcp, whenNoneHealthy: "answer-all" };
    const as = (token: string) => request(`${BASE}/app/A`, "PUT", body, { authorization: `Bearer ${token}` });
    assert.equal((await gated(as("viewer-secret-0000000000000000000"))).status, 403);
    assert.equal((await gated(as("editor-secret-0000000000000000000"))).status, 200);
  });

  it("has no health-check routes on any view but the internal one", async () => {
    const { handler } = await setup();
    const response = await handler(request("/api/v1/zones/example.com/views/external/health-checks"));
    assert.equal(response.status, 404);
    const put = await handler(request("/api/v1/zones/example.com/views/external/health-checks/app/A", "PUT", { probe: tcp }));
    assert.equal(put.status, 404);
  });

  it("reports this process's verdicts, and says so when it serves nothing", async () => {
    const { service, handler: unserved } = await setup();
    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp });
    await service.setHealthCheck("example.com", { name: "@", type: "A", enabled: false, probe: tcp });

    const nowhere = await unserved(request("/api/v1/zones/example.com/health-check-status"));
    assert.equal(nowhere.status, 200);
    const plain = await nowhere.json() as { servedHere: boolean; probing: boolean; transfers: string; healthChecks: { name: string; answer: string }[] };
    assert.equal(plain.servedHere, false);
    assert.equal(plain.probing, false);
    assert.equal(plain.transfers, "refused");
    assert.deepEqual(plain.healthChecks.map((policy) => [policy.name, policy.answer]), [["@", "full"], ["app", "unknown"]]);

    // A monitor that has probed once and found the address answering.
    let fire: (() => void) | undefined;
    const monitor = createHealthMonitor({
      transport: { probe: async () => ({ ok: true }) },
      now: () => 0,
      random: () => 0,
      timers: { setTimeout: (callback) => { fire = callback; return 1; }, clearTimeout: () => undefined },
    });
    const enabled = { ...DEFAULT_SETTINGS, dnsHealthChecksEnabled: true, dnsHealthCheckAllowCidrs: ["10.0.0.0/24"], dnsHealthCheckAllowPorts: [443] };
    monitor.update(servedZones([await service.getZone("example.com")]));
    monitor.configure(enabled);
    fire?.();
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));

    const settings = { current: () => enabled } as unknown as SettingsService;
    const served = createApiHandler({ controlPlane: service, healthMonitor: monitor, settings });
    const response = await served(request("/api/v1/zones/example.com/health-check-status"));
    const status = await response.json() as {
      servedHere: boolean;
      probing: boolean;
      healthChecks: { name: string; answer: string; healthyAddresses?: number; targets?: { address: string; status: string }[] }[];
    };
    assert.equal(status.servedHere, true);
    assert.equal(status.probing, true);
    const app = status.healthChecks.find((policy) => policy.name === "app");
    assert.equal(app?.answer, "filtered");
    assert.equal(app?.healthyAddresses, 1);
    assert.deepEqual(app?.targets?.map((target) => [target.address, target.status]), [["10.0.0.11", "healthy"]]);

    // The command line reads the same command.
    const viaCli = await runCommand({ runtime: { controlPlane: service, healthMonitor: monitor, settings }, actor: "test", role: "viewer" },
      "health check status", { zone: "example.com" }) as typeof status;
    assert.deepEqual(viaCli.healthChecks.map((policy) => policy.answer), ["full", "filtered"]);
    await monitor.close();
  });

  it("reports an answer-all policy with nothing healthy as answering every address", async () => {
    const { service } = await setup();
    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp, whenNoneHealthy: "answer-all" });
    // Probing is on and the address is tracked, but no probe has finished.
    const monitor = createHealthMonitor({
      transport: { probe: async () => ({ ok: false, category: "connection" }) },
      now: () => 0,
      random: () => 0,
      timers: { setTimeout: () => 1, clearTimeout: () => undefined },
    });
    const enabled = { ...DEFAULT_SETTINGS, dnsHealthChecksEnabled: true, dnsHealthCheckAllowCidrs: ["10.0.0.0/24"], dnsHealthCheckAllowPorts: [443] };
    monitor.update(servedZones([await service.getZone("example.com")]));
    monitor.configure(enabled);
    const settings = { current: () => enabled } as unknown as SettingsService;
    const served = createApiHandler({ controlPlane: service, healthMonitor: monitor, settings });
    const status = await (await served(request("/api/v1/zones/example.com/health-check-status"))).json() as {
      healthChecks: { name: string; answer: string; whenNoneHealthy?: string; targets?: { status: string }[] }[];
    };
    const app = status.healthChecks.find((policy) => policy.name === "app");
    assert.equal(app?.answer, "all");
    assert.equal(app?.whenNoneHealthy, "answer-all");
    assert.deepEqual(app?.targets?.map((target) => target.status), ["unknown"]);
    await monitor.close();
  });
});
