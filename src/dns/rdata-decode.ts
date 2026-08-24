import type { RecordType } from "../domain/dns.ts";
import { readName, WireFormatError } from "./wire.ts";

/**
 * The other direction: the bytes a resolver sent back, as the presentation text
 * Parallax stores.
 *
 * `encodeRdata` was the only direction that existed, because until something
 * had to *read* a zone nothing needed this. An AXFR client does -- and it needs
 * it for records this control plane did not write, which is exactly the case a
 * shortcut cannot cover.
 *
 * 🔑 **The rule every decoder here obeys: emit only text `encodeRdata` will
 * take back to the same bytes.** Where that is not possible -- a value carrying
 * whitespace the encoder would split on, a version this build does not know --
 * it throws rather than returning something that looks like content and is not.
 * A record whose content silently changed on the way in is worse than a record
 * that could not be read, because the second one says so.
 *
 * `test/dns/rdata-round-trip.test.ts` holds that rule to the encoder for every
 * type, which is what makes the pair safe to trust.
 */

/**
 * The rdata is well formed and this control plane cannot hold it.
 *
 * Separate from `WireFormatError`, which says the bytes are wrong. A zone is
 * allowed to contain records Parallax has no way to store, and the difference
 * decides what the caller does: refuse the whole transfer, or carry on and
 * report the one record.
 */
export class UnrepresentableRdata extends Error {
  override readonly name = "UnrepresentableRdata";
}

type Decoder = (view: RdataView) => string;

/** The rdata, plus the message around it, because a name in here may be a pointer. */
interface RdataView {
  readonly message: Buffer;
  readonly start: number;
  readonly end: number;
  offset: number;
}

export function decodeRdata(type: RecordType, message: Buffer, start: number, length: number): string {
  const end = start + length;
  if (end > message.length) throw new WireFormatError(`${type} rdata runs past the end of the message`);
  const view: RdataView = { message, start, end, offset: start };
  const content = DECODERS[type](view);
  if (view.offset !== end) {
    throw new WireFormatError(`${type} rdata is ${end - start} bytes and ${view.offset - start} were understood`);
  }
  return content;
}

/**
 * One for every type the domain accepts, required by the compiler the same way
 * the encoders are -- so a type cannot be added, stored and served while being
 * unreadable back off the wire.
 */
const DECODERS: Record<RecordType, Decoder> = {
  A: (view) => Array.from(take(view, 4)).join("."),
  AAAA: (view) => formatIpv6(take(view, 16)),
  CNAME: (view) => name(view),
  NS: (view) => name(view),
  PTR: (view) => name(view),
  DNAME: (view) => name(view),
  TXT: (view) => {
    // Joined only where the encoder would have split. It splits one value at
    // exactly 255 bytes, so a 420-byte DKIM record arrives in two pieces and is
    // one string -- but two *short* strings are two strings, and RFC 6763 §6.1
    // gives each of them its own meaning. Concatenating them read a DNS-SD
    // record's `path=/x` `port=8080` as the single key `path=/xport=8080`, and
    // writing that back would have changed the record the zone serves.
    const parts: Buffer[] = [];
    while (view.offset < view.end) {
      const part = characterString(view);
      const more = view.offset < view.end;
      if (more && part.length !== 255) {
        throw new UnrepresentableRdata("TXT carries several strings, which this control plane stores as one value");
      }
      parts.push(part);
    }
    return text(Buffer.concat(parts), "TXT");
  },
  MX: (view) => `${uint16(view)} ${name(view)}`,
  SRV: (view) => `${uint16(view)} ${uint16(view)} ${uint16(view)} ${name(view)}`,
  CAA: (view) => {
    const flag = uint8(view);
    const tag = characterString(view).toString("ascii");
    // RFC 8659 §4.1.1: a non-zero sequence of US-ASCII letters and digits. A
    // tag with a space in it decoded into text the encoder read as two fields
    // and silently shortened; an empty one made it read one field too few.
    if (!/^[A-Za-z0-9]+$/u.test(tag)) throw new UnrepresentableRdata("CAA carries a tag that is not letters and digits");
    return `${flag} ${tag} ${quote(text(rest(view), "CAA"), "CAA")}`;
  },
  TLSA: (view) => certificateAssociation(view),
  SMIMEA: (view) => certificateAssociation(view),
  SSHFP: (view) => `${uint8(view)} ${uint8(view)} ${hex(view, "SSHFP")}`,
  URI: (view) => {
    const priority = uint16(view);
    const weight = uint16(view);
    return `${priority} ${weight} ${quote(text(rest(view), "URI"), "URI")}`;
  },
  CERT: (view) => `${uint16(view)} ${uint16(view)} ${uint8(view)} ${base64(view, "CERT")}`,
  OPENPGPKEY: (view) => base64(view, "OPENPGPKEY"),
  HINFO: (view) => {
    const cpu = text(characterString(view), "HINFO");
    const os = text(characterString(view), "HINFO");
    return `${quote(cpu, "HINFO")} ${quote(os, "HINFO")}`;
  },
  NAPTR: (view) => {
    const order = uint16(view);
    const preference = uint16(view);
    const flags = text(characterString(view), "NAPTR");
    const service = text(characterString(view), "NAPTR");
    const regexp = text(characterString(view), "NAPTR");
    // Quoted even when empty, because the encoder's pattern requires all three.
    return `${order} ${preference} ${quote(flags, "NAPTR")} ${quote(service, "NAPTR")} ${quote(regexp, "NAPTR")} ${name(view)}`;
  },
  SVCB: (view) => serviceBinding(view, "SVCB"),
  HTTPS: (view) => serviceBinding(view, "HTTPS"),
  DS: (view) => `${uint16(view)} ${uint8(view)} ${uint8(view)} ${hex(view, "DS")}`,
  DNSKEY: (view) => `${uint16(view)} ${uint8(view)} ${uint8(view)} ${base64(view, "DNSKEY")}`,
  LOC: (view) => location(view),
};

// ------------------------------------------------------------------ readers --

function take(view: RdataView, count: number): Buffer {
  if (view.offset + count > view.end) throw new WireFormatError("rdata ended early");
  const slice = view.message.subarray(view.offset, view.offset + count);
  view.offset += count;
  return slice;
}

function rest(view: RdataView): Buffer {
  return take(view, view.end - view.offset);
}

function uint8(view: RdataView): number {
  return take(view, 1).readUInt8(0);
}

function uint16(view: RdataView): number {
  return take(view, 2).readUInt16BE(0);
}

/**
 * A name, following a compression pointer where there is one.
 *
 * The classic types may compress the name inside their rdata, and a server
 * answering AXFR does. `readName` already walks pointers, so what this adds is
 * moving the rdata cursor by the *encoded* length rather than by wherever the
 * pointer landed.
 */
function name(view: RdataView): string {
  const read = readName(view.message, view.offset);
  if (read.offset <= view.offset || read.offset > view.end) {
    throw new WireFormatError("a name in this rdata does not fit inside it");
  }
  view.offset = read.offset;
  // The encoder splits content on whitespace before it reads anything, so a
  // label carrying a space shifts every field after it -- loud for MX, silent
  // for SVCB, where it moves the parameter list.
  if (/[\s]/u.test(read.name)) {
    throw new UnrepresentableRdata("a name in this rdata carries whitespace, which this presentation format cannot express");
  }
  // `readName` gives the root as an empty string, and presentation format
  // spells it `.` -- the null MX target, an SVCB target meaning the owner. The
  // empty string is not merely unconventional here: it would collapse into the
  // space beside it and the encoder, which splits on whitespace, would read one
  // field fewer than was written.
  return read.name === "" ? "." : read.name;
}

function characterString(view: RdataView): Buffer {
  const length = uint8(view);
  return take(view, length);
}

function certificateAssociation(view: RdataView): string {
  return `${uint8(view)} ${uint8(view)} ${uint8(view)} ${hex(view, "certificate association")}`;
}

/**
 * A trailing field the encoder requires to be there.
 *
 * An empty digest or key decoded to text ending in a space, which the encoder
 * then refused for having one field too few -- so the failure arrived from the
 * wrong layer, naming the wrong record.
 */
function hex(view: RdataView, type: string): string {
  const bytes = rest(view);
  if (bytes.length === 0) throw new UnrepresentableRdata(`${type} carries no data where the format requires some`);
  return bytes.toString("hex");
}

function base64(view: RdataView, type: string): string {
  const bytes = rest(view);
  if (bytes.length === 0) throw new UnrepresentableRdata(`${type} carries no data where the format requires some`);
  return bytes.toString("base64");
}

/**
 * Bytes as text, only where they are text.
 *
 * `toString("utf8")` replaces every invalid byte with U+FFFD, and one byte
 * becomes three -- so a character-string carrying arbitrary octets came back
 * changed, and a 255-byte one came back too long for the encoder to write.
 * RFC 1035 §3.3 makes these octets, not characters; the escape that would carry
 * them (`\DDD`, §5.1) is not one this build's encoder reads.
 */
function text(bytes: Buffer, type: string): string {
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) {
    throw new UnrepresentableRdata(`${type} carries bytes that are not text this control plane can store`);
  }
  return decoded;
}

// ----------------------------------------------------------------- shaping --

/**
 * A value the encoder will read back whole.
 *
 * It splits content on whitespace before doing anything else, so a value that
 * carries a space survives only inside quotes -- and a quote or backslash in
 * the value has to be escaped or it ends the string early.
 */
function quote(value: string, type: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new UnrepresentableRdata(`${type} carries a control character that presentation format cannot hold`);
  }
  return `"${value.replace(/(["\\])/gu, "\\$1")}"`;
}

/**
 * RFC 5952: lowercase, no leading zeros, and the longest run of two or more
 * zero groups collapsed once.
 *
 * The canonical form matters here because this text goes into the desired
 * state and is compared against what an operator wrote. Two spellings of one
 * address would read as drift on every reconcile.
 */
function formatIpv6(bytes: Buffer): string {
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index));

  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let index = 0; index <= groups.length; index += 1) {
    if (index < groups.length && groups[index] === 0) {
      if (runStart < 0) runStart = index;
      continue;
    }
    if (runStart >= 0) {
      const length = index - runStart;
      if (length > bestLength) {
        bestStart = runStart;
        bestLength = length;
      }
      runStart = -1;
    }
  }
  // RFC 5952 §5: an IPv4-mapped address is written with the dotted tail. The
  // encoder accepts and expands that form, so without this an operator who
  // wrote `::ffff:192.0.2.1` read `::ffff:c000:201` back off the wire and
  // reconciliation saw drift on every single cycle, forever.
  if (bytes.subarray(0, 10).every((byte) => byte === 0) && bytes.readUInt16BE(10) === 0xffff) {
    return `::ffff:${Array.from(bytes.subarray(12)).join(".")}`;
  }
  const parts = groups.map((group) => group.toString(16));
  if (bestLength < 2) return parts.join(":");
  const head = parts.slice(0, bestStart).join(":");
  const tail = parts.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

// ------------------------------------------------------------------- SVCB --

const SVC_PARAM_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: "mandatory", 1: "alpn", 2: "no-default-alpn", 3: "port", 4: "ipv4hint", 5: "ech", 6: "ipv6hint", 7: "dohpath",
});

function svcParamName(key: number): string {
  return SVC_PARAM_NAMES[key] ?? `key${key}`;
}

function serviceBinding(view: RdataView, type: string): string {
  const priority = uint16(view);
  const target = name(view);
  if (priority === 0) {
    // RFC 9460 §2.4.2: in AliasMode "recipients MUST ignore any SvcParams that
    // are present". Refusing them failed the whole transfer over one record in
    // somebody else's zone, which is the opposite of what a reader should do.
    view.offset = view.end;
    return `${priority} ${target}`;
  }
  const parameters: string[] = [];
  let previousKey = -1;
  while (view.offset < view.end) {
    const key = uint16(view);
    // The encoder always writes them in ascending key order and refuses a
    // repeat, so an answer that is not sorted could not be written back.
    if (key <= previousKey) throw new UnrepresentableRdata(`${type} parameters are not in ascending key order`);
    previousKey = key;
    const value = take(view, uint16(view));
    parameters.push(svcParam(key, value, type));
  }
  return [priority, target, ...parameters].join(" ");
}

function svcParam(key: number, value: Buffer, type: string): string {
  const label = svcParamName(key);
  if (key === 2) {
    if (value.length > 0) throw new WireFormatError(`${type} parameter ${label} carries a value`);
    return label;
  }
  if (key === 0) {
    const keys: string[] = [];
    let previous = -1;
    for (let offset = 0; offset + 2 <= value.length; offset += 2) {
      const named = value.readUInt16BE(offset);
      // RFC 9460 §8: the list is sorted, has no duplicates, and does not name
      // `mandatory` itself. A receiver is entitled to reject a record that
      // breaks any of the three, so carrying one through would put a record
      // into the desired state that some resolvers refuse.
      if (named <= previous) throw new UnrepresentableRdata(`${type} parameter ${label} is not a sorted list of distinct keys`);
      if (named === 0) throw new UnrepresentableRdata(`${type} parameter ${label} names itself`);
      previous = named;
      keys.push(svcParamName(named));
    }
    if (keys.length * 2 !== value.length) throw new WireFormatError(`${type} parameter ${label} is not a list of keys`);
    if (keys.length === 0) throw new UnrepresentableRdata(`${type} parameter ${label} names nothing`);
    return `${label}=${keys.join(",")}`;
  }
  if (key === 1) {
    const entries: string[] = [];
    let offset = 0;
    while (offset < value.length) {
      const length = value.readUInt8(offset);
      const entry = value.subarray(offset + 1, offset + 1 + length);
      if (entry.length !== length) throw new WireFormatError(`${type} parameter ${label} is truncated`);
      entries.push(entry.toString("utf8"));
      offset += 1 + length;
    }
    return `${label}=${listed(entries, label, type)}`;
  }
  if (key === 3) {
    if (value.length !== 2) throw new WireFormatError(`${type} parameter ${label} is not a port`);
    return `${label}=${value.readUInt16BE(0)}`;
  }
  if (key === 4 || key === 6) {
    const width = key === 4 ? 4 : 16;
    if (value.length === 0 || value.length % width !== 0) throw new WireFormatError(`${type} parameter ${label} is not a list of addresses`);
    const addresses: string[] = [];
    for (let offset = 0; offset < value.length; offset += width) {
      const slice = value.subarray(offset, offset + width);
      addresses.push(width === 4 ? Array.from(slice).join(".") : formatIpv6(slice));
    }
    return `${label}=${addresses.join(",")}`;
  }
  if (key === 5) return `${label}=${value.toString("base64")}`;
  // `dohpath` and anything written as `keyNNNNN`: the value is its bytes.
  return `${label}=${unspaced(text(value, `${type} parameter ${label}`), label, type)}`;
}

/** The encoder splits on whitespace before it sees quotes, so this cannot hold any. */
function unspaced(value: string, label: string, type: string): string {
  if (/\s/u.test(value)) {
    throw new UnrepresentableRdata(`${type} parameter ${label} carries whitespace, which this presentation format cannot express`);
  }
  return value;
}

/**
 * A comma-separated list, refused when an item contains the separator.
 *
 * RFC 9460 Appendix A.1 escapes a comma inside an item as `\,`; this build's
 * encoder splits on commas without reading escapes, so a single alpn-id of
 * `h2,3` came back as the two ids `h2` and `3` -- a different record, silently.
 */
function listed(entries: readonly string[], label: string, type: string): string {
  for (const entry of entries) {
    if (entry.includes(",")) {
      throw new UnrepresentableRdata(`${type} parameter ${label} carries a comma inside one of its values`);
    }
  }
  return unspaced(entries.join(","), label, type);
}

// -------------------------------------------------------------------- LOC --

function location(view: RdataView): string {
  const version = uint8(view);
  if (version !== 0) throw new UnrepresentableRdata(`LOC version ${version} is not one this build understands`);
  const size = centimetres(uint8(view));
  const horizontal = centimetres(uint8(view));
  const vertical = centimetres(uint8(view));
  // RFC 1876 §3 bounds these; outside them `sexagesimal` produces degrees no
  // reader would accept and the value is not a location.
  const latitude = bounded(arc(uint32(view)), 90 * 3_600_000, "latitude");
  const longitude = bounded(arc(uint32(view)), 180 * 3_600_000, "longitude");
  const altitude = (uint32(view) - 10_000_000) / 100;
  return [
    sexagesimal(latitude, "N", "S"),
    sexagesimal(longitude, "E", "W"),
    `${trim(altitude)}m`, `${trim(size)}m`, `${trim(horizontal)}m`, `${trim(vertical)}m`,
  ].join(" ");
}

function bounded(thousandths: number, limit: number, what: string): number {
  if (Math.abs(thousandths) > limit) throw new UnrepresentableRdata(`LOC carries a ${what} outside the range the format defines`);
  return thousandths;
}

function uint32(view: RdataView): number {
  return take(view, 4).readUInt32BE(0);
}

/** A mantissa in the high nibble, a power of ten in the low one, counting centimetres. */
function centimetres(byte: number): number {
  const mantissa = byte >> 4;
  const exponent = byte & 0x0f;
  // RFC 1876 §2: "a pair of four-bit unsigned integers, each ranging from zero
  // to nine". Above nine the encoder cannot write the value back -- it clamps
  // the mantissa at 9 -- so the record would come back a different size.
  if (mantissa > 9 || exponent > 9) throw new UnrepresentableRdata("LOC carries a size outside the range the format defines");
  return (mantissa * 10 ** exponent) / 100;
}

/** Thousandths of an arcsecond, offset from the midpoint the format counts from. */
function arc(value: number): number {
  return value - 2_147_483_648;
}

function sexagesimal(thousandths: number, positive: string, negative: string): string {
  const total = Math.abs(thousandths);
  const degrees = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = (total % 60_000) / 1000;
  return `${degrees} ${minutes} ${trim(seconds)} ${thousandths < 0 ? negative : positive}`;
}

/** Whole numbers stay whole, so `1m` does not come back as `1.000m`. */
function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
