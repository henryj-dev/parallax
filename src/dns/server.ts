import { createSocket, type Socket } from "node:dgram";
import { connect, createServer, type Server } from "node:net";
import type { RecordType } from "../domain/dns.ts";
import { encodeRdata, encodeSoa, rrType } from "./rdata.ts";
import {
  CLASS_IN, MIN_UDP_PAYLOAD, RCODE, TYPE, WireFormatError,
  readQuery, writeReply, type ResourceRecord,
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
  readonly negativeTtl?: number;
  readonly forwardTimeoutMs?: number;
  /**
   * Told about a record that could not be encoded. Everything reaching here has
   * already passed the domain's validation, so this fires on stored content the
   * domain accepted and the wire cannot carry -- which is a defect somebody has
   * to be told about, not a record to quietly leave out.
   */
  readonly onUnservable?: (record: UnservableRecord) => void;
}

const DEFAULT_NEGATIVE_TTL = 60;
const DEFAULT_FORWARD_TIMEOUT_MS = 4000;

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
  let udp: Socket | undefined;
  let tcp: Server | undefined;

  async function respond(message: Buffer, overTcp: boolean): Promise<Buffer | undefined> {
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
      const forwarded = await forward(message, forwardTo, forwardTimeoutMs, overTcp);
      return forwarded ?? writeReply({ query, rcode: RCODE.SERVFAIL, authoritative: false }, Number.MAX_SAFE_INTEGER);
    }
    const parts = answerFromZone(query, zone, negativeTtl, options.onUnservable);
    return writeReply(parts, overTcp ? Number.MAX_SAFE_INTEGER : query.udpPayloadSize);
  }

  return {
    async listen(port, host) {
      udp = createSocket({ type: "udp4", reuseAddr: true });
      udp.on("message", (message, remote) => {
        void respond(message, false).then((reply) => {
          if (reply) udp?.send(reply, remote.port, remote.address);
        }).catch(() => undefined);
      });
      tcp = createServer((socket) => {
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
            void respond(message, true).then((reply) => {
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
      await Promise.all([
        new Promise<void>((resolve, reject) => { udp?.once("error", reject); udp?.bind(port, host, resolve); }),
        new Promise<void>((resolve, reject) => { tcp?.once("error", reject); tcp?.listen(port, host, resolve); }),
      ]);
    },
    async close() {
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
 * The bytes are not parsed in either direction. Nothing here needs to know what
 * the answer says, and re-encoding somebody else's reply is a way to change it
 * by accident.
 */
async function forward(
  message: Buffer,
  upstreams: readonly string[],
  timeoutMs: number,
  overTcp: boolean,
): Promise<Buffer | undefined> {
  for (const upstream of upstreams) {
    const [host, port] = splitUpstream(upstream);
    // The transport the client used is the transport the upstream is asked on.
    // A client only reaches TCP because it was told the UDP answer was
    // truncated, so relaying that query over UDP hands back another truncated
    // answer -- and the client has no move left, having already done the thing
    // truncation asks for.
    const reply = overTcp
      ? await relayOverTcp(message, host, port, timeoutMs)
      : await relayOverUdp(message, host, port, timeoutMs);
    if (reply) return reply;
  }
  return undefined;
}

function relayOverUdp(message: Buffer, host: string, port: number, timeoutMs: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const done = (value: Buffer | undefined): void => {
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    timer.unref();
    socket.once("message", (answer) => done(answer));
    socket.once("error", () => done(undefined));
    socket.send(message, port, host, (error) => { if (error) done(undefined); });
  });
}

function relayOverTcp(message: Buffer, host: string, port: number, timeoutMs: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const framed = Buffer.alloc(2 + message.length);
    framed.writeUInt16BE(message.length, 0);
    message.copy(framed, 2);
    const socket = connect(port, host, () => socket.write(framed));
    let buffered = Buffer.alloc(0);
    const done = (value: Buffer | undefined): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    timer.unref();
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 2) return;
      const size = buffered.readUInt16BE(0);
      if (buffered.length < size + 2) return;
      // The frame is stripped here and put back by the caller's own framing, so
      // an upstream that batches replies cannot smuggle a second one through.
      done(Buffer.from(buffered.subarray(2, size + 2)));
    });
    socket.on("error", () => done(undefined));
    socket.on("close", () => done(undefined));
  });
}

function splitUpstream(value: string): [string, number] {
  const [host, port] = value.split("#") as [string, string | undefined];
  return [host, port === undefined ? 53 : Number(port)];
}

export { CLASS_IN, MIN_UDP_PAYLOAD };
