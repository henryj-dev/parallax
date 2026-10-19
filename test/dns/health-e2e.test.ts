import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { DEFAULT_SETTINGS } from "../../src/application/settings.ts";
import { createHealthMonitor, type HealthMonitor } from "../../src/dns/health/monitor.ts";
import { createProbeTransport } from "../../src/dns/health/transport.ts";
import { createDnsServer, type ServedZone } from "../../src/dns/server.ts";
import { servedZones } from "../../src/dns/snapshot.ts";
import { RCODE, TYPE, readName } from "../../src/dns/wire.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";
import { freePort } from "../support/ports.ts";

/**
 * The whole path in one process: a policy stored through the control plane,
 * the served snapshot built from it, the monitor probing over the real
 * transport, and the listener answering on the wire. The two origins are fake
 * apps on loopback; `remap` carries each documentation address to one of them,
 * so the allow-list sees 10.0.0.x and nothing leaves this machine.
 */

function buildQuery(name: string, type: number = TYPE.A): Buffer {
  const labels = name.split(".").flatMap((label) => [Buffer.of(label.length), Buffer.from(label, "latin1")]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x5151, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, ...labels, Buffer.of(0), tail]);
}

/** The rcode and the A records of the answer section, as [address, ttl]. */
function readReply(reply: Buffer): { rcode: number; addresses: [string, number][] } {
  const count = reply.readUInt16BE(6);
  let offset = readName(reply, 12).offset + 4;
  const addresses: [string, number][] = [];
  for (let index = 0; index < count; index += 1) {
    offset = readName(reply, offset).offset;
    const type = reply.readUInt16BE(offset);
    const ttl = reply.readUInt32BE(offset + 4);
    const size = reply.readUInt16BE(offset + 8);
    if (type === TYPE.A) addresses.push([[...reply.subarray(offset + 10, offset + 14)].join("."), ttl]);
    offset += 10 + size;
  }
  addresses.sort(([left], [right]) => left.localeCompare(right));
  return { rcode: reply.readUInt16BE(2) & 0x000f, addresses };
}

function ask(port: number, message: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); reject(new Error("no UDP reply")); }, 2_000);
    socket.once("message", (reply) => { clearTimeout(timer); socket.close(); resolve(reply); });
    socket.send(message, port, "127.0.0.1");
  });
}

/** Polls until `check` holds; the monitor works on its own timers, so the test waits for it. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what}: last seen ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface FakeApp { server: Server; port: number; ready: boolean; seen: { url?: string; host?: string }[] }

async function fakeApp(): Promise<FakeApp> {
  const app: FakeApp = { server: undefined as unknown as Server, port: 0, ready: true, seen: [] };
  app.server = createServer((request: IncomingMessage, response: ServerResponse) => {
    app.seen.push({ url: request.url, host: request.headers.host });
    response.writeHead(app.ready ? 200 : 503).end(app.ready ? "ready" : "draining");
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  app.port = (app.server.address() as AddressInfo).port;
  return app;
}

describe("health checks end to end", () => {
  const apps = new Map<string, FakeApp>();
  let service: ControlPlane;
  let monitor: HealthMonitor;
  let zones: readonly ServedZone[] = [];
  let close: () => Promise<void> = async () => undefined;
  let port = 0;

  before(async () => {
    apps.set("10.0.0.11", await fakeApp());
    apps.set("10.0.0.12", await fakeApp());

    const adapters = createInMemoryAdapters();
    service = new ControlPlane(adapters.zones, adapters.statuses, adapters.provider, undefined, undefined, {},
      (target) => target.endsWith("/internal") ? "listener" : "provider");
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "internal", "app-1", { name: "app", type: "A", content: "10.0.0.11", ttl: 300 });
    await service.upsertRecord("example.com", "internal", "app-2", { name: "app", type: "A", content: "10.0.0.12", ttl: 300 });
    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: { kind: "http", port: 8080 }, responseTtlSeconds: 10 });

    monitor = createHealthMonitor({
      transport: createProbeTransport({
        deadlineMs: 500,
        remap: (address) => ({ address: "127.0.0.1", port: apps.get(address)?.port ?? 1 }),
      }),
      random: () => 0,
      intervalMs: 40,
      freshnessMs: 2_000,
    });
    zones = servedZones([await service.getZone("example.com")]);
    monitor.update(zones);
    monitor.configure({ ...DEFAULT_SETTINGS, dnsHealthChecksEnabled: true, dnsHealthCheckAllowCidrs: ["10.0.0.0/24"], dnsHealthCheckAllowPorts: [8080] });

    for (let attempt = 3; ; attempt -= 1) {
      port = await freePort("127.0.0.1", { udp: true });
      const server = createDnsServer({ zones: () => zones, health: () => monitor.verdict() });
      try {
        await server.listen(port, "127.0.0.1");
        close = () => server.close();
        break;
      } catch (error) {
        if (attempt <= 1 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
  });

  after(async () => {
    await close();
    await monitor.close();
    for (const app of apps.values()) {
      app.server.closeAllConnections();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
  });

  const query = async () => readReply(await ask(port, buildQuery("app.example.com")));
  const app = (address: string): FakeApp => apps.get(address) as FakeApp;

  it("answers with the addresses whose app answers, follows them down and back, and the full RRset once disabled", async () => {
    const both = await eventually(query, (reply) => reply.addresses.length === 2, "both apps healthy");
    assert.deepEqual(both, { rcode: RCODE.NOERROR, addresses: [["10.0.0.11", 10], ["10.0.0.12", 10]] });
    // The probe asked the pinned path, under the protected name, at the policy's port.
    assert.deepEqual(app("10.0.0.11").seen[0], { url: "/health/ready", host: "app.example.com:8080" });

    app("10.0.0.12").ready = false;
    const one = await eventually(query, (reply) => reply.addresses.length === 1, "the draining app dropped");
    assert.deepEqual(one, { rcode: RCODE.NOERROR, addresses: [["10.0.0.11", 10]] });
    assert.equal(monitor.status("example.com").checks[0]?.targets.find((target) => target.address === "10.0.0.12")?.lastFailure, "http-status");

    app("10.0.0.11").ready = false;
    const none = await eventually(query, (reply) => reply.rcode !== RCODE.NOERROR, "nothing healthy");
    assert.deepEqual(none, { rcode: RCODE.SERVFAIL, addresses: [] });

    app("10.0.0.11").ready = true;
    const back = await eventually(query, (reply) => reply.rcode === RCODE.NOERROR, "the recovered app back");
    assert.deepEqual(back.addresses, [["10.0.0.11", 10]]);

    // Opted into answer-all, the same RRset with nothing healthy is answered in
    // full at the policy's TTL, and filtered again as soon as one app answers.
    app("10.0.0.11").ready = false;
    await eventually(query, (reply) => reply.rcode === RCODE.SERVFAIL, "nothing healthy again");
    await service.setHealthCheck("example.com", {
      name: "app", type: "A", enabled: true, probe: { kind: "http", port: 8080 }, responseTtlSeconds: 10, whenNoneHealthy: "answer-all",
    });
    zones = servedZones([await service.getZone("example.com")]);
    monitor.update(zones);
    assert.deepEqual(await query(), { rcode: RCODE.NOERROR, addresses: [["10.0.0.11", 10], ["10.0.0.12", 10]] });
    assert.equal(monitor.status("example.com").checks[0]?.answer, "all");
    app("10.0.0.11").ready = true;
    const filtered = await eventually(query, (reply) => reply.addresses.length === 1, "filtered once one app answers");
    assert.deepEqual(filtered, { rcode: RCODE.NOERROR, addresses: [["10.0.0.11", 10]] });

    // Disabling the policy hands the RRset back to the record TTLs, every address included.
    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: false, probe: { kind: "http", port: 8080 } });
    zones = servedZones([await service.getZone("example.com")]);
    monitor.update(zones);
    assert.deepEqual(await query(), { rcode: RCODE.NOERROR, addresses: [["10.0.0.11", 300], ["10.0.0.12", 300]] });
  });
});

describe("health checks that are off", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
  });

  /** A stored zone, a monitor on the default settings whose transport records every call, and a listener. */
  async function start() {
    const adapters = createInMemoryAdapters();
    const service = new ControlPlane(adapters.zones, adapters.statuses, adapters.provider, undefined, undefined, {},
      (target) => target.endsWith("/internal") ? "listener" : "provider");
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "internal", "app-1", { name: "app", type: "A", content: "10.0.0.11", ttl: 300 });
    await service.upsertRecord("example.com", "internal", "app-2", { name: "app", type: "A", content: "10.0.0.12", ttl: 300 });
    await service.upsertRecord("example.com", "internal", "plain", { name: "plain", type: "A", content: "10.0.0.13", ttl: 300 });
    const probed: string[] = [];
    const monitor = createHealthMonitor({
      transport: { probe: async (target) => { probed.push(target.address); return { ok: true }; } },
      random: () => 0,
      intervalMs: 20,
    });
    closers.push(() => monitor.close());
    monitor.configure(DEFAULT_SETTINGS);
    let zones: readonly ServedZone[] = [];
    const refresh = async (): Promise<readonly ServedZone[]> => {
      zones = servedZones([await service.getZone("example.com")]);
      monitor.update(zones);
      return zones;
    };
    await refresh();
    let port = 0;
    for (let attempt = 3; ; attempt -= 1) {
      port = await freePort("127.0.0.1", { udp: true });
      const server = createDnsServer({ zones: () => zones, health: () => monitor.verdict() });
      try {
        await server.listen(port, "127.0.0.1");
        closers.push(() => server.close());
        break;
      } catch (error) {
        if (attempt <= 1 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    const query = async (name: string) => readReply(await ask(port, buildQuery(name)));
    return { service, refresh, query, probed };
  }

  it("answers as before when a policy leaves enabled out or sets it false", async () => {
    const { service, refresh, query, probed } = await start();
    const full = { rcode: RCODE.NOERROR, addresses: [["10.0.0.11", 300], ["10.0.0.12", 300]] };
    const plain = { rcode: RCODE.NOERROR, addresses: [["10.0.0.13", 300]] };
    assert.deepEqual(await query("app.example.com"), full);

    const saved = await service.setHealthCheck("example.com", { name: "app", type: "A", probe: { kind: "tcp", port: 443 } });
    assert.equal(saved.healthCheck.enabled, false);
    const [unsaid] = await refresh();
    assert.equal(unsaid !== undefined && "healthChecks" in unsaid, false);
    assert.deepEqual(await service.zonesWithEnabledHealthChecks(), []);
    assert.deepEqual(await query("app.example.com"), full);
    assert.deepEqual(await query("plain.example.com"), plain);

    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: false, probe: { kind: "tcp", port: 443 } });
    const [disabled] = await refresh();
    assert.equal(disabled !== undefined && "healthChecks" in disabled, false);
    assert.deepEqual(await service.zonesWithEnabledHealthChecks(), []);
    assert.deepEqual(await query("app.example.com"), full);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(probed, []);
  });

  it("answers an enabled policy SERVFAIL while probing is off, and probes nothing", async () => {
    const { service, refresh, query, probed } = await start();
    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: { kind: "tcp", port: 443 } });
    const [zone] = await refresh();
    assert.equal(zone?.healthChecks?.length, 1);
    assert.deepEqual(await service.zonesWithEnabledHealthChecks(), ["example.com"]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(await query("app.example.com"), { rcode: RCODE.SERVFAIL, addresses: [] });
    // A name without a policy is answered as before.
    assert.deepEqual(await query("plain.example.com"), { rcode: RCODE.NOERROR, addresses: [["10.0.0.13", 300]] });
    assert.deepEqual(probed, []);
  });

  it("keeps an answer-all policy SERVFAIL while probing is off, since nothing is being observed", async () => {
    const { service, refresh, query, probed } = await start();
    await service.setHealthCheck("example.com", {
      name: "app", type: "A", enabled: true, probe: { kind: "tcp", port: 443 }, whenNoneHealthy: "answer-all",
    });
    const [zone] = await refresh();
    assert.equal(zone?.healthChecks?.[0]?.whenNoneHealthy, "answer-all");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(await query("app.example.com"), { rcode: RCODE.SERVFAIL, addresses: [] });
    assert.deepEqual(probed, []);
  });
});
