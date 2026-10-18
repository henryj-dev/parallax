import { isIP } from "node:net";
import { canonicalAddress } from "../address.ts";
import { cidrsContain, compileCidrs, parseIpBytes, prefixMatches, type CompiledCidr } from "../cidr.ts";

/**
 * Whether a probe may connect to an address, decided before any socket opens.
 *
 * The address comes from a record an editor wrote, and the probe is a
 * connection this process makes on its own behalf -- so without this, a record
 * is a way to make the control plane reach whatever it can reach. Two layers:
 * ranges no health check ever has a reason to touch are refused outright, and
 * everything else must sit inside a network and on a port an administrator
 * allowed. An empty allow-list allows nothing.
 */

export type ProbeBlockReason =
  | "not-an-address"
  | "zone-id"
  | "reserved-range"
  | "translated-range"
  | "outside-allowed-networks"
  | "port-not-allowed";

/**
 * Ranges refused whatever the allow-list says. An administrator who writes
 * `0.0.0.0/0` has not asked for the metadata service or this host's loopback,
 * and those are the two a request forger wants.
 */
const ALWAYS_BLOCKED = compileCidrs([
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "fe80::/10",
  "ff00::/8",
  "fd00:ec2::254/128",
  // Metadata and platform endpoints outside the link-local range: Alibaba
  // Cloud's metadata service and Azure's platform (WireServer) address.
  "100.100.100.200/32",
  "168.63.129.16/32",
], "health check");

/**
 * Prefixes whose addresses stand for some other address. A gateway turns them
 * into IPv4 somewhere this check cannot see, so the allow-list would be judging
 * the wrong address.
 */
const TRANSLATED = compileCidrs([
  // IPv4-compatible (deprecated) and SIIT IPv4-translated addresses.
  "::/96",
  "::ffff:0:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  // Teredo and 6to4 carry an IPv4 address inside the IPv6 one.
  "2001::/32",
  "2002::/16",
], "health check");

export interface ProbeAllowList {
  readonly networks: readonly CompiledCidr[];
  readonly ports: ReadonlySet<number>;
}

export function compileProbeAllowList(cidrs: readonly string[], ports: readonly number[]): ProbeAllowList {
  return { networks: compileCidrs(cidrs, "health check"), ports: new Set(ports) };
}

/** The address a probe would connect to: IPv4-mapped folded, IPv6 compressed. */
export function probeAddress(address: string): string {
  return canonicalAddress(address);
}

export function probeBlockReason(address: string, port: number, allow: ProbeAllowList): ProbeBlockReason | undefined {
  const trimmed = address.trim();
  if (trimmed.includes("%")) return "zone-id";
  const canonical = probeAddress(trimmed);
  if (isIP(canonical) === 0) return "not-an-address";
  const bytes = parseIpBytes(canonical);
  if (!bytes) return "not-an-address";
  // 240.0.0.0/4 also covers limited broadcast, 255.255.255.255. Checked first,
  // so `::` and `::1` are reported as what they are rather than as translated.
  if (matchesAny(ALWAYS_BLOCKED, bytes)) return "reserved-range";
  if (matchesAny(TRANSLATED, bytes)) return "translated-range";
  if (!cidrsContain(allow.networks, canonical)) return "outside-allowed-networks";
  if (!allow.ports.has(port)) return "port-not-allowed";
  return undefined;
}

function matchesAny(cidrs: readonly CompiledCidr[], bytes: Uint8Array): boolean {
  return cidrs.some((cidr) => cidr.address.length === bytes.length && prefixMatches(cidr.address, bytes, cidr.prefix));
}
