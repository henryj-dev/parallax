import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, it } from "node:test";

import { ControlPlane } from "../../src/application/control-plane.ts";
import { createDnsServer, type ServedZone } from "../../src/dns/server.ts";
import { TYPE } from "../../src/dns/wire.ts";
import { createNodeHandler } from "../../src/http/api.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";
import { render, resetMetrics } from "../../src/observability/metrics.ts";
import {
  certificateReloadFailed, notifyFailed, recordUnservable, refreshFailed, replyUnanswerable, zoneSkipped,
} from "../../src/observability/signals.ts";
import { freePort } from "../support/ports.ts";

/**
 * The counters, asked whether they fire.
 *
 * ⚠️ `signals.ts` measured **100% line, branch and function** and this file did
 * not exist. The body of that module is eleven `counter(...)`/`histogram(...)`
 * declarations, and a declaration executes when anything imports the module --
 * which every one of these suites does, transitively, on the way to something
 * else. So the number was reporting that the file had been *loaded*. The only
 * mention of any of these names anywhere under `test/` was a comment.
 *
 * That is the failure mode `metrics.ts` was written against, one level up: a
 * counter nobody can tell apart from a counter that does not exist. A signal
 * that is declared and never incremented reports `0` forever, an alert written
 * against it never fires, and the endpoint keeps looking healthy -- which is
 * exactly the shape of the original defect the whole subsystem exists for.
 *
 * 🔑 **The split below is deliberate and it is not uniform.** Five signals are
 * driven end to end: a real API call through the Node handler, and a real DNS
 * query over a real socket. Six are exercised at the registry level, and the
 * reason is one fact rather than convenience -- their only caller is
 * `src/index.ts`, a module that starts listeners the moment it is imported, so
 * the only way to reach them is to spawn a process, and a spawned process has
 * its own registry that `render()` here cannot see. Those six are held to:
 * registered under the name a dashboard would query, of the right type, moving
 * by one per call, and carrying the label sets `src/index.ts` actually passes.
 *
 * A uniform shallow test over all eleven would have read better and said less.
 */

/** Everything declared, in the order a reader of `signals.ts` meets them. */
const COUNTERS = [
  "parallax_dns_unservable_records_total",
  "parallax_dns_unanswerable_replies_total",
  "parallax_dns_zones_skipped_total",
  "parallax_refresh_failures_total",
  "parallax_dns_notify_failures_total",
  "parallax_tls_certificate_reload_failures_total",
  "parallax_dns_answers_total",
  "parallax_dns_forward_failures_total",
  "parallax_http_responses_total",
] as const;

const HISTOGRAMS = [
  "parallax_dns_forward_seconds",
  "parallax_http_request_seconds",
] as const;

/**
 * ⚠️ The reset is process-wide, exactly as in `metrics.test.ts`, and it is why
 * the first case below has to stay first: `signals.ts` declares its counters
 * once when the module loads, and the first reset drops that declaration. Every
 * later case re-declares what it needs by calling it, which is the documented
 * behaviour of the closure `counter()` returns -- but "declared and never
 * touched" is only observable before anything has reset.
 */
afterEach(() => { resetMetrics(); });

describe("what importing the module alone declares", () => {
  it("registers all eleven signals, at zero, before any of them has fired", () => {
    const text = render();

    for (const name of COUNTERS) {
      assert.match(text, new RegExp(`^# TYPE ${name} counter$`, "mu"), name);
      // Present *at zero*, which is the distinction the endpoint exists for: a
      // series that only appears after the first failure cannot tell "never
      // happened" from "no such metric", and `rate(...) == 0` reads the same
      // for both.
      assert.match(text, new RegExp(`^${name} 0$`, "mu"), name);
    }
    for (const name of HISTOGRAMS) {
      assert.match(text, new RegExp(`^# TYPE ${name} histogram$`, "mu"), name);
    }
  });
});

/**
 * The six whose only caller is `src/index.ts`.
 *
 * Each one is the sole warning of something that is otherwise silent: a stored
 * record the wire cannot carry, a reply that could not be assembled, a zone
 * left out of the snapshot, a background refresh that has been failing since
 * the last deploy, a NOTIFY nobody received, a certificate that could not be
 * re-read. None of them has a user-visible symptom until much later -- which is
 * why they are counters and not log lines, and why a counter that is wired to
 * nothing would be worse than no counter at all.
 *
 * What is proved here is the registry contract: the name a dashboard queries,
 * the type, the label sets `src/index.ts` passes, and that a call moves the
 * number `render()` reports. What is not proved here is that `src/index.ts`
 * calls them on the right events -- see the note at the top of this file, and
 * `test/http/identity-only-deployment.test.ts`, which scrapes a real process's
 * `/metrics` and finds `parallax_dns_unservable_records_total` present at zero.
 */
describe("the failure counters src/index.ts is the only caller of", () => {
  it("moves by one per call, under the name a dashboard would query", () => {
    const unlabelled = [
      ["parallax_dns_unservable_records_total", recordUnservable],
      ["parallax_dns_unanswerable_replies_total", replyUnanswerable],
      ["parallax_dns_zones_skipped_total", zoneSkipped],
      ["parallax_dns_notify_failures_total", notifyFailed],
      ["parallax_tls_certificate_reload_failures_total", certificateReloadFailed],
    ] as const;

    for (const [, fire] of unlabelled) { fire(); fire(); }

    const text = render();
    for (const [name] of unlabelled) {
      assert.match(text, new RegExp(`^# TYPE ${name} counter$`, "mu"), name);
      assert.match(text, new RegExp(`^${name} 2$`, "mu"), name);
    }
  });

  /**
   * `refreshFailed` is the one with a label, and the label is the whole value
   * of it: four independent loops report through this counter, and "refreshes
   * are failing" without saying which one is a page nobody can act on. The four
   * names below are the four `src/index.ts` passes -- if one is renamed there
   * and not here, the dashboard keeps drawing the old series at zero forever.
   */
  it("keeps the four refresh loops apart by subsystem", () => {
    refreshFailed({ subsystem: "access-tokens" });
    refreshFailed({ subsystem: "settings" });
    refreshFailed({ subsystem: "settings" });
    refreshFailed({ subsystem: "credentials" });
    refreshFailed({ subsystem: "desired-state" });

    const text = render();
    assert.match(text, /^parallax_refresh_failures_total\{subsystem="access-tokens"\} 1$/mu);
    assert.match(text, /^parallax_refresh_failures_total\{subsystem="settings"\} 2$/mu);
    assert.match(text, /^parallax_refresh_failures_total\{subsystem="credentials"\} 1$/mu);
    assert.match(text, /^parallax_refresh_failures_total\{subsystem="desired-state"\} 1$/mu);
    // No bare series: a labelled counter that also reported an unlabelled total
    // would double-count every one of these in a sum.
    assert.doesNotMatch(text, /^parallax_refresh_failures_total \d+$/mu);
  });
});

/**
 * The HTTP pair, driven by a real request through the real handler.
 *
 * `httpAnswered` is the denominator every failure counter in this file needs:
 * without it, "three 500s" is either an outage or a rounding error and nothing
 * in the exposition says which. `httpSeconds` is the question neither a counter
 * nor a gauge can answer -- whether this is slower than it was.
 *
 * They are incremented in `createNodeHandler`, after the response status is
 * decided and before the body is written, so a mocked `IncomingMessage` and
 * `ServerResponse` are enough to exercise the real path -- the same shape
 * `test/http/api.test.ts` uses.
 */
describe("the HTTP request signals", () => {
  async function call(path: string): Promise<number> {
    const adapters = createInMemoryAdapters();
    const handler = createNodeHandler({
      controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider),
    });
    const incoming = Readable.from([]) as IncomingMessage;
    incoming.method = "GET";
    incoming.url = path;
    incoming.headers = { host: "localhost" };
    let status = 0;
    const response = {
      set statusCode(code: number) { status = code; },
      setHeader() { return this; },
      end() { return this; },
    } as unknown as ServerResponse;

    await handler(incoming, response);
    return status;
  }

  it("counts the answer under the status the response actually carried", async () => {
    const served = await call("/api/v1/zones");
    const missing = await call("/api/v1/there-is-no-such-route");
    assert.equal(served, 200);
    assert.notEqual(missing, served, "the two calls must not share a status, or the label proves nothing");

    const text = render();
    assert.match(text, /^# TYPE parallax_http_responses_total counter$/mu);
    assert.match(text, /^parallax_http_responses_total\{status="200"\} 1$/mu);
    assert.match(text, new RegExp(`^parallax_http_responses_total\\{status="${missing}"\\} 1$`, "mu"));
  });

  it("times every answered request, including the one that was refused", async () => {
    await call("/api/v1/zones");
    await call("/api/v1/there-is-no-such-route");

    const text = render();
    assert.match(text, /^# TYPE parallax_http_request_seconds histogram$/mu);
    // Both, and unlabelled: leaving the failures out would flatter the number,
    // and a latency that only counts successes hides the slowest thing there is.
    assert.match(text, /^parallax_http_request_seconds_bucket\{le="\+Inf"\} 2$/mu);
    assert.match(text, /^parallax_http_request_seconds_count 2$/mu);

    const sum = Number(/^parallax_http_request_seconds_sum (\S+)$/mu.exec(text)?.[1]);
    assert.ok(Number.isFinite(sum) && sum >= 0, `the sum must be a real duration, got ${String(sum)}`);
  });
});

/**
 * The three DNS signals, driven by a real query over a real socket.
 *
 * `dnsAnswered` is read back off the assembled reply rather than threaded down
 * from wherever the rcode was decided -- a dozen places decide one and two send
 * one -- so the only honest way to test it is to make the listener send a reply
 * and read the counter afterwards. The forwarding pair is reached the same way:
 * a name outside every served zone, and an upstream whose host does not resolve.
 *
 * ⚠️ 질의 조립 헬퍼는 `test/dns/server.test.ts` 에도 있다. 열두 줄이라 여기서는
 * 다시 적었지만, 같은 함수가 두 벌인 것은 사실이고 `test/support/ports.ts` 가
 * 적어 둔 교훈이 적용되는 방향이다.
 */
describe("the DNS listener signals", () => {
  function encodeName(name: string): Buffer {
    const chunks: Buffer[] = [];
    for (const label of name.split(".")) chunks.push(Buffer.of(label.length), Buffer.from(label, "latin1"));
    chunks.push(Buffer.of(0));
    return Buffer.concat(chunks);
  }

  function buildQuery(name: string, type: number = TYPE.A): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x4242, 0);
    header.writeUInt16BE(0x0100, 2);
    header.writeUInt16BE(1, 4);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(1, 2);
    return Buffer.concat([header, encodeName(name), tail]);
  }

  const ZONE: ServedZone = {
    name: "internal.test",
    serial: 1,
    records: [{ name: "@", type: "A", content: "10.0.0.1", ttl: 60 }],
  };

  /**
   * A listener on a port the kernel just said was free, with the forwarding
   * behaviour the case asks for. `resolveHost` is injected so no test here ever
   * touches the machine's resolver: the bind address answers, and everything
   * else is a host that does not exist.
   */
  async function listening(forwardTo: readonly string[]): Promise<{
    port: number;
    close: () => Promise<void>;
  }> {
    const port = await freePort("127.0.0.1", { udp: true });
    const server = createDnsServer({
      zones: () => [ZONE],
      forwardTo,
      forwardTimeoutMs: 500,
      resolveHost: async (host) => {
        if (host === "127.0.0.1") return { address: "127.0.0.1", family: 4 };
        throw new Error(`no address for ${host}`);
      },
    });
    await server.listen(port, "127.0.0.1");
    return { port, close: () => server.close() };
  }

  /** Sends one datagram and waits for the reply, rather than for a fixed delay. */
  async function ask(port: number, message: Buffer): Promise<Buffer> {
    const socket = createSocket("udp4");
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error("no reply within 5000ms")); }, 5_000);
        socket.once("message", (reply) => { clearTimeout(timer); resolve(reply); });
        socket.once("error", (error) => { clearTimeout(timer); reject(error); });
        socket.send(message, port, "127.0.0.1");
      });
    } finally {
      await new Promise<void>((resolve) => socket.close(resolve));
    }
  }

  it("counts an answer it served out of a zone, by rcode", async () => {
    const listener = await listening([]);
    try {
      const reply = await ask(listener.port, buildQuery("internal.test"));
      assert.equal(reply.readUInt16BE(2) & 0x000f, 0, "the listener answered NOERROR");
    } finally {
      await listener.close();
    }

    const text = render();
    assert.match(text, /^# TYPE parallax_dns_answers_total counter$/mu);
    assert.match(text, /^parallax_dns_answers_total\{rcode="noerror"\} 1$/mu);
  });

  /**
   * One query, three signals, and the reason they belong together: a forwarded
   * query that cannot be relayed is answered SERVFAIL, and a run of those is
   * indistinguishable from a broken zone unless the forwarding counters say
   * which upstream and why.
   *
   * The upstream host does not resolve, which is `reason="resolve"` -- the
   * everyday one, and the one that looks like a working resolver from outside
   * because the listener keeps answering.
   */
  it("counts a failed relay, times it, and records the SERVFAIL it produced", async () => {
    const listener = await listening(["upstream.invalid"]);
    try {
      const reply = await ask(listener.port, buildQuery("outside.example"));
      assert.equal(reply.readUInt16BE(2) & 0x000f, 2, "the listener answered SERVFAIL");
    } finally {
      await listener.close();
    }

    const text = render();
    assert.match(text, /^parallax_dns_answers_total\{rcode="servfail"\} 1$/mu);
    // The upstream index rather than its address: the address is a deployment
    // detail and would be unbounded label cardinality; the index is what the
    // configuration already numbers.
    assert.match(text, /^parallax_dns_forward_failures_total\{reason="resolve",upstream="0"\} 1$/mu);
    // Timed whether or not an upstream answered. Leaving the failures out is
    // what makes a forwarder look fast on the day it stops working.
    assert.match(text, /^# TYPE parallax_dns_forward_seconds histogram$/mu);
    assert.match(text, /^parallax_dns_forward_seconds_bucket\{outcome="failed",le="\+Inf"\} 1$/mu);
    assert.match(text, /^parallax_dns_forward_seconds_count\{outcome="failed"\} 1$/mu);
  });
});
