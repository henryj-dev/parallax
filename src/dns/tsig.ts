import { createHmac, timingSafeEqual } from "node:crypto";
import { TYPE, WireFormatError, writeName } from "./wire.ts";

/**
 * TSIG (RFC 8945): a shared secret on the message itself, rather than trust in
 * the address it came from.
 *
 * An IP allowlist was the only control on zone transfer and on NOTIFY, and an
 * address is not a credential -- it is a routing decision somebody else makes.
 * A key is: the secondary proves it holds the secret, and the primary proves
 * the same on the way back, so neither end is taking the network's word for who
 * it is talking to.
 *
 * Written here rather than taken from a library for the same reason the rest of
 * the wire format is: these bytes arrive from whoever can reach the port, and
 * the failure modes of a parser one dependency away are not ours to know.
 */

/** The algorithms this build will use. SHA-1 is omitted rather than deprecated. */
export const TSIG_ALGORITHMS = ["hmac-sha256", "hmac-sha512"] as const;

export type TsigAlgorithm = (typeof TSIG_ALGORITHMS)[number];

export interface TsigKey {
  /** Lowercased, no trailing dot. Both ends must spell it the same way. */
  readonly name: string;
  readonly algorithm: TsigAlgorithm;
  readonly secret: Buffer;
}

/** RFC 8945 §2: the extended rcodes TSIG adds, carried in the record itself. */
export const TSIG_ERROR = Object.freeze({ NONE: 0, BADSIG: 16, BADKEY: 17, BADTIME: 18 });

/** How far apart the two clocks may be, in seconds. The value BIND also defaults to. */
export const DEFAULT_FUDGE_SECONDS = 300;

export interface TsigRecord {
  readonly keyName: string;
  readonly algorithm: string;
  readonly timeSigned: number;
  readonly fudge: number;
  readonly mac: Buffer;
  readonly originalId: number;
  readonly error: number;
  readonly otherData: Buffer;
  /** Where the record begins, so the message can be hashed without it. */
  readonly offset: number;
}

/**
 * Reads the TSIG record, which the specification requires to be the very last
 * record in the additional section.
 *
 * That position is not a formality: the MAC covers the message with this record
 * removed, so anything after it could not have been signed. A TSIG found
 * anywhere else is treated as absent, which makes the message unsigned rather
 * than partly signed.
 */
export function readTsig(message: Buffer): TsigRecord | undefined {
  if (message.length < 12) return undefined;
  const counts = [message.readUInt16BE(4), message.readUInt16BE(6), message.readUInt16BE(8), message.readUInt16BE(10)];
  const additional = counts[3] as number;
  if (additional === 0) return undefined;

  let offset = 12;
  try {
    for (let index = 0; index < (counts[0] as number); index += 1) {
      offset = skipName(message, offset) + 4;
    }
    const records = (counts[1] as number) + (counts[2] as number) + additional;
    let candidate: TsigRecord | undefined;
    for (let index = 0; index < records; index += 1) {
      const start = offset;
      const afterName = skipName(message, offset);
      if (afterName + 10 > message.length) return undefined;
      const type = message.readUInt16BE(afterName);
      const rdataLength = message.readUInt16BE(afterName + 8);
      const rdataStart = afterName + 10;
      if (rdataStart + rdataLength > message.length) return undefined;
      // Only the last record counts, and only if it is this one.
      candidate = index === records - 1 && type === TYPE.TSIG
        ? readTsigRdata(message, start, rdataStart, rdataLength)
        : undefined;
      offset = rdataStart + rdataLength;
    }
    // Trailing bytes mean the message is not what its counts say it is.
    return offset === message.length ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function readTsigRdata(
  message: Buffer,
  start: number,
  rdataStart: number,
  rdataLength: number,
): TsigRecord | undefined {
  const keyName = readName(message, start);
  const algorithmEnd = skipName(message, rdataStart);
  const algorithm = readName(message, rdataStart);
  // A name this build could never have configured is not a key it holds, and
  // carrying it further only carries it into a log line.
  if (keyName === undefined || algorithm === undefined) return undefined;
  let cursor = algorithmEnd;
  if (cursor + 10 > rdataStart + rdataLength) return undefined;
  // Time signed is 48 bits, so it outlives the 32-bit epoch on purpose.
  const timeSigned = message.readUIntBE(cursor, 6);
  const fudge = message.readUInt16BE(cursor + 6);
  const macLength = message.readUInt16BE(cursor + 8);
  cursor += 10;
  if (cursor + macLength + 6 > rdataStart + rdataLength) return undefined;
  const mac = Buffer.from(message.subarray(cursor, cursor + macLength));
  cursor += macLength;
  const originalId = message.readUInt16BE(cursor);
  const error = message.readUInt16BE(cursor + 2);
  const otherLength = message.readUInt16BE(cursor + 4);
  cursor += 6;
  if (cursor + otherLength !== rdataStart + rdataLength) return undefined;
  return {
    keyName,
    algorithm,
    timeSigned,
    fudge,
    mac,
    originalId,
    error,
    otherData: Buffer.from(message.subarray(cursor, cursor + otherLength)),
    offset: start,
  };
}

/** Uncompressed names only: a TSIG record may not use compression pointers. */
function skipName(message: Buffer, start: number): number {
  let offset = start;
  for (;;) {
    if (offset >= message.length) throw new WireFormatError("name runs past the end of the message");
    const length = message[offset] as number;
    if ((length & 0xc0) !== 0) throw new WireFormatError("a TSIG record may not use name compression");
    offset += 1;
    if (length === 0) return offset;
    offset += length;
  }
}

/**
 * A name from a message anyone can send, read as a name and nothing else.
 *
 * ⚠️ It returned the bytes as latin1 with no filtering and no total length cap,
 * and the result reached `console.warn` through the rejection log. A key name
 * spelled out of newlines therefore wrote whatever lines its sender chose, over
 * this deployment's name -- one unauthenticated packet, and it worked with no
 * keys configured at all, because a present TSIG is always verified.
 *
 * It also fed the string back to `writeName` when refusing, which throws on an
 * unescaped `.` inside a label -- so a two-byte name turned the BADKEY the peer
 * needed into a dropped packet.
 *
 * The alphabet here is the one `parseTsigKey` already requires of a configured
 * key, so anything this refuses could never have named a key that exists.
 */
function readName(message: Buffer, start: number): string | undefined {
  const labels: string[] = [];
  let offset = start;
  let total = 0;
  for (;;) {
    const length = message[offset] as number;
    offset += 1;
    if (length === 0) break;
    total += length + 1;
    if (total > MAX_NAME_BYTES) return undefined;
    const label = message.toString("latin1", offset, offset + length);
    if (!/^[A-Za-z0-9_-]+$/u.test(label)) return undefined;
    labels.push(label);
    offset += length;
  }
  return labels.join(".").toLowerCase();
}

/** RFC 1035 §2.3.4, so a name cannot be used to make this build hold anything large. */
const MAX_NAME_BYTES = 255;

/**
 * What came before this message, when it is an answer rather than a question.
 *
 * A reply digests the request's MAC first, and a transfer envelope after the
 * first digests its predecessor's and only the timers. Without this a caller
 * checking a reply has to reimplement the digest to check it, which is the
 * thing most likely to be wrong in both places at once.
 */
export interface TsigPrior {
  readonly mac: Buffer;
  /** True for a transfer envelope after the first (RFC 8945 §5.3.1). */
  readonly envelope?: boolean;
}

export type TsigVerdict =
  | { readonly kind: "ok"; readonly mac: Buffer }
  | { readonly kind: "rejected"; readonly error: number; readonly reason: string; readonly record: TsigRecord };

/**
 * Whether a signed message was signed by a key this deployment holds, recently.
 *
 * The three refusals are distinct because a peer can act on the difference:
 * BADKEY means it is using a name nobody here knows, BADTIME means the clocks
 * have drifted, and BADSIG means the secret does not match. Collapsing them
 * would leave an operator with one symptom for three repairs.
 */
export function verifyTsig(
  message: Buffer,
  record: TsigRecord,
  keys: readonly TsigKey[],
  now: () => number = Date.now,
  prior?: TsigPrior,
): TsigVerdict {
  const key = keys.find((candidate) => candidate.name === record.keyName);
  if (!key || key.algorithm !== record.algorithm) {
    return { kind: "rejected", error: TSIG_ERROR.BADKEY, reason: `no key named ${record.keyName} with algorithm ${record.algorithm}`, record };
  }
  const skew = Math.abs(Math.floor(now() / 1000) - record.timeSigned);
  if (skew > record.fudge) {
    return { kind: "rejected", error: TSIG_ERROR.BADTIME, reason: `signed ${skew}s away from this clock, beyond the ${record.fudge}s fudge`, record };
  }
  const body = strippedMessage(message, record.offset, record.originalId);
  const expected = prior?.envelope
    ? computeMac(key, [lengthPrefixed(prior.mac), body, timers(record.timeSigned, record.fudge)])
    : computeMac(key, [
      ...(prior ? [lengthPrefixed(prior.mac)] : []),
      body,
      tsigVariables(key, record.timeSigned, record.fudge, record.error, record.otherData),
    ]);
  if (record.mac.length !== expected.length || !timingSafeEqual(record.mac, expected)) {
    return { kind: "rejected", error: TSIG_ERROR.BADSIG, reason: "the signature does not match this key", record };
  }
  return { kind: "ok", mac: record.mac };
}

/**
 * Signs a message this process is sending on its own initiative -- a NOTIFY.
 *
 * No prior MAC, because nothing was being answered.
 */
export function signRequest(message: Buffer, key: TsigKey, now: () => number = Date.now): { message: Buffer; mac: Buffer } {
  const timeSigned = Math.floor(now() / 1000);
  const mac = computeMac(key, [message, tsigVariables(key, timeSigned, DEFAULT_FUDGE_SECONDS, 0, Buffer.alloc(0))]);
  return { message: appendTsig(message, key, timeSigned, mac, message.readUInt16BE(0), 0, Buffer.alloc(0)), mac };
}

/**
 * Signs a reply, binding it to the request it answers.
 *
 * The request's MAC goes in first, which is what stops a valid reply from being
 * replayed against a different question.
 */
export function signReply(
  reply: Buffer,
  key: TsigKey,
  requestMac: Buffer,
  now: () => number = Date.now,
): { message: Buffer; mac: Buffer } {
  const timeSigned = Math.floor(now() / 1000);
  const mac = computeMac(key, [
    lengthPrefixed(requestMac),
    reply,
    tsigVariables(key, timeSigned, DEFAULT_FUDGE_SECONDS, 0, Buffer.alloc(0)),
  ]);
  return { message: appendTsig(reply, key, timeSigned, mac, reply.readUInt16BE(0), 0, Buffer.alloc(0)), mac };
}

/**
 * Signs a message after the first in a multi-message answer.
 *
 * RFC 8945 §5.3.1: these carry only the timers, not the whole variable set, and
 * each one chains onto the MAC before it -- so a transfer cannot be reordered
 * or have an envelope dropped out of the middle without the next one failing.
 */
export function signEnvelope(
  envelope: Buffer,
  key: TsigKey,
  priorMac: Buffer,
  now: () => number = Date.now,
): { message: Buffer; mac: Buffer } {
  const timeSigned = Math.floor(now() / 1000);
  const mac = computeMac(key, [lengthPrefixed(priorMac), envelope, timers(timeSigned, DEFAULT_FUDGE_SECONDS)]);
  return { message: appendTsig(envelope, key, timeSigned, mac, envelope.readUInt16BE(0), 0, Buffer.alloc(0)), mac };
}

/**
 * The unsigned refusal a peer gets when its own signature did not verify.
 *
 * BADTIME carries this server's clock in the other-data field, which is the one
 * refusal the peer can actually correct from. BADKEY and BADSIG carry an empty
 * MAC, because there is no key here to sign with.
 */
export function signErrorReply(
  reply: Buffer,
  record: TsigRecord,
  error: number,
  key: TsigKey | undefined,
  now: () => number = Date.now,
): Buffer {
  const timeSigned = Math.floor(now() / 1000);
  let otherData = Buffer.alloc(0);
  if (error === TSIG_ERROR.BADTIME) {
    otherData = Buffer.alloc(6);
    otherData.writeUIntBE(timeSigned, 0, 6);
  }
  const algorithm = (key?.algorithm ?? record.algorithm) as TsigAlgorithm;
  const named: TsigKey = { name: record.keyName, algorithm, secret: key?.secret ?? Buffer.alloc(0) };
  // A rejected message is answered with an empty MAC: signing it would assert
  // agreement about a message this end has just said it cannot verify.
  return appendTsig(reply, named, record.timeSigned, Buffer.alloc(0), reply.readUInt16BE(0), error, otherData, timeSigned);
}

/**
 * How many bytes signing will add, so a reply can be built small enough to
 * still fit once it is signed.
 *
 * A budget spent entirely on records leaves nowhere to put the signature, and
 * the overflow lands on the transport rather than on the assembler that could
 * have avoided it.
 */
export function tsigOverhead(key: TsigKey): number {
  const macLength = key.algorithm === "hmac-sha512" ? 64 : 32;
  return writeName(key.name.toLowerCase()).length + 10 + writeName(key.algorithm).length + 10 + macLength + 6;
}

function computeMac(key: TsigKey, parts: readonly Buffer[]): Buffer {
  const hmac = createHmac(key.algorithm === "hmac-sha512" ? "sha512" : "sha256", key.secret);
  for (const part of parts) hmac.update(part);
  return hmac.digest();
}

function timers(timeSigned: number, fudge: number): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeUIntBE(timeSigned, 0, 6);
  encoded.writeUInt16BE(fudge, 6);
  return encoded;
}

function lengthPrefixed(mac: Buffer): Buffer {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(mac.length, 0);
  return Buffer.concat([prefix, mac]);
}

/**
 * The message as it was before the TSIG was attached: the record removed, the
 * additional count put back, and the header carrying the id the signer used.
 */
function strippedMessage(message: Buffer, tsigOffset: number, originalId: number): Buffer {
  const stripped = Buffer.from(message.subarray(0, tsigOffset));
  stripped.writeUInt16BE(originalId, 0);
  stripped.writeUInt16BE(Math.max(0, stripped.readUInt16BE(10) - 1), 10);
  return stripped;
}

/** RFC 8945 §4.3.3, in the order the digest takes them. Names are canonical. */
function tsigVariables(key: TsigKey, timeSigned: number, fudge: number, error: number, otherData: Buffer): Buffer {
  const name = writeName(key.name.toLowerCase());
  const classAndTtl = Buffer.alloc(6);
  classAndTtl.writeUInt16BE(0x00ff, 0); // CLASS ANY
  classAndTtl.writeUInt32BE(0, 2); // TTL 0
  const algorithm = writeName(key.algorithm);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(error, 0);
  tail.writeUInt16BE(otherData.length, 2);
  return Buffer.concat([name, classAndTtl, algorithm, timers(timeSigned, fudge), tail, otherData]);
}

function appendTsig(
  message: Buffer,
  key: TsigKey,
  timeSigned: number,
  mac: Buffer,
  originalId: number,
  error: number,
  otherData: Buffer,
  recordTimeSigned = timeSigned,
): Buffer {
  const name = writeName(key.name.toLowerCase());
  const algorithm = writeName(key.algorithm);
  const rdata = Buffer.concat([
    algorithm,
    (() => {
      const head = Buffer.alloc(10);
      head.writeUIntBE(recordTimeSigned, 0, 6);
      head.writeUInt16BE(DEFAULT_FUDGE_SECONDS, 6);
      head.writeUInt16BE(mac.length, 8);
      return head;
    })(),
    mac,
    (() => {
      const tail = Buffer.alloc(6);
      tail.writeUInt16BE(originalId, 0);
      tail.writeUInt16BE(error, 2);
      tail.writeUInt16BE(otherData.length, 4);
      return tail;
    })(),
    otherData,
  ]);
  const header = Buffer.alloc(10);
  header.writeUInt16BE(TYPE.TSIG, 0);
  header.writeUInt16BE(0x00ff, 2); // CLASS ANY
  header.writeUInt32BE(0, 4); // TTL 0
  header.writeUInt16BE(rdata.length, 8);

  const signed = Buffer.concat([message, name, header, rdata]);
  signed.writeUInt16BE(signed.readUInt16BE(10) + 1, 10);
  return signed;
}

/**
 * Reads `name:algorithm:base64secret`, the shape `dig -y` and `named.conf`
 * both spell out, so a key can be copied between them without translation.
 */
export function parseTsigKey(source: string, setting: string): TsigKey {
  const parts = source.split(":");
  if (parts.length !== 3) {
    throw new Error(`${setting} entries must be name:algorithm:base64secret, as in transfer.key:hmac-sha256:...`);
  }
  const [rawName, rawAlgorithm, rawSecret] = parts as [string, string, string];
  const name = rawName.trim().replace(/\.$/u, "").toLowerCase();
  if (!name || !/^[a-z0-9_.-]+$/u.test(name)) throw new Error(`${setting} contains an invalid key name: ${rawName}`);
  const algorithm = rawAlgorithm.trim().toLowerCase();
  if (!TSIG_ALGORITHMS.some((candidate) => candidate === algorithm)) {
    throw new Error(`${setting} algorithm must be one of ${TSIG_ALGORITHMS.join(", ")}`);
  }
  const secret = Buffer.from(rawSecret.trim(), "base64");
  // A short secret is a key that was mistyped or truncated, and it would
  // authenticate zone transfer.
  if (secret.byteLength < 16) throw new Error(`${setting} secret must decode to at least 16 bytes of base64`);
  return { name, algorithm: algorithm as TsigAlgorithm, secret };
}
