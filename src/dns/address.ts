import { isIP } from "node:net";

/**
 * One spelling per address, so two spellings of the same one compare equal.
 *
 * The loop checks used to compare strings, and an address has many: deny
 * `2001:db8::10` and an upstream written `[2001:0db8:0:0:0:0:0:10]` were two
 * different things to them and one thing to the network. IPv6 is compressed and
 * lowercased the way the URL parser does it; an IPv4-mapped IPv6 address is the
 * IPv4 address it maps. Anything that is not an address comes back unchanged
 * (lowercased) -- a hostname is compared after it resolves, not before.
 */
export function canonicalAddress(value: string): string {
  const bare = value.trim().replace(/^\[|\]$/gu, "").toLowerCase();
  if (isIP(bare) !== 6) return bare;
  // A zone id (`fe80::1%en0`) is part of a link-local address and not something
  // the URL parser accepts; it is kept, and only the address before it is
  // compressed.
  const zone = bare.indexOf("%");
  if (zone >= 0) return `${canonicalAddress(bare.slice(0, zone))}${bare.slice(zone)}`;
  const compressed = new URL(`http://[${bare}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(compressed);
  if (!mapped) return compressed;
  const high = Number.parseInt(mapped[1] as string, 16);
  const low = Number.parseInt(mapped[2] as string, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** Loopback is a range, not one address: anything in 127/8 reaches a listener on it. */
export function isLoopbackAddress(value: string): boolean {
  const address = canonicalAddress(value);
  return address === "::1" || address === "localhost" || (isIP(address) === 4 && address.startsWith("127."));
}

/** The spellings a listener uses for "every address on this host". */
export function isWildcardListener(host: string): boolean {
  const address = canonicalAddress(host);
  return address === "0.0.0.0" || address === "::" || address === "*";
}
