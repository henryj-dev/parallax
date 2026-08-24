import { connect } from "node:net";
import type { RecordType } from "../domain/dns.ts";
import { decodeRdata, UnrepresentableRdata } from "./rdata-decode.ts";
import { readTsig, verifyTsig, type TsigKey } from "./tsig.ts";
import {
  CLASS_IN, RCODE, TYPE, WireFormatError, readName, typeName, writeName,
} from "./wire.ts";

/**
 * The client half of the wire format.
 *
 * Everything here already existed for answering; nothing existed for asking.
 * An adapter that publishes into somebody else's DNS server has to read that
 * server's zone back -- including the records it did not write, which is the
 * case no shortcut covers -- so this is a transfer client and a query client,
 * and nothing more than the two of them.
 *
 * TCP only. A zone transfer requires it, an UPDATE that does not fit a datagram
 * needs it, and a truncated answer retried over TCP is a code path that would
 * exist to save one round trip on the rare small case.
 */

export interface DnsEndpoint {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
}

/** One record as it arrived, with its rdata already in presentation form. */
export interface AnsweredRecord {
  /** Absolute, lowercased, no trailing dot -- the shape `readName` gives. */
  readonly name: string;
  readonly type: number;
  readonly ttl: number;
  /** Absent for a record this build cannot store. `unreadable` says why. */
  readonly content?: string;
  /**
   * Why the rdata could not be carried, where it could not.
   *
   * A zone holds records Parallax has no way to store -- a type it does not
   * know, a TXT of several strings, a character-string of raw octets. Failing
   * the whole transfer over one of them would make this unusable against any
   * real server; dropping it silently would make records disappear from a
   * listing an operator reads as complete. So it is carried, empty, with the
   * reason attached.
   */
  readonly unreadable?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A ceiling on one transfer, so a peer that never ends one cannot exhaust this
 * process. Well past any zone this control plane would publish.
 */
const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;

/**
 * Sends one message and reads the replies.
 *
 * A transfer answers with several and is finished by the second SOA (RFC 5936
 * §2.2); everything else answers with one. The caller says which it expects,
 * because a client that guessed would hang on the wrong guess.
 */
export async function exchange(
  endpoint: DnsEndpoint,
  message: Buffer,
  expect: "one" | "transfer",
  verify?: TsigVerification,
): Promise<Buffer[]> {
  const replies = await receive(endpoint, message, expect);
  return verify ? verifyReplies(replies, verify) : replies;
}

/**
 * What a signed exchange needs to check the answers.
 *
 * ⚠️ Optional in the type and never optional in practice: every caller in this
 * build signs, and every one of them must pass this. It was not here at all
 * once -- the requests were signed and the answers were taken on the network's
 * word, which made the signing decorative in the direction that matters. A
 * peer that can answer on the connection chooses what the zone contains.
 */
export interface TsigVerification {
  readonly key: TsigKey;
  /** The MAC of the request these replies answer, which binds them to it. */
  readonly requestMac: Buffer;
  readonly now?: () => number;
}

/**
 * RFC 8945 §5.2: a reply that does not verify is discarded, not read.
 *
 * The first reply is bound to the request's MAC and each one after it chains
 * onto its predecessor (§5.3.1), which is the same walk the server does when it
 * signs them -- so a dropped, reordered or substituted envelope fails here.
 */
function verifyReplies(replies: readonly Buffer[], verify: TsigVerification): Buffer[] {
  let prior = verify.requestMac;
  return replies.map((reply, index) => {
    const record = readTsig(reply);
    // RFC 8945 §5.2: an unverifiable message is discarded *unless* its rcode is
    // NOTAUTH. That exception is what lets a peer say "your key is wrong" --
    // it cannot sign such an answer, by definition. Refusing it too would
    // replace the one actionable sentence with "no signature".
    if (!record && (reply.readUInt16BE(2) & 0xf) === RCODE.NOTAUTH) {
      throw new Error("the peer refused this key: NOTAUTH");
    }
    if (!record) throw new Error("the answer carried no signature, and this exchange was signed");
    const verdict = verifyTsig(reply, record, [verify.key], verify.now ?? Date.now, index === 0 ? { mac: prior } : { mac: prior, envelope: true });
    if (verdict.kind !== "ok") throw new Error(`the answer did not verify: ${verdict.reason}`);
    prior = verdict.mac;
    return reply;
  });
}

function receive(endpoint: DnsEndpoint, message: Buffer, expect: "one" | "transfer"): Promise<Buffer[]> {
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<Buffer[]>((resolve, reject) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port });
    const replies: Buffer[] = [];
    let buffered = Buffer.alloc(0);
    let received = 0;
    let soaSeen = 0;
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolve(replies);
    };

    // ⚠️ A deadline, not an idle timeout. `socket.setTimeout` resets on every
    // byte, so a peer trickling one byte per interval holds the connection --
    // and the transfer buffer -- open indefinitely. The listener already made
    // this distinction for incoming frames; the client had not.
    const deadline = setTimeout(
      () => finish(new Error(`${endpoint.host}:${endpoint.port} did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    );
    deadline.unref?.();

    socket.setTimeout(timeoutMs, () => finish(new Error(`${endpoint.host}:${endpoint.port} went quiet for ${timeoutMs}ms`)));
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      // A transfer that stopped early is not a short zone. RFC 5936 §6: a
      // transfer with any error detected must be discarded, and the client
      // keeps serving what it had. Resolving here reported a truncated zone as
      // a complete one, and the records the peer never sent read as deleted.
      if (expect === "transfer" && soaSeen < 2) {
        return finish(new Error(`${endpoint.host}:${endpoint.port} closed part way through the transfer`));
      }
      finish(replies.length > 0 ? undefined : new Error(`${endpoint.host}:${endpoint.port} closed without answering`));
    });
    socket.on("connect", () => {
      const framed = Buffer.alloc(2 + message.length);
      framed.writeUInt16BE(message.length, 0);
      message.copy(framed, 2);
      socket.write(framed);
    });
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 2) return;
        const length = buffered.readUInt16BE(0);
        if (buffered.length < 2 + length) return;
        const reply = Buffer.from(buffered.subarray(2, 2 + length));
        buffered = buffered.subarray(2 + length);
        // ⚠️ Before anything reads a header field. A two-byte frame -- a length
        // of zero -- made `readUInt16BE(2)` below throw a RangeError inside this
        // listener, outside the promise, so it was uncaught and the process
        // died. Two bytes from a peer, measured.
        if (reply.length < 12) return finish(new WireFormatError("a reply is too short to be a DNS message"));
        received += reply.length;
        // Bounded on purpose. A peer streaming well-formed messages whose answer
        // sections hold no SOA advances nothing, and `replies` grew until the
        // process died.
        if (received > MAX_TRANSFER_BYTES) return finish(new Error(`the transfer passed ${MAX_TRANSFER_BYTES} bytes without ending`));
        replies.push(reply);
        if (expect === "one") return finish();
        // A refused transfer answers once and stops. Waiting for the second SOA
        // that a refusal never carries turned "your key is wrong" into a
        // timeout -- the failure arrived late, and as the wrong sentence.
        if (replies.length === 1 && (reply.readUInt16BE(2) & 0xf) !== RCODE.NOERROR) return finish();
        // The first SOA opens the transfer and the second closes it.
        soaSeen += countSoa(reply);
        if (soaSeen >= 2) return finish();
      }
    });
  });
}

/** A question, with nothing else in it. */
export function writeQuestion(name: string, type: number, id: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([header, writeName(name), tail]);
}

/**
 * Refuses anything but NOERROR, naming the rcode.
 *
 * A caller that reads the answer section without this reads an empty section
 * from a REFUSED reply as "the zone holds nothing", which is the difference
 * between "your key is wrong" and "delete everything".
 */
export function assertAnswered(reply: Buffer, what: string): void {
  if (reply.length < 12) throw new WireFormatError(`${what} came back too short to be a DNS message`);
  const rcode = reply.readUInt16BE(2) & 0xf;
  if (rcode !== RCODE.NOERROR) throw new Error(`${what} was refused: ${rcodeName(rcode)}`);
}

/**
 * Every record in the answer section, with rdata already decoded.
 *
 * A type this build does not store comes back without `content` rather than
 * throwing: a zone is allowed to hold records Parallax has no opinion about,
 * and refusing the whole transfer over one of them would make the adapter
 * unusable against any real server.
 */
export function readAnswers(replies: readonly Buffer[]): AnsweredRecord[] {
  const records: AnsweredRecord[] = [];
  for (const message of replies) {
    if (message.length < 12) throw new WireFormatError("a reply is too short to be a DNS message");
    const questions = message.readUInt16BE(4);
    const answers = message.readUInt16BE(6);
    let offset = 12;
    for (let index = 0; index < questions; index += 1) offset = readName(message, offset).offset + 4;
    for (let index = 0; index < answers; index += 1) {
      const owner = readName(message, offset);
      offset = owner.offset;
      if (offset + 10 > message.length) throw new WireFormatError("a record header runs past the end of the reply");
      const type = message.readUInt16BE(offset);
      const ttl = message.readUInt32BE(offset + 4);
      const length = message.readUInt16BE(offset + 8);
      const rdataStart = offset + 10;
      if (rdataStart + length > message.length) throw new WireFormatError("a record's rdata runs past the end of the reply");
      const stored = storedType(type);
      records.push({ name: owner.name, type, ttl, ...readContent(stored, message, rdataStart, length) });
      offset = rdataStart + length;
    }
  }
  return records;
}

/**
 * The rdata, or the reason it could not be read.
 *
 * ⚠️ Only `UnrepresentableRdata` is caught. That one means the bytes are fine
 * and this control plane has nowhere to put them. A `WireFormatError` means the
 * bytes are wrong, and swallowing it would turn a malformed answer into a
 * shorter zone -- which is the difference between "I cannot store this" and
 * "this is not a zone".
 */
function readContent(
  stored: RecordType | undefined,
  message: Buffer,
  rdataStart: number,
  length: number,
): { content?: string; unreadable?: string } {
  if (stored === undefined) return { unreadable: `${typeName(message.readUInt16BE(rdataStart - 10))} is not a type this control plane stores` };
  try {
    return { content: decodeRdata(stored, message, rdataStart, length) };
  } catch (error) {
    if (error instanceof UnrepresentableRdata) return { unreadable: error.message };
    throw error;
  }
}

/** The name this build stores a type under, or nothing where it stores none. */
export function storedType(type: number): RecordType | undefined {
  const name = typeName(type);
  return (STORED_TYPES as ReadonlySet<string>).has(name) ? name as RecordType : undefined;
}

const STORED_TYPES: ReadonlySet<string> = new Set(
  Object.entries(TYPE)
    .filter(([name]) => name !== "SOA" && name !== "OPT" && name !== "ANY" && name !== "AXFR" && name !== "IXFR" && name !== "TSIG")
    .map(([name]) => name),
);

function countSoa(message: Buffer): number {
  let seen = 0;
  if (message.length < 12) return 0;
  const questions = message.readUInt16BE(4);
  const answers = message.readUInt16BE(6);
  let offset = 12;
  try {
    for (let index = 0; index < questions; index += 1) offset = readName(message, offset).offset + 4;
    for (let index = 0; index < answers; index += 1) {
      const owner = readName(message, offset);
      offset = owner.offset;
      if (message.readUInt16BE(offset) === TYPE.SOA) seen += 1;
      offset += 10 + message.readUInt16BE(offset + 8);
    }
  } catch {
    // A reply this build cannot walk is not a reply that closes a transfer.
    return seen;
  }
  return seen;
}

function rcodeName(rcode: number): string {
  for (const [name, value] of Object.entries(RCODE)) if (value === rcode) return name;
  return `rcode${rcode}`;
}
