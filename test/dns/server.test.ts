import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { connect, createServer, type AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { createDnsServer, type ServedZone, type UnservableRecord } from "../../src/dns/server.ts";
import { RCODE, TYPE, readName } from "../../src/dns/wire.ts";

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
function received(reply: Buffer | undefined): Buffer {
  assert.ok(reply, "no reply arrived");
  return reply;
}

function rcodeOf(reply: Buffer | undefined): number {
  return received(reply).readUInt16BE(2) & 0x000f;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function ask(port: number, message: Buffer, timeoutMs = 2000): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const done = (value: Buffer | undefined): void => { clearTimeout(timer); socket.close(); resolve(value); };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    socket.once("message", (reply) => done(reply));
    socket.once("error", () => done(undefined));
    socket.send(message, port, "127.0.0.1");
  });
}

/** Sends over TCP, optionally in pieces, to exercise the length-prefix framing. */
function askOverTcp(port: number, message: Buffer, split = false): Promise<Buffer> {
  const framed = Buffer.concat([Buffer.alloc(2), message]);
  framed.writeUInt16BE(message.length, 0);
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
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
  after(async () => { for (const close of closers) await close().catch(() => undefined); });

  async function start(options: Partial<Parameters<typeof createDnsServer>[0]> & { zones: () => readonly ServedZone[] }) {
    const port = await freePort();
    const server = createDnsServer(options);
    await server.listen(port, "127.0.0.1");
    closers.push(() => server.close());
    return { port, server };
  }

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

  it("reassembles a TCP message that arrives in pieces", async () => {
    const { port } = await start({ zones: () => [EXAMPLE] });
    const reply = await askOverTcp(port, buildQuery("www.example.com"), true);
    assert.equal(readAnswers(reply).length, 2);
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
    const upstreamPort = await freePort();
    const upstream = createSocket("udp4");
    await new Promise<void>((resolve) => upstream.bind(upstreamPort, "127.0.0.1", resolve));
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
    const upstreamPort = await freePort();
    const big = Buffer.alloc(1200, 0x41);
    const overUdp: number[] = [];
    const udpUpstream = createSocket("udp4");
    await new Promise<void>((resolve) => udpUpstream.bind(upstreamPort, "127.0.0.1", resolve));
    udpUpstream.on("message", (message, remote) => {
      overUdp.push(1);
      const truncated = Buffer.from(message.subarray(0, 12));
      truncated.writeUInt16BE(0x8380, 2);
      udpUpstream.send(truncated, remote.port, remote.address);
    });
    const tcpUpstream = createServer((socket) => {
      socket.on("data", () => {
        const framed = Buffer.alloc(2 + big.length);
        framed.writeUInt16BE(big.length, 0);
        big.copy(framed, 2);
        socket.write(framed);
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
});
