/**
 * Just enough of the DNS wire format to answer for the zones this control plane
 * holds, and to hand everything else to somebody who can.
 *
 * Written here rather than taken from a library because the read side has to be
 * hostile-input safe -- these bytes arrive from anyone who can reach the port --
 * and a parser that is one dependency away is one whose failure modes are not
 * ours to know. The write side is small: the answers are already computed.
 */
import type { RecordType } from "../domain/dns.ts";

export const CLASS_IN = 1;

/**
 * The `satisfies` is the point: every type the domain accepts must have a wire
 * code here, and the compiler is what requires it. Adding a type to
 * `RECORD_TYPES` and forgetting this file would otherwise produce a record that
 * validates, publishes, and cannot be answered for.
 *
 * SOA, OPT and ANY are not stored types -- they are synthesized, negotiated and
 * asked for -- so they are named separately rather than added to the domain.
 */
export const TYPE = Object.freeze({
  A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, HINFO: 13, MX: 15, TXT: 16, AAAA: 28,
  LOC: 29, SRV: 33, NAPTR: 35, CERT: 37, DNAME: 39, OPT: 41, DS: 43, SSHFP: 44,
  DNSKEY: 48, TLSA: 52, SMIMEA: 53, OPENPGPKEY: 61, SVCB: 64, HTTPS: 65,
  URI: 256, CAA: 257, ANY: 255, AXFR: 252,
} as const satisfies Record<RecordType | "SOA" | "OPT" | "ANY" | "AXFR", number>);

const TYPE_NAMES = new Map<number, string>(Object.entries(TYPE).map(([name, value]) => [value as number, name]));

export const RCODE = Object.freeze({
  NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5,
  /**
   * "I do not speak the EDNS version you asked for." Extended: it does not fit
   * the header's four bits and is carried in the OPT record, so it can only be
   * said to a client that sent one -- which is exactly the client that can ask
   * the question.
   */
  BADVERS: 16,
});

/** The highest EDNS version this build understands. */
export const MAX_EDNS_VERSION = 0;

/** QCLASS 255, the one class a question may carry that is not a class. */
export const CLASS_ANY = 255;

/**
 * The opcodes this build knows by name. Everything else is answered NOTIMP:
 * a message whose opcode says UPDATE is not a question, however much its first
 * section looks like one.
 */
export const OPCODE = Object.freeze({ QUERY: 0 });

/** The four bits of the header that say what kind of message this is. */
export function opcodeOf(query: Pick<ParsedQuery, "flags">): number {
  return (query.flags >> 11) & 0xf;
}

export interface Question {
  /** Lowercased, no trailing dot. The root is the empty string. */
  readonly name: string;
  readonly type: number;
  readonly class: number;
}

export interface ParsedQuery {
  readonly id: number;
  /** Byte 2 of the header, kept so the reply can echo RD and the opcode. */
  readonly flags: number;
  readonly question: Question;
  /** Largest reply the client will accept over UDP, from its OPT record. */
  readonly udpPayloadSize: number;
  readonly hasOpt: boolean;
  /** EDNS version the client claims. 0 when it sent no OPT record. */
  readonly ednsVersion: number;
  /**
   * The client's EDNS COOKIE option, exactly as it arrived: 8 bytes of client
   * cookie, optionally followed by 8 to 32 bytes this server minted earlier.
   */
  readonly cookie?: Buffer;
}

export class WireFormatError extends Error {
  override readonly name = "WireFormatError";
}

const HEADER_BYTES = 12;
const MAX_NAME_BYTES = 255;
const MAX_LABEL_BYTES = 63;
/**
 * RDLENGTH is an unsigned 16-bit field, so this is what a resource record can
 * carry -- not a policy, a property of the format.
 *
 * Exported because two places have to agree with it and neither is here: the
 * domain refuses to store content that would exceed it, and the listener
 * refuses to answer with content that already does. Without the second, a
 * record stored before this existed would make `writeRecord` throw while
 * assembling the reply -- past every per-record guard, so the query was
 * answered with nothing at all and nothing was logged.
 */
export const MAX_RDATA_BYTES = 0xffff;
/** Without an OPT record a client is promised no more than this. */
export const MIN_UDP_PAYLOAD = 512;
/**
 * The largest message DNS-over-TCP can frame, because the frame's length
 * prefix is an unsigned 16-bit field. A property of the transport, not a
 * policy -- and not the same limit as `MAX_RDATA_BYTES` above, which happens
 * to be the same number for the same reason one field up.
 */
export const MAX_TCP_MESSAGE_BYTES = 0xffff;

/**
 * Reads the one question a query carries.
 *
 * Only the question is parsed. Everything else in the message is either absent
 * from a query or not something an authoritative answer depends on, and parsing
 * what is not needed is parsing that can be wrong.
 */
export function readQuery(message: Buffer): ParsedQuery {
  if (message.length < HEADER_BYTES) throw new WireFormatError("message is shorter than a header");
  const id = message.readUInt16BE(0);
  const flags = message.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) throw new WireFormatError("message is a response, not a query");
  const questionCount = message.readUInt16BE(4);
  if (questionCount !== 1) throw new WireFormatError(`expected exactly one question, found ${questionCount}`);

  const { name, offset } = readName(message, HEADER_BYTES);
  if (offset + 4 > message.length) throw new WireFormatError("question is truncated");
  const type = message.readUInt16BE(offset);
  const klass = message.readUInt16BE(offset + 2);

  const opt = findOpt(message, offset + 4, message.readUInt16BE(6), message.readUInt16BE(8), message.readUInt16BE(10));
  return {
    id,
    flags,
    question: { name, type, class: klass },
    // The client's advertised size is a ceiling, not a floor: sending more than
    // it asked for is how a reply gets fragmented and dropped. Only the absent
    // case falls back to 512, and an absurdly large claim is capped.
    udpPayloadSize: opt === undefined ? MIN_UDP_PAYLOAD : Math.min(Math.max(opt.payloadSize, 512), 4096),
    hasOpt: opt !== undefined,
    ednsVersion: opt?.version ?? 0,
    ...(opt?.cookie ? { cookie: opt.cookie } : {}),
  };
}

/**
 * Checks the correlation fields a forwarding resolver must verify before it
 * relays an upstream datagram. Malformed or unrelated packets are ignored so a
 * later valid response from the connected upstream can still win.
 */
export function isResponseToQuery(message: Buffer, query: ParsedQuery): boolean {
  try {
    if (message.length < HEADER_BYTES) return false;
    if (message.readUInt16BE(0) !== query.id) return false;
    const flags = message.readUInt16BE(2);
    if ((flags & 0x8000) === 0) return false;
    if ((flags & 0x7800) !== (query.flags & 0x7800)) return false;
    if (message.readUInt16BE(4) !== 1) return false;
    const question = readName(message, HEADER_BYTES);
    if (question.offset + 4 > message.length) return false;
    return question.name === query.question.name
      && message.readUInt16BE(question.offset) === query.question.type
      && message.readUInt16BE(question.offset + 2) === query.question.class;
  } catch {
    return false;
  }
}

/**
 * Walks the records after the question looking for the client's OPT record,
 * which is where it says how large a reply it can take and which version of
 * EDNS it is speaking.
 *
 * Returns `undefined` rather than throwing when the rest of the message cannot
 * be walked: a query whose additional section is malformed is still a question
 * that can be answered, and the only thing lost is the larger size.
 */
/** The OPT record's own option codes. Only the one this build acts on. */
export const OPT_OPTION = Object.freeze({ COOKIE: 10 });

/**
 * One option out of an OPT record's RDATA, which is a run of
 * `code, length, value` triples. Bounded by the RDATA length the caller read,
 * so a malformed run cannot walk into the rest of the message.
 */
function findOptionInRdata(message: Buffer, start: number, rdataLength: number, wanted: number): Buffer | undefined {
  const end = Math.min(start + rdataLength, message.length);
  let offset = start;
  while (offset + 4 <= end) {
    const code = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    const valueStart = offset + 4;
    if (valueStart + length > end) return undefined;
    if (code === wanted) return Buffer.from(message.subarray(valueStart, valueStart + length));
    offset = valueStart + length;
  }
  return undefined;
}

function findOpt(
  message: Buffer,
  start: number,
  answers: number,
  authority: number,
  additional: number,
): { payloadSize: number; version: number; cookie?: Buffer } | undefined {
  let offset = start;
  try {
    for (let index = 0; index < answers + authority + additional; index += 1) {
      const read = readName(message, offset);
      offset = read.offset;
      if (offset + 10 > message.length) return undefined;
      const type = message.readUInt16BE(offset);
      const size = message.readUInt16BE(offset + 8);
      if (type === TYPE.OPT) {
        // The OPT record reuses the record header's fields for other things:
        // CLASS carries the payload size, and the top byte of TTL the version.
        const cookie = findOptionInRdata(message, offset + 10, size, OPT_OPTION.COOKIE);
        return {
          payloadSize: message.readUInt16BE(offset + 2),
          version: message.readUInt8(offset + 4),
          ...(cookie ? { cookie } : {}),
        };
      }
      offset += 10 + size;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Reads a name, following compression pointers.
 *
 * Every pointer must move strictly backwards. That single rule is what stops a
 * name from pointing at itself or at a later pointer that points back -- a
 * message a stranger can send, which would otherwise loop forever inside this
 * process.
 */
export function readName(message: Buffer, start: number): { name: string; offset: number } {
  const labels: string[] = [];
  let offset = start;
  let afterPointer: number | undefined;
  let limit = start;
  let bytes = 0;

  for (;;) {
    if (offset >= message.length) throw new WireFormatError("name runs past the end of the message");
    const length = message[offset] as number;
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= message.length) throw new WireFormatError("compression pointer is truncated");
      const target = ((length & 0x3f) << 8) | (message[offset + 1] as number);
      if (target >= limit) throw new WireFormatError("compression pointer does not move backwards");
      if (afterPointer === undefined) afterPointer = offset + 2;
      limit = target;
      offset = target;
      continue;
    }
    // This is also the 63-byte label limit. The two top bits are the only thing
    // that distinguishes a length from a pointer, so any byte above 63 that is
    // not a pointer is rejected right here, and a separate length check below
    // would be one no message could ever reach.
    if ((length & 0xc0) !== 0) throw new WireFormatError("label length has reserved bits set");
    offset += 1;
    if (length === 0) break;
    if (offset + length > message.length) throw new WireFormatError("label runs past the end of the message");
    bytes += length + 1;
    if (bytes > MAX_NAME_BYTES) throw new WireFormatError("name is longer than 255 bytes");
    // A label may hold any byte, `.` included, and this codebase carries a name
    // as one dotted string. Without escaping, a single 11-byte label spelling
    // `example.com` read back identical to the two-label name and was answered
    // for as though it were the zone apex. Presentation format has always
    // spelled it this way; `writeName` reads the escape back.
    labels.push(message.toString("latin1", offset, offset + length)
      .replace(/\\/gu, "\\\\")
      .replace(/\./gu, "\\."));
    offset += length;
  }
  return { name: labels.join(".").toLowerCase(), offset: afterPointer ?? offset };
}

/** Encodes a name uncompressed. Compression is not used: the saving is small. */
export function writeName(name: string): Buffer {
  // The root, and the null MX/SRV/SVCB target that is spelled the same way.
  if (name === "" || name === ".") return Buffer.of(0);
  const parts = splitEscapedName(name);
  // A trailing dot is the root label, which the terminator below already writes.
  if (parts.at(-1) === "") parts.pop();
  if (parts.length === 0) return Buffer.of(0);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const label = Buffer.from(part, "latin1");
    if (label.length === 0 || label.length > MAX_LABEL_BYTES) throw new WireFormatError(`invalid label in ${name}`);
    chunks.push(Buffer.of(label.length), label);
  }
  chunks.push(Buffer.of(0));
  const encoded = Buffer.concat(chunks);
  if (encoded.length > MAX_NAME_BYTES) throw new WireFormatError(`name ${name} is longer than 255 bytes`);
  return encoded;
}

/**
 * Splits on the dots that separate labels, leaving the escaped ones alone.
 *
 * `readName` writes `\\.` for a dot inside a label and `\\\\` for a backslash, so
 * this is the other half of that round trip -- without it, echoing the question
 * back would split one label into two and the reply would not match the query.
 */
function splitEscapedName(name: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < name.length; index += 1) {
    const character = name[index];
    if (character === "\\" && index + 1 < name.length) {
      current += name[index + 1];
      index += 1;
      continue;
    }
    if (character === ".") {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

export interface ResourceRecord {
  readonly name: string;
  readonly type: number;
  readonly ttl: number;
  readonly data: Buffer;
}

export interface ReplyParts {
  readonly query: ParsedQuery;
  readonly rcode: number;
  readonly authoritative: boolean;
  readonly answers?: readonly ResourceRecord[];
  readonly authority?: readonly ResourceRecord[];
  /**
   * The EDNS COOKIE to send back: the client's 8 bytes followed by this
   * server's. Omitted when the client sent none, which is every client that
   * does not implement RFC 7873.
   */
  readonly cookie?: Buffer;
}

/**
 * Builds a reply, and truncates it if the client cannot take it whole.
 *
 * `truncated` is not a failure: it tells the client to ask again over TCP, and
 * a client that does not is one that would have received a mangled answer
 * instead. A 420-byte DKIM record makes this ordinary rather than exotic.
 */
export function writeReply(parts: ReplyParts, maxBytes: number): Buffer {
  const answers = parts.answers ?? [];
  const authority = parts.authority ?? [];
  const full = assemble(parts, answers, authority);
  if (full.length <= maxBytes) return full;
  return writeTruncatedReply(parts);
}

/**
 * The reply with nothing in it and TC set: the question, the OPT record, and
 * the instruction to ask again over TCP.
 *
 * Reached two ways. A reply too large for the client's advertised size takes
 * this because the alternative is a mangled answer -- and a listener refusing
 * to hand a large answer to an address that has not proved it is there takes
 * it because that is the whole point: small in, small out.
 */
export function writeTruncatedReply(parts: ReplyParts): Buffer {
  const empty = assemble(parts, [], []);
  const header = Buffer.from(empty.subarray(0, empty.length));
  header.writeUInt16BE(header.readUInt16BE(2) | 0x0200, 2);
  return header;
}

function assemble(parts: ReplyParts, answers: readonly ResourceRecord[], authority: readonly ResourceRecord[]): Buffer {
  const { query } = parts;
  // Echo the opcode and RD from the query; set QR, and AA when we are the
  // authority. RA is set only when the answer came from somewhere that recurses.
  let flags = 0x8000 | (query.flags & 0x7900) | (parts.rcode & 0x000f);
  if (parts.authoritative) flags |= 0x0400;

  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16BE(query.id, 0);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authority.length, 8);
  header.writeUInt16BE(query.hasOpt ? 1 : 0, 10);

  const chunks = [header, writeName(query.question.name), Buffer.alloc(4)];
  chunks[2]?.writeUInt16BE(query.question.type, 0);
  chunks[2]?.writeUInt16BE(query.question.class, 2);
  for (const record of [...answers, ...authority]) chunks.push(writeRecord(record));
  if (query.hasOpt) chunks.push(writeOpt(query.udpPayloadSize, parts.rcode, parts.cookie));
  return Buffer.concat(chunks);
}

function writeRecord(record: ResourceRecord): Buffer {
  const name = writeName(record.name);
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(record.type, 0);
  fixed.writeUInt16BE(CLASS_IN, 2);
  fixed.writeUInt32BE(record.ttl, 4);
  fixed.writeUInt16BE(record.data.length, 8);
  return Buffer.concat([name, fixed, record.data]);
}

/** Answers the client's OPT with our own, so EDNS stays negotiated. */
function writeOpt(payloadSize: number, rcode: number, cookie?: Buffer): Buffer {
  const options = cookie
    ? (() => {
      const header = Buffer.alloc(4);
      header.writeUInt16BE(OPT_OPTION.COOKIE, 0);
      header.writeUInt16BE(cookie.length, 2);
      return Buffer.concat([header, cookie]);
    })()
    : Buffer.alloc(0);
  const opt = Buffer.alloc(11);
  opt.writeUInt8(0, 0);
  opt.writeUInt16BE(TYPE.OPT, 1);
  opt.writeUInt16BE(payloadSize, 3);
  // An rcode is 12 bits once EDNS is in play, and only the low four fit in the
  // header. The top eight live in the first byte of this record's TTL field --
  // which is why BADVERS (16) cannot be told to a client that sent no OPT, and
  // why nothing above 15 could be said at all until this was written.
  opt.writeUInt8((rcode >> 4) & 0xff, 5);
  opt.writeUInt16BE(options.length, 9);
  return Buffer.concat([opt, options]);
}

export function typeName(type: number): string {
  return TYPE_NAMES.get(type) ?? `TYPE${type}`;
}
