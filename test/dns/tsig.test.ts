import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  DEFAULT_FUDGE_SECONDS, TSIG_ERROR,
  parseTsigKey, readTsig, signEnvelope, signReply, signRequest, tsigOverhead, verifyTsig,
  type TsigKey,
} from "../../src/dns/tsig.ts";
import { TYPE, writeName } from "../../src/dns/wire.ts";

const SECRET = Buffer.alloc(32, 7).toString("base64");
const KEY = parseTsigKey(`transfer.key:hmac-sha256:${SECRET}`, "TEST");
const OTHER: TsigKey = { ...KEY, secret: Buffer.alloc(32, 9) };
const AT = 1_700_000_000_000;
const now = (): number => AT;

/** A question, assembled here rather than by the encoder under test. */
function query(id = 0x1234): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE.AXFR, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, writeName("example.test"), tail]);
}

describe("TSIG", () => {
  it("signs a request and accepts it back", () => {
    const { message, mac } = signRequest(query(), KEY, now);
    // The record is counted, so a peer that reads the header finds it.
    assert.equal(message.readUInt16BE(10), 1);
    const record = readTsig(message);
    assert.ok(record);
    assert.equal(record.keyName, "transfer.key");
    assert.equal(record.algorithm, "hmac-sha256");
    assert.equal(record.fudge, DEFAULT_FUDGE_SECONDS);
    assert.equal(record.originalId, 0x1234);
    assert.deepEqual(record.mac, mac);
    assert.deepEqual(verifyTsig(message, record, [KEY], now), { kind: "ok", mac });
  });

  it("tells the three refusals apart", () => {
    const { message } = signRequest(query(), KEY, now);
    const record = readTsig(message);
    assert.ok(record);

    const unknown = verifyTsig(message, record, [{ ...KEY, name: "other.key" }], now);
    assert.equal(unknown.kind === "rejected" && unknown.error, TSIG_ERROR.BADKEY);

    // An algorithm this build will not use is a key it does not have, not a
    // signature that failed: answering BADSIG would send the peer looking at
    // its secret.
    const wrongAlgorithm = verifyTsig(message, record, [{ ...KEY, algorithm: "hmac-sha512" }], now);
    assert.equal(wrongAlgorithm.kind === "rejected" && wrongAlgorithm.error, TSIG_ERROR.BADKEY);

    const late = verifyTsig(message, record, [KEY], () => AT + (DEFAULT_FUDGE_SECONDS + 1) * 1000);
    assert.equal(late.kind === "rejected" && late.error, TSIG_ERROR.BADTIME);
    // Symmetric: a peer whose clock runs ahead is as wrong as one behind.
    const early = verifyTsig(message, record, [KEY], () => AT - (DEFAULT_FUDGE_SECONDS + 1) * 1000);
    assert.equal(early.kind === "rejected" && early.error, TSIG_ERROR.BADTIME);
    assert.equal(verifyTsig(message, record, [KEY], () => AT + DEFAULT_FUDGE_SECONDS * 1000).kind, "ok");

    const wrongSecret = verifyTsig(message, record, [OTHER], now);
    assert.equal(wrongSecret.kind === "rejected" && wrongSecret.error, TSIG_ERROR.BADSIG);
  });

  it("refuses a message whose body was changed under a valid-looking signature", () => {
    const { message } = signRequest(query(), KEY, now);
    const tampered = Buffer.from(message);
    // A byte of the question, not of the signature: the MAC covers both.
    tampered[14] = (tampered[14] as number) ^ 0x20;
    const record = readTsig(tampered);
    assert.ok(record);
    const verdict = verifyTsig(tampered, record, [KEY], now);
    assert.equal(verdict.kind === "rejected" && verdict.error, TSIG_ERROR.BADSIG);
  });

  it("binds a reply to the request it answers", () => {
    const asked = signRequest(query(0x1111), KEY, now);
    const other = signRequest(query(0x2222), KEY, now);
    const reply = Buffer.concat([query(0x1111).subarray(0, 12), query(0x1111).subarray(12)]);

    const answered = signReply(reply, KEY, asked.mac, now);
    const elsewhere = signReply(reply, KEY, other.mac, now);
    // Same bytes, same key, same second -- and a different MAC, which is the
    // whole point: this reply cannot be lifted onto the other question.
    assert.notDeepEqual(answered.mac, elsewhere.mac);
  });

  it("chains each transfer envelope onto the one before it", () => {
    const request = signRequest(query(), KEY, now);
    const first = signReply(Buffer.from(query()), KEY, request.mac, now);
    const second = signEnvelope(Buffer.from(query()), KEY, first.mac, now);
    const reordered = signEnvelope(Buffer.from(query()), KEY, request.mac, now);
    assert.notDeepEqual(second.mac, reordered.mac);

    // RFC 8945 §5.3.1: a follow-on envelope digests only the timers, not the
    // whole variable set. Recomputed here from the specification rather than
    // from the implementation, so the two have to agree independently.
    const record = readTsig(second.message);
    assert.ok(record);
    const stripped = Buffer.from(second.message.subarray(0, record.offset));
    stripped.writeUInt16BE(stripped.readUInt16BE(10) - 1, 10);
    const priorLength = Buffer.alloc(2);
    priorLength.writeUInt16BE(first.mac.length, 0);
    const timers = Buffer.alloc(8);
    timers.writeUIntBE(Math.floor(AT / 1000), 0, 6);
    timers.writeUInt16BE(DEFAULT_FUDGE_SECONDS, 6);
    const expected = createHmac("sha256", KEY.secret)
      .update(Buffer.concat([priorLength, first.mac, stripped, timers])).digest();
    assert.deepEqual(record.mac, expected);
  });

  it("treats a TSIG that is not the last record as absent", () => {
    const { message } = signRequest(query(), KEY, now);
    // One trailing byte, and the counts no longer describe the message.
    assert.equal(readTsig(Buffer.concat([message, Buffer.of(0)])), undefined);
    assert.equal(readTsig(query()), undefined);
    assert.equal(readTsig(Buffer.alloc(4)), undefined);
    // Truncated rdata is refused rather than read past the end.
    assert.equal(readTsig(message.subarray(0, message.length - 4)), undefined);
  });

  it("reserves exactly what signing will add", () => {
    for (const algorithm of ["hmac-sha256", "hmac-sha512"] as const) {
      const key = parseTsigKey(`a.rather.longer.key.name:${algorithm}:${Buffer.alloc(64, 3).toString("base64")}`, "TEST");
      const bare = query();
      const { message } = signRequest(bare, key, now);
      assert.equal(message.length - bare.length, tsigOverhead(key));
    }
  });

  it("refuses key material that would not authenticate anything", () => {
    assert.throws(() => parseTsigKey("only.a.name", "K"), /name:algorithm:base64secret/u);
    assert.throws(() => parseTsigKey(`k:hmac-md5:${SECRET}`, "K"), /algorithm must be one of/u);
    assert.throws(() => parseTsigKey(`k:hmac-sha1:${SECRET}`, "K"), /algorithm must be one of/u);
    // Eight bytes of base64 is a typo, and it would be gating zone transfer.
    assert.throws(() => parseTsigKey(`k:hmac-sha256:${Buffer.alloc(8).toString("base64")}`, "K"), /at least 16 bytes/u);
    assert.throws(() => parseTsigKey(`bad name:hmac-sha256:${SECRET}`, "K"), /invalid key name/u);
    // A trailing dot is how `named.conf` spells it and how `dig` does not.
    assert.equal(parseTsigKey(`Transfer.Key.:hmac-sha256:${SECRET}`, "K").name, "transfer.key");
  });
});
