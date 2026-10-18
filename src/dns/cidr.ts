import { isIP } from "node:net";

/**
 * CIDR matching shared by the listener's client ACLs and the health checks'
 * target allow-list. Moved here unchanged from `server.ts` so both read one
 * definition of what an address and a prefix are.
 *
 * `parseIpBytes` folds an IPv4-mapped IPv6 address to its four IPv4 bytes and
 * drops a `%zone` suffix, which is what a socket peer address needs. A caller
 * that must refuse zone ids has to do so before calling it.
 */

export interface CompiledCidr {
  readonly address: Uint8Array;
  readonly prefix: number;
}

export function compileCidrs(values: readonly string[], label = "DNS client"): CompiledCidr[] {
  return values.map((source) => {
    const value = source.trim();
    const slash = value.lastIndexOf("/");
    const addressText = slash < 0 ? value : value.slice(0, slash);
    const address = parseIpBytes(addressText);
    if (!address) throw new Error(`invalid ${label} CIDR: ${source}`);
    const bits = address.length * 8;
    const prefixText = slash < 0 ? String(bits) : value.slice(slash + 1);
    if (!/^\d{1,3}$/u.test(prefixText)) throw new Error(`invalid ${label} CIDR prefix: ${source}`);
    const prefix = Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
      throw new Error(`invalid ${label} CIDR prefix: ${source}`);
    }
    return { address, prefix };
  });
}

export function cidrsContain(cidrs: readonly CompiledCidr[], source: string): boolean {
  const address = parseIpBytes(source);
  if (!address) return false;
  return cidrs.some((cidr) => cidr.address.length === address.length
    && prefixMatches(cidr.address, address, cidr.prefix));
}

export function prefixMatches(network: Uint8Array, address: Uint8Array, prefix: number): boolean {
  const complete = Math.floor(prefix / 8);
  for (let index = 0; index < complete; index += 1) {
    if (network[index] !== address[index]) return false;
  }
  const remainder = prefix % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((network[complete] ?? 0) & mask) === ((address[complete] ?? 0) & mask);
}

export function parseIpBytes(source: string): Uint8Array | undefined {
  const unbracketed = source.trim().replace(/^\[|\]$/gu, "").split("%")[0] ?? "";
  if (isIP(unbracketed) === 4) return Uint8Array.from(unbracketed.split(".").map(Number));
  if (isIP(unbracketed) !== 6) return undefined;

  let value = unbracketed.toLowerCase();
  const embedded = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u.exec(value)?.[1];
  if (embedded) {
    const bytes = embedded.split(".").map(Number);
    const replacement = `${((bytes[0] ?? 0) << 8 | (bytes[1] ?? 0)).toString(16)}:${((bytes[2] ?? 0) << 8 | (bytes[3] ?? 0)).toString(16)}`;
    value = `${value.slice(0, -embedded.length)}${replacement}`;
  }
  const halves = value.split("::");
  const left = (halves[0] ?? "").split(":").filter(Boolean);
  const right = (halves[1] ?? "").split(":").filter(Boolean);
  const missing = 8 - left.length - right.length;
  const groups = halves.length === 1 ? left : [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    const parsed = Number.parseInt(group, 16);
    bytes[index * 2] = parsed >>> 8;
    bytes[index * 2 + 1] = parsed & 0xff;
  }
  // Node commonly reports IPv4 TCP peers in this mapped form.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes.slice(12);
  }
  return bytes;
}
