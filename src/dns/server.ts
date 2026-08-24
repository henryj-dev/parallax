import { createSocket, type Socket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Server, type Socket as TcpSocket } from "node:net";
import { performance } from "node:perf_hooks";
import { providerManagement, type RecordType } from "../domain/dns.ts";
import { dnsAnswered, dnsForwardSeconds } from "../observability/signals.ts";
import { createDnsCookies } from "./cookies.ts";
import {
  readTsig, signEnvelope, signErrorReply, signReply, signRequest, tsigOverhead, verifyTsig,
  type TsigKey,
} from "./tsig.ts";
import { DEFAULT_SOA_TIMERS, encodeRdata, encodeSoa, rrType, type SoaTimers } from "./rdata.ts";
import {
  CLASS_ANY, CLASS_IN, MAX_EDNS_VERSION, MAX_RDATA_BYTES, MAX_TCP_MESSAGE_BYTES, MIN_UDP_PAYLOAD, OPCODE, RCODE, TYPE, WireFormatError,
  isResponseToQuery, opcodeOf, readQuery, readTransferSerial, writeName, writeReply, writeTruncatedReply,
  type ParsedQuery, type ReplyParts, type ResourceRecord,
} from "./wire.ts";

/** What the signature layer decided about one incoming message. */
type Signing =
  | { readonly kind: "unsigned" }
  | { readonly kind: "signed"; readonly key: TsigKey; readonly requestMac: Buffer }
  | { readonly kind: "refused"; readonly reply: Buffer };

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
  /** Client CIDRs allowed to request AXFR over TCP. Defaults to deny all. */
  readonly transferAllow?: readonly string[];
  /**
   * A zone as it stood at an earlier serial, for IXFR (RFC 1995).
   *
   * Absent, or returning nothing, means every transfer is a full one -- which
   * is always a valid answer to an IXFR, and is what the specification asks for
   * when the server cannot reach that far back. There is no journal behind
   * this: the serial *is* the revision, and the store already keeps the
   * retained revisions, so the difference is computed from two snapshots
   * rather than from a third record of what happened between them.
   *
   * ⚠️ This reaches the store from the query path. It is gated the same way
   * the transfer itself is -- the allowlist, which denies everything by
   * default, and a TSIG signature where keys are configured -- and the rate
   * limiter applies as it does to everything else.
   */
  readonly zoneAtSerial?: (zone: string, serial: number) => Promise<ServedZone | undefined>;
  /**
   * Shared secrets for zone transfer and NOTIFY (RFC 8945).
   *
   * Empty leaves both as they were, gated on address alone. Configuring any key
   * makes a signature *required* on AXFR -- an allowlisted address that cannot
   * sign stops being enough, which is the point of turning it on.
   */
  readonly tsigKeys?: readonly TsigKey[];
  readonly negativeTtl?: number;
  readonly forwardTimeoutMs?: number;
  readonly maxConcurrentForwards?: number;
  readonly tcpIdleTimeoutMs?: number;
  /** Maximum time to finish one DNS-over-TCP length-prefixed frame. */
  readonly tcpIncompleteFrameTimeoutMs?: number;
  readonly maxTcpConnections?: number;
  readonly rateLimitPerSecond?: number;
  readonly rateLimitBurst?: number;
  /**
   * How many client addresses the limiter will track at once.
   *
   * Once the table is full an address it has not seen is refused, because
   * evicting a live bucket would let an attacker cycling source addresses reset
   * the allowance of the client it is aiming at. That is the right trade, and
   * it means a flood of spoofed sources can deny service to genuinely new
   * clients until the buckets age out -- so a deployment that expects more
   * distinct clients than this should say so.
   */
  readonly rateLimitMaxClients?: number;
  /**
   * Answer an unproven UDP client with a truncated reply instead of the whole
   * thing, so it has to come back over TCP.
   *
   * Off by default, and deliberately. Cookies are always offered and checked --
   * that costs a client nothing and it is how one becomes proven -- but most
   * resolvers do not implement RFC 7873, and turning this on sends every one of
   * them through TCP. It is for a listener reachable from a network the
   * deployment does not trust, where an answer many times larger than its
   * question is worth denying to an address that has not proved it is there.
   */
  readonly requireCookie?: boolean;
  /** Injected by tests that need a stable server cookie. */
  readonly cookieSecret?: Buffer;
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
  /**
   * Told when a reply could not be assembled at all, after every per-record
   * guard has passed. There is no record to name by then, so this says only
   * which zone and which query -- which is still the difference between a
   * reported failure and a query that vanished.
   */
  readonly onUnanswerable?: (detail: { zone: string; name: string; reason: string }) => void;
  /**
   * A message arrived signed and the signature did not hold.
   *
   * Worth a line wherever it happens: on a deployment with keys configured this
   * is either a misconfigured secondary or somebody trying, and the two are
   * told apart by how often it repeats and from where.
   */
  readonly onSignatureRejected?: (detail: { client: string; keyName: string; reason: string }) => void;
  /** Hosts that receive NOTIFY when a served zone's serial rises. `host` or `host:port`. */
  readonly notifyTo?: readonly string[];
  /** Injected by tests that capture NOTIFY instead of sending UDP. */
  readonly sendNotify?: (packet: Buffer, address: string, port: number) => Promise<void>;
  /** What the synthesized SOA says. Every field falls back to a derived default. */
  readonly soa?: SoaSettings;
}

export interface SoaSettings {
  /**
   * MNAME -- where a secondary asks for updates and sends them. Defaults to
   * `ns.<zone>`, which is a guess: a deployment with secondaries should name a
   * host that exists.
   */
  readonly primary?: string;
  /** RNAME, the responsible mailbox with `@` written as a dot. */
  readonly mailbox?: string;
  readonly timers?: SoaTimers;
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
const DEFAULT_RATE_LIMIT_MAX_CLIENTS = 10_000;
// The DNS-over-TCP prefix is an unsigned 16-bit payload length. Keeping only
// one incomplete frame means a peer can never make one connection retain more
// than this, even while it pipelines complete requests behind it.
const MAX_TCP_INCOMPLETE_FRAME_BYTES = 2 + 0xffff;

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
  notifyChanged(previous: ReadonlyMap<string, number>, next: readonly ServedZone[]): Promise<void>;
} {
  const negativeTtl = options.negativeTtl ?? DEFAULT_NEGATIVE_TTL;
  const forwardTo = options.forwardTo ?? [];
  const forwardTimeoutMs = options.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
  const forwardAllow = compileCidrs(options.forwardAllow ?? DEFAULT_FORWARD_ALLOW);
  const transferAllow = compileCidrs(options.transferAllow ?? []);
  const tsigKeys = options.tsigKeys ?? [];
  const now = options.now ?? Date.now;
  const maxConcurrentForwards = positiveInteger(options.maxConcurrentForwards ?? DEFAULT_MAX_CONCURRENT_FORWARDS, "maxConcurrentForwards");
  const tcpIdleTimeoutMs = positiveInteger(options.tcpIdleTimeoutMs ?? DEFAULT_TCP_IDLE_TIMEOUT_MS, "tcpIdleTimeoutMs");
  const tcpIncompleteFrameTimeoutMs = positiveInteger(
    options.tcpIncompleteFrameTimeoutMs ?? tcpIdleTimeoutMs,
    "tcpIncompleteFrameTimeoutMs",
  );
  const maxTcpConnections = positiveInteger(options.maxTcpConnections ?? DEFAULT_MAX_TCP_CONNECTIONS, "maxTcpConnections");
  const rateLimiter = createRateLimiter(
    positiveInteger(options.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT_PER_SECOND, "rateLimitPerSecond"),
    positiveInteger(options.rateLimitBurst ?? DEFAULT_RATE_LIMIT_BURST, "rateLimitBurst"),
    options.now ?? Date.now,
    positiveInteger(options.rateLimitMaxClients ?? DEFAULT_RATE_LIMIT_MAX_CLIENTS, "rateLimitMaxClients"),
  );
  const cookies = createDnsCookies({
    ...(options.cookieSecret ? { secret: options.cookieSecret } : {}),
    // Shared with the rate limiter, so a test that moves time moves both.
    ...(options.now ? { now: options.now } : {}),
  });
  const requireCookie = options.requireCookie ?? false;
  const soaSettings = options.soa ?? {};
  const resolveHost = options.resolveHost ?? resolveDnsAddress;
  const resolveForwardHost = createTimedDnsResolver(resolveHost);
  const udpSockets: Socket[] = [];
  const tcpServers: Server[] = [];
  const tcpSockets = new Set<TcpSocket>();
  let activeForwards = 0;

  /**
   * The messages to send back, in order, with the signature layer around them.
   *
   * Split from the answering below because a signature is about the message
   * rather than about the question: it has to be checked before anything is
   * decided, and applied after everything is, including the error replies that
   * return early from a dozen places in between.
   */
  async function respond(message: Buffer, overTcp: boolean, clientAddress: string): Promise<Buffer[]> {
    let query;
    try {
      query = readQuery(message);
    } catch (error) {
      // Not answerable and not worth a reply that quotes it back.
      if (error instanceof WireFormatError) return [];
      throw error;
    }
    const signing = evaluateSignature(message, query, clientAddress);
    if (signing.kind === "refused") return [signing.reply];
    const replies = await answerQuery(message, query, overTcp, clientAddress, signing);
    if (signing.kind !== "signed") return replies;
    // The first reply is bound to the request's MAC; each one after it chains
    // onto the one before, so a transfer cannot be reordered or have an
    // envelope lifted out of the middle (RFC 8945 §5.3.1).
    let previous = signing.requestMac;
    return replies.map((reply, index) => {
      const signed = index === 0
        ? signReply(reply, signing.key, previous, now)
        : signEnvelope(reply, signing.key, previous, now);
      previous = signed.mac;
      return signed.message;
    });
  }

  /**
   * Whether this message carries a signature, and whether it is one this
   * deployment honours.
   *
   * A key configured anywhere makes AXFR require one. That is deliberately not
   * per-zone: the allowlist is not per-zone either, and a deployment that has
   * gone to the trouble of provisioning a key has said what it wants.
   */
  function evaluateSignature(message: Buffer, query: ParsedQuery, clientAddress: string): Signing {
    const record = readTsig(message);
    if (!record) {
      if (tsigKeys.length === 0 || !isTransfer(query.question.type)) return { kind: "unsigned" };
      // No signature to answer with, so this refusal goes back bare.
      return { kind: "refused", reply: writeReply({ query, rcode: RCODE.NOTAUTH, authoritative: false }, Number.MAX_SAFE_INTEGER) };
    }
    const verdict = verifyTsig(message, record, tsigKeys, now);
    if (verdict.kind === "ok") {
      const key = tsigKeys.find((candidate) => candidate.name === record.keyName) as TsigKey;
      return { kind: "signed", key, requestMac: verdict.mac };
    }
    options.onSignatureRejected?.({ client: clientAddress, keyName: record.keyName, reason: verdict.reason });
    const bare = writeReply({ query, rcode: RCODE.NOTAUTH, authoritative: false }, Number.MAX_SAFE_INTEGER);
    const named = tsigKeys.find((candidate) => candidate.name === record.keyName);
    return { kind: "refused", reply: signErrorReply(bare, record, verdict.error, named, now) };
  }

  /**
   * The difference between what a secondary has and what this zone is now.
   *
   * Undefined means "answer this as a full transfer", which is what the caller
   * does with it. That is the honest answer whenever the difference cannot be
   * computed -- and it is the specification's own fallback, not a shortcut.
   */
  async function incrementalAnswer(message: Buffer, query: ParsedQuery, zone: ServedZone, overTcp: boolean): Promise<ReplyParts | undefined> {
    if (query.question.name !== zone.name) return undefined;
    const soa = soaRecord(zone, negativeTtl, soaSettings);
    const upToDate: ReplyParts = { query, rcode: RCODE.NOERROR, authoritative: true, answers: [soa] };
    const clientSerial = readTransferSerial(message);
    if (clientSerial === undefined) return undefined;
    // Equal, or somehow ahead of us: there is nothing to send, and the SOA is
    // how that is said. Over UDP the same answer is what asks the client to
    // come back over TCP, so a transfer never rides a datagram it may not fit.
    if (clientSerial >= zone.serial || !overTcp) return upToDate;

    const previous = await options.zoneAtSerial?.(zone.name, clientSerial);
    if (!previous || previous.serial !== clientSerial) return undefined;
    const before = transferRecords(previous, options.onUnservable);
    const after = transferRecords(zone, options.onUnservable);
    // A record that cannot be written is reported by the full path, with the
    // SERVFAIL that goes with it. Doing it twice would double the log line.
    if (!before || !after) return undefined;

    const removed = missingFrom(before, after);
    const added = missingFrom(after, before);
    // RFC 1995 §4, as one condensed difference rather than one per serial: the
    // deletions under the old serial, the additions under the new, and the new
    // SOA again to close it.
    return {
      query,
      rcode: RCODE.NOERROR,
      authoritative: true,
      answers: [soa, soaRecord(previous, negativeTtl, soaSettings), ...removed, soa, ...added, soa],
    };
  }

  /** The answer itself, once the message has been shown to be one we accept. */
  async function answerQuery(
    message: Buffer,
    query: ParsedQuery,
    overTcp: boolean,
    clientAddress: string,
    signing: Signing & { kind: "unsigned" | "signed" },
  ): Promise<Buffer[]> {
    const signed = signing.kind === "signed";
    // Reserved out of every budget below rather than checked afterwards: the
    // assembler is the only thing that can drop a record to make room, and by
    // the time the signature is appended it has already gone.
    const reserved = signing.kind === "signed" ? tsigOverhead(signing.key) : 0;
    const tcpCeiling = MAX_TCP_MESSAGE_BYTES - reserved;
    const verdict = cookies.evaluate(query.cookie, clientAddress);
    // Every reply carries a fresh server cookie when the client sent one, so a
    // client that is unproven now becomes proven on its next query.
    const cookie = verdict.kind === "absent" || verdict.kind === "malformed" ? undefined : verdict.reply;
    /** A reply with no records in it, carrying whatever cookie is owed. */
    const answer = (rcode: number): Buffer[] => [writeReply(
      { query, rcode, authoritative: false, ...(cookie ? { cookie } : {}) },
      Number.MAX_SAFE_INTEGER,
    )];

    const relay = async (): Promise<Buffer[]> => {
      // A signed question was asked of this server by name. Relaying it would
      // send our peer's credential to an upstream that does not hold the key,
      // and the answer that came back could not be signed as ours.
      if (signed) return answer(RCODE.REFUSED);
      if (activeForwards >= maxConcurrentForwards) return answer(RCODE.SERVFAIL);
      activeForwards += 1;
      let forwarded: Buffer | undefined;
      const startedAt = performance.now();
      try {
        forwarded = await forward(message, query, forwardTo, forwardTimeoutMs, overTcp, resolveForwardHost);
      } finally {
        activeForwards -= 1;
        // Timed whether or not an upstream answered: a run of timeouts is
        // exactly the shape this is here to make visible, and leaving the
        // failures out would flatter the number.
        dnsForwardSeconds((performance.now() - startedAt) / 1000, { outcome: forwarded ? "answered" : "failed" });
      }
      // A relayed answer is the upstream's bytes, cookie and all. Ours would be
      // about a conversation the client is not having with us.
      return forwarded ? [forwarded] : answer(RCODE.SERVFAIL);
    };

    // Anything that is not a standard query. UPDATE, NOTIFY and STATUS all
    // carry a question-shaped first section, so parsing succeeded and the old
    // code answered them as though they were questions -- echoing the opcode
    // back, which claims the operation was understood. None of them is a thing
    // to relay either, so this sits ahead of the forwarder.
    if (opcodeOf(query) !== OPCODE.QUERY) return answer(RCODE.NOTIMP);
    // A client speaking a later EDNS is told which version this one speaks,
    // rather than being answered as though the question had been understood.
    // RFC 6891 says the reply carries no answer and the client retries lower.
    if (query.ednsVersion > MAX_EDNS_VERSION) return answer(RCODE.BADVERS);
    // A cookie that is not a cookie. RFC 7873 asks for FORMERR rather than a
    // guess at what was meant.
    if (verdict.kind === "malformed") return answer(RCODE.FORMERR);
    // Over UDP, and only where the deployment asked: an address that has not
    // shown it can receive an answer does not get a large one. TC costs the
    // client one TCP retry and costs a spoofed victim nothing.
    if (requireCookie && !overTcp && verdict.kind !== "proven") {
      return [writeTruncatedReply({ query, rcode: RCODE.NOERROR, authoritative: false, ...(cookie ? { cookie } : {}) })];
    }
    // Both transfer types answer to the same policy. They part company only
    // over UDP: AXFR cannot be attempted there at all, while an IXFR that will
    // not fit is answered with the current SOA and the client comes back over
    // TCP (RFC 1995 §2). That answer is built below, where the zone is known.
    if (isTransfer(query.question.type)) {
      if (!cidrsContain(transferAllow, clientAddress)) return answer(RCODE.REFUSED);
      if (query.question.type === TYPE.AXFR && !overTcp) return answer(RCODE.REFUSED);
    }
    const zone = matchZone(options.zones(), query.question.name);
    if (!zone) {
      if (forwardTo.length === 0) return answer(RCODE.REFUSED);
      if (!cidrsContain(forwardAllow, clientAddress)) return answer(RCODE.REFUSED);
      return relay();
    }
    // A name the provider serves itself carries a placeholder address that
    // nobody can reach, so answering it from the desired state sends the client
    // somewhere that does not exist. The public answer is the only real one, and
    // it is not ours to hold: it changes without our records changing.
    //
    // Deliberately not behind `forwardAllow`. That gate exists so this cannot be
    // used as an open resolver, and this path cannot be: it relays only names
    // inside a zone we serve, and only those carrying a placeholder. Gating it
    // would break the case it exists for -- a client outside the allowed range
    // asking for one of our own names.
    if (forwardTo.length > 0 && servedByProvider(zone, query.question.name, query.question.type)) {
      return relay();
    }
    // Only now, once this is a name we answer for ourselves. Every record we
    // hold is IN, and `writeRecord` writes IN whatever was asked -- so a CHAOS
    // question used to come back carrying IN answers, which is a reply to a
    // question nobody asked.
    //
    // Deliberately after the forwarding decision rather than before it. This
    // process is also a resolver, and `version.bind` CHAOS TXT is an ordinary
    // thing for a client to ask an upstream. Refusing non-IN at the top would
    // have made the forwarder lie about names that are not ours at all.
    if (query.question.class !== CLASS_IN && query.question.class !== CLASS_ANY) {
      return answer(RCODE.REFUSED);
    }
    // An incremental answer, when one can be built. Everything else -- the
    // client is up to date, it asked over UDP, the serial it names is no longer
    // retained -- comes back as a full transfer or a lone SOA, both of which
    // are valid answers to an IXFR.
    const incremental = query.question.type === TYPE.IXFR
      ? await incrementalAnswer(message, query, zone, overTcp)
      : undefined;
    const parts = {
      ...(incremental ?? answerFromZone(query, zone, negativeTtl, options.onUnservable, soaSettings)),
      ...(cookie ? { cookie } : {}),
    };
    const budget = overTcp ? Number.MAX_SAFE_INTEGER : Math.max(MIN_UDP_PAYLOAD, query.udpPayloadSize - reserved);
    try {
      const reply = writeReply(parts, budget);
      // A DNS-over-TCP message is length-prefixed with a uint16, so this is a
      // ceiling the transport imposes and the assembler above knows nothing
      // about. Over UDP `writeReply` has already truncated to fit; over TCP the
      // budget is deliberately unbounded, because TC on a TCP reply tells the
      // client to retry over TCP -- which is where it already is.
      //
      // What used to happen: the framing wrote this length into two bytes,
      // `writeUInt16BE` threw ERR_OUT_OF_RANGE, and the `.catch()` beside it
      // destroyed the socket. Measured at 2,500 A records -- the secondary
      // received **zero bytes** and nothing here said why. SERVFAIL is an
      // answer, and it is small.
      //
      if (overTcp && reply.length > tcpCeiling) {
        // A transfer is allowed to span messages, and is the only thing here
        // that is (RFC 5936 §2.2). Everything else has to fit one, so a reply
        // that does not is answered SERVFAIL and reported -- loudly, because
        // the alternative is a query that vanishes.
        if (isTransfer(query.question.type)) {
          const split = splitTransfer(parts, tcpCeiling);
          if (split) return split;
        }
        options.onUnanswerable?.({
          zone: zone.name,
          name: query.question.name,
          reason: `reply is ${reply.length} bytes and a DNS-over-TCP message cannot exceed ${tcpCeiling}`,
        });
        return [writeReply({ query, rcode: RCODE.SERVFAIL, authoritative: true, ...(cookie ? { cookie } : {}) }, budget)];
      }
      return [reply];
    } catch (error) {
      // Everything that knows which record it was has already run. Whatever is
      // left -- a name that will not re-encode, a type this build cannot write
      // -- must still be an answer: dropping the datagram makes the name look
      // like a black hole to the client and leaves nothing in any log.
      // `message` names this function's own Buffer parameter here, so the
      // shared helper of that name is out of reach.
      options.onUnanswerable?.({
        zone: zone.name,
        name: query.question.name,
        reason: error instanceof Error ? error.message : "unknown error",
      });
      try {
        return [writeReply({ query, rcode: RCODE.SERVFAIL, authoritative: true, ...(cookie ? { cookie } : {}) }, budget)];
      } catch {
        return [];
      }
    }
  }

  /**
   * Closes whatever is open, including a half-open bind.
   *
   * Tolerates a socket that never bound: `close()` on one of those throws
   * rather than doing nothing, and the failure path this exists for is exactly
   * where that happens.
   */
  const shutdown = async (): Promise<void> => {
    for (const socket of tcpSockets) socket.destroy();
    tcpSockets.clear();
    const closingUdp = udpSockets.splice(0);
    const closingTcp = tcpServers.splice(0);
    for (const socket of closingUdp) socket.on("error", () => undefined);
    for (const server of closingTcp) server.on("error", () => undefined);
    await Promise.all([
      ...closingUdp.map((socket) => new Promise<void>((resolve) => {
        try { socket.close(resolve); } catch { resolve(); }
      })),
      ...closingTcp.map((server) => new Promise<void>((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
      })),
    ]);
  };

  /**
   * The rcode of a reply, counted as it leaves.
   *
   * Read back off the assembled bytes rather than threaded down from wherever
   * the decision was made: there are a dozen places that decide an rcode and
   * exactly two that send one, so this counts where it cannot be forgotten.
   */
  const counted = (replies: Buffer[]): Buffer[] => {
    // A transfer is one answer spread over several messages; counting each
    // frame would make one AXFR look like a hundred queries.
    const first = replies[0];
    if (first && first.length >= 12) dnsAnswered({ rcode: rcodeName(first.readUInt16BE(2) & 0xf) });
    return replies;
  };

  function attachUdp(udp: Socket): void {
    udp.on("message", (message, remote) => {
      if (!rateLimiter.allow(remote.address)) return;
      void respond(message, false, remote.address).then(counted).then(([reply]) => {
        // Only a transfer ever produces more than one, and no transfer produces
        // more than one here: AXFR over UDP is refused before an answer is
        // built, and an IXFR over UDP is answered with a lone SOA.
        if (reply) udp.send(reply, remote.port, remote.address);
      }).catch(() => undefined);
    });
  }

  function attachTcp(tcp: Server): void {
    tcp.maxConnections = maxTcpConnections;
    tcp.on("connection", (socket) => {
      tcpSockets.add(socket);
      socket.setTimeout(tcpIdleTimeoutMs, () => socket.destroy());
      let buffered = Buffer.alloc(0);
      let incompleteFrameTimer: NodeJS.Timeout | undefined;
      const clearIncompleteFrameTimer = (): void => {
        if (!incompleteFrameTimer) return;
        clearTimeout(incompleteFrameTimer);
        incompleteFrameTimer = undefined;
      };
      const armIncompleteFrameTimer = (): void => {
        if (incompleteFrameTimer) return;
        incompleteFrameTimer = setTimeout(() => socket.destroy(), tcpIncompleteFrameTimeoutMs);
        incompleteFrameTimer.unref();
      };
      const handleMessage = (message: Buffer): void => {
        const clientAddress = socket.remoteAddress;
        if (!clientAddress || !rateLimiter.allow(clientAddress)) return;
        void respond(message, true, clientAddress).then(counted).then((replies) => {
          for (const reply of replies) {
            const framed = Buffer.alloc(2 + reply.length);
            framed.writeUInt16BE(reply.length, 0);
            reply.copy(framed, 2);
            socket.write(framed);
          }
        }).catch(() => socket.destroy());
      };
      socket.on("close", () => {
        clearIncompleteFrameTimer();
        tcpSockets.delete(socket);
      });
      // ⚠️ Annotated rather than inferred. From @types/node 26 the listener's
      // parameter is `string | NonSharedBuffer`, because a socket that has had
      // `setEncoding()` called on it delivers strings. Nothing here ever calls
      // it -- this is a wire protocol with a two-byte length prefix, and
      // decoding it as text would corrupt the frame before it was read -- so
      // the buffer branch is the only one that occurs. The annotation says
      // that out loud; the alternative was a cast at each of the five uses
      // below, which would have hidden the assumption instead of stating it.
      socket.on("data", (chunk: Buffer) => {
        let remaining = chunk;
        while (remaining.length > 0) {
          // Avoid accumulating a whole pipelined chunk. Complete frames go
          // straight to the handler; only one partial frame is retained.
          if (buffered.length === 0 && remaining.length >= 2) {
            const size = remaining.readUInt16BE(0);
            const frameBytes = size + 2;
            if (remaining.length >= frameBytes) {
              handleMessage(Buffer.from(remaining.subarray(2, frameBytes)));
              remaining = remaining.subarray(frameBytes);
              continue;
            }
          }

          const bytesNeededForPrefixOrFrame = buffered.length >= 2 ? buffered.readUInt16BE(0) + 2 : 2;
          const needed = bytesNeededForPrefixOrFrame - buffered.length;
          const take = Math.min(needed, remaining.length);
          if (buffered.length + take > MAX_TCP_INCOMPLETE_FRAME_BYTES) {
            socket.destroy();
            return;
          }
          buffered = Buffer.concat([buffered, remaining.subarray(0, take)]);
          remaining = remaining.subarray(take);
          if (buffered.length < 2) {
            if (remaining.length === 0) {
              armIncompleteFrameTimer();
              return;
            }
            continue;
          }
          const frameBytes = buffered.readUInt16BE(0) + 2;
          if (buffered.length < frameBytes) {
            // socket.setTimeout() resets for every byte. This deadline does
            // not, so a slow-drip client cannot reserve a connection forever.
            if (remaining.length === 0) {
              armIncompleteFrameTimer();
              return;
            }
            continue;
          }
          clearIncompleteFrameTimer();
          handleMessage(Buffer.from(buffered.subarray(2)));
          buffered = Buffer.alloc(0);
        }
      });
      socket.on("error", () => socket.destroy());
    });
  }

  return {
    async listen(port, host) {
      const bindings = await bindAddresses(host, resolveHost);
      for (const binding of bindings) {
        const udp = createSocket({
          type: binding.family === 6 ? "udp6" : "udp4",
          reuseAddr: true,
          ipv6Only: binding.family === 6,
        });
        attachUdp(udp);
        const tcp = createServer();
        attachTcp(tcp);
        udpSockets.push(udp);
        tcpServers.push(tcp);
        const bound = await Promise.allSettled([
          new Promise<void>((resolve, reject) => { udp.once("error", reject); udp.bind(port, binding.address, resolve); }),
          new Promise<void>((resolve, reject) => {
            tcp.once("error", reject);
            tcp.listen({ port, host: binding.address, ipv6Only: binding.family === 6 }, resolve);
          }),
        ]);
        const failed = bound.find((result) => result.status === "rejected");
        if (failed) {
          await shutdown();
          throw failed.reason;
        }
      }
    },
    close: shutdown,
    async notifyChanged(previous, next) {
      const destinations = options.notifyTo ?? [];
      if (destinations.length === 0) return;
      const send = options.sendNotify ?? sendNotifyDatagram;
      for (const zone of next) {
        const before = previous.get(zone.name);
        if (before !== undefined && before === zone.serial) continue;
        if (before === undefined && previous.size === 0) continue;
        const packet = writeNotify(zone.name);
        for (const destination of destinations) {
          const parsed = parseNotifyDestination(destination);
          const key = parsed.keyName === undefined
            ? undefined
            : tsigKeys.find((candidate) => candidate.name === parsed.keyName);
          if (parsed.keyName !== undefined && !key) {
            // Named a key that is not configured. Sending it unsigned would be
            // the one thing the operator asked not to happen.
            options.onSignatureRejected?.({
              client: parsed.address,
              keyName: parsed.keyName,
              reason: `notify destination names a key that is not in the configured set`,
            });
            continue;
          }
          await send(key ? signRequest(packet, key, now).message : packet, parsed.address, parsed.port);
        }
      }
    },
  };
}

async function bindAddresses(host: string, resolveHost: (host: string) => Promise<ResolvedDnsAddress>): Promise<ResolvedDnsAddress[]> {
  if (host === "0.0.0.0" || host === "*" || host === "::" || host === "[::]") {
    return [
      { address: "0.0.0.0", family: 4 },
      { address: "::", family: 6 },
    ];
  }
  const binding = await resolveHost(host);
  assertResolvedAddress(binding, host);
  return [binding];
}

/**
 * A NOTIFY destination, optionally naming the key to sign it with.
 *
 * `10.0.0.2:53#transfer.key`. The key goes per destination rather than being
 * one global choice because secondaries do not have to share a secret -- the
 * inbound direction tries every configured key and needs no such decision, but
 * a packet leaving here has to be signed with exactly one, and picking the
 * first would quietly break the second secondary.
 */
export function parseNotifyDestination(value: string): { address: string; port: number; keyName?: string } {
  const separator = value.lastIndexOf("#");
  if (separator > 0) {
    const keyName = value.slice(separator + 1).trim().replace(/\.$/u, "").toLowerCase();
    // The separator is consumed either way. Leaving a bare trailing `#` on the
    // address turns a typo into a hostname nothing resolves.
    const destination = parseNotifyDestination(value.slice(0, separator));
    return keyName ? { ...destination, keyName } : destination;
  }
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/u.exec(value);
  if (bracketed) {
    const port = notifyPort(bracketed[2]);
    if (port !== undefined) return { address: bracketed[1] ?? "", port };
  }
  const firstColon = value.indexOf(":");
  const lastColon = value.lastIndexOf(":");
  if (firstColon > 0 && firstColon === lastColon) {
    const port = notifyPort(value.slice(lastColon + 1));
    if (port !== undefined) return { address: value.slice(0, lastColon), port };
  }
  return { address: value.replace(/^\[|\]$/gu, ""), port: 53 };
}

function notifyPort(value: string | undefined): number | undefined {
  if (value === undefined) return 53;
  if (!/^\d+$/u.test(value)) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function writeNotify(zone: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x2000, 2);
  header.writeUInt16BE(1, 4);
  const typeClass = Buffer.alloc(4);
  typeClass.writeUInt16BE(TYPE.SOA, 0);
  typeClass.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([header, writeName(zone), typeClass]);
}

async function sendNotifyDatagram(packet: Buffer, address: string, port: number): Promise<void> {
  const family = isIP(address) === 6 || address.includes(":") ? 6 : 4;
  const socket = createSocket(family === 6 ? "udp6" : "udp4");
  await new Promise<void>((resolve, reject) => {
    socket.send(packet, port, address, (error) => {
      socket.close();
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * A zone's records arranged the way a query asks for them.
 *
 * Every lookup on the answer path was a full scan of `zone.records`, and there
 * were three or four of them per query -- the records at the name, whether
 * anything sits below it, the wildcard walk, and the placeholder check. Cost
 * grew with the zone: measured over UDP, a hit went 0.104 ms at 1,000 records
 * to 0.571 ms at 10,000, and a wildcard miss 0.187 ms to 1.638 ms.
 *
 * Built once per snapshot rather than per query, which is the right way round:
 * the snapshot is rebuilt when the desired state changes, and queries arrive
 * far more often than that. Keyed on the snapshot object, so a new snapshot
 * simply gets a new index and the old one is collected with it -- no
 * invalidation to get wrong.
 */
interface ZoneIndex {
  /** Absolute owner name to the records at it. */
  readonly byName: ReadonlyMap<string, ServedZone["records"]>;
  /**
   * Names that exist without holding anything: every ancestor of a record's
   * owner. DNS calls these empty non-terminals, and both the negative answers
   * and the wildcard rule turn on them.
   */
  readonly parents: ReadonlySet<string>;
}

const zoneIndexes = new WeakMap<ServedZone, ZoneIndex>();

function indexOf(zone: ServedZone): ZoneIndex {
  const cached = zoneIndexes.get(zone);
  if (cached) return cached;
  const byName = new Map<string, ServedZone["records"][number][]>();
  const parents = new Set<string>();
  for (const record of zone.records) {
    const owner = absolute(record.name, zone.name);
    const group = byName.get(owner);
    if (group) group.push(record);
    else byName.set(owner, [record]);
    // Walk to the apex, marking each ancestor as a name that exists.
    let ancestor = owner;
    while (ancestor !== zone.name && ancestor.includes(".")) {
      ancestor = ancestor.slice(ancestor.indexOf(".") + 1);
      parents.add(ancestor);
    }
  }
  const index: ZoneIndex = { byName, parents };
  zoneIndexes.set(zone, index);
  return index;
}

/** The longest zone whose apex the name sits at or under. */
/**
 * Whether an address query for this name must be answered by the upstream.
 *
 * Only address queries. A name whose A or AAAA is a placeholder still holds its
 * own MX and TXT, and those are exactly what an internal view is for -- relaying
 * the whole name would throw away every override that is not an address. So the
 * question type decides, and one placeholder among the addresses is enough:
 * where the apex has AAAA `100::` and no A at all, a browser asks for A and the
 * honest answer is the public one, not an empty section.
 */
function servedByProvider(zone: ServedZone, name: string, type: number): boolean {
  if (type !== TYPE.A && type !== TYPE.AAAA) return false;
  return (indexOf(zone).byName.get(name) ?? []).some((record) =>
    (record.type === "A" || record.type === "AAAA") && providerManagement(record)?.originless === true);
}

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
  soaSettings: SoaSettings,
) {
  const name = query.question.name;
  const soa = soaRecord(zone, negativeTtl, soaSettings);
  // SOA is synthesized, not stored. A query that asks for it at the apex must
  // get it in the answer section — authority-only is how we talk about
  // negatives, and `dig SOA` / a secondary asking for the zone's SOA is not a
  // negative.
  if (name === zone.name && query.question.type === TYPE.SOA) {
    return { query, rcode: RCODE.NOERROR, authoritative: true, answers: [soa] };
  }
  // A full transfer. An IXFR arrives here when no difference could be built,
  // and RFC 1995 §4 says a full answer to one looks exactly like an AXFR.
  if (name === zone.name && isTransfer(query.question.type)) {
    const records = transferRecords(zone, onUnservable);
    if (!records) return { query, rcode: RCODE.SERVFAIL, authoritative: true };
    return { query, rcode: RCODE.NOERROR, authoritative: true, answers: [soa, ...records, soa] };
  }
  let atName: ServedZone["records"] = indexOf(zone).byName.get(name) ?? [];

  if (atName.length === 0) {
    // The name exists without holding anything of its own when something sits
    // below it, and the apex always exists. Either way the answer is empty
    // rather than NXDOMAIN, and no wildcard may cover a name that exists.
    const exists = nameExists(zone, name);
    if (exists) return { query, rcode: RCODE.NOERROR, authoritative: true, authority: [soa] };
    const substitution = dnameSubstitution(zone, name);
    if (substitution) {
      return { query, rcode: RCODE.NOERROR, authoritative: true, answers: substitution };
    }
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
      answers.push({ name, type: rrType(record.type), ttl: record.ttl, data: servableRdata(record.type, record.content) });
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
  // A CNAME on its own is a correct answer, and the resolver would ask again
  // for the target. Following it here saves that round trip, which is what
  // every other authoritative server does -- and the target's records are ones
  // this zone already holds, so nothing is being asserted that was not ours.
  if (alias && query.question.type !== TYPE.CNAME && query.question.type !== TYPE.ANY) {
    answers.push(...chaseAlias(zone, name, alias.content, query.question.type, onUnservable));
  }
  return { query, rcode: RCODE.NOERROR, authoritative: true, answers };
}

/** A CNAME may point at a CNAME. Bounded, because a zone may also point at itself. */
const MAX_ALIAS_DEPTH = 8;

/**
 * The records the alias leads to, as far as this zone can follow it.
 *
 * Only exact names inside this zone. A target outside it belongs to whoever is
 * authoritative for that name, and a target covered only by a wildcard is left
 * to the resolver's own query -- synthesizing into somebody else's question is
 * more than saving a round trip.
 *
 * Never fails the answer. The CNAME already in hand is complete and correct on
 * its own, so a target that will not encode stops the walk and is reported,
 * rather than turning a good answer into SERVFAIL.
 */
function chaseAlias(
  zone: ServedZone,
  answered: string,
  from: string,
  type: number,
  onUnservable: DnsServerOptions["onUnservable"],
): ResourceRecord[] {
  const index = indexOf(zone);
  const chased: ResourceRecord[] = [];
  // Seeded with the name already in the answer, so a CNAME pointing at its own
  // owner cannot make the walk emit that record a second time.
  const seen = new Set<string>([answered]);
  let target = from.replace(/\.$/u, "").toLowerCase();

  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
    if (target !== zone.name && !target.endsWith(`.${zone.name}`)) return chased;
    if (seen.has(target)) return chased;
    seen.add(target);

    const at = index.byName.get(target) ?? [];
    const matches = at.filter((record) => rrType(record.type) === type);
    const next = at.find((record) => record.type === "CNAME");
    const step = matches.length > 0 ? matches : next ? [next] : [];
    if (step.length === 0) return chased;

    for (const record of step) {
      try {
        chased.push({ name: target, type: rrType(record.type), ttl: record.ttl, data: servableRdata(record.type, record.content) });
      } catch (error) {
        onUnservable?.({ zone: zone.name, name: record.name, type: record.type, reason: message(error) });
        return chased;
      }
    }
    if (matches.length > 0 || !next) return chased;
    target = next.content.replace(/\.$/u, "").toLowerCase();
  }
  return chased;
}

/** A small fixed label set, so the counter cannot grow a series per query. */
function rcodeName(rcode: number): string {
  for (const [name, value] of Object.entries(RCODE)) if (value === rcode) return name.toLowerCase();
  return `rcode${rcode}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * A zone transfer spread across as many messages as it takes.
 *
 * AXFR is defined to span messages (RFC 5936 §2.2) and this listener used to
 * put the whole zone in one. Past 65535 bytes the TCP length prefix cannot
 * describe it, so a large zone could not be transferred at all -- measured at
 * 2,500 A records, the secondary received zero bytes.
 *
 * The rules a receiver relies on are that the first message opens with the
 * zone's SOA and the last closes with it, and that every record arrives exactly
 * once in between. `answerFromZone` already produced the sequence in that
 * shape, so this only decides where to cut: greedily, by the size each record
 * takes on the wire, which is the same arithmetic `writeRecord` performs.
 *
 * Returns `undefined` when even one record will not fit a message on its own.
 * Nothing can carry that, and the caller says so rather than emitting a frame
 * the transport will reject.
 */
function isTransfer(type: number): boolean {
  return type === TYPE.AXFR || type === TYPE.IXFR;
}

/** Every record in a zone, on the wire, or nothing when one of them will not go. */
function transferRecords(
  zone: ServedZone,
  onUnservable: DnsServerOptions["onUnservable"],
): ResourceRecord[] | undefined {
  const records: ResourceRecord[] = [];
  for (const record of zone.records) {
    try {
      records.push({
        name: absolute(record.name, zone.name),
        type: rrType(record.type),
        ttl: record.ttl,
        data: servableRdata(record.type, record.content),
      });
    } catch (error) {
      onUnservable?.({ zone: zone.name, name: record.name, type: record.type, reason: message(error) });
      return undefined;
    }
  }
  return records;
}

/**
 * The records in the first list that the second does not have.
 *
 * Identity is the whole record -- owner, type, TTL and rdata -- because that is
 * what a secondary stores. A TTL change with the same rdata is a delete and an
 * add, which is what RFC 1995 expects and what makes the secondary's copy match
 * ours afterwards.
 */
function missingFrom(candidates: readonly ResourceRecord[], present: readonly ResourceRecord[]): ResourceRecord[] {
  const held = new Set(present.map(recordKey));
  return candidates.filter((record) => !held.has(recordKey(record)));
}

function recordKey(record: ResourceRecord): string {
  return `${record.name}\u0000${record.type}\u0000${record.ttl}\u0000${record.data.toString("base64")}`;
}

function splitTransfer(parts: ReplyParts, budget: number): Buffer[] | undefined {
  const answers = parts.answers ?? [];
  if (answers.length === 0) return undefined;
  // What a message costs before any answer goes into it: header, question and
  // -- when the client sent one -- the OPT record.
  const overhead = writeReply({ ...parts, answers: [], authority: [] }, Number.MAX_SAFE_INTEGER).length;

  const messages: Buffer[] = [];
  let batch: ResourceRecord[] = [];
  let size = overhead;
  const flush = (): void => {
    if (batch.length === 0) return;
    messages.push(writeReply({ ...parts, answers: batch, authority: [] }, Number.MAX_SAFE_INTEGER));
    batch = [];
    size = overhead;
  };
  for (const record of answers) {
    const cost = writeName(record.name).length + 10 + record.data.length;
    if (overhead + cost > budget) return undefined;
    if (batch.length > 0 && size + cost > budget) flush();
    batch.push(record);
    size += cost;
  }
  flush();
  // Belt and braces: the arithmetic above should make this impossible, and a
  // frame over the limit would throw at the length prefix rather than fail
  // visibly here.
  return messages.every((entry) => entry.length <= budget) ? messages : undefined;
}

/**
 * The record's RDATA, refused here if the wire cannot carry it.
 *
 * Measured while the record is still in hand. `writeRecord` would find the same
 * thing a moment later -- it writes the length into a uint16 -- but by then the
 * only thing left is a half-assembled buffer, and the caller could say which
 * zone had a problem and not which record. Both callers of this already report
 * an unservable record and answer SERVFAIL, which is exactly the right answer;
 * they just never got the chance, because the throw happened after them.
 */
function servableRdata(type: RecordType, content: string): Buffer {
  const data = encodeRdata(type, content);
  if (data.length > MAX_RDATA_BYTES) {
    throw new WireFormatError(`RDATA is ${data.length} bytes and a DNS record cannot carry more than ${MAX_RDATA_BYTES}`);
  }
  return data;
}

/**
 * Whether the zone holds this name at all -- as a record of its own, or as an
 * ancestor of one, or as the apex.
 *
 * The middle case is the empty non-terminal: `a.b.example.com` existing makes
 * `b.example.com` exist too, with nothing in it. DNS treats that as a name, and
 * both the negative answers and the wildcard rule below depend on it.
 */
function nameExists(zone: ServedZone, name: string): boolean {
  if (name === zone.name) return true;
  const index = indexOf(zone);
  return index.byName.has(name) || index.parents.has(name);
}

/**
 * The records a wildcard covering this name holds, or none.
 *
 * The desired state accepts `*` and `*.name`, and every other publisher of the
 * internal view expands them -- a zone file, PowerDNS and Cloudflare all do.
 * Taking them literally here would answer NXDOMAIN for names the same desired
 * state resolves everywhere else.
 *
 * The walk climbs to the **closest encloser** -- the longest ancestor of the
 * queried name that the zone actually holds -- and looks for a wildcard only
 * there. RFC 4592 §3.3.1, and the difference is not academic: it used to climb
 * past existing names until it found any wildcard at all, so a zone holding
 * `b` and `*` answered `a.b.example.com` from `*.example.com`. The closest
 * encloser there is `b.example.com`, the source of synthesis would be
 * `*.b.example.com`, and there is none -- so the answer is NXDOMAIN.
 *
 * Every other publisher of this desired state applies that rule, which made
 * this the one place where inside and outside disagreed about whether a name
 * exists. A name that exists never reaches here at all, which is the separate
 * rule that keeps a wildcard from answering over a real one.
 */
function wildcardMatch(zone: ServedZone, name: string): ServedZone["records"] {
  let parent = name.slice(name.indexOf(".") + 1);
  for (;;) {
    if (nameExists(zone, parent)) return indexOf(zone).byName.get(`*.${parent}`) ?? [];
    // The apex always exists, so this is a floor rather than a guess.
    if (parent === zone.name || !parent.includes(".")) return [];
    parent = parent.slice(parent.indexOf(".") + 1);
  }
}

/**
 * RFC 6672: a DNAME at an ancestor substitutes the suffix and synthesizes a
 * CNAME for the queried name. Without this, every name below a stored DNAME
 * was NXDOMAIN even though the record existed to cover them.
 */
function dnameSubstitution(zone: ServedZone, name: string): ResourceRecord[] | undefined {
  let parent = name.includes(".") ? name.slice(name.indexOf(".") + 1) : "";
  while (parent.length > 0) {
    const records = (indexOf(zone).byName.get(parent) ?? []).filter((record) => record.type === "DNAME");
    if (records.length > 0) {
      const record = records[0] as ServedZone["records"][number];
      const prefix = name.slice(0, name.length - parent.length);
      const target = record.content.replace(/\.$/u, "").toLowerCase();
      const synthesized = `${prefix}${target}`;
      return [
        { name: parent, type: TYPE.DNAME, ttl: record.ttl, data: encodeRdata("DNAME", record.content) },
        { name, type: TYPE.CNAME, ttl: record.ttl, data: writeName(synthesized) },
      ];
    }
    if (parent === zone.name || !parent.includes(".")) break;
    parent = parent.slice(parent.indexOf(".") + 1);
  }
  return undefined;
}

/**
 * The zone's SOA, which this listener synthesizes rather than stores.
 *
 * The primary name matters and used to be invented. `ns.<zone>` was written in
 * because every zone has an apex, not because that name exists -- and a
 * secondary that transfers this zone reads MNAME as where to ask for updates
 * and where to send them. Pointing it at a name that does not resolve is not a
 * cosmetic default; it is an answer about somebody else's next step.
 *
 * So a deployment that has secondaries names its own. One that has none never
 * notices either way, which is why the invented name survived this long.
 */
function soaRecord(zone: ServedZone, negativeTtl: number, soa: SoaSettings): ResourceRecord {
  return {
    name: zone.name,
    type: TYPE.SOA,
    ttl: negativeTtl,
    data: encodeSoa(
      soa.primary ?? `ns.${zone.name}`,
      soa.mailbox ?? `hostmaster.${zone.name}`,
      zone.serial,
      negativeTtl,
      soa.timers ?? DEFAULT_SOA_TIMERS,
    ),
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
    // Same reason as the listener above: no `setEncoding()` on this socket, so
    // the string half of the parameter's type never arrives.
    socket.on("data", (chunk: Buffer) => {
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

function createRateLimiter(
  ratePerSecond: number,
  burst: number,
  now: () => number,
  maxClients: number,
): { allow(address: string): boolean } {
  const clients = new Map<string, { tokens: number; at: number }>();
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
