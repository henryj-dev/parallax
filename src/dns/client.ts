import { connect } from "node:net";
import type { RecordType } from "../domain/dns.ts";
import { decodeRdata } from "./rdata-decode.ts";
import {
  CLASS_IN, MAX_TCP_MESSAGE_BYTES, RCODE, TYPE, WireFormatError, readName, typeName, writeName,
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
  /** Absent for a type this build does not store, which is not an error here. */
  readonly content?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

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
): Promise<Buffer[]> {
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<Buffer[]>((resolve, reject) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port });
    const replies: Buffer[] = [];
    let buffered = Buffer.alloc(0);
    let soaSeen = 0;
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(replies);
    };

    socket.setTimeout(timeoutMs, () => finish(new Error(`${endpoint.host}:${endpoint.port} did not answer within ${timeoutMs}ms`)));
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(replies.length > 0 ? undefined : new Error(`${endpoint.host}:${endpoint.port} closed without answering`)));
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
        if (length > MAX_TCP_MESSAGE_BYTES) return finish(new WireFormatError("a framed reply claims more than a DNS message may hold"));
        if (buffered.length < 2 + length) return;
        const reply = Buffer.from(buffered.subarray(2, 2 + length));
        buffered = buffered.subarray(2 + length);
        replies.push(reply);
        if (expect === "one") return finish();
        // ⚠️ A refused transfer answers once and stops. Waiting for the second
        // SOA that a refusal never carries turned "your key is wrong" into a
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
      records.push({
        name: owner.name,
        type,
        ttl,
        ...(stored === undefined ? {} : { content: decodeRdata(stored, message, rdataStart, length) }),
      });
      offset = rdataStart + length;
    }
  }
  return records;
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
