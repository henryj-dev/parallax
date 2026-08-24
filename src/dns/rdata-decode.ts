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
    // Joined, not separated: the encoder splits one value at 255 bytes, so the
    // pieces are one string and a 420-byte DKIM record arrives in two.
    const parts: Buffer[] = [];
    while (view.offset < view.end) parts.push(characterString(view));
    return Buffer.concat(parts).toString("utf8");
  },
  MX: (view) => `${uint16(view)} ${name(view)}`,
  SRV: (view) => `${uint16(view)} ${uint16(view)} ${uint16(view)} ${name(view)}`,
  CAA: (view) => {
    const flag = uint8(view);
    const tag = characterString(view).toString("ascii");
    const value = rest(view).toString("utf8");
    return `${flag} ${tag} ${quote(value, "CAA")}`;
  },
  TLSA: (view) => certificateAssociation(view),
  SMIMEA: (view) => certificateAssociation(view),
  SSHFP: (view) => `${uint8(view)} ${uint8(view)} ${rest(view).toString("hex")}`,
  URI: (view) => {
    const priority = uint16(view);
    const weight = uint16(view);
    return `${priority} ${weight} ${quote(rest(view).toString("utf8"), "URI")}`;
  },
  CERT: (view) => `${uint16(view)} ${uint16(view)} ${uint8(view)} ${rest(view).toString("base64")}`,
  OPENPGPKEY: (view) => rest(view).toString("base64"),
  HINFO: (view) => {
    const cpu = characterString(view).toString("utf8");
    const os = characterString(view).toString("utf8");
    return `${quote(cpu, "HINFO")} ${quote(os, "HINFO")}`;
  },
  NAPTR: (view) => {
    const order = uint16(view);
    const preference = uint16(view);
    const flags = characterString(view).toString("utf8");
    const service = characterString(view).toString("utf8");
    const regexp = characterString(view).toString("utf8");
    // Quoted even when empty, because the encoder's pattern requires all three.
    return `${order} ${preference} ${quote(flags, "NAPTR")} ${quote(service, "NAPTR")} ${quote(regexp, "NAPTR")} ${name(view)}`;
  },
  SVCB: (view) => serviceBinding(view, "SVCB"),
  HTTPS: (view) => serviceBinding(view, "HTTPS"),
  DS: (view) => `${uint16(view)} ${uint8(view)} ${uint8(view)} ${rest(view).toString("hex")}`,
  DNSKEY: (view) => `${uint16(view)} ${uint8(view)} ${uint8(view)} ${rest(view).toString("base64")}`,
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
  return `${uint8(view)} ${uint8(view)} ${uint8(view)} ${rest(view).toString("hex")}`;
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
    throw new WireFormatError(`${type} carries a control character that presentation format cannot hold`);
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
  const text = groups.map((group) => group.toString(16));
  if (bestLength < 2) return text.join(":");
  const head = text.slice(0, bestStart).join(":");
  const tail = text.slice(bestStart + bestLength).join(":");
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
  if (priority === 0 && view.offset < view.end) {
    // The encoder refuses parameters on the alias form, so emitting them would
    // produce content that cannot be written back.
    throw new WireFormatError(`${type} priority 0 is the alias form and this answer carries parameters`);
  }
  const parameters: string[] = [];
  let previousKey = -1;
  while (view.offset < view.end) {
    const key = uint16(view);
    // The encoder always writes them in ascending key order and refuses a
    // repeat, so an answer that is not sorted could not be written back.
    if (key <= previousKey) throw new WireFormatError(`${type} parameters are not in ascending key order`);
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
    for (let offset = 0; offset + 2 <= value.length; offset += 2) keys.push(svcParamName(value.readUInt16BE(offset)));
    if (keys.length * 2 !== value.length) throw new WireFormatError(`${type} parameter ${label} is not a list of keys`);
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
    return `${label}=${unspaced(entries.join(","), label, type)}`;
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
  return `${label}=${unspaced(value.toString("utf8"), label, type)}`;
}

/** The encoder splits on whitespace before it sees quotes, so this cannot hold any. */
function unspaced(value: string, label: string, type: string): string {
  if (/\s/u.test(value)) {
    throw new WireFormatError(`${type} parameter ${label} carries whitespace, which presentation format cannot express here`);
  }
  return value;
}

// -------------------------------------------------------------------- LOC --

function location(view: RdataView): string {
  const version = uint8(view);
  if (version !== 0) throw new WireFormatError(`LOC version ${version} is not one this build understands`);
  const size = centimetres(uint8(view));
  const horizontal = centimetres(uint8(view));
  const vertical = centimetres(uint8(view));
  const latitude = arc(uint32(view));
  const longitude = arc(uint32(view));
  const altitude = (uint32(view) - 10_000_000) / 100;
  return [
    sexagesimal(latitude, "N", "S"),
    sexagesimal(longitude, "E", "W"),
    `${trim(altitude)}m`, `${trim(size)}m`, `${trim(horizontal)}m`, `${trim(vertical)}m`,
  ].join(" ");
}

function uint32(view: RdataView): number {
  return take(view, 4).readUInt32BE(0);
}

/** A mantissa in the high nibble, a power of ten in the low one, counting centimetres. */
function centimetres(byte: number): number {
  return ((byte >> 4) * 10 ** (byte & 0x0f)) / 100;
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
