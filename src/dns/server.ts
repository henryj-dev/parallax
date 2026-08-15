import { createSocket, type Socket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Server, type Socket as TcpSocket } from "node:net";
import { performance } from "node:perf_hooks";
import type { RecordType } from "../domain/dns.ts";
import { encodeRdata, encodeSoa, rrType } from "./rdata.ts";
import {
  CLASS_IN, MIN_UDP_PAYLOAD, RCODE, TYPE, WireFormatError,
  isResponseToQuery, readQuery, writeReply, type ParsedQuery, type ResourceRecord,
} from "./wire.ts";

/** One zone's answers, as the control plane computed them. */
export interface ServedZone {
  /** Apex, lowercased, no trailing dot. */
  readonly name: string;
  readonly records: readonly { name: string; type: RecordType; content: string; ttl: number }[];
  /** Rises with each published revision so caches and secondaries notice. */
  readonly serial: number;
}

/** A stored record that reached the wire and could not be written to it. */
export interface UnservableRecord {
  readonly zone: string;
  readonly name: string;
  readonly type: RecordType;
  readonly reason: string;
}

export interface DnsServerOptions {
  /** Read on every query, so a refreshed snapshot takes effect without a restart. */
  readonly zones: () => readonly ServedZone[];
  /** Where names outside every zone go. Empty means answer REFUSED instead. */
  readonly forwardTo?: readonly string[];
  /** Client CIDRs allowed to use recursion. Defaults to loopback only. */
  readonly forwardAllow?: readonly string[];
  readonly negativeTtl?: number;
  readonly forwardTimeoutMs?: number;
  readonly maxConcurrentForwards?: number;
  readonly tcpIdleTimeoutMs?: number;
  readonly maxTcpConnections?: number;
  readonly rateLimitPerSecond?: number;
  readonly rateLimitBurst?: number;
  /** Injected only by deterministic tests. */
  readonly now?: () => number;
  /** Resolves a bind or upstream hostname to the address both transports use. */
  readonly resolveHost?: (host: string) => Promise<ResolvedDnsAddress>;
  /**
   * Told about a record that could not be encoded. Everything reaching here has
   * already passed the domain's validation, so this fires on stored content the
   * domain accepted and the wire cannot carry -- which is a defect somebody has
   * to be told about, not a record to quietly leave out.
   */
  readonly onUnservable?: (record: UnservableRecord) => void;
}

export interface ResolvedDnsAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

const DEFAULT_NEGATIVE_TTL = 60;
const DEFAULT_FORWARD_TIMEOUT_MS = 4000;
const DEFAULT_FORWARD_ALLOW = ["127.0.0.0/8", "::1/128"];
const DEFAULT_MAX_CONCURRENT_FORWARDS = 256;
const DEFAULT_TCP_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TCP_CONNECTIONS = 1024;
const DEFAULT_RATE_LIMIT_PER_SECOND = 100;
const DEFAULT_RATE_LIMIT_BURST = 200;

/**
 * Answers for the zones this control plane holds, and forwards everything else.
 *
 * Both halves in one listener is the point. An authoritative server refuses
 * what is not its own, so something in front has to know which names are whose
 * -- and that knowledge then lives in a list on every resolver, maintained by
 * hand, growing stale the moment a zone is added. Here the list is the desired
 * state itself, so adding a zone changes nothing anywhere else.
 */
export function createDnsServer(options: DnsServerOptions): {
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
} {
  const negativeTtl = options.negativeTtl ?? DEFAULT_NEGATIVE_TTL;
  const forwardTo = options.forwardTo ?? [];
  const forwardTimeoutMs = options.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
  const forwardAllow = compileCidrs(options.forwardAllow ?? DEFAULT_FORWARD_ALLOW);
  const maxConcurrentForwards = positiveInteger(options.maxConcurrentForwards ?? DEFAULT_MAX_CONCURRENT_FORWARDS, "maxConcurrentForwards");
  const tcpIdleTimeoutMs = positiveInteger(options.tcpIdleTimeoutMs ?? DEFAULT_TCP_IDLE_TIMEOUT_MS, "tcpIdleTimeoutMs");
  const maxTcpConnections = positiveInteger(options.maxTcpConnections ?? DEFAULT_MAX_TCP_CONNECTIONS, "maxTcpConnections");
  const rateLimiter = createRateLimiter(
    positiveInteger(options.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT_PER_SECOND, "rateLimitPerSecond"),
    positiveInteger(options.rateLimitBurst ?? DEFAULT_RATE_LIMIT_BURST, "rateLimitBurst"),
    options.now ?? Date.now,
  );
  const resolveHost = options.resolveHost ?? resolveDnsAddress;
  const resolveForwardHost = createTimedDnsResolver(resolveHost);
  let udp: Socket | undefined;
  let tcp: Server | undefined;
  const tcpSockets = new Set<TcpSocket>();
  let activeForwards = 0;

  async function respond(message: Buffer, overTcp: boolean, clientAddress: string): Promise<Buffer | undefined> {
    let query;
    try {
      query = readQuery(message);
    } catch (error) {
      // Not answerable and not worth a reply that quotes it back.
      if (error instanceof WireFormatError) return undefined;
      throw error;
    }
    const zone = matchZone(options.zones(), query.question.name);
    if (!zone) {
      if (forwardTo.length === 0) {
        return writeReply({ query, rcode: RCODE.REFUSED, authoritative: false }, Number.MAX_SAFE_INTEGER);
      }
      if (!cidrsContain(forwardAllow, clientAddress)) {
        return writeReply({ query, rcode: RCODE.REFUSED, authoritative: false }, Number.MAX_SAFE_INTEGER);
      }
      if (activeForwards >= maxConcurrentForwards) {
        return writeReply({ query, rcode: RCODE.SERVFAIL, authoritative: false }, Number.MAX_SAFE_INTEGER);
      }
      activeForwards += 1;
      let forwarded: Buffer | undefined;
      try {
        forwarded = await forward(message, query, forwardTo, forwardTimeoutMs, overTcp, resolveForwardHost);
      } finally {
        activeForwards -= 1;
      }
      return forwarded ?? writeReply({ query, rcode: RCODE.SERVFAIL, authoritative: false }, Number.MAX_SAFE_INTEGER);
    }
    const parts = answerFromZone(query, zone, negativeTtl, options.onUnservable);
    return writeReply(parts, overTcp ? Number.MAX_SAFE_INTEGER : query.udpPayloadSize);
  }

  return {
    async listen(port, host) {
      const binding = await resolveHost(host);
      assertResolvedAddress(binding, host);
      // UDP sockets are family-specific. The TCP listener accepts either
      // family from a hostname, so bind both transports to this one numeric
      // result instead of letting their separate resolvers choose differently.
      udp = createSocket({ type: binding.family === 6 ? "udp6" : "udp4", reuseAddr: true });
      udp.on("message", (message, remote) => {
        if (!rateLimiter.allow(remote.address)) return;
        void respond(message, false, remote.address).then((reply) => {
          if (reply) udp?.send(reply, remote.port, remote.address);
        }).catch(() => undefined);
      });
      tcp = createServer((socket) => {
        tcpSockets.add(socket);
        socket.setTimeout(tcpIdleTimeoutMs, () => socket.destroy());
        socket.on("close", () => tcpSockets.delete(socket));
        // A TCP message is length-prefixed, and may arrive in pieces.
        let buffered = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          buffered = Buffer.concat([buffered, chunk]);
          for (;;) {
            if (buffered.length < 2) return;
            const size = buffered.readUInt16BE(0);
            if (buffered.length < size + 2) return;
            const message = buffered.subarray(2, size + 2);
            buffered = buffered.subarray(size + 2);
            const clientAddress = socket.remoteAddress;
            if (!clientAddress || !rateLimiter.allow(clientAddress)) continue;
            void respond(message, true, clientAddress).then((reply) => {
              if (!reply) return;
              const framed = Buffer.alloc(2 + reply.length);
              framed.writeUInt16BE(reply.length, 0);
              reply.copy(framed, 2);
              socket.write(framed);
            }).catch(() => socket.destroy());
          }
        });
        socket.on("error", () => socket.destroy());
      });
      tcp.maxConnections = maxTcpConnections;
      await Promise.all([
        new Promise<void>((resolve, reject) => { udp?.once("error", reject); udp?.bind(port, binding.address, resolve); }),
        new Promise<void>((resolve, reject) => { tcp?.once("error", reject); tcp?.listen(port, binding.address, resolve); }),
      ]);
    },
    async close() {
      for (const socket of tcpSockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => { if (udp) udp.close(resolve); else resolve(); }),
        new Promise<void>((resolve) => { if (tcp) tcp.close(() => resolve()); else resolve(); }),
      ]);
    },
  };
}

/** The longest zone whose apex the name sits at or under. */
function matchZone(zones: readonly ServedZone[], name: string): ServedZone | undefined {
  let best: ServedZone | undefined;
  for (const zone of zones) {
    if (name !== zone.name && !name.endsWith(`.${zone.name}`)) continue;
    if (!best || zone.name.length > best.name.length) best = zone;
  }
  return best;
}

/**
 * Builds the answer for a name inside a zone we are authoritative for.
 *
 * The two negatives are different and a resolver treats them differently: a
 * name with no records of the asked type is NOERROR with nothing in it, and a
 * name that does not exist at all is NXDOMAIN. Both carry the SOA so the
 * resolver knows how long it may remember the absence.
 */
function answerFromZone(
  query: ReturnType<typeof readQuery>,
  zone: ServedZone,
  negativeTtl: number,
  onUnservable: DnsServerOptions["onUnservable"],
) {
  const name = query.question.name;
  const soa = soaRecord(zone, negativeTtl);
  let atName: ServedZone["records"] = zone.records.filter((record) => absolute(record.name, zone.name) === name);

  if (atName.length === 0) {
    // The name exists without holding anything of its own when something sits
    // below it, and the apex always exists. Either way the answer is empty
    // rather than NXDOMAIN, and no wildcard may cover a name that exists.
    const exists = name === zone.name
      || zone.records.some((record) => absolute(record.name, zone.name).endsWith(`.${name}`));
    if (exists) return { query, rcode: RCODE.NOERROR, authoritative: true, authority: [soa] };
    atName = wildcardMatch(zone, name);
    if (atName.length === 0) return { query, rcode: RCODE.NXDOMAIN, authoritative: true, authority: [soa] };
  }
  // A CNAME answers for every type, which is why it may not share a name.
  const alias = atName.find((record) => record.type === "CNAME");
  const wanted = query.question.type === TYPE.ANY
    ? atName
    : alias && query.question.type !== TYPE.CNAME ? [alias]
    : atName.filter((record) => rrType(record.type) === query.question.type);

  if (wanted.length === 0) return { query, rcode: RCODE.NOERROR, authoritative: true, authority: [soa] };
  const answers: ResourceRecord[] = [];
  let unservable = false;
  for (const record of wanted) {
    try {
      answers.push({ name, type: rrType(record.type), ttl: record.ttl, data: encodeRdata(record.type, record.content) });
    } catch (error) {
      // The whole RRset fails, not just this record. Half an RRset is the
      // dangerous answer: it looks complete, a resolver caches it, and whoever
      // depended on the addresses that went missing finds out later and
      // elsewhere. SERVFAIL is loud, and it is not cached as an answer.
      unservable = true;
      onUnservable?.({ zone: zone.name, name: record.name, type: record.type, reason: message(error) });
    }
  }
  if (unservable) return { query, rcode: RCODE.SERVFAIL, authoritative: true };
  return { query, rcode: RCODE.NOERROR, authoritative: true, answers };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * The records a wilddcard covering this name holds, or none.
 *
 * The desired state accepts `*` and `*.name`, and every other publisher of the
 * internal view expands them -- a zone file, PowerDNS and Cloudflare all do.
 * Taking them literally here would answer NXDOMAIN for names the same desired
 * state resolves everywhere else.
 *
 * The walk goes upwards from the queried name's parent and stops at the first
 * wildcard it finds, so `*.eu.example.com` answers for `shop.eu.example.com`
 * and `*.example.com` does not get the chance. A name that exists never reaches
 * here, which is the rule that keeps a wildcard from answering over a real one.
 */
function wildcardMatch(zone: ServedZone, name: string): ServedZone["records"] {
  let parent = name.slice(name.indexOf(".") + 1);
  for (;;) {
    const covering = `*.${parent}`;
    const records = zone.records.filter((record) => absolute(record.name, zone.name) === covering);
    if (records.length > 0) return records;
    if (parent === zone.name || !parent.includes(".")) return [];
    parent = parent.slice(parent.indexOf(".") + 1);
  }
}

function soaRecord(zone: ServedZone, negativeTtl: number): ResourceRecord {
  return {
    name: zone.name,
    type: TYPE.SOA,
    ttl: negativeTtl,
    data: encodeSoa(`ns.${zone.name}`, `hostmaster.${zone.name}`, zone.serial, negativeTtl),
  };
}

function absolute(name: string, zone: string): string {
  return name === "@" ? zone : `${name}.${zone}`.toLowerCase();
}

/**
 * Hands the query on unchanged and relays what comes back.
 *
 * The answer remains byte-for-byte intact, but its correlation fields are
 * parsed before relay. A connected UDP socket lets the kernel reject any other
 * source; the DNS checks reject stale or forged datagrams from the right peer.
 */
async function forward(
  message: Buffer,
  query: ParsedQuery,
  upstreams: readonly string[],
  timeoutMs: number,
  overTcp: boolean,
  resolveHost: (host: string, timeoutMs: number) => Promise<ResolvedDnsAddress | undefined>,
): Promise<Buffer | undefined> {
  for (const upstream of upstreams) {
    const [host, port] = splitUpstream(upstream);
    const deadline = performance.now() + timeoutMs;
    let resolved: ResolvedDnsAddress;
    try {
      const candidate = await resolveHost(host, timeoutMs);
      if (!candidate) continue;
      resolved = candidate;
      assertResolvedAddress(resolved, host);
    } catch {
      continue;
    }
    const remainingMs = Math.ceil(deadline - performance.now());
    if (remainingMs <= 0) continue;
    // Preserve the client's transport: a TCP retry relayed over UDP could only
    // return another truncated reply. Both paths validate DNS correlation data.
    const reply = overTcp
      ? await relayOverTcp(message, query, resolved.address, port, remainingMs)
      : await relayOverUdp(message, query, resolved.address, resolved.family, port, remainingMs);
    if (reply) return reply;
  }
  return undefined;
}

/**
 * Shares one raw lookup per host and gives every caller a bounded wait.
 *
 * `dns.lookup()` cannot be cancelled. Merely racing it with a timer would let
 * every new query start another abandoned lookup after its application-level
 * timeout. Keeping the unresolved promise here bounds that backlog to one raw
 * lookup per configured upstream while still releasing the forwarding slot.
 */
export function createTimedDnsResolver(
  resolveHost: (host: string) => Promise<ResolvedDnsAddress>,
): (host: string, timeoutMs: number) => Promise<ResolvedDnsAddress | undefined> {
  interface PendingResolution {
    readonly waiters: Set<(value: ResolvedDnsAddress | undefined) => void>;
  }
  const pending = new Map<string, PendingResolution>();
  return (host, timeoutMs) => {
    const key = normalizeDnsHost(host).toLowerCase();
    let resolution = pending.get(key);
    if (!resolution) {
      resolution = { waiters: new Set() };
      pending.set(key, resolution);
      const current = resolution;
      const finish = (value: ResolvedDnsAddress | undefined): void => {
        if (pending.get(key) === current) pending.delete(key);
        for (const waiter of current.waiters) waiter(value);
        current.waiters.clear();
      };
      // Exactly one reaction observes the uncancellable raw lookup. Application
      // callers subscribe to the removable Set below, so timed-out closures do
      // not accumulate forever on a stalled Promise.
      void Promise.resolve().then(() => resolveHost(host)).then(finish, () => finish(undefined));
    }
    const current = resolution;
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const complete = (value: ResolvedDnsAddress | undefined): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        current.waiters.delete(complete);
        resolve(value);
      };
      current.waiters.add(complete);
      timer = setTimeout(() => complete(undefined), timeoutMs);
      timer.unref();
    });
  };
}

function relayOverUdp(
  message: Buffer,
  query: ParsedQuery,
  host: string,
  family: 4 | 6,
  port: number,
  timeoutMs: number,
): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket(family === 6 ? "udp6" : "udp4");
    let settled = false;
    const done = (value: Buffer | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* The connect may have failed before bind. */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    timer.unref();
    socket.on("message", (answer) => {
      if (isResponseToQuery(answer, query)) done(answer);
    });
    socket.once("error", () => done(undefined));
    // Connected UDP makes the kernel reject datagrams from every other source
    // address or port before the DNS-level checks above run.
    socket.connect(port, host, () => {
      socket.send(message, (error) => { if (error) done(undefined); });
    });
  });
}

function relayOverTcp(
  message: Buffer,
  query: ParsedQuery,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const framed = Buffer.alloc(2 + message.length);
    framed.writeUInt16BE(message.length, 0);
    message.copy(framed, 2);
    const socket = connect(port, host, () => socket.write(framed));
    let buffered = Buffer.alloc(0);
    let settled = false;
    const done = (value: Buffer | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    timer.unref();
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const size = buffered.readUInt16BE(0);
        if (buffered.length < size + 2) return;
        // Consume every complete frame, including a forged or stale one, so a
        // later valid reply on the same connection still has a chance to win.
        const answer = Buffer.from(buffered.subarray(2, size + 2));
        buffered = buffered.subarray(size + 2);
        if (isResponseToQuery(answer, query)) {
          done(answer);
          return;
        }
      }
    });
    socket.on("error", () => done(undefined));
    socket.on("close", () => done(undefined));
  });
}

function splitUpstream(value: string): [string, number] {
  const [host, port] = value.split("#") as [string, string | undefined];
  return [host, port === undefined ? 53 : Number(port)];
}

async function resolveDnsAddress(source: string): Promise<ResolvedDnsAddress> {
  const host = normalizeDnsHost(source);
  const literalFamily = isIP(host);
  if (literalFamily === 4 || literalFamily === 6) {
    return { address: host, family: literalFamily };
  }
  const resolved = await lookup(host);
  const family = isIP(resolved.address);
  if ((family !== 4 && family !== 6) || family !== resolved.family) {
    throw new Error(`DNS host did not resolve to an IPv4 or IPv6 address: ${source}`);
  }
  return { address: resolved.address, family };
}

function normalizeDnsHost(source: string): string {
  const host = source.trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    if (isIP(inner) === 6) return inner;
  }
  return host;
}

function assertResolvedAddress(value: ResolvedDnsAddress, source: string): void {
  const family = isIP(value.address);
  if ((family !== 4 && family !== 6) || family !== value.family) {
    throw new Error(`DNS host resolver returned an invalid address for ${source}`);
  }
}

interface CompiledCidr {
  readonly address: Uint8Array;
  readonly prefix: number;
}

function compileCidrs(values: readonly string[]): CompiledCidr[] {
  return values.map((source) => {
    const value = source.trim();
    const slash = value.lastIndexOf("/");
    const addressText = slash < 0 ? value : value.slice(0, slash);
    const address = parseIpBytes(addressText);
    if (!address) throw new Error(`invalid DNS client CIDR: ${source}`);
    const bits = address.length * 8;
    const prefixText = slash < 0 ? String(bits) : value.slice(slash + 1);
    if (!/^\d{1,3}$/u.test(prefixText)) throw new Error(`invalid DNS client CIDR prefix: ${source}`);
    const prefix = Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
      throw new Error(`invalid DNS client CIDR prefix: ${source}`);
    }
    return { address, prefix };
  });
}

function cidrsContain(cidrs: readonly CompiledCidr[], source: string): boolean {
  const address = parseIpBytes(source);
  if (!address) return false;
  return cidrs.some((cidr) => cidr.address.length === address.length
    && prefixMatches(cidr.address, address, cidr.prefix));
}

function prefixMatches(network: Uint8Array, address: Uint8Array, prefix: number): boolean {
  const complete = Math.floor(prefix / 8);
  for (let index = 0; index < complete; index += 1) {
    if (network[index] !== address[index]) return false;
  }
  const remainder = prefix % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((network[complete] ?? 0) & mask) === ((address[complete] ?? 0) & mask);
}

function parseIpBytes(source: string): Uint8Array | undefined {
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function createRateLimiter(ratePerSecond: number, burst: number, now: () => number): { allow(address: string): boolean } {
  const clients = new Map<string, { tokens: number; at: number }>();
  const maxClients = 10_000;
  const idleExpiryMs = Math.max(1000, Math.ceil(burst * 1000 / ratePerSecond));
  let lastSweep = Number.NEGATIVE_INFINITY;
  return {
    allow(address) {
      const parsed = parseIpBytes(address);
      const key = parsed ? `${parsed.length}:${[...parsed].join(".")}` : address;
      const time = now();
      let client = clients.get(key);
      if (!client) {
        // Do not evict a live bucket merely because a new spoofed source was
        // observed: cycling enough source addresses would otherwise reset the
        // victim's allowance. Expired buckets are swept at most once a second;
        // if the table is still full, an unknown client fails closed.
        if (clients.size >= maxClients && time - lastSweep >= 1000) {
          for (const [candidate, state] of clients) {
            if (time - state.at >= idleExpiryMs) clients.delete(candidate);
          }
          lastSweep = time;
        }
        if (clients.size >= maxClients) return false;
        client = { tokens: burst, at: time };
        clients.set(key, client);
      }
      const elapsed = Math.max(0, time - client.at);
      client.tokens = Math.min(burst, client.tokens + elapsed * ratePerSecond / 1000);
      client.at = time;
      if (client.tokens < 1) return false;
      client.tokens -= 1;
      return true;
    },
  };
}

export { CLASS_IN, MIN_UDP_PAYLOAD };
