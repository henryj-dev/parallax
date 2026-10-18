import { isIPv4, isIPv6 } from "node:net";

/**
 * The unit an attempt limit counts a client by.
 *
 * One IPv6 subscriber usually holds a whole /64, so counting each address would let one client
 * look like 2^64 clients. IPv6 is therefore counted by its /64 prefix, IPv4 by its address, and an
 * IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) as the IPv4 address it carries. A key that is not an
 * address -- a test client, a proxy label -- is counted as itself.
 */
export function clientBucket(key: string): string {
  // A key is counted by the client it names, never by its spelling.
  const address = withoutPort(key.trim());
  if (isIPv4(address)) return `ipv4:${address}`;
  const zoneless = address.replace(/%.*$/u, "");
  // Anything that is not an address shares one bucket: a forged or odd value must not buy a fresh limit.
  if (!isIPv6(zoneless)) return "other";
  const groups = ipv6Groups(zoneless);
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) return `ipv4:${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  return `ipv6:${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/** `1.2.3.4:80` and `[2001:db8::1]:443` name the address before the port; a bare IPv6 address is left alone. */
function withoutPort(value: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/u.exec(value);
  if (bracketed) return bracketed[1]!;
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/u.exec(value);
  return v4 ? v4[1]! : value;
}

/**
 * The eight 16-bit groups of an address `isIPv6` already accepted. The WHATWG URL parser does the
 * normalization (case, embedded IPv4, compression), so only its canonical form is read here.
 */
function ipv6Groups(address: string): number[] {
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head = "", tail] = canonical.split("::");
  const read = (part: string): number[] => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
  const front = read(head), back = tail === undefined ? [] : read(tail);
  return [...front, ...Array.from({ length: 8 - front.length - back.length }, () => 0), ...back];
}
