import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { connect, createServer, isIP, type AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import {
  createDnsServer,
  createTimedDnsResolver,
  parseNotifyDestination,
  type ResolvedDnsAddress,
  type ServedZone,
  type UnservableRecord,
} from "../../src/dns/server.ts";
import {
  TSIG_ERROR, parseTsigKey, readTsig, signRequest, verifyTsig,
} from "../../src/dns/tsig.ts";
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
    socket.on("data", (chunk: Buffer) => {
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
 * Every message the server sends for one query, not just the first.
 *
 * A transfer spans messages, so a reader that stops at the first frame sees a
 * zone with a SOA and nothing else -- which is indistinguishable from a working
 * transfer of an empty zone. The connection close is what ends the sequence.
 */
function askAllOverTcp(port: number, message: Buffer, host = "127.0.0.1"): Promise<Buffer[]> {
  const framed = Buffer.concat([Buffer.alloc(2), message]);
  framed.writeUInt16BE(message.length, 0);
  return new Promise((resolve, reject) => {
    const socket = connect(port, host, () => socket.write(framed));
    const messages: Buffer[] = [];
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 2) return;
        const size = buffered.readUInt16BE(0);
        if (buffered.length < size + 2) return;
        messages.push(Buffer.from(buffered.subarray(2, size + 2)));
        buffered = buffered.subarray(size + 2);
      }
    });
    // The server keeps the connection open for more queries, so the reader
    // decides when a transfer is done: the last message repeats the SOA.
    const finished = setInterval(() => {
      const last = messages.at(-1);
      if (messages.length > 0 && last && readAnswers(last).at(-1)?.type === TYPE.SOA) {
        clearInterval(finished);
        socket.destroy();
        resolve(messages);
      }
    }, 5);
    finished.unref?.();
    socket.on("error", (error) => { clearInterval(finished); reject(error); });
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

  /**
   * A zone whose wire form outgrows the frame that has to carry it.
   *
   * DNS-over-TCP prefixes each message with a uint16 length, so 65535 bytes is
   * the ceiling the transport imposes. This listener used to put the whole zone
   * in one message: the framing wrote that length unconditionally,
   * `writeUInt16BE` threw, and the `.catch()` beside it destroyed the socket --
   * the secondary received **zero bytes** and nothing was logged or counted.
   *
   * ⚠️ This test asserted SERVFAIL when the interim fix only made the failure
   * audible. It now asserts the transfer, because AXFR is defined to span
   * messages and does. The SERVFAIL path still exists for a reply that is *not*
   * a transfer and does not fit, which the case below covers.
   */
  it("carries a zone too large for one message across several", async () => {
    const unanswerable: { zone: string; name: string; reason: string }[] = [];
    const size = 2_500;
    const huge: ServedZone = {
      name: "example.com",
      serial: 1,
      records: Array.from({ length: size }, (_unused, index) => ({
        name: `host-with-a-longish-label-${index}`, type: "A" as const, content: "203.0.113.5", ttl: 300,
      })),
    };
    const { port } = await start({
      zones: () => [huge],
      transferAllow: ["127.0.0.0/8"],
      onUnanswerable: (detail) => unanswerable.push(detail),
    });

    const messages = await askAllOverTcp(port, buildQuery("example.com", TYPE.AXFR));

    assert.ok(messages.length > 1, `a zone this size needs more than one message, got ${messages.length}`);
    assert.deepEqual(unanswerable, [], "nothing failed");
    for (const reply of messages) {
      assert.equal(rcodeOf(reply), RCODE.NOERROR);
      assert.ok(reply.length <= 65_535, "every message fits the frame that carries it");
    }

    // The shape a receiver relies on: SOA first, SOA last, every record once.
    const answers = messages.flatMap((reply) => readAnswers(reply));
    assert.equal(answers[0]?.type, TYPE.SOA);
    assert.equal(answers.at(-1)?.type, TYPE.SOA);
    assert.equal(answers.filter((record) => record.type === TYPE.A).length, size, "no record lost or repeated");
    assert.equal(new Set(answers.filter((record) => record.type === TYPE.A).map((record) => record.name)).size, size);
  });

  it("still answers SERVFAIL for an oversized reply that is not a transfer", async () => {
    // Only a transfer may span messages. Anything else that will not fit has
    // to say so rather than being silently cut in half.
    const unanswerable: { zone: string; name: string; reason: string }[] = [];
    const wide: ServedZone = {
      name: "example.com",
      serial: 1,
      records: Array.from({ length: 2_000 }, (_unused, index) => ({
        name: "big", type: "TXT" as const, content: `${index}`.padStart(200, "x"), ttl: 300,
      })),
    };
    const { port } = await start({ zones: () => [wide], onUnanswerable: (detail) => unanswerable.push(detail) });

    const reply = await askOverTcp(port, buildQuery("big.example.com", TYPE.TXT));

    assert.equal(rcodeOf(reply), RCODE.SERVFAIL);
    assert.equal(unanswerable.length, 1);
    assert.match(unanswerable[0]?.reason ?? "", /cannot exceed 65535/u);
  });

  it("still transfers a zone that does fit", async () => {
    // The guard must not have moved the ceiling down onto ordinary zones.
    const ordinary: ServedZone = {
      name: "example.com",
      serial: 1,
      records: Array.from({ length: 800 }, (_unused, index) => ({
        name: `host-${index}`, type: "A" as const, content: "203.0.113.5", ttl: 300,
      })),
    };
    const { port } = await start({ zones: () => [ordinary], transferAllow: ["127.0.0.0/8"] });

    const reply = await askOverTcp(port, buildQuery("example.com", TYPE.AXFR));

    assert.equal(rcodeOf(reply), RCODE.NOERROR);
    assert.equal(readAnswers(reply).length, 802, "SOA, 800 records, SOA");
  });

  /**
   * RFC 4592 §3.3.1: a wildcard synthesizes only from the *closest encloser*.
   *
   * The walk used to keep climbing past names the zone actually holds, so
   * `*.example.com` answered for `a.b.example.com` even though `b.example.com`
   * exists and `*.b.example.com` does not. The right answer there is NXDOMAIN.
   *
   * This is the divergence that matters most for a split-horizon control plane:
   * Cloudflare and a zone file both apply the closest-encloser rule, so the
   * same desired state answered one thing outside and another thing inside.
   */
  it("does not reach past a name the zone holds to find a wildcard", async () => {
    const zone: ServedZone = {
      name: "example.com",
      serial: 1,
      records: [
        { name: "b", type: "A", content: "203.0.113.5", ttl: 300 },
        { name: "*", type: "A", content: "203.0.113.99", ttl: 300 },
      ],
    };
    const { port } = await start({ zones: () => [zone] });

    assert.equal(rcodeOf(await ask(port, buildQuery("b.example.com"))), RCODE.NOERROR, "the real name");
    assert.equal(rcodeOf(await ask(port, buildQuery("x.example.com"))), RCODE.NOERROR, "covered by the wildcard");

    // `b.example.com` is the closest encloser and there is no `*.b.example.com`.
    const below = await ask(port, buildQuery("a.b.example.com"));
    assert.ok(below);
    assert.equal(rcodeOf(below), RCODE.NXDOMAIN);
    assert.equal(readAnswers(below).length, 0);

    // ⚠️ The blast radius, pinned: only a name under an *existing* one changes.
    // A catch-all wildcard still covers arbitrary depth where nothing exists in
    // between, and that is what most zones actually lean on.
    const deepButEmpty = await ask(port, buildQuery("a.nothing-here.example.com"));
    assert.ok(deepButEmpty);
    assert.equal(rcodeOf(deepButEmpty), RCODE.NOERROR);
    assert.equal(readAnswers(deepButEmpty)[0]?.data.join("."), "203.0.113.99");
  });

  it("still lets the nearest wildcard answer, at every depth it should", async () => {
    // The comment on `wildcardMatch` promises exactly this, and it has to keep
    // being true after the walk learns where to stop.
    const zone: ServedZone = {
      name: "example.com",
      serial: 1,
      records: [
        { name: "*.eu", type: "A", content: "203.0.113.7", ttl: 300 },
        { name: "*", type: "A", content: "203.0.113.99", ttl: 300 },
      ],
    };
    const { port } = await start({ zones: () => [zone] });

    const nearest = await ask(port, buildQuery("shop.eu.example.com"));
    assert.ok(nearest);
    assert.equal(rcodeOf(nearest), RCODE.NOERROR);
    assert.equal(readAnswers(nearest)[0]?.data.join("."), "203.0.113.7", "the nearer wildcard wins");

    // `shop.eu.example.com` does not exist, so the closest encloser of the name
    // below it is still `eu.example.com` -- the same wildcard covers it.
    const deeper = await ask(port, buildQuery("deep.shop.eu.example.com"));
    assert.ok(deeper);
    assert.equal(rcodeOf(deeper), RCODE.NOERROR);
    assert.equal(readAnswers(deeper)[0]?.data.join("."), "203.0.113.7");

    const apexLevel = await ask(port, buildQuery("other.example.com"));
    assert.ok(apexLevel);
    assert.equal(readAnswers(apexLevel)[0]?.data.join("."), "203.0.113.99", "and the apex wildcard still covers its own level");
  });

  /**
   * The answer path reads a per-snapshot index rather than scanning the records
   * on every query -- measured at 50,000 records, a wildcard miss went from
   * 9.879 ms to 0.047 ms, and the cost stopped growing with the zone.
   *
   * The index is keyed on the snapshot object, so it is only correct while a
   * snapshot is replaced rather than edited. `servedZones()` builds a new one
   * each refresh, which is what makes that safe; this pins the property so a
   * future in-place edit fails here instead of serving yesterday's answers.
   */
  it("answers from the snapshot it was last given, not the one it indexed first", async () => {
    let current: ServedZone = {
      name: "example.com",
      serial: 1,
      records: [{ name: "www", type: "A", content: "203.0.113.1", ttl: 300 }],
    };
    const { port } = await start({ zones: () => [current] });

    const before = await ask(port, buildQuery("www.example.com"));
    assert.ok(before);
    assert.equal(readAnswers(before)[0]?.data.join("."), "203.0.113.1");

    current = {
      name: "example.com",
      serial: 2,
      records: [
        { name: "www", type: "A", content: "203.0.113.2", ttl: 300 },
        { name: "new", type: "A", content: "203.0.113.3", ttl: 300 },
      ],
    };

    const after = await ask(port, buildQuery("www.example.com"));
    assert.ok(after);
    assert.equal(readAnswers(after)[0]?.data.join("."), "203.0.113.2", "the replaced record");
    const added = await ask(port, buildQuery("new.example.com"));
    assert.ok(added);
    assert.equal(readAnswers(added)[0]?.data.join("."), "203.0.113.3", "and the added one");

    const removed = await ask(port, buildQuery("gone.example.com"));
    assert.equal(rcodeOf(removed), RCODE.NXDOMAIN);
  });

  /**
   * A CNAME alone is a correct answer and the resolver would ask again for the
   * target. Following it here saves that round trip, which is what every other
   * authoritative server does -- and the target's records are ones this zone
   * already holds, so nothing is asserted that was not already ours.
   */
  describe("following a CNAME inside the zone", () => {
    const ALIASED: ServedZone = {
      name: "example.com",
      serial: 1,
      records: [
        { name: "shop", type: "CNAME", content: "front.example.com", ttl: 300 },
        { name: "front", type: "CNAME", content: "origin.example.com", ttl: 300 },
        { name: "origin", type: "A", content: "203.0.113.20", ttl: 300 },
        { name: "away", type: "CNAME", content: "elsewhere.example.net", ttl: 300 },
        { name: "loop", type: "CNAME", content: "loop.example.com", ttl: 300 },
        { name: "mail", type: "CNAME", content: "origin.example.com", ttl: 300 },
      ],
    };

    it("answers the chain and the address it ends at", async () => {
      const { port } = await start({ zones: () => [ALIASED] });
      const reply = await ask(port, buildQuery("shop.example.com"));
      assert.ok(reply);
      const answers = readAnswers(reply);

      assert.deepEqual(answers.map((record) => [record.name, record.type]), [
        ["shop.example.com", TYPE.CNAME],
        ["front.example.com", TYPE.CNAME],
        ["origin.example.com", TYPE.A],
      ]);
      assert.equal(answers.at(-1)?.data.join("."), "203.0.113.20");
    });

    it("stops at the edge of the zone", async () => {
      // The target belongs to whoever is authoritative for that name.
      const { port } = await start({ zones: () => [ALIASED] });
      const reply = await ask(port, buildQuery("away.example.com"));
      assert.ok(reply);
      assert.deepEqual(readAnswers(reply).map((record) => record.name), ["away.example.com"]);
    });

    it("does not spin on a zone that points at itself", async () => {
      const { port } = await start({ zones: () => [ALIASED] });
      const reply = await ask(port, buildQuery("loop.example.com"));
      assert.ok(reply);
      assert.equal(rcodeOf(reply), RCODE.NOERROR);
      assert.equal(readAnswers(reply).length, 1, "the CNAME itself, and no second visit");
    });

    it("returns the CNAME alone when the target holds nothing of that type", async () => {
      const { port } = await start({ zones: () => [ALIASED] });
      const reply = await ask(port, buildQuery("mail.example.com", TYPE.MX));
      assert.ok(reply);
      const answers = readAnswers(reply);
      assert.equal(answers.length, 1);
      assert.equal(answers[0]?.type, TYPE.CNAME);
    });

    it("still answers the CNAME itself when that is what was asked for", async () => {
      const { port } = await start({ zones: () => [ALIASED] });
      const reply = await ask(port, buildQuery("shop.example.com", TYPE.CNAME));
      assert.ok(reply);
      assert.deepEqual(readAnswers(reply).map((record) => record.name), ["shop.example.com"]);
    });
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

  it("parses bracketed IPv6 NOTIFY destinations with an optional port", async () => {
    const sent: Array<{ address: string; port: number }> = [];
    const zone = { ...EXAMPLE, serial: 12 };
    const { server } = await start({
      zones: () => [zone],
      notifyTo: ["[2001:db8::53]:5300", "[2001:db8::54]", "2001:db8::55"],
      sendNotify: async (_packet, address, port) => { sent.push({ address, port }); },
    });
    await server.notifyChanged(new Map([["example.com", 11]]), [{ ...zone, serial: 12 }]);
    assert.deepEqual(sent, [
      { address: "2001:db8::53", port: 5300 },
      { address: "2001:db8::54", port: 53 },
      { address: "2001:db8::55", port: 53 },
    ]);
  });

  /**
   * ⚠️ These assert against this build's own signer, which is the weaker half
   * of the evidence. The stronger half was measured against BIND 9.10.6's
   * `dig -y ... AXFR` on 2026-08-24: a 2,500-record zone transferred across two
   * messages, 81,833 bytes, with no verification warning -- and, as the control,
   * breaking the envelope chain produced `tsig verify failure` from the same
   * client. `dig` is not assumed present in CI, so what is pinned here is the
   * behaviour that measurement confirmed.
   */
  describe("TSIG", () => {
    const SECRET = Buffer.alloc(32, 5).toString("base64");
    const KEY = parseTsigKey(`transfer.key:hmac-sha256:${SECRET}`, "TEST");

    it("requires a signature for AXFR once a key is configured", async () => {
      const { port } = await start({ zones: () => [EXAMPLE], transferAllow: ["127.0.0.0/8"], tsigKeys: [KEY] });
      const reply = await askOverTcp(port, buildQuery("example.com", TYPE.AXFR));
      // NOTAUTH, not REFUSED: the allowlist let this client through and the
      // credential is what was missing.
      assert.equal(rcodeOf(reply), RCODE.NOTAUTH);
      assert.equal(readAnswers(reply).length, 0);
    });

    it("transfers a signed AXFR and chains the signature across every message", async () => {
      const size = 2_500;
      const huge: ServedZone = {
        name: "example.com",
        serial: 1,
        records: Array.from({ length: size }, (_unused, index) => ({
          name: `host-with-a-longish-label-${index}`, type: "A" as const, content: "203.0.113.5", ttl: 300,
        })),
      };
      const { port } = await start({ zones: () => [huge], transferAllow: ["127.0.0.0/8"], tsigKeys: [KEY] });
      const request = signRequest(buildQuery("example.com", TYPE.AXFR), KEY);
      const messages = await askAllOverTcp(port, request.message);
      assert.ok(messages.length > 1, `a zone this size needs more than one message, got ${messages.length}`);

      let previous = request.mac;
      for (const [index, reply] of messages.entries()) {
        // Every frame still fits, signature included -- the reservation, not
        // an accident of this zone's size.
        assert.ok(reply.length <= 0xffff, `message ${index} is ${reply.length} bytes`);
        const record = readTsig(reply);
        assert.ok(record, `message ${index} carries no signature`);
        const prior = { mac: previous, ...(index === 0 ? {} : { envelope: true }) };
        assert.equal(verifyTsig(reply, record, [KEY], undefined, prior).kind, "ok", `message ${index} did not verify`);
        // The chain: the same message checked against the wrong predecessor
        // must fail, or the ordering is not actually asserted by the MAC.
        const misordered = verifyTsig(reply, record, [KEY], undefined, { ...prior, mac: Buffer.alloc(previous.length) });
        assert.equal(misordered.kind === "rejected" && misordered.error, TSIG_ERROR.BADSIG);
        previous = record.mac;
      }
      assert.equal(readAnswers(messages[0] as Buffer)[0]?.type, TYPE.SOA);
    });

    it("names the reason a signature was refused without leaking the key", async () => {
      const rejected: { client: string; keyName: string; reason: string }[] = [];
      const { port } = await start({
        zones: () => [EXAMPLE],
        transferAllow: ["127.0.0.0/8"],
        tsigKeys: [KEY],
        onSignatureRejected: (detail) => rejected.push(detail),
      });
      const wrong = signRequest(buildQuery("example.com", TYPE.AXFR), { ...KEY, secret: Buffer.alloc(32, 6) });
      const reply = await askOverTcp(port, wrong.message);
      assert.equal(rcodeOf(reply), RCODE.NOTAUTH);
      // The refusal is itself a TSIG record, carrying the extended error, so
      // the peer learns which of the three went wrong.
      const record = readTsig(reply);
      assert.ok(record);
      assert.equal(record.error, TSIG_ERROR.BADSIG);
      assert.equal(record.mac.length, 0, "a message this end could not verify is not signed back");
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0]?.keyName, "transfer.key");
      assert.equal(rejected[0]?.client, "127.0.0.1");
      assert.ok(!JSON.stringify(rejected).includes(SECRET.slice(0, 12)));

      const unknown = signRequest(buildQuery("example.com", TYPE.AXFR), { ...KEY, name: "nobody.key" });
      const second = readTsig(await askOverTcp(port, unknown.message));
      assert.ok(second);
      assert.equal(second.error, TSIG_ERROR.BADKEY);
    });

    it("answers an ordinary signed query, signed", async () => {
      const { port } = await start({ zones: () => [EXAMPLE], tsigKeys: [KEY] });
      const request = signRequest(buildQuery("www.example.com", TYPE.A), KEY);
      const reply = await askOverTcp(port, request.message);
      const record = readTsig(reply);
      assert.ok(record, "a signed question is answered signed");
      assert.equal(verifyTsig(reply, record, [KEY], undefined, { mac: request.mac }).kind, "ok");
      // The binding is real: the same reply does not verify against another
      // question's signature.
      const elsewhere = verifyTsig(reply, record, [KEY], undefined, { mac: Buffer.alloc(request.mac.length) });
      assert.equal(elsewhere.kind === "rejected" && elsewhere.error, TSIG_ERROR.BADSIG);
      assert.equal(readAnswers(reply).filter((answer) => answer.type === TYPE.A).length, 2);
    });

    it("does not relay a signed question to an upstream that cannot hold the key", async () => {
      const { socket: upstream, port: upstreamPort } = await upstreamOn();
      let receivedQueries = 0;
      upstream.on("message", () => { receivedQueries += 1; });
      closers.push(async () => { upstream.close(); });
      const { port } = await start({
        zones: () => [EXAMPLE],
        forwardTo: [`127.0.0.1#${upstreamPort}`],
        forwardAllow: ["127.0.0.0/8"],
        tsigKeys: [KEY],
      });
      const request = signRequest(buildQuery("outside.example", TYPE.A), KEY);
      assert.equal(rcodeOf(await askOverTcp(port, request.message)), RCODE.REFUSED);
      assert.equal(receivedQueries, 0, "our peer's credential does not go to a stranger");
    });

    it("signs NOTIFY with the key the destination names, and sends none it cannot", async () => {
      const rejected: { keyName: string }[] = [];
      const sent: Array<{ packet: Buffer; address: string }> = [];
      const zone = { ...EXAMPLE, serial: 12 };
      const { server } = await start({
        zones: () => [zone],
        tsigKeys: [KEY],
        notifyTo: ["10.0.0.2:5300#transfer.key", "10.0.0.3", "10.0.0.4#absent.key"],
        onSignatureRejected: (detail) => rejected.push(detail),
        sendNotify: async (packet, address) => { sent.push({ packet, address }); },
      });
      await server.notifyChanged(new Map([["example.com", 11]]), [{ ...zone, serial: 12 }]);

      assert.deepEqual(sent.map((one) => one.address), ["10.0.0.2", "10.0.0.3"]);
      const signed = readTsig(sent[0]?.packet as Buffer);
      assert.ok(signed);
      assert.equal(verifyTsig(sent[0]?.packet as Buffer, signed, [KEY]).kind, "ok");
      // A destination that named no key is sent as it always was.
      assert.equal(readTsig(sent[1]?.packet as Buffer), undefined);
      // ...and one that named a key nobody holds is not sent unsigned instead.
      assert.deepEqual(rejected.map((one) => one.keyName), ["absent.key"]);
    });

    it("reads a key name off a destination without swallowing the port", () => {
      assert.deepEqual(parseNotifyDestination("10.0.0.2:5300#a.key"), { address: "10.0.0.2", port: 5300, keyName: "a.key" });
      assert.deepEqual(parseNotifyDestination("[2001:db8::53]:5300#A.Key."), { address: "2001:db8::53", port: 5300, keyName: "a.key" });
      assert.deepEqual(parseNotifyDestination("10.0.0.2"), { address: "10.0.0.2", port: 53 });
      // A trailing `#` names nothing, so it is not a key selector.
      assert.deepEqual(parseNotifyDestination("10.0.0.2#"), { address: "10.0.0.2", port: 53 });
    });
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

  it("closes a client that trickles an incomplete TCP DNS frame", async () => {
    const { port } = await start({
      zones: () => [EXAMPLE],
      tcpIdleTimeoutMs: 200,
      tcpIncompleteFrameTimeoutMs: 40,
    });
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.on("error", () => undefined);
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(buildQuery("www.example.com").length, 0);
    socket.write(prefix);
    const drip = setInterval(() => { if (!socket.destroyed) socket.write(Buffer.of(0)); }, 10);
    try {
      await Promise.race([
        new Promise<void>((resolve) => socket.once("close", resolve)),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("slow-drip DNS TCP socket stayed open")), 300)),
      ]);
    } finally {
      clearInterval(drip);
      socket.destroy();
    }
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

  describe("messages that are not standard IN queries", () => {
    /**
     * The header used to be read for its id and its RD bit and nothing else.
     * A message whose opcode says UPDATE has a question-shaped first section,
     * so it parsed, was answered as a question, and had its opcode echoed back
     * -- which tells the sender the operation was understood.
     */
    for (const [name, opcode] of [["UPDATE", 5], ["NOTIFY", 4], ["STATUS", 2]] as const) {
      it(`answers NOTIMP to an opcode ${name} message`, async () => {
        const { port } = await start({ zones: () => [EXAMPLE] });
        const query = buildQuery("www.example.com");
        query.writeUInt16BE(query.readUInt16BE(2) | (opcode << 11), 2);
        assert.equal(rcodeOf(received(await ask(port, query))), RCODE.NOTIMP);
      });
    }

    /**
     * BADVERS is 16, and an rcode is four bits in the header. The top eight
     * live in the OPT record's TTL field, so this could not be said at all
     * until the writer learned to put them there.
     */
    it("tells a client asking for a later EDNS version which one it speaks", async () => {
      const { port } = await start({ zones: () => [EXAMPLE] });
      const query = buildQuery("www.example.com");
      // One OPT record claiming EDNS version 1.
      const opt = Buffer.alloc(11);
      opt.writeUInt8(0, 0);
      opt.writeUInt16BE(TYPE.OPT, 1);
      opt.writeUInt16BE(4096, 3);
      opt.writeUInt8(1, 5);
      const withOpt = Buffer.concat([query, opt]);
      withOpt.writeUInt16BE(1, 10);

      const reply = received(await ask(port, withOpt));
      // The header's four bits are the low half; the OPT record carries the
      // rest, and 16 is entirely in that upper half.
      assert.equal(rcodeOf(reply), 0);
      const extended = reply.readUInt8(reply.length - 6);
      assert.equal((extended << 4) | rcodeOf(reply), RCODE.BADVERS);
      assert.equal(reply.readUInt16BE(6), 0, "a BADVERS reply carries no answer");
    });

    it("answers a client speaking the EDNS version it knows", async () => {
      const { port } = await start({ zones: () => [EXAMPLE] });
      const query = buildQuery("www.example.com");
      const opt = Buffer.alloc(11);
      opt.writeUInt8(0, 0);
      opt.writeUInt16BE(TYPE.OPT, 1);
      opt.writeUInt16BE(4096, 3);
      const withOpt = Buffer.concat([query, opt]);
      withOpt.writeUInt16BE(1, 10);

      const reply = received(await ask(port, withOpt));
      assert.equal(rcodeOf(reply), RCODE.NOERROR);
      assert.equal(reply.readUInt8(reply.length - 6), 0, "no extended rcode on a normal answer");
      assert.ok(reply.readUInt16BE(6) > 0);
    });

    /**
     * EDNS cookies (RFC 7873) are how a UDP server tells a client that really
     * is at the address it claims from one that is not. Measured motivation:
     * a 44-byte question here draws a 3944-byte answer, and a forged source
     * address makes that somebody else's problem.
     */
    describe("EDNS cookies", () => {
      const CLIENT_COOKIE = Buffer.from("0102030405060708", "hex");

      function withCookie(name: string, cookie: Buffer): Buffer {
        const query = buildQuery(name);
        const option = Buffer.alloc(4);
        option.writeUInt16BE(10, 0);
        option.writeUInt16BE(cookie.length, 2);
        const opt = Buffer.alloc(11);
        opt.writeUInt8(0, 0);
        opt.writeUInt16BE(TYPE.OPT, 1);
        opt.writeUInt16BE(4096, 3);
        opt.writeUInt16BE(option.length + cookie.length, 9);
        const built = Buffer.concat([query, opt, option, cookie]);
        built.writeUInt16BE(1, 10);
        return built;
      }

      /**
       * The COOKIE option's value out of a reply's OPT record, read rather than
       * assumed: root name (one zero byte), type 41, then the record header and
       * a run of `code, length, value` options.
       */
      function cookieOf(reply: Buffer): Buffer {
        for (let index = reply.length - 11; index >= 12; index -= 1) {
          if (reply[index] !== 0 || reply.readUInt16BE(index + 1) !== TYPE.OPT) continue;
          const rdataEnd = index + 11 + reply.readUInt16BE(index + 9);
          let option = index + 11;
          while (option + 4 <= rdataEnd) {
            const code = reply.readUInt16BE(option);
            const length = reply.readUInt16BE(option + 2);
            if (code === 10) return reply.subarray(option + 4, option + 4 + length);
            option += 4 + length;
          }
          return Buffer.alloc(0);
        }
        return Buffer.alloc(0);
      }

      it("answers a cookie-sending client with its own cookie plus a server cookie", async () => {
        const { port } = await start({ zones: () => [EXAMPLE], cookieSecret: Buffer.alloc(32, 7) });
        const reply = received(await ask(port, withCookie("www.example.com", CLIENT_COOKIE)));
        assert.equal(rcodeOf(reply), RCODE.NOERROR);
        const returned = cookieOf(reply);
        assert.equal(returned.length, 24, "8 bytes of client cookie and 16 of server cookie");
        assert.deepEqual([...returned.subarray(0, 8)], [...CLIENT_COOKIE], "the client's own bytes come back");
        // RFC 9018 §4.3: version, three reserved bytes, then a timestamp.
        assert.equal(returned.readUInt8(8), 1, "version 1");
        assert.deepEqual([...returned.subarray(9, 12)], [0, 0, 0], "reserved bytes stay zero");
        const stamped = returned.readUInt32BE(12);
        assert.ok(Math.abs(stamped - Math.floor(Date.now() / 1000)) < 60, `stamped now, got ${stamped}`);
      });

      /**
       * A cookie used to be good for the life of the process, which made it a
       * permanent key to the address it names: anybody who had ever held one
       * could go on spoofing that address past `requireCookie` indefinitely.
       */
      it("stops accepting a server cookie once it is older than the window", async () => {
        let clock = Date.UTC(2026, 0, 1, 12, 0, 0);
        const secret = Buffer.alloc(32, 9);
        const { port } = await start({
          zones: () => [EXAMPLE], requireCookie: true, cookieSecret: secret, now: () => clock,
        });

        const issued = cookieOf(received(await ask(port, withCookie("www.example.com", CLIENT_COOKIE))));
        const proven = received(await ask(port, withCookie("www.example.com", issued)));
        assert.equal((proven.readUInt16BE(2) & 0x0200) >> 9, 0, "accepted while fresh");

        clock += 3_601_000;
        const stale = received(await ask(port, withCookie("www.example.com", issued)));
        assert.equal((stale.readUInt16BE(2) & 0x0200) >> 9, 1, "past an hour it proves nothing");

        // And the reply still carries a freshly stamped one, so the client
        // recovers on its next query rather than being locked out.
        const renewed = cookieOf(stale);
        assert.equal(renewed.readUInt32BE(12), Math.floor(clock / 1000));
        const again = received(await ask(port, withCookie("www.example.com", renewed)));
        assert.equal((again.readUInt16BE(2) & 0x0200) >> 9, 0, "proven again with the new one");
      });

      it("refuses a cookie stamped further ahead than a clock could plausibly be", async () => {
        let clock = Date.UTC(2026, 0, 1, 12, 0, 0);
        const secret = Buffer.alloc(32, 9);
        const { port } = await start({
          zones: () => [EXAMPLE], requireCookie: true, cookieSecret: secret, now: () => clock,
        });
        const future = cookieOf(received(await ask(port, withCookie("www.example.com", CLIENT_COOKIE))));

        clock -= 600_000;
        const reply = received(await ask(port, withCookie("www.example.com", future)));
        assert.equal((reply.readUInt16BE(2) & 0x0200) >> 9, 1, "ten minutes ahead is beyond the allowed skew");
      });

      it("does not accept a cookie minted for a different address", async () => {
        // The hash covers the address, so a cookie lifted from one client
        // proves nothing for another. This is the property the whole scheme
        // exists for, and the timestamp must not have displaced it.
        const secret = Buffer.alloc(32, 9);
        const { port } = await start({ zones: () => [EXAMPLE], requireCookie: true, cookieSecret: secret });
        const mine = cookieOf(received(await ask(port, withCookie("www.example.com", CLIENT_COOKIE))));

        const tampered = Buffer.from(mine);
        tampered.writeUInt8(tampered.readUInt8(20) ^ 0xff, 20);
        const reply = received(await ask(port, withCookie("www.example.com", tampered)));
        assert.equal((reply.readUInt16BE(2) & 0x0200) >> 9, 1, "a forged hash proves nothing");
      });

      it("leaves a client that sends no cookie exactly as it was", async () => {
        // Most resolvers do not implement RFC 7873. They must not notice this.
        const { port } = await start({ zones: () => [EXAMPLE], cookieSecret: Buffer.alloc(32, 7) });
        const reply = received(await ask(port, buildQuery("www.example.com")));
        assert.equal(rcodeOf(reply), RCODE.NOERROR);
        assert.ok(reply.readUInt16BE(6) > 0, "answered normally");
      });

      it("answers FORMERR to a cookie that is not one", async () => {
        const { port } = await start({ zones: () => [EXAMPLE] });
        const reply = received(await ask(port, withCookie("www.example.com", Buffer.alloc(3))));
        assert.equal(rcodeOf(reply), RCODE.FORMERR);
      });

      it("truncates an unproven UDP client only where the deployment asked", async () => {
        const secret = Buffer.alloc(32, 9);
        const { port } = await start({ zones: () => [EXAMPLE], requireCookie: true, cookieSecret: secret });

        // First query: the client has no server cookie yet, so it is unproven.
        const first = received(await ask(port, withCookie("www.example.com", CLIENT_COOKIE)));
        assert.equal((first.readUInt16BE(2) & 0x0200) >> 9, 1, "TC set");
        assert.equal(first.readUInt16BE(6), 0, "and nothing to amplify");

        // It returns the server cookie it was just given, and is now proven.
        const proven = received(await ask(port, withCookie("www.example.com", cookieOf(first))));
        assert.equal((proven.readUInt16BE(2) & 0x0200) >> 9, 0, "not truncated");
        assert.ok(proven.readUInt16BE(6) > 0, "answered in full");
      });

      it("does not truncate a proven client over TCP either way", async () => {
        const { port } = await start({ zones: () => [EXAMPLE], requireCookie: true, cookieSecret: Buffer.alloc(32, 9) });
        // TCP already proves the address; requiring a cookie there would cost a
        // round trip for a fact the handshake has established.
        const reply = received(await askOverTcp(port, buildQuery("www.example.com")));
        assert.ok(reply.readUInt16BE(6) > 0);
      });
    });

    /**
     * MNAME is where a secondary asks for updates and sends them. It used to be
     * `ns.<zone>` unconditionally -- written in because every zone has an apex,
     * not because that name exists. A zone with secondaries needs to name one
     * that does.
     */
    describe("the synthesized SOA", () => {
      /** MNAME and RNAME, read back off the wire as two consecutive names. */
      function soaNamesOf(reply: Buffer): [string, string] {
        const answers = readAnswers(reply);
        const data = answers[0]?.data as Buffer;
        const first = readName(data, 0);
        const second = readName(data, first.offset);
        return [first.name, second.name];
      }

      it("derives a primary from the zone when nothing names one", async () => {
        const { port } = await start({ zones: () => [EXAMPLE] });
        const reply = received(await ask(port, buildQuery("example.com", TYPE.SOA)));
        assert.deepEqual(soaNamesOf(reply), ["ns.example.com", "hostmaster.example.com"]);
      });

      it("uses the names the deployment gave", async () => {
        const { port } = await start({
          zones: () => [EXAMPLE],
          soa: { primary: "ns1.real.example", mailbox: "dns.real.example" },
        });
        const reply = received(await ask(port, buildQuery("example.com", TYPE.SOA)));
        assert.deepEqual(soaNamesOf(reply), ["ns1.real.example", "dns.real.example"]);
      });

      it("carries the timers a secondary reads", async () => {
        const { port } = await start({
          zones: () => [EXAMPLE],
          soa: { timers: { refresh: 120, retry: 30, expire: 1_209_600 } },
        });
        const reply = received(await ask(port, buildQuery("example.com", TYPE.SOA)));
        const data = readAnswers(reply)[0]?.data as Buffer;
        const numbers = data.subarray(data.length - 20);
        assert.equal(numbers.readUInt32BE(4), 120, "refresh");
        assert.equal(numbers.readUInt32BE(8), 30, "retry");
        assert.equal(numbers.readUInt32BE(12), 1_209_600, "expire");
      });
    });

    it("refuses a non-IN question about a name it is authoritative for", async () => {
      // Every record here is IN, and `writeRecord` writes IN regardless of what
      // was asked -- so answering a CHAOS question meant replying to a question
      // nobody asked.
      const { port } = await start({ zones: () => [EXAMPLE] });
      const query = buildQuery("www.example.com");
      query.writeUInt16BE(3, query.length - 2); // QCLASS CHAOS
      assert.equal(rcodeOf(received(await ask(port, query))), RCODE.REFUSED);
    });

    it("still forwards a non-IN question about a name that is not its own", async () => {
      // `version.bind` CHAOS TXT is an ordinary thing to ask a resolver, and
      // this process is also a resolver. Refusing non-IN before the forwarding
      // decision would have made it answer for names it has no business in.
      const { socket: upstream, port: upstreamPort } = await upstreamOn();
      upstream.on("message", (message, remote) => {
        const reply = Buffer.from(message);
        reply.writeUInt16BE(0x8180, 2);
        upstream.send(Buffer.concat([reply, Buffer.of(0xc4, 0x05)]), remote.port, remote.address);
      });
      closers.push(async () => { upstream.close(); });

      const { port } = await start({ zones: () => [EXAMPLE], forwardTo: [`127.0.0.1#${upstreamPort}`] });
      const query = buildQuery("version.bind", TYPE.TXT);
      query.writeUInt16BE(3, query.length - 2); // QCLASS CHAOS
      const reply = received(await ask(port, query));
      assert.equal(reply.subarray(-2).toString("hex"), "c405", "the upstream answered, not this process");
    });
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

  it("answers SERVFAIL, and says which record, for RDATA the wire cannot carry", async () => {
    // Measured, not supposed: this query used to get no reply at all. The
    // content encodes, so the per-record guard above let it through; the throw
    // came later, in `writeRecord`, where RDLENGTH is written into a uint16.
    // Past every guard, the exception reached the socket handler, which drops
    // the datagram -- so the name went dark and nothing was logged.
    //
    // The zone is built here rather than through `createDesiredRecord`, which
    // now refuses this content on the way in. Going through it would make this
    // test prove the first defence twice and never reach the second.
    const unservable: UnservableRecord[] = [];
    const oversized: ServedZone = {
      name: "example.com",
      serial: 1,
      records: [{ name: "key", type: "OPENPGPKEY", content: "a".repeat(90_000), ttl: 60 }],
    };
    const { port } = await start({
      zones: () => [oversized],
      onUnservable: (record) => unservable.push(record),
    });
    const reply = received(await ask(port, buildQuery("key.example.com", TYPE.OPENPGPKEY)));
    assert.equal(rcodeOf(reply), RCODE.SERVFAIL);
    assert.equal(unservable.length, 1);
    assert.equal(unservable[0]?.name, "key");
    assert.equal(unservable[0]?.type, "OPENPGPKEY");
    assert.match(unservable[0]?.reason ?? "", /cannot carry more than 65535/u);
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
      socket.on("data", (request: Buffer) => {
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
        { name: "inside", type: "A", content: "10.0.0.11", ttl: 60 },
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
          ? { ...record, managedBy: { service: "worker" as const, resource: "example-dashboard" } }
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
      assert.deepEqual(readAnswers(reply).map((record) => [...record.data]), [[10, 0, 0, 11]]);
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
