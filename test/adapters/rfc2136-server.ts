import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { describe, it } from "node:test";
import { exchange, writeQuestion } from "../../src/dns/client.ts";
import { parseTsigKey, readTsig, signReply, signRequest, verifyTsig, type TsigKey } from "../../src/dns/tsig.ts";
import { CLASS_IN, RCODE, TYPE, readName, writeName } from "../../src/dns/wire.ts";

/**
 * Just enough of a primary to hold the RFC 2136 adapter to account: TSIG on
 * every message, AXFR, one-name queries, and an update section applied as a
 * unit or not at all.
 *
 * A real BIND would be better evidence and cannot run in CI, so this is
 * deliberately written from the specification rather than from the adapter --
 * it parses what arrives instead of expecting a shape, and refuses what the
 * specification says to refuse. Where the two could agree on something wrong,
 * the note says so.
 */

export interface FakeRecord {
  /** Absolute, lowercased, no trailing dot. */
  name: string;
  type: number;
  ttl: number;
  rdata: Buffer;
}

const CLASS_NONE = 254;
const CLASS_ANY = 255;
const RCODE_NXRRSET = 8;
const RCODE_NOTAUTH = 9;

export interface FakePrimary {
  readonly port: number;
  readonly records: FakeRecord[];
  /** Every update this server accepted, for tests that care how it was asked. */
  readonly updates: number;
  close(): Promise<void>;
}

export async function startFakePrimary(options: { zone: string; key: TsigKey; records?: FakeRecord[] }): Promise<FakePrimary> {
  const records: FakeRecord[] = [...options.records ?? []];
  let updates = 0;
  const soa: FakeRecord = {
    name: options.zone,
    type: TYPE.SOA,
    ttl: 3600,
    rdata: Buffer.concat([
      writeName(`ns.${options.zone}`), writeName(`hostmaster.${options.zone}`),
      (() => { const numbers = Buffer.alloc(20); numbers.writeUInt32BE(1, 0); return numbers; })(),
    ]),
  };

  const server: Server = createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 2) return;
        const length = buffered.readUInt16BE(0);
        if (buffered.length < 2 + length) return;
        const message = Buffer.from(buffered.subarray(2, 2 + length));
        buffered = buffered.subarray(2 + length);
        for (const reply of handle(message)) {
          const framed = Buffer.alloc(2 + reply.length);
          framed.writeUInt16BE(reply.length, 0);
          reply.copy(framed, 2);
          socket.write(framed);
        }
      }
    });
    socket.on("error", () => undefined);
  });

  function handle(message: Buffer): Buffer[] {
    // Unsigned is not answered at all: this server exists to prove the adapter
    // signs, and a fallback would let it stop signing without a test noticing.
    const tsig = readTsig(message);
    if (!tsig) return [reply(message, RCODE_NOTAUTH, [])];
    const verdict = verifyTsig(message, tsig, [options.key]);
    if (verdict.kind !== "ok") return [reply(message, RCODE_NOTAUTH, [])];

    const parsed = parseMessage(message, tsig.offset);
    const opcode = (message.readUInt16BE(2) >> 11) & 0xf;
    if (opcode === 5) {
      const rcode = applyUpdate(parsed);
      if (rcode === RCODE.NOERROR) updates += 1;
      return [sign(reply(message, rcode, []), verdict.mac)];
    }
    const question = parsed.question;
    if (!question) return [sign(reply(message, RCODE.FORMERR, []), verdict.mac)];
    if (question.type === TYPE.AXFR) {
      return [sign(reply(message, RCODE.NOERROR, [soa, ...records, soa]), verdict.mac)];
    }
    const matched = records.filter((record) => record.name === question.name && record.type === question.type);
    // Nothing at the name at all is NXDOMAIN; nothing of this type is an empty
    // NOERROR. The adapter reads the difference, so this must not flatten it.
    const nameExists = records.some((record) => record.name === question.name);
    const rcode = matched.length === 0 && !nameExists ? RCODE.NXDOMAIN : RCODE.NOERROR;
    return [sign(reply(message, rcode, matched), verdict.mac)];
  }

  function applyUpdate(parsed: ParsedMessage): number {
    // RFC 2136 §3.2: every prerequisite is checked before anything is changed.
    for (const prerequisite of parsed.prerequisites) {
      if (prerequisite.klass !== CLASS_IN) return RCODE.NOTIMP;
      const present = records.some((record) =>
        record.name === prerequisite.name && record.type === prerequisite.type && record.rdata.equals(prerequisite.rdata));
      if (!present) return RCODE_NXRRSET;
    }
    for (const update of parsed.updates) {
      if (update.klass === CLASS_IN) {
        const already = records.some((record) =>
          record.name === update.name && record.type === update.type && record.rdata.equals(update.rdata));
        if (!already) records.push({ name: update.name, type: update.type, ttl: update.ttl, rdata: update.rdata });
        continue;
      }
      if (update.klass === CLASS_NONE) {
        const index = records.findIndex((record) =>
          record.name === update.name && record.type === update.type && record.rdata.equals(update.rdata));
        if (index >= 0) records.splice(index, 1);
        continue;
      }
      if (update.klass === CLASS_ANY) {
        for (let index = records.length - 1; index >= 0; index -= 1) {
          const record = records[index];
          if (record && record.name === update.name && (update.type === TYPE.ANY || record.type === update.type)) records.splice(index, 1);
        }
        continue;
      }
      return RCODE.FORMERR;
    }
    return RCODE.NOERROR;
  }

  function sign(message: Buffer, requestMac: Buffer): Buffer {
    return signReply(message, options.key, requestMac).message;
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    records,
    get updates() { return updates; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

// ------------------------------------------------------------------ parsing --

interface ParsedRecord {
  name: string;
  type: number;
  klass: number;
  ttl: number;
  rdata: Buffer;
}

interface ParsedMessage {
  question?: { name: string; type: number };
  prerequisites: ParsedRecord[];
  updates: ParsedRecord[];
}

function parseMessage(message: Buffer, end: number): ParsedMessage {
  const counts = [message.readUInt16BE(4), message.readUInt16BE(6), message.readUInt16BE(8)];
  let offset = 12;
  let question: { name: string; type: number } | undefined;
  for (let index = 0; index < (counts[0] as number); index += 1) {
    const owner = readName(message, offset);
    question = { name: owner.name, type: message.readUInt16BE(owner.offset) };
    offset = owner.offset + 4;
  }
  const read = (count: number): ParsedRecord[] => {
    const out: ParsedRecord[] = [];
    for (let index = 0; index < count && offset < end; index += 1) {
      const owner = readName(message, offset);
      offset = owner.offset;
      const type = message.readUInt16BE(offset);
      const klass = message.readUInt16BE(offset + 2);
      const ttl = message.readUInt32BE(offset + 4);
      const length = message.readUInt16BE(offset + 8);
      out.push({ name: owner.name, type, klass, ttl, rdata: Buffer.from(message.subarray(offset + 10, offset + 10 + length)) });
      offset += 10 + length;
    }
    return out;
  };
  return { ...(question ? { question } : {}), prerequisites: read(counts[1] as number), updates: read(counts[2] as number) };
}

function reply(request: Buffer, rcode: number, answers: readonly FakeRecord[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(request.readUInt16BE(0), 0);
  header.writeUInt16BE((request.readUInt16BE(2) & 0x7800) | 0x8400 | rcode, 2);
  const questionEnd = request.readUInt16BE(4) > 0 ? readName(request, 12).offset + 4 : 12;
  const question = request.subarray(12, questionEnd);
  header.writeUInt16BE(request.readUInt16BE(4), 4);
  header.writeUInt16BE(answers.length, 6);
  const encoded = answers.map((record) => {
    const head = Buffer.alloc(10);
    head.writeUInt16BE(record.type, 0);
    head.writeUInt16BE(CLASS_IN, 2);
    head.writeUInt32BE(record.ttl, 4);
    head.writeUInt16BE(record.rdata.length, 8);
    return Buffer.concat([writeName(record.name), head, record.rdata]);
  });
  return Buffer.concat([header, question, ...encoded]);
}

/**
 * The fake's own guarantees, because several adapter tests are vacuous without
 * them.
 *
 * If this server accepted an unsigned message, "the adapter signs everything"
 * would pass whether or not it signed. If it ignored prerequisites, "refuses to
 * change a record whose marker has gone" would pass on an adapter that sent no
 * prerequisite at all. A test double that is more permissive than the thing it
 * stands in for does not stand in for it -- the same finding the provider
 * contract turned up about the in-memory provider.
 */
describe("the fake primary refuses what a real one would", () => {
  const key = parseTsigKey(`update.key:hmac-sha256:${Buffer.alloc(32, 3).toString("base64")}`, "SELF-TEST");

  async function ask(primary: FakePrimary, message: Buffer): Promise<Buffer> {
    const [reply] = await exchange({ host: "127.0.0.1", port: primary.port, timeoutMs: 5_000 }, message, "one");
    assert.ok(reply);
    return reply;
  }

  it("answers NOTAUTH to a message carrying no signature at all", async () => {
    const primary = await startFakePrimary({ zone: "example.com", key });
    try {
      const reply = await ask(primary, writeQuestion("example.com", TYPE.AXFR, 1));
      assert.equal(reply.readUInt16BE(2) & 0xf, RCODE_NOTAUTH);
    } finally {
      await primary.close();
    }
  });

  it("answers NOTAUTH to a signature made with another key", async () => {
    const primary = await startFakePrimary({ zone: "example.com", key });
    try {
      const forged = signRequest(writeQuestion("example.com", TYPE.AXFR, 2), { ...key, secret: Buffer.alloc(32, 9) });
      const reply = await ask(primary, forged.message);
      assert.equal(reply.readUInt16BE(2) & 0xf, RCODE_NOTAUTH);
    } finally {
      await primary.close();
    }
  });

  it("applies nothing when a prerequisite is not met", async () => {
    const primary = await startFakePrimary({ zone: "example.com", key });
    try {
      // One prerequisite that cannot hold, and one addition that must therefore
      // not happen.
      const absent = record("absent.example.com", TYPE.TXT, CLASS_IN, 0, Buffer.of(1, 0x78));
      const addition = record("new.example.com", TYPE.TXT, CLASS_IN, 60, Buffer.of(1, 0x79));
      const header = Buffer.alloc(12);
      header.writeUInt16BE(3, 0);
      header.writeUInt16BE(5 << 11, 2);
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(1, 6);
      header.writeUInt16BE(1, 8);
      const question = Buffer.alloc(4);
      question.writeUInt16BE(TYPE.SOA, 0);
      question.writeUInt16BE(CLASS_IN, 2);
      const update = Buffer.concat([header, writeName("example.com"), question, absent, addition]);

      const reply = await ask(primary, signRequest(update, key).message);
      assert.equal(reply.readUInt16BE(2) & 0xf, RCODE_NXRRSET);
      assert.equal(primary.records.length, 0, "an update ran despite its prerequisite failing");
      assert.equal(primary.updates, 0);
    } finally {
      await primary.close();
    }
  });
});

function record(name: string, type: number, klass: number, ttl: number, rdata: Buffer): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(klass, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([writeName(name), head, rdata]);
}
