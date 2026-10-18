import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { ControlPlane } from "../../src/application/control-plane.ts";
import type { ServedHealthCheck } from "../../src/dns/health/targets.ts";
import { createDnsServer, type ServedZone } from "../../src/dns/server.ts";
import { servedZones } from "../../src/dns/snapshot.ts";
import { RCODE, TYPE, readName } from "../../src/dns/wire.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";
import { render as renderMetrics } from "../../src/observability/metrics.ts";
import { freePort } from "../support/ports.ts";

/**
 * The listener's half of a health check: what a protected RRset is answered
 * with for a given verdict. The verdict is a plain function here; the monitor
 * that produces it in a running process is tested on its own.
 */

function encodeName(name: string): Buffer {
  const chunks: Buffer[] = [];
  for (const label of name.split(".")) chunks.push(Buffer.of(label.length), Buffer.from(label, "latin1"));
  chunks.push(Buffer.of(0));
  return Buffer.concat(chunks);
}

function buildQuery(name: string, type: number = TYPE.A): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x4242, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, encodeName(name), tail]);
}

interface Answer { name: string; type: number; ttl: number; data: string }

/** The answer section, with A and AAAA rdata written out as addresses. */
function readAnswers(reply: Buffer): Answer[] {
  const count = reply.readUInt16BE(6);
  let offset = readName(reply, 12).offset + 4;
  const records: Answer[] = [];
  for (let index = 0; index < count; index += 1) {
    const owner = readName(reply, offset);
    offset = owner.offset;
    const type = reply.readUInt16BE(offset);
    const ttl = reply.readUInt32BE(offset + 4);
    const size = reply.readUInt16BE(offset + 8);
    const data = reply.subarray(offset + 10, offset + 10 + size);
    const text = type === TYPE.A ? [...data].join(".")
      : type === TYPE.AAAA ? Array.from({ length: 8 }, (_, group) => data.readUInt16BE(group * 2).toString(16)).join(":")
      : data.toString("hex");
    records.push({ name: owner.name, type, ttl, data: text });
    offset += 10 + size;
  }
  return records;
}

function rcodeOf(reply: Buffer): number {
  return reply.readUInt16BE(2) & 0x000f;
}

function ask(port: number, message: Buffer, timeoutMs = 2_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); reject(new Error("no UDP reply")); }, timeoutMs);
    socket.once("message", (reply) => { clearTimeout(timer); socket.close(); resolve(reply); });
    socket.once("error", (error) => { clearTimeout(timer); socket.close(); reject(error); });
    socket.send(message, port, "127.0.0.1");
  });
}

/** The first framed message over TCP; enough for a refusal or a transfer's opening SOA. */
function askOverTcp(port: number, message: Buffer, timeoutMs = 5_000): Promise<Buffer> {
  const framed = Buffer.concat([Buffer.alloc(2), message]);
  framed.writeUInt16BE(message.length, 0);
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void): void => { clearTimeout(timer); socket.destroy(); finish(); };
    const timer = setTimeout(() => settle(() => reject(new Error("no TCP reply"))), timeoutMs);
    const socket = connect(port, "127.0.0.1", () => socket.write(framed));
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 2 || buffered.length < buffered.readUInt16BE(0) + 2) return;
      const reply = Buffer.from(buffered.subarray(2, buffered.readUInt16BE(0) + 2));
      settle(() => resolve(reply));
    });
    socket.on("error", (error) => settle(() => reject(error)));
  });
}

function servfails(): number {
  const match = /^parallax_dns_health_servfail_total (\d+)$/mu.exec(renderMetrics());
  return match ? Number(match[1]) : 0;
}

const APP: ServedHealthCheck = {
  name: "app.example.com",
  type: "A",
  ttl: 15,
  probe: { kind: "tcp", port: 443 },
  addresses: ["10.0.0.11", "10.0.0.12"],
};

const ZONE: ServedZone = {
  name: "example.com",
  serial: 7,
  records: [
    { name: "app", type: "A", content: "10.0.0.11", ttl: 300 },
    { name: "app", type: "A", content: "10.0.0.12", ttl: 300 },
    { name: "app", type: "AAAA", content: "fd00::11", ttl: 300 },
    { name: "app", type: "TXT", content: "\"owner=platform\"", ttl: 300 },
    { name: "alias", type: "CNAME", content: "app.example.com", ttl: 60 },
    { name: "plain", type: "A", content: "10.0.0.13", ttl: 300 },
  ],
  healthChecks: [APP],
};

/** A verdict that trusts exactly the listed addresses. */
const only = (...healthy: string[]) => () => (_zone: string, _check: ServedHealthCheck, address: string) => healthy.includes(address);

describe("DNS listener with health checks", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
  });

  async function start(options: Partial<Parameters<typeof createDnsServer>[0]> & { zones: () => readonly ServedZone[] }) {
    for (let attempt = 3; ; attempt -= 1) {
      const port = await freePort("127.0.0.1", { udp: true });
      const server = createDnsServer(options);
      try {
        await server.listen(port, "127.0.0.1");
      } catch (error) {
        if (attempt <= 1 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        continue;
      }
      closers.push(() => server.close());
      return { port, server };
    }
  }

  it("answers a protected RRset with its healthy addresses only, at the check's TTL", async () => {
    const { port } = await start({ zones: () => [ZONE], health: only("10.0.0.12") });
    const reply = await ask(port, buildQuery("app.example.com"));
    assert.equal(rcodeOf(reply), RCODE.NOERROR);
    assert.deepEqual(readAnswers(reply).map((answer) => [answer.data, answer.ttl]), [["10.0.0.12", 15]]);

    // The rest of the name and the rest of the zone are untouched.
    const aaaa = readAnswers(await ask(port, buildQuery("app.example.com", TYPE.AAAA)));
    assert.deepEqual(aaaa.map((answer) => [answer.data, answer.ttl]), [["fd00:0:0:0:0:0:0:11", 300]]);
    const plain = readAnswers(await ask(port, buildQuery("plain.example.com")));
    assert.deepEqual(plain.map((answer) => [answer.data, answer.ttl]), [["10.0.0.13", 300]]);
  });

  it("answers SERVFAIL when nothing is healthy, when no verdict is wired, and when the check has an issue", async () => {
    const before = servfails();
    const none = await start({ zones: () => [ZONE], health: only() });
    assert.equal(rcodeOf(await ask(none.port, buildQuery("app.example.com"))), RCODE.SERVFAIL);
    assert.equal(servfails(), before + 1, "counted");

    const unwired = await start({ zones: () => [ZONE] });
    const reply = await ask(unwired.port, buildQuery("app.example.com"));
    assert.equal(rcodeOf(reply), RCODE.SERVFAIL);
    assert.equal(readAnswers(reply).length, 0);

    const broken: ServedZone = { ...ZONE, healthChecks: [{ ...APP, addresses: [], issue: "no A record to protect" }] };
    const issue = await start({ zones: () => [broken], health: only("10.0.0.11", "10.0.0.12") });
    assert.equal(rcodeOf(await ask(issue.port, buildQuery("app.example.com"))), RCODE.SERVFAIL);
    // An unprotected name in the same zone still answers.
    assert.equal(rcodeOf(await ask(issue.port, buildQuery("plain.example.com"))), RCODE.NOERROR);
  });

  it("guards every protected RRset an ANY answer would carry", async () => {
    const { port } = await start({ zones: () => [ZONE], health: only("10.0.0.11") });
    const reply = await ask(port, buildQuery("app.example.com", TYPE.ANY));
    const answers = readAnswers(reply);
    assert.deepEqual(answers.filter((answer) => answer.type === TYPE.A).map((answer) => [answer.data, answer.ttl]), [["10.0.0.11", 15]]);
    assert.equal(answers.filter((answer) => answer.type === TYPE.AAAA).length, 1, "the unprotected AAAA stays");
    assert.equal(answers.filter((answer) => answer.type === TYPE.TXT).length, 1);

    const blocked = await start({ zones: () => [ZONE], health: only() });
    assert.equal(rcodeOf(await ask(blocked.port, buildQuery("app.example.com", TYPE.ANY))), RCODE.SERVFAIL);
  });

  it("filters a CNAME chase into a protected RRset, and fails it when nothing there is healthy", async () => {
    const { port } = await start({ zones: () => [ZONE], health: only("10.0.0.11") });
    const answers = readAnswers(await ask(port, buildQuery("alias.example.com")));
    assert.deepEqual(answers.map((answer) => [answer.name, answer.type]), [
      ["alias.example.com", TYPE.CNAME],
      ["app.example.com", TYPE.A],
    ]);
    assert.equal(answers[1]?.data, "10.0.0.11");
    assert.equal(answers[1]?.ttl, 15);

    const blocked = await start({ zones: () => [ZONE], health: only() });
    assert.equal(rcodeOf(await ask(blocked.port, buildQuery("alias.example.com"))), RCODE.SERVFAIL);
    // The CNAME itself was asked for: nothing is chased, nothing is judged.
    assert.equal(rcodeOf(await ask(blocked.port, buildQuery("alias.example.com", TYPE.CNAME))), RCODE.NOERROR);
  });

  it("refuses to transfer a zone holding health checks, even to an allowed client", async () => {
    const unprotected: ServedZone = { name: ZONE.name, serial: ZONE.serial, records: ZONE.records };
    const open = await start({ zones: () => [unprotected], transferAllow: ["127.0.0.0/8"] });
    const transfer = await askOverTcp(open.port, buildQuery("example.com", TYPE.AXFR));
    assert.equal(rcodeOf(transfer), RCODE.NOERROR, "the same zone without checks transfers");
    assert.equal(readAnswers(transfer)[0]?.type, TYPE.SOA);

    const guarded = await start({ zones: () => [ZONE], transferAllow: ["127.0.0.0/8"], health: only("10.0.0.11") });
    assert.equal(rcodeOf(await askOverTcp(guarded.port, buildQuery("example.com", TYPE.AXFR))), RCODE.REFUSED);
    assert.equal(rcodeOf(await askOverTcp(guarded.port, buildQuery("example.com", TYPE.IXFR))), RCODE.REFUSED);

    // Over UDP an IXFR is otherwise answered with the current SOA, which is
    // where a secondary learns the serial it would come back over TCP for.
    const lone = await ask(open.port, buildQuery("example.com", TYPE.IXFR));
    assert.equal(rcodeOf(lone), RCODE.NOERROR, "the same zone without checks answers an IXFR over UDP");
    assert.equal(readAnswers(lone)[0]?.type, TYPE.SOA);
    const refused = await ask(guarded.port, buildQuery("example.com", TYPE.IXFR));
    assert.equal(rcodeOf(refused), RCODE.REFUSED);
    assert.equal(readAnswers(refused).length, 0);
  });

  it("skips NOTIFY for a protected zone and says so once per zone", async () => {
    const sent: string[] = [];
    const skipped: string[] = [];
    const { server } = await start({
      zones: () => [ZONE],
      notifyTo: ["10.0.0.11:5300"],
      sendNotify: async (_packet, address) => { sent.push(address); },
      onNotifySkipped: (zone) => skipped.push(zone),
    });
    await server.notifyChanged(new Map([["example.com", 7]]), [{ ...ZONE, serial: 8 }]);
    await server.notifyChanged(new Map([["example.com", 8]]), [{ ...ZONE, serial: 9 }]);
    assert.deepEqual(sent, []);
    assert.deepEqual(skipped, ["example.com"]);

    // Once the checks are gone the zone is notified again, and a later check is reported afresh.
    const plain: ServedZone = { name: ZONE.name, serial: 10, records: ZONE.records };
    await server.notifyChanged(new Map([["example.com", 9]]), [plain]);
    assert.deepEqual(sent, ["10.0.0.11"]);
    await server.notifyChanged(new Map([["example.com", 10]]), [{ ...ZONE, serial: 11 }]);
    assert.deepEqual(skipped, ["example.com", "example.com"]);
  });

  it("answers SERVFAIL for a protected RRset the snapshot no longer holds, and never asks the fallback upstream", async () => {
    const upstream = createSocket("udp4");
    await new Promise<void>((resolve) => upstream.bind(0, "127.0.0.1", resolve));
    const asked: string[] = [];
    upstream.on("message", (message, remote) => {
      asked.push(readName(message, 12).name);
      const reply = Buffer.from(message);
      reply.writeUInt16BE(0x8180, 2);
      upstream.send(reply, remote.port, remote.address);
    });
    closers.push(async () => { upstream.close(); });
    const forwardTo = [`127.0.0.1#${(upstream.address() as AddressInfo).port}`];

    // Hand-built, the way a stale or damaged snapshot would arrive: each policy
    // names an RRset that is not there. `gone` holds nothing at all, `web` only
    // a TXT, and two aliases lead to them.
    const dangling: ServedZone = {
      name: "example.com",
      serial: 4,
      records: [
        { name: "web", type: "TXT", content: "\"owner=platform\"", ttl: 300 },
        { name: "to-gone", type: "CNAME", content: "gone.example.com", ttl: 60 },
        { name: "to-web", type: "CNAME", content: "web.example.com", ttl: 60 },
        { name: "plain", type: "A", content: "10.0.0.13", ttl: 300 },
      ],
      healthChecks: [
        { ...APP, name: "gone.example.com", addresses: [] },
        { ...APP, name: "web.example.com", type: "AAAA", addresses: [] },
      ],
    };
    const before = servfails();
    const { port } = await start({ zones: () => [dangling], forwardTo, fallbackZones: ["example.com"], health: only("10.0.0.11") });
    for (const [name, type] of [
      ["gone.example.com", TYPE.A],
      ["gone.example.com", TYPE.ANY],
      ["web.example.com", TYPE.AAAA],
      ["web.example.com", TYPE.ANY],
      ["to-gone.example.com", TYPE.A],
      ["to-web.example.com", TYPE.AAAA],
    ] as const) {
      const reply = await ask(port, buildQuery(name, type));
      assert.equal(rcodeOf(reply), RCODE.SERVFAIL, `${name} ${type}`);
      assert.equal(readAnswers(reply).length, 0, `${name} ${type}`);
    }
    assert.deepEqual(asked, [], "a protected name went to the fallback upstream");
    assert.equal(servfails(), before + 6);

    // Everything else keeps its meaning: the TXT beside the missing AAAA still
    // answers, an unprotected type at a protected name is still empty, an
    // unprotected gap still falls back, and the CNAME itself is still an answer.
    const txt = await ask(port, buildQuery("web.example.com", TYPE.TXT));
    assert.equal(rcodeOf(txt), RCODE.NOERROR);
    assert.equal(readAnswers(txt).length, 1);
    assert.equal(rcodeOf(await ask(port, buildQuery("to-gone.example.com", TYPE.CNAME))), RCODE.NOERROR);
    assert.deepEqual(asked, []);
    await ask(port, buildQuery("web.example.com", TYPE.A));
    await ask(port, buildQuery("missing.example.com"));
    assert.deepEqual(asked, ["web.example.com", "missing.example.com"]);
  });

  it("does not let a wildcard answer for a protected name that holds nothing of its own", async () => {
    const covered: ServedZone = {
      name: "example.com",
      serial: 5,
      records: [{ name: "*", type: "A", content: "10.0.0.13", ttl: 300 }],
      healthChecks: [{ ...APP, addresses: [] }],
    };
    const { port } = await start({ zones: () => [covered], health: only("10.0.0.13") });
    assert.equal(rcodeOf(await ask(port, buildQuery("app.example.com"))), RCODE.SERVFAIL);
    // The wildcard still covers every other name.
    const other = await ask(port, buildQuery("other.example.com"));
    assert.deepEqual(readAnswers(other).map((answer) => answer.data), ["10.0.0.13"]);
  });

  it("answers a protected RRset itself rather than relaying the placeholder beside it", async () => {
    const upstream = createSocket("udp4");
    await new Promise<void>((resolve) => upstream.bind(0, "127.0.0.1", resolve));
    const asked: string[] = [];
    upstream.on("message", (message, remote) => {
      asked.push(readName(message, 12).name);
      const reply = Buffer.from(message);
      reply.writeUInt16BE(0x8180, 2);
      upstream.send(reply, remote.port, remote.address);
    });
    closers.push(async () => { upstream.close(); });
    const upstreamPort = (upstream.address() as AddressInfo).port;

    // Adopted shape: a provider placeholder AAAA beside an internal A that is checked.
    const adopted: ServedZone = {
      name: "example.com",
      serial: 3,
      records: [
        { name: "@", type: "AAAA", content: "100::", ttl: 300 },
        { name: "@", type: "A", content: "10.0.0.11", ttl: 300 },
      ],
      healthChecks: [{ ...APP, name: "example.com", addresses: ["10.0.0.11"] }],
    };
    const { port } = await start({ zones: () => [adopted], forwardTo: [`127.0.0.1#${upstreamPort}`], health: only("10.0.0.11") });
    const reply = await ask(port, buildQuery("example.com"));
    assert.deepEqual(readAnswers(reply).map((answer) => answer.data), ["10.0.0.11"]);
    assert.deepEqual(asked, [], "the protected A was not relayed");

    // The placeholder's own type still goes upstream.
    await ask(port, buildQuery("example.com", TYPE.AAAA));
    assert.deepEqual(asked, ["example.com"]);
  });
});

describe("served zones with health checks", () => {
  async function stored() {
    const adapters = createInMemoryAdapters();
    const service = new ControlPlane(adapters.zones, adapters.statuses, adapters.provider,
      { now: () => new Date("2026-08-08T00:00:00.000Z") }, undefined, {},
      (target) => target.endsWith("/internal") ? "listener" : "provider");
    await service.createZone("example.com");
    await service.upsertRecord("example.com", "internal", "app-1", { name: "app", type: "A", content: "10.0.0.11", ttl: 20 });
    await service.upsertRecord("example.com", "internal", "app-2", { name: "app", type: "A", content: "10.0.0.12", ttl: 300 });
    return service;
  }

  it("carries each enabled policy with its addresses and the smaller TTL, and nothing for a disabled one", async () => {
    const service = await stored();
    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: { kind: "tcp", port: 443 } });
    const [zone] = servedZones([await service.getZone("example.com")]);
    const [check] = zone?.healthChecks ?? [];
    // Addresses come in stored order; which order is not part of the contract.
    assert.deepEqual({ ...check, addresses: [...(check?.addresses ?? [])].sort() }, {
      name: "app.example.com",
      type: "A",
      ttl: 20,
      probe: { kind: "tcp", port: 443 },
      addresses: ["10.0.0.11", "10.0.0.12"],
    });
    assert.equal(zone?.healthChecks?.length, 1);

    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: false, probe: { kind: "tcp", port: 443 } });
    const [disabled] = servedZones([await service.getZone("example.com")]);
    assert.equal(disabled && "healthChecks" in disabled, false);
  });

  it("keeps a policy that no longer resolves, with its issue, rather than answering the full RRset", async () => {
    const service = await stored();
    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: { kind: "tcp", port: 443 } });
    const zone = await service.getZone("example.com");
    // A stored state the commit guard would have refused, as if written by another path.
    const drifted = {
      ...zone,
      views: zone.views.map((view) => view.name !== "internal" ? view : {
        ...view,
        records: [...view.records.filter((record) => record.name !== "app"), { id: "web", name: "web", type: "A" as const, content: "10.0.0.13", ttl: 300 }],
      }),
    };
    const [served] = servedZones([drifted]);
    assert.equal(served?.healthChecks?.length, 1);
    assert.deepEqual(served?.healthChecks?.[0]?.addresses, []);
    assert.match(served?.healthChecks?.[0]?.issue ?? "", /app A/u);
  });
});
