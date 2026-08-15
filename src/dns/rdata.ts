import { isIP } from "node:net";
import type { RecordType } from "../domain/dns.ts";
import { TYPE, WireFormatError, writeName } from "./wire.ts";

/**
 * Turns the RDATA Parallax stores -- presentation format, the text a zone file
 * puts after the type -- into the bytes that go on the wire.
 *
 * The desired state already holds every value in the one form, so this is the
 * only place that has to know what each type's fields are, and it is the same
 * knowledge the domain validates with. A type it cannot encode is reported
 * rather than skipped: a record that silently does not get served is the
 * failure this whole control plane exists to make visible.
 */
type Encoder = (content: string, fields: string[]) => Buffer;

/**
 * An encoder for every type the domain accepts, required by the compiler rather
 * than by a memory. A `switch` with a `default` that throws would let a type be
 * added to `RECORD_TYPES`, validated, published, and then not answered for --
 * and nothing would say so until a query arrived.
 */
const ENCODERS: Record<RecordType, Encoder> = {
  A: (content) => encodeIpv4(content),
  AAAA: (content) => encodeIpv6(content),
  CNAME: (content) => writeName(content),
  NS: (content) => writeName(content),
  PTR: (content) => writeName(content),
  DNAME: (content) => writeName(content),
  TXT: (content) => encodeCharacterStrings(content),
  MX: (_content, fields) => {
    exactly(fields, 2, "MX", "a preference and a hostname");
    return Buffer.concat([uint16(fields[0]), writeName(fields[1] as string)]);
  },
  SRV: (_content, fields) => {
    exactly(fields, 4, "SRV", "a priority, a weight, a port and a target");
    return Buffer.concat([uint16(fields[0]), uint16(fields[1]), uint16(fields[2]), writeName(fields[3] as string)]);
  },
  CAA: (content, fields) => encodeCaa(content, fields),
  TLSA: (_content, fields) => encodeCertificateAssociation(fields, "TLSA"),
  SMIMEA: (_content, fields) => encodeCertificateAssociation(fields, "SMIMEA"),
  SSHFP: (_content, fields) => {
    exactly(fields, 3, "SSHFP", "an algorithm, a fingerprint type and hexadecimal data");
    return Buffer.concat([uint8(fields[0]), uint8(fields[1]), hex(fields[2])]);
  },
  URI: (content, fields) => {
    atLeast(fields, 3, "URI", "a priority, a weight and a quoted target");
    return Buffer.concat([uint16(fields[0]), uint16(fields[1]), Buffer.from(unquote(content), "utf8")]);
  },
  CERT: (_content, fields) => {
    exactly(fields, 4, "CERT", "a type, a key tag, an algorithm and base64 data");
    return Buffer.concat([uint16(fields[0]), uint16(fields[1]), uint8(fields[2]), base64(fields[3])]);
  },
  OPENPGPKEY: (content) => base64(content),
  HINFO: (content) => encodeHinfo(content),
  NAPTR: (content) => encodeNaptr(content),
  SVCB: (_content, fields) => encodeServiceBinding(fields, "SVCB"),
  HTTPS: (_content, fields) => encodeServiceBinding(fields, "HTTPS"),
  DS: (_content, fields) => {
    exactly(fields, 4, "DS", "a key tag, an algorithm, a digest type and hexadecimal data");
    return Buffer.concat([uint16(fields[0]), uint8(fields[1]), uint8(fields[2]), hex(fields[3])]);
  },
  DNSKEY: (_content, fields) => {
    exactly(fields, 4, "DNSKEY", "flags, a protocol, an algorithm and base64 key data");
    return Buffer.concat([uint16(fields[0]), uint8(fields[1]), uint8(fields[2]), base64(fields[3])]);
  },
  LOC: (_content, fields) => encodeLocation(fields),
};

export function encodeRdata(type: RecordType, content: string): Buffer {
  const fields = content.split(/\s+/u).filter((field) => field.length > 0);
  return ENCODERS[type](content, fields);
}

/** SOA is synthesized rather than stored, so it is built from its parts. */
export function encodeSoa(primary: string, mailbox: string, serial: number, negativeTtl: number): Buffer {
  const numbers = Buffer.alloc(20);
  numbers.writeUInt32BE(serial, 0);
  numbers.writeUInt32BE(3600, 4);
  numbers.writeUInt32BE(600, 8);
  numbers.writeUInt32BE(604_800, 12);
  numbers.writeUInt32BE(negativeTtl, 16);
  return Buffer.concat([writeName(primary), writeName(mailbox), numbers]);
}

/** Total, because `TYPE` is required to name every type the domain accepts. */
export function rrType(type: RecordType): number {
  return TYPE[type];
}

function encodeIpv4(value: string): Buffer {
  if (isIP(value) !== 4) throw new WireFormatError(`${value} is not an IPv4 address`);
  return Buffer.from(value.split(".").map(Number));
}

function encodeIpv6(value: string): Buffer {
  if (isIP(value) !== 6) throw new WireFormatError(`${value} is not an IPv6 address`);
  // Expanded here rather than by a parser: the groups are already the answer,
  // and `::` is the only thing that has to be counted out.
  const [head, tail] = value.split("::") as [string, string | undefined];
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const middle = new Array(8 - left.length - right.length).fill("0");
  const groups = tail === undefined ? left : [...left, ...middle, ...right];
  const out = Buffer.alloc(16);
  groups.forEach((group, index) => out.writeUInt16BE(Number.parseInt(group || "0", 16), index * 2));
  return out;
}

/**
 * TXT is a sequence of character-strings, each at most 255 bytes. Longer values
 * are split, which every provider does and which is why a 420-byte DKIM record
 * arrives in two pieces and means one value.
 */
function encodeCharacterStrings(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 255) {
    const slice = bytes.subarray(offset, offset + 255);
    chunks.push(Buffer.of(slice.length), slice);
  }
  return chunks.length === 0 ? Buffer.of(0) : Buffer.concat(chunks);
}

function encodeCaa(content: string, fields: string[]): Buffer {
  // Not field-counted: a CAA value legitimately carries spaces, as in
  // `0 issue "ca.example.net; account=123"`.
  atLeast(fields, 3, "CAA", "a flag, a tag and a quoted value");
  const tag = Buffer.from(fields[1] as string, "ascii");
  const value = Buffer.from(unquote(content), "utf8");
  return Buffer.concat([uint8(fields[0]), Buffer.of(tag.length), tag, value]);
}

function encodeCertificateAssociation(fields: string[], type: string): Buffer {
  exactly(fields, 4, type, "a usage, a selector, a matching type and hexadecimal data");
  return Buffer.concat([uint8(fields[0]), uint8(fields[1]), uint8(fields[2]), hex(fields[3])]);
}

function encodeHinfo(content: string): Buffer {
  const quoted = [...content.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((match) => match[1] ?? "");
  if (quoted.length !== 2) throw new WireFormatError("HINFO needs two quoted strings");
  return Buffer.concat(quoted.map((part) => characterString(unescape(part), "HINFO")));
}

/**
 * `100 10 "s" "SIP+D2U" "" _sip._udp.example.com`.
 *
 * Matched whole rather than split on whitespace: the three character-strings
 * are quoted precisely because a regexp field may contain spaces, and a split
 * would tear one in half and encode the pieces as separate fields.
 */
const NAPTR = /^(\d+)\s+(\d+)\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"\s+(\S+)$/u;

function encodeNaptr(content: string): Buffer {
  const match = NAPTR.exec(content.trim());
  if (!match) {
    throw new WireFormatError('NAPTR needs two numbers, three quoted strings and a replacement, as in `100 10 "s" "SIP+D2U" "" _sip._udp.example.com`');
  }
  return Buffer.concat([
    uint16(match[1]), uint16(match[2]),
    characterString(unescape(match[3] as string), "NAPTR"),
    characterString(unescape(match[4] as string), "NAPTR"),
    characterString(unescape(match[5] as string), "NAPTR"),
    writeName(match[6] as string),
  ]);
}

/** The parameter keys RFC 9460 names, and the number each goes on the wire as. */
const SVC_PARAM_KEYS = Object.freeze({
  mandatory: 0, alpn: 1, "no-default-alpn": 2, port: 3, ipv4hint: 4, ech: 5, ipv6hint: 6, dohpath: 7,
} as const);

/**
 * `1 svc.example.net alpn=h2,h3 port=8443`, and the alias form `0 target`.
 *
 * Parameters go on the wire in ascending key order whatever order they were
 * written in, and a repeated key is refused: a receiver is entitled to reject
 * both, and finding that out from a browser that quietly stopped upgrading is
 * the failure this encoder exists to prevent.
 */
/**
 * RFC 1876. The three sizes are not stored as numbers but as one byte each:
 * a mantissa in the high nibble and a power of ten in the low one, counting
 * centimetres. Encoding is therefore lossy by design -- 1m and 1.004m are the
 * same byte -- which is why the round trip is checked against what a resolver
 * reads back rather than against what was written.
 *
 * Latitude and longitude are unsigned offsets from a midpoint, so the equator
 * and the prime meridian are 2^31 rather than zero, and altitude counts from
 * 100km below the reference spheroid.
 */
function encodeLocation(fields: readonly string[]): Buffer {
  const northSouth = fields.findIndex((field) => /^[NS]$/iu.test(field));
  const eastWest = fields.findIndex((field) => /^[EW]$/iu.test(field));
  if (northSouth < 0 || eastWest <= northSouth) throw new WireFormatError("LOC needs a latitude and a longitude");
  const latitude = arcThousandths(fields.slice(0, northSouth), (fields[northSouth] as string).toUpperCase() === "S");
  const longitude = arcThousandths(fields.slice(northSouth + 1, eastWest), (fields[eastWest] as string).toUpperCase() === "W");
  const rest = fields.slice(eastWest + 1).map((value) => Number(value.replace(/m$/iu, "")));
  if (rest.length === 0 || rest.some((value) => !Number.isFinite(value))) throw new WireFormatError("LOC needs an altitude");
  const out = Buffer.alloc(16);
  out.writeUInt8(0, 0);
  out.writeUInt8(centimetreExponent(rest[1] ?? 1), 1);
  out.writeUInt8(centimetreExponent(rest[2] ?? 10_000), 2);
  out.writeUInt8(centimetreExponent(rest[3] ?? 10), 3);
  out.writeUInt32BE(2_147_483_648 + latitude, 4);
  out.writeUInt32BE(2_147_483_648 + longitude, 8);
  out.writeUInt32BE(Math.round((rest[0] as number) * 100) + 10_000_000, 12);
  return out;
}

/** Degrees, minutes and seconds to thousandths of an arcsecond. */
function arcThousandths(parts: readonly string[], negative: boolean): number {
  const [degrees = "0", minutes = "0", seconds = "0"] = parts;
  const total = Math.round(((Number(degrees) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000);
  return negative ? -total : total;
}

function centimetreExponent(metres: number): number {
  const centimetres = Math.round(metres * 100);
  if (centimetres <= 0) return 0;
  let exponent = 0;
  let mantissa = centimetres;
  while (mantissa > 9 && exponent < 9) {
    mantissa = Math.round(mantissa / 10);
    exponent += 1;
  }
  return (Math.min(mantissa, 9) << 4) | exponent;
}

function encodeServiceBinding(fields: string[], type: string): Buffer {
  atLeast(fields, 2, type, "a priority and a target");
  const priority = uint16(fields[0]);
  const target = writeName(fields[1] as string);
  const parameters = fields.slice(2);
  // Priority 0 is the alias form, which names another owner and carries nothing
  // else. Parameters there would be dropped by the receiver, so they are
  // refused here instead of being encoded into an answer nobody reads.
  if (priority.readUInt16BE(0) === 0 && parameters.length > 0) {
    throw new WireFormatError(`${type} priority 0 is the alias form and takes no parameters`);
  }
  const encoded = new Map<number, Buffer>();
  for (const parameter of parameters) {
    const equals = parameter.indexOf("=");
    const name = equals === -1 ? parameter : parameter.slice(0, equals);
    const value = equals === -1 ? undefined : stripQuotes(parameter.slice(equals + 1));
    const key = svcParamKey(name, type);
    if (encoded.has(key)) throw new WireFormatError(`${type} parameter ${name} is given more than once`);
    encoded.set(key, svcParamValue(key, name, value, type));
  }
  const chunks = [priority, target];
  for (const [key, value] of [...encoded].sort(([left], [right]) => left - right)) {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(key, 0);
    header.writeUInt16BE(value.length, 2);
    chunks.push(header, value);
  }
  return Buffer.concat(chunks);
}

function svcParamKey(name: string, type: string): number {
  const known = (SVC_PARAM_KEYS as Record<string, number | undefined>)[name];
  if (known !== undefined) return known;
  // `keyNNNNN` is how a parameter this build has no name for is written, and
  // carrying it through is what lets a zone use one without a release here.
  const generic = /^key(\d{1,5})$/u.exec(name);
  if (generic) return bounded(generic[1], 0xffff);
  throw new WireFormatError(`${type} parameter ${name} is not a known key, and is not written as keyNNNNN`);
}

function svcParamValue(key: number, name: string, value: string | undefined, type: string): Buffer {
  if (key === SVC_PARAM_KEYS["no-default-alpn"]) {
    if (value !== undefined) throw new WireFormatError(`${type} parameter ${name} takes no value`);
    return Buffer.alloc(0);
  }
  if (value === undefined) throw new WireFormatError(`${type} parameter ${name} needs a value`);
  switch (key) {
    case SVC_PARAM_KEYS.mandatory:
      return Buffer.concat(list(value, name, type).map((entry) => {
        const buffer = Buffer.alloc(2);
        buffer.writeUInt16BE(svcParamKey(entry, type), 0);
        return buffer;
      }));
    case SVC_PARAM_KEYS.alpn:
      return Buffer.concat(list(value, name, type).map((entry) => characterString(entry, type)));
    case SVC_PARAM_KEYS.port:
      return uint16(value);
    case SVC_PARAM_KEYS.ipv4hint:
      return Buffer.concat(list(value, name, type).map(encodeIpv4));
    case SVC_PARAM_KEYS.ipv6hint:
      return Buffer.concat(list(value, name, type).map(encodeIpv6));
    case SVC_PARAM_KEYS.ech:
      return base64(value);
    default:
      // `dohpath` and anything written as `keyNNNNN`: the value is its bytes.
      return Buffer.from(value, "utf8");
  }
}

function list(value: string, name: string, type: string): string[] {
  const entries = value.split(",").filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new WireFormatError(`${type} parameter ${name} needs at least one value`);
  return entries;
}

function stripQuotes(value: string): string {
  return /^".*"$/su.test(value) ? unescape(value.slice(1, -1)) : value;
}

/** The last quoted string in the content, which is where these types put theirs. */
function unquote(content: string): string {
  const quoted = [...content.matchAll(/"((?:[^"\\]|\\.)*)"/gu)];
  const last = quoted.at(-1)?.[1];
  if (last === undefined) throw new WireFormatError("expected a quoted value");
  return unescape(last);
}

function unescape(value: string): string {
  return value.replace(/\\(.)/gu, "$1");
}

/** One length-prefixed string. The length is a single byte, so 255 is the limit. */
function characterString(value: string, what: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 255) throw new WireFormatError(`${what} cannot carry a string longer than 255 bytes`);
  return Buffer.concat([Buffer.of(bytes.length), bytes]);
}

function exactly(fields: string[], count: number, type: string, shape: string): void {
  if (fields.length !== count) throw new WireFormatError(`${type} content must be ${shape}`);
}

function atLeast(fields: string[], count: number, type: string, shape: string): void {
  if (fields.length < count) throw new WireFormatError(`${type} content must be ${shape}`);
}

function uint8(value: string | undefined): Buffer {
  return Buffer.of(bounded(value, 0xff));
}

function uint16(value: string | undefined): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(bounded(value, 0xffff));
  return out;
}

function bounded(value: string | undefined, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new WireFormatError(`${value} is not a number 0..${max}`);
  return parsed;
}

function hex(value: string | undefined): Buffer {
  if (value === undefined || value.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(value)) {
    throw new WireFormatError("expected hexadecimal data");
  }
  return Buffer.from(value, "hex");
}

function base64(value: string | undefined): Buffer {
  if (value === undefined || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new WireFormatError("expected base64 data");
  return Buffer.from(value, "base64");
}
