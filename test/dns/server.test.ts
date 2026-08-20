import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { connect, createServer, isIP, type AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import {
  createDnsServer,
  createTimedDnsResolver,
  type ResolvedDnsAddress,
  type ServedZone,
  type UnservableRecord,
} from "../../src/dns/server.ts";
import { RCODE, TYPE, readName } from "../../src/dns/wire.ts";
import { shutdownProcess } from "../../src/shutdown.ts";

function encodeName(name: string): Buffer {
  if (name === "") return Buffer.of(0);
  const chunks: Buffer[] = [];
  for (const label of name.split(".")) chunks.push(Buffer.of(label.length), Buffer.from(label, "latin1"));
  chunks.push(Buffer.of(0));
  return Buffer.concat(chunks);
}

function buildQuery(name: string, type: number = TYPE.A, id = 0x4242): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, encodeName(name), tail]);
}

function forwardedReply(message: Buffer, marker: number[]): Buffer {
  const reply = Buffer.from(message);
  reply.writeUInt16BE((reply.readUInt16BE(2) & 0x7900) | 0x8080, 2);
  return Buffer.concat([reply, Buffer.from(marker)]);
}

/** The answer section, decoded far enough to say what was returned. */
function readAnswers(reply: Buffer): { name: string; type: number; ttl: number; data: Buffer }[] {
  const count = reply.readUInt16BE(6);
  let offset = readName(reply, 12).offset + 4;
  const records: { name: string; type: number; ttl: number; data: Buffer }[] = [];
  for (let index = 0; index < count; index += 1) {
    const owner = readName(reply, offset);
    offset = owner.offset;
    const type = reply.readUInt16BE(offset);
    const ttl = reply.readUInt32BE(offset + 4);
    const size = reply.readUInt16BE(offset + 8);
    records.push({ name: owner.name, type, ttl, data: reply.subarray(offset + 10, offset + 10 + size) });
    offset += 10 + size;
  }
  return records;
}

/**
 * Asserts a reply arrived before reading it. Without this a test that got
 * nothing back reads `undefined & mask` as 0 and passes for NOERROR.
 */
const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function received(reply: Buffer | undefined): Buffer {
  assert.ok(reply, "no reply arrived");
  return reply;
}

function rcodeOf(reply: Buffer | undefined): number {
  return received(reply).readUInt16BE(2) & 0x000f;
}

/**
 * A port free for both transports, because the listener binds both.
 *
 * A TCP probe alone certifies the wrong thing: every caller here goes on to
 * bind UDP, and the two have separate port spaces. A port this said was free
 * could already be held by another UDP socket, and the bind that followed
 * neither answered nor failed -- the test simply stopped, which is how it
 * reached a timeout on a loaded machine and never on this one.
 */
async function freePort(host = "127.0.0.1"): Promise<number> {
  for (let attempt = 8; ; attempt -= 1) {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, host, resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const datagram = createSocket(isIP(host) === 6 ? "udp6" : "udp4");
    try {
      await bound(datagram, port, host);
    } catch (error) {
      // Free for TCP and taken for UDP is a real answer, not an error: ask the
      // kernel for another one rather than handing back a port half of the
      // caller cannot have.
      datagram.close();
      if (attempt <= 1 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      continue;
    }
    await new Promise<void>((resolve) => datagram.close(resolve));
    return port;
  }
}

/**
 * Binds, and fails when it cannot.
 *
 * `bind` reports a taken port by emitting `error`, so a promise that only
 * resolves from the callback waits for something that will never come. Every
 * bind here used to be written that way.
 */
function bound(socket: ReturnType<typeof createSocket>, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, host, () => { socket.removeListener("error", reject); resolve(); });
  });
}

/**
 * `undefined` means the listener said nothing. It must not mean anything else.
 *
 * This used to answer `undefined` when the client socket itself failed, which
 * reads identically to silence from the server and is a different fact
 * entirely. A burst opens a socket per query, so the first thing to give out
 * under load is the test's own descriptors -- and then the report was that the
 * listener had dropped queries, at a millisecond, with no errno anywhere. A
 * defect in the harness wearing the costume of a defect in the subject.
 *
 * So a failure to send throws, carrying its errno, and silence stays silence.
 */
function ask(port: number, message: Buffer, timeoutMs = 2000, host = "127.0.0.1"): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(isIP(host) === 6 ? "udp6" : "udp4");
    const settle = (finish: () => void): void => { clearTimeout(timer); socket.close(); finish(); };
    const failed = (error: Error): void => settle(() => reject(
      new Error(`the query never left this test (${error.message}); the listener was never asked`, { cause: error })));
    const timer = setTimeout(() => settle(() => resolve(undefined)), timeoutMs);
    socket.once("message", (reply) => settle(() => resolve(reply)));
    socket.once("error", failed);
    socket.send(message, port, host, (error) => { if (error) failed(error); });
  });
}

/** Sends over TCP, optionally in pieces, to exercise the length-prefix framing. */
function askOverTcp(port: number, message: Buffer, split = false, host = "127.0.0.1"): Promise<Buffer> {
  const framed = Buffer.concat([Buffer.alloc(2), message]);
  framed.writeUInt16BE(message.length, 0);
  return new Promise((resolve, reject) => {
    const socket = connect(port, host, () => {
      if (!split) socket.write(framed);
      else {
        socket.write(framed.subarray(0, 3));
        setTimeout(() => socket.write(framed.subarray(3)), 20);
      }
    });
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 2) return;
      const size = buffered.readUInt16BE(0);
      if (buffered.length < size + 2) return;
      socket.destroy();
      resolve(buffered.subarray(2, size + 2));
    });
    socket.on("error", reject);
  });
}

/**
 * A datagram socket already holding its port, and the port it took.
 *
 * Asking for a free port and then binding it is two steps with a gap, and the
 * gap is where another test takes it. Binding to 0 and reading back what the
 * kernel gave has no gap: nothing else can be holding a port this socket is
 * already on.
 */
async function upstreamOn(host = "127.0.0.1"): Promise<{ socket: ReturnType<typeof createSocket>; port: number }> {
  const socket = createSocket(isIP(host) === 6 ? "udp6" : "udp4");
  await bound(socket, 0, host);
  return { socket, port: (socket.address() as AddressInfo).port };
}

const EXAMPLE: ServedZone = {
  name: "example.com",
  serial: 12,
  records: [
    { name: "@", type: "A", content: "192.0.2.1", ttl: 300 },
    { name: "www", type: "A", content: "192.0.2.2", ttl: 60 },
    { name: "www", type: "A", content: "192.0.2.3", ttl: 60 },
    { name: "alias", type: "CNAME", content: "www.example.com", ttl: 60 },
    { name: "mail", type: "MX", content: "10 mx.example.com", ttl: 300 },
    { name: "deep.nested", type: "A", content: "192.0.2.4", ttl: 60 },
  ],
};

describe("DNS server", () => {
  const closers: (() => Promise<void>)[] = [];
  /**
   * A closer that throws is forgiven; one that never answers is not.
   *
   * `.catch()` forgives an error, which is a different thing from a failure
   * that produces no error at all -- and this hook is where a socket that will
   * not close stops the whole file without saying so. Bounded, the file fails
   * and names the closer that would not finish.
   */
  after(async () => {
    for (const [index, close] of closers.entries()) {
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<"stalled">((resolve) => { timer = setTimeout(() => resolve("stalled"), 5_000); });
      const finished = await Promise.race([close().then(() => "closed" as const).catch(() => "closed" as const), stalled]);
      clearTimeout(timer);
      assert.notEqual(finished, "stalled", `closer ${index} did not finish; something here stays open`);
    }
  });

  async function start(
    options: Partial<Parameters<typeof createDnsServer>[0]> & { zones: () => readonly ServedZone[] },
    host = "127.0.0.1",
  ) {
    // The listener needs one port for both transports, so it cannot be handed a
    // socket already holding one the way the upstreams are. That leaves a gap
    // between asking and binding, and something else can take it there. The
    // listener now leaves nothing bound when it fails, so trying again is safe
    // -- and a collision is rare enough that a second attempt settles it.
    for (let attempt = 3; ; attempt -= 1) {
      const port = await freePort(host);
      const server = createDnsServer(options);
      try {
        await server.listen(port, host);
      } catch (error) {
        if (attempt <= 1 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        continue;
      }
      closers.push(() => server.close());
      return { port, server };
    }
  }

  it("leaves nothing bound when one transport cannot take the port", async () => {
    // A free port is only free until somebody takes it, and this suite finds
    // ports by probing and letting go. Under a loaded machine another test wins
    // the race, one of the two binds fails, and `listen` throws -- at which
    // point whatever bound first has no owner. Nobody can close it, because the
    // caller never received the server.
    //
    // That is what the eight-minute silence was: every test in this file had
    // finished and the process would not leave, holding a UDP socket and a TCP
    // server that no `after` hook knew about.
    const port = await freePort();
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));
    closers.push(async () => { await new Promise<void>((resolve) => squatter.close(() => resolve())); });

    const server = createDnsServer({ zones: () => [EXAMPLE] });
    await assert.rejects(() => server.listen(port, "127.0.0.1"), "the TCP half cannot have the port");

    // The UDP half is the one that would have bound. Take the port without
    // `reuseAddr` -- a socket still holding it makes this fail, which is the
    // whole assertion.
    const probe = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.bind(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => probe.close(resolve));
  });

  it("answers from the snapshot it is given, over UDP and over TCP", async () => {
    const { port } = await start({ zones: () => [EXAMPLE] });

    const reply = await ask(port, buildQuery("www.example.com"));
    assert.ok(reply);
    assert.equal(reply.readUInt16BE(0), 0x4242, "the reply carries the query's id");
    assert.equal(reply.readUInt16BE(2) & 0x0400, 0x0400, "authoritative");
    const answers = readAnswers(reply);
    assert.equal(answers.length, 2, "both addresses, not one");
    assert.deepEqual(answers.map((record) => [...record.data]).sort(), [[192, 0, 2, 2], [192, 0, 2, 3]].sort());
    assert.equal(answers[0]?.ttl, 60);

    const overTcp = await askOverTcp(port, buildQuery("www.example.com"));
    assert.deepEqual(readAnswers(overTcp).length, 2);
  });

  it("binds both UDP and TCP when configured with an IPv6 host", async () => {
    const { port } = await start({ zones: () => [EXAMPLE] }, "::1");

    const overUdp = received(await ask(port, buildQuery("www.example.com"), 2_000, "::1"));
    assert.equal(readAnswers(overUdp).length, 2);

    const overTcp = await askOverTcp(port, buildQuery("www.example.com"), false, "::1");
    assert.equal(readAnswers(overTcp).length, 2);
  });

  it("binds UDP and TCP to the same resolved address for a hostname", async () => {
    const port = await freePort("::1");
    const resolutions: string[] = [];
    const server = createDnsServer({
      zones: () => [EXAMPLE],
      resolveHost: async (host) => {
        resolutions.push(host);
        return { address: "::1", family: 6 };
      },
    });
    await server.listen(port, "localhost");
    closers.push(() => server.close());

    assert.equal(readAnswers(received(await ask(port, buildQuery("www.example.com"), 2_000, "::1"))).length, 2);
    assert.equal(readAnswers(await askOverTcp(port, buildQuery("www.example.com"), false, "::1")).length, 2);
    assert.deepEqual(resolutions, ["localhost"], "the bind hostname is resolved once for both transports");
  });

  it("answers on the other family when the bind host is unspecified", async () => {
    const { port } = await start({ zones: () => [EXAMPLE] }, "0.0.0.0");
    const overV6 = received(await ask(port, buildQuery("www.example.com"), 2_000, "::1"));
    assert.equal(readAnswers(overV6).length, 2);
  });

  it("substitutes a name below a stored DNAME instead of NXDOMAIN", async () => {
    const { port } = await start({
      zones: () => [{
        name: "example.com",
        serial: 1,
        records: [
          { name: "old", type: "DNAME", content: "new.example.net", ttl: 300 },
        ],
      }],
    });
    const reply = received(await ask(port, buildQuery("www.old.example.com")));
    assert.equal(rcodeOf(reply), RCODE.NOERROR);
    const answers = readAnswers(reply);
    assert.equal(answers.some((record) => record.type === TYPE.DNAME), true);
    assert.equal(answers.some((record) => record.type === TYPE.CNAME), true);
  });

  it("denies AXFR by default", async () => {
    const { port } = await start({ zones: () => [EXAMPLE] });
    assert.equal(rcodeOf(await askOverTcp(port, buildQuery("example.com", TYPE.AXFR))), RCODE.REFUSED);
  });

  it("denies AXFR over UDP even for an allowed client", async () => {
    const { port } = await start({ zones: () => [EXAMPLE], transferAllow: ["127.0.0.0/8"] });
    assert.equal(rcodeOf(await ask(port, buildQuery("example.com", TYPE.AXFR))), RCODE.REFUSED);
  });

  it("denies AXFR from a client outside the transfer allowlist", async () => {
    const { port } = await start({ zones: () => [EXAMPLE], transferAllow: ["10.0.0.0/8"] });
    assert.equal(rcodeOf(await askOverTcp(port, buildQuery("example.com", TYPE.AXFR))), RCODE.REFUSED);
  });

  it("never forwards AXFR around the transfer policy", async () => {
    const { socket: upstream, port: upstreamPort } = await upstreamOn();
    let receivedQueries = 0;
    upstream.on("message", () => { receivedQueries += 1; });
    closers.push(async () => { upstream.close(); });
    const { port } = await start({
      zones: () => [EXAMPLE],
      forwardTo: [`127.0.0.1#${upstreamPort}`],
      forwardAllow: ["127.0.0.0/8"],
    });
    assert.equal(rcodeOf(await askOverTcp(port, buildQuery("outside.example", TYPE.AXFR))), RCODE.REFUSED);
    assert.equal(receivedQueries, 0);
  });

  it("answers an allowed TCP AXFR of a served apex with that zone's records", async () => {
    const { port } = await start({ zones: () => [EXAMPLE], transferAllow: ["127.0.0.0/8"] });
    const reply = await askOverTcp(port, buildQuery("example.com", TYPE.AXFR));
    const answers = readAnswers(reply);
    assert.equal(answers[0]?.type, TYPE.SOA);
    assert.equal(answers.at(-1)?.type, TYPE.SOA);
    assert.ok(answers.some((record) => record.type === TYPE.A && record.name === "www.example.com"));
    assert.ok(answers.some((record) => record.type === TYPE.MX));
  });

  it("emits NOTIFY when a served zone's serial rises", async () => {
    const sent: Array<{ packet: Buffer; address: string; port: number }> = [];
    const zone = { ...EXAMPLE, serial: 12 };
    const { server } = await start({
      zones: () => [zone],
      notifyTo: ["127.0.0.1:5300"],
      sendNotify: async (packet, address, port) => { sent.push({ packet, address, port }); },
    });
    await server.notifyChanged(new Map(), [{ ...zone, serial: 12 }]);
    assert.equal(sent.length, 0, "the first snapshot is not a change");
    await server.notifyChanged(new Map([["example.com", 12]]), [{ ...zone, serial: 13 }]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.address, "127.0.0.1");
    assert.equal(sent[0]?.port, 5300);
    assert.equal(sent[0]?.packet.readUInt16BE(2), 0x2000);
  });

  it("closes so a subsequent bind on the same ports can succeed", async () => {
    const { port, server } = await start({ zones: () => [EXAMPLE] });
    const http = createServer((socket) => socket.end());
    const httpPort = await freePort();
    await new Promise<void>((resolve) => http.listen(httpPort, "127.0.0.1", resolve));
    const runtime = { close: async () => undefined };
    await shutdownProcess({ dns: server, http, runtime, timers: [] });
    const rebound = createDnsServer({ zones: () => [EXAMPLE] });
    await rebound.listen(port, "127.0.0.1");
    closers.push(() => rebound.close());
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(httpPort, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    assert.equal(readAnswers(received(await ask(port, buildQuery("www.example.com")))).length, 2);
  });

  it("bounds and coalesces stalled upstream hostname resolutions", async () => {
    let calls = 0;
    let releaseLookup = (_value: ResolvedDnsAddress): void => {};
    const rawLookup = new Promise<ResolvedDnsAddress>((resolve) => { releaseLookup = resolve; });
    const resolve = createTimedDnsResolver(async () => {
      calls += 1;
      return rawLookup;
    });

    assert.deepEqual(await Promise.all([
      resolve("upstream.example", 10),
      resolve("UPSTREAM.EXAMPLE", 10),
    ]), [undefined, undefined]);
    assert.equal(calls, 1, "concurrent callers share the raw lookup");

    assert.equal(await resolve("upstream.example", 5), undefined);
    assert.equal(calls, 1, "a timed-out raw lookup is not fanned out by later queries");

    releaseLookup({ address: "127.0.0.1", family: 4 });
    await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(await resolve("upstream.example", 10), { address: "127.0.0.1", family: 4 });
    assert.equal(calls, 2, "a settled lookup is removed so a later query can refresh it");
  });

  it("reassembles a TCP message that arrives in pieces", async () => {
    const { port } = await start({ zones: () => [EXAMPLE] });
    const reply = await askOverTcp(port, buildQuery("www.example.com"), true);
    assert.equal(readAnswers(reply).length, 2);
  });

  it("answers an apex SOA query from the zone serial", async () => {
    const { port } = await start({ zones: () => [EXAMPLE] });
    const reply = received(await ask(port, buildQuery("example.com", TYPE.SOA)));
    assert.equal(rcodeOf(reply), RCODE.NOERROR);
    const answers = readAnswers(reply);
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.type, TYPE.SOA);
    const serialOffset = (answers[0]?.data.length ?? 0) - 20;
    assert.ok(serialOffset >= 0);
    assert.equal(answers[0]?.data.readUInt32BE(serialOffset), EXAMPLE.serial);
  });

  it("tells apart a name with no records of this type from a name that does not exist", async () => {
    // A resolver treats these differently, and caches them differently. Both
    // carry the SOA so it knows how long it may remember the absence.
    const { port } = await start({ zones: () => [EXAMPLE] });

    const wrongType = received(await ask(port, buildQuery("www.example.com", TYPE.TXT)));
    assert.equal(rcodeOf(wrongType), RCODE.NOERROR);
    assert.equal(wrongType.readUInt16BE(6), 0, "no answers");
    assert.equal(wrongType.readUInt16BE(8), 1, "the SOA, in the authority section");

    const missing = received(await ask(port, buildQuery("nothing.example.com")));
    assert.equal(rcodeOf(missing), RCODE.NXDOMAIN);
    assert.equal(missing.readUInt16BE(8), 1);

    // `nested.example.com` holds no records itself but something below it does,
    // so it exists and the answer is empty rather than NXDOMAIN.
    assert.equal(rcodeOf(await ask(port, buildQuery("nested.example.com"))), RCODE.NOERROR);
  });

  it("answers a CNAME to a query for any other type", async () => {
    const { port } = await start({ zones: () => [EXAMPLE] });
    const answers = readAnswers(received(await ask(port, buildQuery("alias.example.com", TYPE.AAAA))));
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.type, TYPE.CNAME);
  });

  it("serves the longest zone that matches, not the first", async () => {
    const inner: ServedZone = {
      name: "internal.example.com",
      serial: 1,
      records: [{ name: "host", type: "A", content: "10.0.0.1", ttl: 60 }],
    };
    const { port } = await start({ zones: () => [EXAMPLE, inner] });
    const answers = readAnswers(received(await ask(port, buildQuery("host.internal.example.com"))));
    assert.deepEqual([...(answers[0]?.data ?? [])], [10, 0, 0, 1]);
  });

  it("refuses a name outside every zone when it has nowhere to send it", async () => {
    const { port } = await start({ zones: () => [EXAMPLE] });
    const reply = received(await ask(port, buildQuery("example.org")));
    assert.equal(rcodeOf(reply), RCODE.REFUSED);
    assert.equal(reply.readUInt16BE(2) & 0x0400, 0, "not authoritative for what it refused");
  });

  it("hands a name outside every zone to an upstream, and relays the bytes unchanged", async () => {
    const { socket: upstream, port: upstreamPort } = await upstreamOn();
    upstream.on("message", (message, remote) => {
      // Answer with something this server could not have synthesized, so the
      // test can tell a relayed reply from a locally built one.
      const reply = Buffer.from(message);
      reply.writeUInt16BE(0x8180, 2);
      upstream.send(Buffer.concat([reply, Buffer.of(0xde, 0xad)]), remote.port, remote.address);
    });
    closers.push(async () => { upstream.close(); });

    const { port } = await start({ zones: () => [EXAMPLE], forwardTo: [`127.0.0.1#${upstreamPort}`] });
    const reply = received(await ask(port, buildQuery("elsewhere.example.org")));
    assert.equal(reply.subarray(-2).toString("hex"), "dead", "the upstream's bytes came back as they were");
  });

  it("ignores forged-source and mismatched upstream datagrams until a valid response arrives", async () => {
    const { socket: upstream, port: upstreamPort } = await upstreamOn();
    const rogue = createSocket("udp4");
    await bound(rogue, 0, "127.0.0.1");
    closers.push(async () => { upstream.close(); rogue.close(); });
    upstream.on("message", (message, remote) => {
      const valid = forwardedReply(message, [0xbe, 0xef]);
      const forged = forwardedReply(message, [0xba, 0xd1]);
      rogue.send(forged, remote.port, remote.address);

      const notAResponse = Buffer.from(message);
      const wrongId = forwardedReply(message, [0xba, 0xd2]);
      wrongId.writeUInt16BE(wrongId.readUInt16BE(0) ^ 1, 0);
      const wrongOpcode = forwardedReply(message, [0xba, 0xd3]);
      wrongOpcode.writeUInt16BE((wrongOpcode.readUInt16BE(2) & ~0x7800) | 0x0800, 2);
      const wrongQuestion = forwardedReply(buildQuery("wrong.example.org", TYPE.A, message.readUInt16BE(0)), [0xba, 0xd4]);
      upstream.send(notAResponse, remote.port, remote.address);
      upstream.send(wrongId, remote.port, remote.address);
      upstream.send(wrongOpcode, remote.port, remote.address);
      upstream.send(wrongQuestion, remote.port, remote.address);
      setTimeout(() => upstream.send(valid, remote.port, remote.address), 20);
    });

    const { port } = await start({
      zones: () => [EXAMPLE],
      forwardTo: [`127.0.0.1#${upstreamPort}`],
      forwardTimeoutMs: 250,
    });
    const reply = received(await ask(port, buildQuery("elsewhere.example.org")));
    assert.equal(reply.subarray(-2).toString("hex"), "beef");
    assert.equal(reply.readUInt16BE(0), 0x4242);
  });

  it("allows forwarding only for explicitly permitted client networks", async () => {
    const { socket: upstream, port: upstreamPort } = await upstreamOn();
    let receivedQueries = 0;
    upstream.on("message", () => { receivedQueries += 1; });
    closers.push(async () => { upstream.close(); });

    const { port } = await start({
      zones: () => [EXAMPLE],
      forwardTo: [`127.0.0.1#${upstreamPort}`],
      forwardAllow: ["10.0.0.0/8"],
    });
    assert.equal(rcodeOf(await ask(port, buildQuery("elsewhere.example.org"))), RCODE.REFUSED);
    assert.equal(receivedQueries, 0);
  });

  it("rejects malformed forwarding CIDRs instead of treating an empty prefix as zero", () => {
    assert.throws(
      () => createDnsServer({ zones: () => [], forwardAllow: ["10.0.0.1/"] }),
      /invalid DNS client CIDR prefix/,
    );
  });

  it("rate-limits each client without permanently denying it", async () => {
    let now = 0;
    const { port } = await start({
      zones: () => [EXAMPLE],
      rateLimitPerSecond: 1,
      rateLimitBurst: 1,
      now: () => now,
    });
    assert.ok(await ask(port, buildQuery("www.example.com"), 200));
    assert.equal(await ask(port, buildQuery("www.example.com"), 80), undefined);
    now = 1000;
    assert.ok(await ask(port, buildQuery("www.example.com"), 200));
  });

  it("bounds simultaneous upstream work and returns SERVFAIL at capacity", async () => {
    const { socket: upstream, port: upstreamPort } = await upstreamOn();
    let firstMessage: { message: Buffer; port: number; address: string } | undefined;
    let signalFirst = (): void => {};
    const sawFirst = new Promise<void>((resolve) => { signalFirst = resolve; });
    upstream.on("message", (message, remote) => {
      firstMessage ??= { message, port: remote.port, address: remote.address };
      signalFirst();
    });
    closers.push(async () => { upstream.close(); });

    const { port } = await start({
      zones: () => [EXAMPLE],
      forwardTo: [`127.0.0.1#${upstreamPort}`],
      maxConcurrentForwards: 1,
      forwardTimeoutMs: 500,
    });
    const first = ask(port, buildQuery("first.example.org", TYPE.A, 0x1001));
    await sawFirst;
    const second = await ask(port, buildQuery("second.example.org", TYPE.A, 0x1002));
    assert.equal(rcodeOf(second), RCODE.SERVFAIL);
    assert.ok(firstMessage);
    upstream.send(forwardedReply(firstMessage.message, [0xca, 0xfe]), firstMessage.port, firstMessage.address);
    assert.equal(received(await first).subarray(-2).toString("hex"), "cafe");
  });

  it("closes idle TCP clients and refuses connections beyond its cap", async () => {
    const idle = await start({ zones: () => [EXAMPLE], tcpIdleTimeoutMs: 40 });
    const idleSocket = connect(idle.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { idleSocket.once("connect", resolve); idleSocket.once("error", reject); });
    await Promise.race([
      new Promise<void>((resolve) => idleSocket.once("close", () => resolve())),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("idle DNS TCP socket stayed open")), 300)),
    ]);

    const capped = await start({ zones: () => [EXAMPLE], maxTcpConnections: 1, tcpIdleTimeoutMs: 1000 });
    const first = connect(capped.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { first.once("connect", resolve); first.once("error", reject); });
    const second = connect(capped.port, "127.0.0.1");
    await Promise.race([
      new Promise<void>((resolve) => {
        second.once("close", () => resolve());
        second.once("error", () => resolve());
      }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("excess DNS TCP connection stayed open")), 300)),
    ]);
    first.destroy();
  });

  it("answers SERVFAIL when the upstream says nothing", async () => {
    const deadPort = await freePort();
    const { port } = await start({
      zones: () => [EXAMPLE],
      forwardTo: [`127.0.0.1#${deadPort}`],
      forwardTimeoutMs: 150,
    });
    assert.equal(rcodeOf(await ask(port, buildQuery("elsewhere.example.org"))), RCODE.SERVFAIL);
  });

  it("reads the snapshot on every query, so a published revision takes effect without a restart", async () => {
    let current: ServedZone = { ...EXAMPLE, records: [{ name: "@", type: "A", content: "192.0.2.1", ttl: 60 }] };
    const { port } = await start({ zones: () => [current] });
    const answer = async (): Promise<number[]> =>
      [...(readAnswers(received(await ask(port, buildQuery("example.com"))))[0]?.data ?? [])];
    assert.deepEqual(await answer(), [192, 0, 2, 1]);

    current = { ...current, serial: 13, records: [{ name: "@", type: "A", content: "192.0.2.9", ttl: 60 }] };
    assert.deepEqual(await answer(), [192, 0, 2, 9]);
  });

  it("answers SERVFAIL, and says which record, rather than serving half an RRset", async () => {
    // Half an RRset is the dangerous answer: it looks complete, a resolver
    // caches it, and a client silently loses the addresses that went missing.
    const unservable: UnservableRecord[] = [];
    const broken: ServedZone = {
      name: "example.com",
      serial: 1,
      records: [
        { name: "www", type: "A", content: "192.0.2.1", ttl: 60 },
        { name: "www", type: "A", content: "not-an-address", ttl: 60 },
      ],
    };
    const { port } = await start({
      zones: () => [broken],
      onUnservable: (record) => unservable.push(record),
    });
    const reply = received(await ask(port, buildQuery("www.example.com")));
    assert.equal(rcodeOf(reply), RCODE.SERVFAIL);
    assert.equal(reply.readUInt16BE(6), 0);
    assert.equal(unservable.length, 1);
    assert.equal(unservable[0]?.zone, "example.com");
    assert.equal(unservable[0]?.name, "www");
    assert.equal(unservable[0]?.type, "A");
    assert.match(unservable[0]?.reason ?? "", /not an IPv4 address/);
  });

  describe("wildcards", () => {
    // The desired state accepts `*` and `*.name`, and every other publisher of
    // the internal view -- a zone file, PowerDNS, Cloudflare -- expands them.
    // A listener that took them literally would answer NXDOMAIN for names the
    // same desired state resolves everywhere else.
    const WILDCARDS: ServedZone = {
      name: "example.com",
      serial: 3,
      records: [
        { name: "*", type: "A", content: "192.0.2.50", ttl: 60 },
        { name: "*.eu", type: "A", content: "192.0.2.51", ttl: 60 },
        { name: "www", type: "A", content: "192.0.2.1", ttl: 60 },
        { name: "deep.nested", type: "A", content: "192.0.2.4", ttl: 60 },
      ],
    };

    it("synthesizes an answer for a name the apex wildcard covers", async () => {
      const { port } = await start({ zones: () => [WILDCARDS] });
      const answers = readAnswers(received(await ask(port, buildQuery("anything.example.com"))));
      assert.equal(answers.length, 1);
      assert.deepEqual([...(answers[0]?.data ?? [])], [192, 0, 2, 50]);
      // The owner name is the name that was asked for, never the wildcard: a
      // resolver matches the answer against its question.
      assert.equal(answers[0]?.name, "anything.example.com");
    });

    it("prefers an exact record over a wildcard that would also match", async () => {
      const { port } = await start({ zones: () => [WILDCARDS] });
      const answers = readAnswers(received(await ask(port, buildQuery("www.example.com"))));
      assert.deepEqual([...(answers[0]?.data ?? [])], [192, 0, 2, 1]);
    });

    it("prefers the closest wildcard, not the first one that matches", async () => {
      const { port } = await start({ zones: () => [WILDCARDS] });
      const answers = readAnswers(received(await ask(port, buildQuery("shop.eu.example.com"))));
      assert.deepEqual([...(answers[0]?.data ?? [])], [192, 0, 2, 51]);
    });

    it("does not let a wildcard answer for a name that exists with other types", async () => {
      // `nested.example.com` holds nothing itself but something below it does,
      // so it exists. A wildcard must not answer over an existing name.
      const { port } = await start({ zones: () => [WILDCARDS] });
      const reply = received(await ask(port, buildQuery("nested.example.com")));
      assert.equal(rcodeOf(reply), RCODE.NOERROR);
      assert.equal(reply.readUInt16BE(6), 0, "an empty answer, not the wildcard's address");
    });

    it("does not let a wildcard answer for the zone apex, and does not deny the apex either", async () => {
      // A wildcard never covers its own parent. The apex is also not a name
      // that can be absent -- the zone is there -- so denying it would tell a
      // resolver to cache the whole zone as nonexistent.
      const { port } = await start({ zones: () => [WILDCARDS] });
      const reply = received(await ask(port, buildQuery("example.com")));
      assert.equal(reply.readUInt16BE(6), 0, "the apex is not a name the wildcard covers");
      assert.equal(rcodeOf(reply), RCODE.NOERROR, "the apex exists even when it holds nothing");
    });

    it("answers the empty NOERROR a wildcard owner gives for another type", async () => {
      const { port } = await start({ zones: () => [WILDCARDS] });
      const reply = received(await ask(port, buildQuery("anything.example.com", TYPE.MX)));
      assert.equal(rcodeOf(reply), RCODE.NOERROR);
      assert.equal(reply.readUInt16BE(6), 0);
      assert.equal(reply.readUInt16BE(8), 1, "with the SOA, so the absence can be cached");
    });
  });

  it("forwards a TCP query over TCP, so the answer is not truncated again", async () => {
    // A client reaches TCP because it was told the UDP answer was truncated.
    // Relaying that query over UDP hands back another truncated answer, and the
    // client has no move left -- it already did the thing TC asks for.
    const overUdp: number[] = [];
    const { socket: udpUpstream, port: upstreamPort } = await upstreamOn();
    udpUpstream.on("message", (message, remote) => {
      overUdp.push(1);
      const truncated = Buffer.from(message.subarray(0, 12));
      truncated.writeUInt16BE(0x8380, 2);
      udpUpstream.send(truncated, remote.port, remote.address);
    });
    const tcpUpstream = createServer((socket) => {
      socket.on("data", (request) => {
        const querySize = request.readUInt16BE(0);
        const query = request.subarray(2, 2 + querySize);
        const reply = Buffer.alloc(1200, 0x41);
        query.copy(reply);
        reply.writeUInt16BE((reply.readUInt16BE(2) & 0x7900) | 0x8080, 2);
        const framed = Buffer.alloc(2 + reply.length);
        framed.writeUInt16BE(reply.length, 0);
        reply.copy(framed, 2);
        const wrong = Buffer.from(framed);
        wrong.writeUInt16BE(wrong.readUInt16BE(2) ^ 1, 2);
        socket.write(Buffer.concat([wrong, framed]));
      });
    });
    await new Promise<void>((resolve) => tcpUpstream.listen(upstreamPort, "127.0.0.1", resolve));
    closers.push(async () => {
      udpUpstream.close();
      await new Promise<void>((resolve) => tcpUpstream.close(() => resolve()));
    });

    const { port } = await start({ zones: () => [EXAMPLE], forwardTo: [`127.0.0.1#${upstreamPort}`] });
    const reply = await askOverTcp(port, buildQuery("elsewhere.example.org"));
    assert.equal(reply.length, 1200, "the whole TCP answer came back");
    assert.equal(overUdp.length, 0, "the UDP upstream was never asked for a TCP query");
  });

  it("says nothing at all to a message it cannot parse", async () => {
    // A reply to an unparseable message is a reply to a forged source address,
    // which is what makes a DNS server useful to somebody else's flood.
    const { port } = await start({ zones: () => [EXAMPLE] });
    assert.equal(await ask(port, Buffer.of(1, 2, 3), 300), undefined);
    const response = buildQuery("example.com");
    response.writeUInt16BE(0x8180, 2);
    assert.equal(await ask(port, response, 300), undefined);
  });

  describe("names the provider serves itself", () => {
    /** A zone shaped like an adopted one: a placeholder apex that also holds mail. */
    const WORKERS: ServedZone = {
      name: "example.com",
      serial: 3,
      records: [
        { name: "@", type: "AAAA", content: "100::", ttl: 300 },
        { name: "@", type: "MX", content: "10 mx.example.com", ttl: 300 },
        { name: "@", type: "TXT", content: "v=spf1 -all", ttl: 300 },
        { name: "inside", type: "A", content: "10.17.192.11", ttl: 60 },
      ],
    };

    async function withUpstream(zone: ServedZone) {
      const { socket: upstream, port: upstreamPort } = await upstreamOn();
      const asked: string[] = [];
      upstream.on("message", (message, remote) => {
        asked.push(readName(message, 12).name);
        upstream.send(forwardedReply(message, [0xc0, 0xde]), remote.port, remote.address);
      });
      closers.push(async () => { upstream.close(); });
      const started = await start({
        zones: () => [zone],
        forwardTo: [`127.0.0.1#${upstreamPort}`],
        // Deliberately excludes the loopback client below: this path must not be
        // gated by it, because the clients that need it are the ones outside.
        forwardAllow: ["10.99.0.0/16"],
      });
      return { ...started, asked };
    }

    it("asks the upstream for an address it cannot answer, though the name is ours", async () => {
      const { port, asked } = await withUpstream(WORKERS);
      const reply = received(await ask(port, buildQuery("example.com", TYPE.AAAA)));
      assert.equal(reply.subarray(-2).toString("hex"), "c0de", "the answer came from the upstream");
      assert.deepEqual(asked, ["example.com"]);
    });

    it("asks for A too, where the placeholder is the AAAA and there is no A at all", async () => {
      // The apex holds AAAA `100::` and no A. Answering the A query from the zone
      // is an empty section, and a browser has nowhere to go; publicly the name
      // has an address. This is the case the whole thing exists for.
      const { port, asked } = await withUpstream(WORKERS);
      const reply = received(await ask(port, buildQuery("example.com", TYPE.A)));
      assert.equal(reply.subarray(-2).toString("hex"), "c0de");
      assert.deepEqual(asked, ["example.com"]);
    });

    it("still relays once the record says which worker publishes the name", async () => {
      // The label and the address are two facts, and adoption learns the first
      // without changing the second: Cloudflare stores a Workers custom domain
      // as this exact placeholder, so a name that gained a `Worker` label is
      // still a name no view can answer usefully. Reading the binding as "the
      // service is the origin, so the address is fine" made labelling the apex
      // answer `100::` inside, to every client, for the most important name in
      // the zone -- and nothing in the portal or the plan would have shown it.
      const { port, asked } = await withUpstream({
        ...WORKERS,
        records: WORKERS.records.map((record) => (record.type === "AAAA"
          ? { ...record, managedBy: { service: "worker" as const, resource: "tinyuniverse-dashboard" } }
          : record)),
      });
      const reply = received(await ask(port, buildQuery("example.com", TYPE.AAAA)));
      assert.equal(reply.subarray(-2).toString("hex"), "c0de", "the answer still came from the upstream");
      assert.deepEqual(asked, ["example.com"]);
    });

    it("still answers the same name's mail and text itself", async () => {
      // Relaying the whole name would throw away every override that is not an
      // address, which is most of what an internal view is for.
      const { port, asked } = await withUpstream(WORKERS);
      const mx = received(await ask(port, buildQuery("example.com", TYPE.MX)));
      assert.equal(mx.readUInt16BE(2) & 0x0400, 0x0400, "authoritative");
      assert.equal(readAnswers(mx).length, 1);
      const txt = received(await ask(port, buildQuery("example.com", TYPE.TXT)));
      assert.equal(readAnswers(txt).length, 1);
      assert.deepEqual(asked, [], "the upstream was never asked");
    });

    it("answers ordinary names in the zone itself", async () => {
      const { port, asked } = await withUpstream(WORKERS);
      const reply = received(await ask(port, buildQuery("inside.example.com", TYPE.A)));
      assert.equal(reply.readUInt16BE(2) & 0x0400, 0x0400);
      assert.deepEqual(readAnswers(reply).map((record) => [...record.data]), [[10, 17, 192, 11]]);
      assert.deepEqual(asked, []);
    });

    it("answers the placeholder as stored when there is no upstream to ask", async () => {
      // Without somewhere to ask, the desired state is all there is. Refusing
      // would replace an answer that is merely useless with no answer at all.
      const { port } = await start({ zones: () => [WORKERS] });
      const reply = received(await ask(port, buildQuery("example.com", TYPE.AAAA)));
      assert.equal(reply.readUInt16BE(2) & 0x0400, 0x0400, "authoritative");
      assert.equal(readAnswers(reply).length, 1, "the placeholder itself");
    });

    it("keeps serving a record whose value works, though the provider owns it", async () => {
      // The r2 case: locked against editing, but the target resolves, so there is
      // nothing to relay and the stored value is the answer.
      const zone: ServedZone = {
        name: "example.com",
        serial: 4,
        records: [{ name: "files", type: "CNAME", content: "pub-1234.r2.dev", ttl: 300 }],
      };
      const { port, asked } = await withUpstream(zone);
      const reply = received(await ask(port, buildQuery("files.example.com", TYPE.A)));
      assert.equal(reply.readUInt16BE(2) & 0x0400, 0x0400, "authoritative");
      assert.equal(readAnswers(reply).length, 1, "the CNAME answers for every type");
      assert.deepEqual(asked, [], "nothing was relayed");
    });
  });


  describe("many clients at once", () => {
    it("answers every one of a burst, not most of them", async () => {
      // A deployment measured this from its gateway and saw no losses. That is an
      // observation of one listener under one load; this is the assertion, and it
      // fails if a shared buffer or a shared parse ever starts serving one
      // client's answer to another.
      const { port } = await start({ zones: () => [EXAMPLE] });
      const replies = await Promise.all(Array.from({ length: 120 }, (_unused, index) =>
        ask(port, buildQuery("www.example.com", TYPE.A, 0x1000 + index))));

      assert.equal(replies.filter((reply) => reply !== undefined).length, 120, "every query was answered");
      for (const [index, reply] of replies.entries()) {
        const message = received(reply);
        assert.equal(message.readUInt16BE(0), 0x1000 + index, "each answer carries its own query's id");
        assert.equal(readAnswers(message).length, 2, "and the whole RRset, not a truncated share of it");
      }
    });

    it("refuses past the concurrent forward limit rather than queueing without bound", async () => {
      // The limit exists so a burst of names this listener does not hold cannot
      // hold open more upstream work than the process can carry. Reached, it must
      // answer SERVFAIL -- a client can retry that. Silence it cannot.
      const { socket: upstream, port: upstreamPort } = await upstreamOn();
      const held: { message: Buffer; port: number; address: string }[] = [];
      upstream.on("message", (message, remote) => { held.push({ message, port: remote.port, address: remote.address }); });
      closers.push(async () => { upstream.close(); });

      const { port } = await start({
        zones: () => [EXAMPLE],
        forwardTo: [`127.0.0.1#${upstreamPort}`],
        maxConcurrentForwards: 2,
      });

      // Two queries occupy both slots and are left unanswered upstream.
      const occupying = [
        ask(port, buildQuery("first.example.org", TYPE.A, 0x2001), 6_000),
        ask(port, buildQuery("second.example.org", TYPE.A, 0x2002), 6_000),
      ];
      for (let waited = 0; held.length < 2 && waited < 200; waited += 1) await delay(10);
      assert.equal(held.length, 2, "both slots are in use");

      const overflow = received(await ask(port, buildQuery("third.example.org", TYPE.A, 0x2003)));
      assert.equal(overflow.readUInt16BE(2) & 0x000f, RCODE.SERVFAIL, "the third is refused, not dropped");

      // Releasing one returns its slot, and the next query is forwarded again.
      for (const request of held) {
        const reply = Buffer.from(request.message);
        reply.writeUInt16BE(0x8180, 2);
        upstream.send(reply, request.port, request.address);
      }
      await Promise.all(occupying);
      for (let waited = 0; held.length < 3 && waited < 200; waited += 1) {
        void ask(port, buildQuery("fourth.example.org", TYPE.A, 0x2004), 500);
        await delay(10);
      }
      assert.ok(held.length > 2, "a completed forward frees its slot");
    });
  });

});
