import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect, isIP, type LookupFunction, type Socket } from "node:net";
import type { HealthCheckProbe } from "../../domain/health-checks.ts";

/**
 * The connection a health check makes, and nothing more.
 *
 * Everything here is pinned by the caller: the literal address, the port, the
 * path, and the name the request presents. Nothing is resolved -- the lookup
 * hook throws, so a hostname reaching this layer is an error rather than a
 * query -- nothing is pooled, no proxy is consulted, and no redirect is
 * followed. Each limit bounds what one probe can cost: a 2 second deadline, an
 * 8 KiB header block and 4 KiB of body before the response is dropped.
 *
 * The result is a category and, for HTTP, the status code. Never the body,
 * never a header and never an error message, which may quote either.
 */

export const PROBE_DEADLINE_MS = 2_000;
export const MAX_PROBE_HEADER_BYTES = 8 * 1024;
export const MAX_PROBE_BODY_BYTES = 4 * 1024;

export type ProbeFailure = "timeout" | "connection" | "tls" | "http-status" | "blocked";

export type ProbeResult =
  | { readonly ok: true; readonly status?: number }
  | { readonly ok: false; readonly category: ProbeFailure; readonly status?: number };

export interface ProbeTarget {
  /** A literal address the safety check has already accepted. */
  readonly address: string;
  readonly probe: HealthCheckProbe;
  /** The protected RRset's absolute name, for the Host header and SNI. */
  readonly host: string;
}

export interface ProbeTransport {
  probe(target: ProbeTarget, signal: AbortSignal): Promise<ProbeResult>;
}

export interface ProbeTransportOptions {
  readonly deadlineMs?: number;
  /**
   * Where the connection actually goes, for tests that stand a fake origin up
   * on loopback behind an address the allow-list accepts. Programmatic only: no
   * configuration reaches it, because in production it would be the very
   * redirection the safety check exists to prevent.
   */
  readonly remap?: (address: string, port: number) => { address: string; port: number };
  /** Extra trust anchors for tests. Deployments use `NODE_EXTRA_CA_CERTS`. */
  readonly ca?: string | Buffer;
}

/** Proves no name is resolved: a probe that reaches this hook is a defect. */
const refuseLookup: LookupFunction = (hostname) => {
  throw new Error(`health check probes connect to literal addresses only, not ${hostname}`);
};

export function createProbeTransport(options: ProbeTransportOptions = {}): ProbeTransport {
  const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS;
  // Dedicated agents rather than the global ones. The global agent is where an
  // environment proxy is attached (`NODE_USE_ENV_PROXY`), and where a socket
  // kept alive for one origin could be handed to a request meant for another.
  const httpAgent = new HttpAgent({ keepAlive: false, maxSockets: Infinity });
  const httpsAgent = new HttpsAgent({ keepAlive: false, maxSockets: Infinity });

  return {
    probe(target, signal) {
      const destination = options.remap
        ? options.remap(target.address, target.probe.port)
        : { address: target.address, port: target.probe.port };
      if (isIP(destination.address) === 0) return Promise.resolve({ ok: false, category: "blocked" });
      if (signal.aborted) return Promise.resolve({ ok: false, category: "timeout" });
      return target.probe.kind === "tcp"
        ? probeTcp(destination, deadlineMs, signal)
        : probeHttp(target, destination, deadlineMs, signal, target.probe.kind === "https" ? httpsAgent : httpAgent, options.ca);
    },
  };
}

function probeTcp(
  destination: { address: string; port: number },
  deadlineMs: number,
  signal: AbortSignal,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket: Socket = connect({ host: destination.address, port: destination.port, lookup: refuseLookup });
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(result);
    };
    const onAbort = (): void => finish({ ok: false, category: "timeout" });
    const timer = setTimeout(() => finish({ ok: false, category: "timeout" }), deadlineMs);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    // Connected is the whole check. Nothing is written: the listener has
    // proved it accepts, and anything further is a protocol this probe does
    // not speak.
    socket.once("connect", () => finish({ ok: true }));
    socket.once("error", () => finish({ ok: false, category: "connection" }));
  });
}

function probeHttp(
  target: ProbeTarget,
  destination: { address: string; port: number },
  deadlineMs: number,
  signal: AbortSignal,
  agent: HttpAgent,
  ca: string | Buffer | undefined,
): Promise<ProbeResult> {
  const probe = target.probe as Extract<HealthCheckProbe, { kind: "http" | "https" }>;
  const secure = probe.kind === "https";
  const host = target.host.replace(/\.$/u, "");
  const defaultPort = secure ? 443 : 80;
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let secured = false;
    let response: IncomingMessage | undefined;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      response?.destroy();
      request.destroy();
      resolve(result);
    };
    const onAbort = (): void => finish({ ok: false, category: "timeout" });
    const timer = setTimeout(() => finish({ ok: false, category: "timeout" }), deadlineMs);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });

    const send = secure ? httpsRequest : httpRequest;
    const request: ClientRequest = send({
      host: destination.address,
      port: destination.port,
      path: probe.path,
      method: "GET",
      agent,
      lookup: refuseLookup,
      setHost: false,
      maxHeaderSize: MAX_PROBE_HEADER_BYTES,
      headers: {
        host: destination.port === defaultPort || probe.port === defaultPort ? host : `${host}:${probe.port}`,
        "user-agent": "parallax-health-check",
        accept: "*/*",
        connection: "close",
      },
      ...(secure
        ? {
          // The name the certificate must carry is the protected name, not the
          // address dialled -- exactly what a client of that name would check.
          // Verification stays on; an origin with a private CA is trusted
          // through NODE_EXTRA_CA_CERTS, like any other Node client.
          servername: host,
          rejectUnauthorized: true,
          ...(ca ? { ca } : {}),
        }
        : {}),
    });
    request.once("socket", (socket: Socket) => {
      socket.once("connect", () => { connected = true; });
      socket.once("secureConnect", () => { secured = true; });
    });
    request.once("response", (incoming) => {
      response = incoming;
      const status = incoming.statusCode ?? 0;
      // Any 2xx. A redirect is a failure rather than something to follow: the
      // location is chosen by the origin, and following it is a connection to
      // somewhere the allow-list never judged.
      const result: ProbeResult = status >= 200 && status < 300
        ? { ok: true, status }
        : { ok: false, category: "http-status", status };
      // The verdict is the status line. The body is read only so a small one
      // can finish cleanly, and never past the cap.
      let received = 0;
      incoming.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_PROBE_BODY_BYTES) finish(result);
      });
      incoming.once("end", () => finish(result));
      incoming.once("error", () => finish(result));
      incoming.once("aborted", () => finish(result));
    });
    request.once("error", (error: NodeJS.ErrnoException) => {
      if (secure && connected && !secured) return finish({ ok: false, category: "tls" });
      if (error.code === "HPE_HEADER_OVERFLOW" || error.code?.startsWith("HPE_")) {
        return finish({ ok: false, category: "http-status" });
      }
      finish({ ok: false, category: "connection" });
    });
    request.end();
  });
}
