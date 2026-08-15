import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MIN_UDP_PAYLOAD, RCODE, TYPE, WireFormatError,
  isResponseToQuery, readName, readQuery, typeName, writeName, writeReply,
} from "../../src/dns/wire.ts";

/**
 * Query bytes assembled here rather than by the code under test, so a parser
 * that agrees with its own encoder about something wrong still fails.
 */
function encodeName(name: string): Buffer {
  if (name === "") return Buffer.of(0);
  const chunks: Buffer[] = [];
  for (const label of name.split(".")) {
    chunks.push(Buffer.of(label.length), Buffer.from(label, "latin1"));
  }
  chunks.push(Buffer.of(0));
  return Buffer.concat(chunks);
}

interface QueryOptions {
  readonly id?: number;
  readonly flags?: number;
  readonly questionCount?: number;
  readonly udpPayloadSize?: number;
  readonly trailing?: Buffer;
  readonly additionalCount?: number;
}

function buildQuery(name: string, type: number = TYPE.A, options: QueryOptions = {}): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(options.id ?? 0x1234, 0);
  header.writeUInt16BE(options.flags ?? 0x0100, 2);
  header.writeUInt16BE(options.questionCount ?? 1, 4);
  const question = Buffer.concat([encodeName(name), Buffer.alloc(4)]);
  question.writeUInt16BE(type, question.length - 4);
  question.writeUInt16BE(1, question.length - 2);
  const parts: Buffer[] = [header, question];
  if (options.udpPayloadSize !== undefined) {
    header.writeUInt16BE(1, 10);
    const opt = Buffer.alloc(11);
    opt.writeUInt16BE(TYPE.OPT, 1);
    opt.writeUInt16BE(options.udpPayloadSize, 3);
    parts.push(opt);
  }
  if (options.trailing) {
    header.writeUInt16BE(options.additionalCount ?? 1, 10);
    parts.push(options.trailing);
  }
  return Buffer.concat(parts);
}

describe("DNS wire format", () => {
  it("reads the one question a query carries, lowercased and without a trailing dot", () => {
    const query = readQuery(buildQuery("WWW.Example.COM", TYPE.AAAA));
    assert.equal(query.id, 0x1234);
    assert.equal(query.question.name, "www.example.com");
    assert.equal(query.question.type, TYPE.AAAA);
    assert.equal(query.question.class, 1);
  });

  it("reads a query for the root as the empty name", () => {
    assert.equal(readQuery(buildQuery("", TYPE.NS)).question.name, "");
  });

  it("refuses a message that is not a single-question query", () => {
    // Anything else is either a reply somebody bounced at this port or a shape
    // this server has no answer for, and guessing at it is how a reflector works.
    assert.throws(() => readQuery(Buffer.alloc(11)), WireFormatError);
    assert.throws(() => readQuery(buildQuery("example.com", TYPE.A, { flags: 0x8180 })), /response, not a query/);
    assert.throws(() => readQuery(buildQuery("example.com", TYPE.A, { questionCount: 0 })), /exactly one question/);
    assert.throws(() => readQuery(buildQuery("example.com", TYPE.A, { questionCount: 2 })), /exactly one question/);
  });

  it("refuses a question whose type and class were cut off", () => {
    const full = buildQuery("example.com");
    assert.throws(() => readQuery(full.subarray(0, full.length - 2)), /truncated/);
  });

  it("matches forwarded responses by QR, opcode, id and the complete question", () => {
    const request = buildQuery("www.example.com", TYPE.AAAA, { id: 0x4242 });
    const query = readQuery(request);
    const valid = Buffer.from(request);
    valid.writeUInt16BE(0x8180, 2);
    assert.equal(isResponseToQuery(valid, query), true);

    const wrongId = Buffer.from(valid);
    wrongId.writeUInt16BE(0x4243, 0);
    const wrongOpcode = Buffer.from(valid);
    wrongOpcode.writeUInt16BE(0x8980, 2);
    const notAResponse = Buffer.from(request);
    const wrongQuestion = buildQuery("other.example.com", TYPE.AAAA, { id: 0x4242, flags: 0x8180 });
    const wrongType = buildQuery("www.example.com", TYPE.A, { id: 0x4242, flags: 0x8180 });
    for (const candidate of [wrongId, wrongOpcode, notAResponse, wrongQuestion, wrongType, Buffer.of(1, 2, 3)]) {
      assert.equal(isResponseToQuery(candidate, query), false);
    }
  });

  describe("names", () => {
    it("refuses labels the format does not allow", () => {
      // The two top bits are the only thing separating a length from a pointer,
      // so a label claiming 64 bytes is refused by that same check -- there is
      // no separate 63-byte test a message could ever reach.
      const oversizedLabel = Buffer.concat([Buffer.alloc(12), Buffer.of(64), Buffer.alloc(64), Buffer.alloc(4)]);
      assert.throws(() => readName(oversizedLabel, 12), /reserved bits/);

      const reserved = Buffer.concat([Buffer.alloc(12), Buffer.of(0x40), Buffer.alloc(4)]);
      assert.throws(() => readName(reserved, 12), /reserved bits/);

      const runsPast = Buffer.concat([Buffer.alloc(12), Buffer.of(9), Buffer.from("abc")]);
      assert.throws(() => readName(runsPast, 12), /past the end/);

      const unterminated = Buffer.concat([Buffer.alloc(12), Buffer.of(1), Buffer.from("a")]);
      assert.throws(() => readName(unterminated, 12), /past the end/);
    });

    it("refuses a name longer than 255 bytes, however it was assembled", () => {
      const label = Buffer.concat([Buffer.of(63), Buffer.from("a".repeat(63))]);
      const long = Buffer.concat([Buffer.alloc(12), label, label, label, label, label, Buffer.of(0)]);
      assert.throws(() => readName(long, 12), /longer than 255/);
    });

    it("follows a compression pointer that moves backwards", () => {
      const message = Buffer.concat([Buffer.alloc(12), encodeName("a.example"), Buffer.of(0xc0, 0x0c)]);
      const pointerAt = 12 + encodeName("a.example").length;
      const read = readName(message, pointerAt);
      assert.equal(read.name, "a.example");
      assert.equal(read.offset, pointerAt + 2, "reading resumes after the pointer, not after the name it names");
    });

    it("refuses a pointer that does not move backwards, which is how a name loops forever", () => {
      // A stranger can send these. Without the rule the process spins inside a
      // two-byte message and stops answering anything at all.
      const selfReferential = Buffer.concat([Buffer.alloc(12), Buffer.of(0xc0, 0x0c)]);
      assert.throws(() => readName(selfReferential, 12), /does not move backwards/);

      const mutual = Buffer.concat([Buffer.alloc(12), Buffer.of(0xc0, 0x0e), Buffer.of(0xc0, 0x0c)]);
      assert.throws(() => readName(mutual, 12), /does not move backwards/);
      assert.throws(() => readName(mutual, 14), /does not move backwards/);

      const truncatedPointer = Buffer.concat([Buffer.alloc(12), Buffer.of(0xc0)]);
      assert.throws(() => readName(truncatedPointer, 12), /pointer is truncated/);
    });

    it("writes a name uncompressed, and refuses one it could not write back", () => {
      assert.equal(writeName("a.example").toString("hex"), encodeName("a.example").toString("hex"));
      assert.equal(writeName("example.com.").toString("hex"), encodeName("example.com").toString("hex"), "the trailing dot is not a label");
      assert.equal(writeName(".").toString("hex"), "00");
      assert.throws(() => writeName("a..example"), /invalid label/);
      assert.throws(() => writeName(`${"a".repeat(64)}.example`), /invalid label/);
      assert.throws(() => writeName(new Array(5).fill("a".repeat(63)).join(".")), /longer than 255/);
    });
  });

  describe("EDNS", () => {
    it("promises only 512 bytes to a client that did not say it could take more", () => {
      const query = readQuery(buildQuery("example.com"));
      assert.equal(query.hasOpt, false);
      assert.equal(query.udpPayloadSize, MIN_UDP_PAYLOAD);
    });

    it("takes the client's advertised size as a ceiling, and caps an absurd claim", () => {
      assert.equal(readQuery(buildQuery("example.com", TYPE.A, { udpPayloadSize: 1232 })).udpPayloadSize, 1232);
      // Sending more than the path can carry is how a reply gets fragmented and
      // dropped, so a claim of 64k is not taken at its word.
      assert.equal(readQuery(buildQuery("example.com", TYPE.A, { udpPayloadSize: 65_535 })).udpPayloadSize, 4096);
      assert.equal(readQuery(buildQuery("example.com", TYPE.A, { udpPayloadSize: 100 })).udpPayloadSize, 512);
    });

    it("still answers a query whose additional section cannot be walked", () => {
      // The question is intact and that is what an answer needs. Losing the
      // larger size is the whole cost of not understanding the rest.
      const query = readQuery(buildQuery("example.com", TYPE.A, { trailing: Buffer.of(0xff, 0xff, 0xff) }));
      assert.equal(query.question.name, "example.com");
      assert.equal(query.udpPayloadSize, MIN_UDP_PAYLOAD);
      assert.equal(query.hasOpt, false);
    });
  });

  describe("replies", () => {
    it("echoes the query's id, question and recursion-desired bit, and claims authority", () => {
      const query = readQuery(buildQuery("example.com", TYPE.A, { id: 0xbeef }));
      const reply = writeReply({ query, rcode: RCODE.NOERROR, authoritative: true }, 512);
      assert.equal(reply.readUInt16BE(0), 0xbeef);
      const flags = reply.readUInt16BE(2);
      assert.equal(flags & 0x8000, 0x8000, "QR");
      assert.equal(flags & 0x0400, 0x0400, "AA");
      assert.equal(flags & 0x0100, 0x0100, "RD is echoed back");
      assert.equal(flags & 0x0080, 0, "RA is not set: this server does not recurse");
      assert.equal(reply.readUInt16BE(4), 1);
      assert.equal(reply.subarray(12).toString("hex").startsWith(encodeName("example.com").toString("hex")), true);
    });

    it("carries the rcode and the section counts", () => {
      const query = readQuery(buildQuery("example.com"));
      const soa = { name: "example.com", type: TYPE.SOA, ttl: 60, data: Buffer.alloc(22) };
      const reply = writeReply({ query, rcode: RCODE.NXDOMAIN, authoritative: true, authority: [soa] }, 512);
      assert.equal(reply.readUInt16BE(2) & 0x000f, RCODE.NXDOMAIN);
      assert.equal(reply.readUInt16BE(6), 0, "no answers");
      assert.equal(reply.readUInt16BE(8), 1, "one authority record");
    });

    it("truncates rather than sending more than the client will accept", () => {
      // Truncation is not a failure: it tells the client to ask again over TCP.
      // A client that ignores it would otherwise have received a mangled answer.
      const query = readQuery(buildQuery("example.com", TYPE.TXT));
      const big = { name: "example.com", type: TYPE.TXT, ttl: 60, data: Buffer.alloc(600) };
      const reply = writeReply({ query, rcode: RCODE.NOERROR, authoritative: true, answers: [big] }, MIN_UDP_PAYLOAD);
      assert.ok(reply.length <= MIN_UDP_PAYLOAD);
      assert.equal(reply.readUInt16BE(2) & 0x0200, 0x0200, "TC");
      assert.equal(reply.readUInt16BE(6), 0, "a truncated reply carries no partial answer");
      assert.equal(readQuery(buildQuery("example.com", TYPE.TXT)).question.name, "example.com");
    });

    it("answers a client's OPT with one of its own, so EDNS stays negotiated", () => {
      const query = readQuery(buildQuery("example.com", TYPE.A, { udpPayloadSize: 1232 }));
      const reply = writeReply({ query, rcode: RCODE.NOERROR, authoritative: true }, 1232);
      assert.equal(reply.readUInt16BE(10), 1, "one additional record");
      const opt = reply.subarray(reply.length - 11);
      assert.equal(opt.readUInt8(0), 0, "the OPT owner name is the root");
      assert.equal(opt.readUInt16BE(1), TYPE.OPT);
      assert.equal(opt.readUInt16BE(3), 1232);
    });

    it("sends no OPT back to a client that sent none", () => {
      const query = readQuery(buildQuery("example.com"));
      const reply = writeReply({ query, rcode: RCODE.NOERROR, authoritative: true }, 512);
      assert.equal(reply.readUInt16BE(10), 0);
    });
  });

  it("names known types and admits when it does not know one", () => {
    assert.equal(typeName(TYPE.HTTPS), "HTTPS");
    assert.equal(typeName(99), "TYPE99");
  });
});
