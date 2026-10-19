import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHealthMonitor,
  type HealthMonitorOptions,
  type HealthMonitorSettings,
  type HealthTransition,
} from "../../src/dns/health/monitor.ts";
import type { ServedHealthCheck } from "../../src/dns/health/targets.ts";
import type { ProbeResult, ProbeTarget } from "../../src/dns/health/transport.ts";

/**
 * The monitor owns no clock and no timers of its own here: the test moves time
 * and fires the one timer the monitor arms, and a fake transport answers each
 * probe the way the case needs.
 */

const ZONE = "example.com";
const INTERVAL = 10_000;

const on: HealthMonitorSettings = {
  dnsHealthChecksEnabled: true,
  dnsHealthCheckAllowCidrs: ["10.0.0.0/24"],
  dnsHealthCheckAllowPorts: [443],
};

function check(addresses: string[], extra: Partial<ServedHealthCheck> = {}): ServedHealthCheck {
  return { name: `app.${ZONE}`, type: "A", ttl: 30, probe: { kind: "tcp", port: 443 }, addresses, ...extra };
}

interface Pending { at: number; callback: () => void }

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function harness(answer: (target: ProbeTarget, signal: AbortSignal) => Promise<ProbeResult> | ProbeResult, options: Partial<HealthMonitorOptions> = {}) {
  let clock = 0;
  const timers = new Set<Pending>();
  const calls: ProbeTarget[] = [];
  const transitions: HealthTransition[] = [];
  const monitor = createHealthMonitor({
    transport: {
      probe: async (target, signal) => {
        calls.push(target);
        return answer(target, signal);
      },
    },
    now: () => clock,
    random: () => 0,
    timers: {
      setTimeout: (callback, ms) => {
        const pending = { at: clock + ms, callback };
        timers.add(pending);
        return pending;
      },
      clearTimeout: (handle) => { timers.delete(handle as Pending); },
    },
    onTransition: (transition) => transitions.push(transition),
    ...options,
  });

  /** Moves the clock to `to`, firing every timer that falls due on the way. */
  async function advance(to: number): Promise<void> {
    await flush();
    for (;;) {
      const due = [...timers].filter((pending) => pending.at <= to).sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      timers.delete(due);
      clock = Math.max(clock, due.at);
      due.callback();
      await flush();
    }
    clock = to;
  }

  return { monitor, calls, transitions, timers, advance, time: () => clock };
}

const healthy = (): ProbeResult => ({ ok: true });
const refused = (): ProbeResult => ({ ok: false, category: "connection" });

describe("health monitor", () => {
  it("probes nothing and gives nothing out until it is turned on", async () => {
    const h = harness(healthy);
    const served = check(["10.0.0.11"]);
    h.monitor.update([{ name: ZONE, healthChecks: [served] }]);
    await h.advance(60_000);
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "unprobeable");
    const status = h.monitor.status(ZONE);
    assert.equal(status.servedHere, true);
    assert.equal(status.probing, false);
    assert.equal(status.checks[0]?.targets[0]?.status, "disabled");
    assert.equal(status.checks[0]?.answer, "servfail");
    assert.deepEqual(h.monitor.summary(), { targets: 1, healthy: 0, unhealthy: 0, unknown: 0, blocked: 0, overLimit: 0 });
  });

  it("treats an address it was never given as unprobeable, so answer-all cannot hand it out", async () => {
    const h = harness(healthy);
    const served = check(["10.0.0.11"]);
    h.monitor.configure(on);
    // No update: nothing has judged this address against the allow-list.
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "unprobeable");
    h.monitor.update([{ name: ZONE, healthChecks: [served] }]);
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "unconfirmed", "tracked but not yet probed");
  });

  it("trusts a first success, probes every interval, and drops the address on the third failure", async () => {
    let answer: () => ProbeResult = healthy;
    const h = harness(() => answer());
    const served = check(["10.0.0.11"]);
    h.monitor.update([{ name: ZONE, healthChecks: [served] }]);
    h.monitor.configure(on);
    await h.advance(0);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0], { address: "10.0.0.11", probe: { kind: "tcp", port: 443 }, host: `app.${ZONE}` });
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "healthy");
    assert.equal(h.monitor.status(ZONE).checks[0]?.answer, "filtered");
    assert.equal(h.monitor.status(ZONE).checks[0]?.targets[0]?.checkedAt, new Date(0).toISOString());

    answer = refused;
    await h.advance(INTERVAL * 2);
    assert.equal(h.calls.length, 3);
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "healthy", "two failures are survived");
    await h.advance(INTERVAL * 3);
    assert.equal(h.calls.length, 4);
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "unconfirmed");
    const target = h.monitor.status(ZONE).checks[0]?.targets[0];
    assert.equal(target?.status, "unhealthy");
    assert.equal(target?.lastFailure, "connection");

    answer = healthy;
    await h.advance(INTERVAL * 4);
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "unconfirmed", "one success is not recovery");
    await h.advance(INTERVAL * 5);
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "healthy");

    // One transition per change, never per probe.
    assert.deepEqual(h.transitions.map((entry) => `${entry.from}>${entry.to}`), [
      "disabled>unknown",
      "unknown>healthy",
      "healthy>unhealthy",
      "unhealthy>healthy",
    ]);
    const down = h.transitions[2];
    assert.equal(down?.zone, ZONE);
    assert.equal(down?.address, "10.0.0.11");
    assert.equal(down?.lastFailure, "connection");
    assert.equal(h.transitions[3]?.lastFailure, undefined);
  });

  it("goes stale when probes stop completing, and fails closed", async () => {
    let hang = false;
    const h = harness((_target, signal) => hang
      ? new Promise<ProbeResult>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, category: "timeout" })))
      : healthy());
    const served = check(["10.0.0.11"]);
    h.monitor.update([{ name: ZONE, healthChecks: [served] }]);
    h.monitor.configure(on);
    await h.advance(0);
    hang = true;
    await h.advance(INTERVAL);
    assert.equal(h.calls.length, 2);
    await h.advance(30_000);
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "healthy", "still fresh at the freshness limit");
    await h.advance(30_001);
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "unconfirmed");
    assert.equal(h.monitor.status(ZONE).checks[0]?.targets[0]?.status, "stale");
    assert.equal(h.monitor.summary().unknown, 1);
    await h.monitor.close();
  });

  it("blocks an address the allow-list refuses and never probes it", async () => {
    const h = harness(healthy);
    const served = check(["10.0.0.11", "203.0.113.7"]);
    const wrongPort = check(["10.0.0.11"], { name: `web.${ZONE}`, probe: { kind: "http", port: 8080, path: "/health/ready" } });
    h.monitor.update([{ name: ZONE, healthChecks: [served, wrongPort] }]);
    h.monitor.configure(on);
    await h.advance(0);
    assert.deepEqual(h.calls.map((call) => `${call.host} ${call.address}`), [`app.${ZONE} 10.0.0.11`]);
    const [app, web] = h.monitor.status(ZONE).checks;
    assert.deepEqual(app?.targets.map((target) => [target.address, target.status, target.blockedReason]), [
      ["10.0.0.11", "healthy", undefined],
      ["203.0.113.7", "blocked", "outside-allowed-networks"],
    ]);
    assert.equal(web?.targets[0]?.blockedReason, "port-not-allowed");
    assert.equal(h.monitor.verdict()(ZONE, served, "203.0.113.7"), "unprobeable");
    assert.deepEqual(h.monitor.summary(), { targets: 3, healthy: 1, unhealthy: 0, unknown: 0, blocked: 2, overLimit: 0 });

    // Widening the list unblocks the address and starts it from nothing.
    h.monitor.configure({ ...on, dnsHealthCheckAllowCidrs: ["10.0.0.0/24", "203.0.113.0/24"], dnsHealthCheckAllowPorts: [443, 8080] });
    assert.equal(h.monitor.status(ZONE).checks[0]?.targets[1]?.status, "unknown");
    await h.advance(h.time());
    assert.equal(h.monitor.verdict()(ZONE, served, "203.0.113.7"), "healthy");
    assert.equal(h.monitor.verdict()(ZONE, wrongPort, "10.0.0.11"), "healthy");
  });

  it("holds the process to its target limit, in a fixed order, without counting unsupported zones", async () => {
    const h = harness(healthy, { maxTargets: 2, unsupported: (zone) => zone === "published.example.com" });
    const served = check(["10.0.0.13", "10.0.0.11", "10.0.0.12"]);
    const published = check(["10.0.0.11"], { name: "app.published.example.com" });
    h.monitor.update([{ name: ZONE, healthChecks: [served] }, { name: "published.example.com", healthChecks: [published] }]);
    h.monitor.configure(on);
    await h.advance(0);
    assert.deepEqual(h.calls.map((call) => call.address).sort(), ["10.0.0.11", "10.0.0.12"]);
    const statuses = h.monitor.status(ZONE).checks[0]?.targets.map((target) => `${target.address}=${target.status}`);
    assert.deepEqual(statuses, ["10.0.0.13=over_limit", "10.0.0.11=healthy", "10.0.0.12=healthy"]);
    assert.equal(h.monitor.status("published.example.com").checks[0]?.targets[0]?.status, "unsupported_target");
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.13"), "unprobeable");
    assert.equal(h.monitor.summary().overLimit, 1);

    // Losing an address frees a slot for the next one in order.
    h.monitor.update([{ name: ZONE, healthChecks: [check(["10.0.0.13", "10.0.0.12"])] }]);
    assert.equal(h.monitor.status(ZONE).checks[0]?.targets[0]?.status, "unknown");
    assert.equal(h.monitor.status(ZONE).checks[0]?.targets[1]?.status, "healthy", "an unchanged target keeps its state");
  });

  it("answers SERVFAIL for a check with an issue and probes nothing for it", async () => {
    const h = harness(healthy);
    h.monitor.update([{ name: ZONE, healthChecks: [check([], { issue: "no A record to protect" })] }]);
    h.monitor.configure(on);
    await h.advance(0);
    assert.equal(h.calls.length, 0);
    const status = h.monitor.status(ZONE).checks[0];
    assert.equal(status?.issue, "no A record to protect");
    assert.equal(status?.answer, "servfail");
    assert.deepEqual(status?.targets, []);
    assert.equal(h.monitor.status("other.example.com").servedHere, false);
  });

  it("reports a served zone as served here when none of its policies is enabled", () => {
    const h = harness(healthy);
    // The snapshot drops disabled policies, so such a zone arrives with none.
    h.monitor.update([{ name: ZONE }, { name: "other.example.com", healthChecks: [] }]);
    assert.equal(h.monitor.status(ZONE).servedHere, true);
    assert.deepEqual(h.monitor.status(ZONE).checks, []);
    assert.equal(h.monitor.status("other.example.com").servedHere, true);
    assert.equal(h.monitor.status("unknown.example.com").servedHere, false);
    // A zone the listener stops answering for stops being served here.
    h.monitor.update([{ name: "other.example.com" }]);
    assert.equal(h.monitor.status(ZONE).servedHere, false);
  });

  it("starts a target over when its probe changes or probing is turned off and on", async () => {
    const h = harness(healthy);
    const served = check(["10.0.0.11"]);
    h.monitor.update([{ name: ZONE, healthChecks: [served] }]);
    h.monitor.configure(on);
    await h.advance(0);
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "healthy");

    h.monitor.configure({ ...on, dnsHealthChecksEnabled: false });
    assert.equal(h.monitor.status(ZONE).checks[0]?.targets[0]?.status, "disabled");
    h.monitor.configure(on);
    assert.equal(h.monitor.status(ZONE).checks[0]?.targets[0]?.status, "unknown", "old results are not reused");

    await h.advance(h.time());
    const moved = check(["10.0.0.11"], { probe: { kind: "tcp", port: 443 }, ttl: 10 });
    h.monitor.update([{ name: ZONE, healthChecks: [moved] }]);
    assert.equal(h.monitor.verdict()(ZONE, moved, "10.0.0.11"), "healthy", "a TTL change is the same question");
    const otherPath = check(["10.0.0.11"], { probe: { kind: "https", port: 443, path: "/ready" } });
    h.monitor.update([{ name: ZONE, healthChecks: [otherPath] }]);
    assert.equal(h.monitor.verdict()(ZONE, otherPath, "10.0.0.11"), "unconfirmed", "a new probe is a new question");
  });

  it("keeps at most the configured number of probes in flight and drops results after close", async () => {
    const waiting: (() => void)[] = [];
    // Like the real transport, a probe settles when it is aborted; close waits for that.
    const h = harness((_target, signal) => new Promise<ProbeResult>((resolve) => {
      waiting.push(() => resolve({ ok: true }));
      signal.addEventListener("abort", () => resolve({ ok: false, category: "timeout" }));
    }), { concurrency: 2 });
    const served = check(["10.0.0.11", "10.0.0.12", "10.0.0.13"]);
    h.monitor.update([{ name: ZONE, healthChecks: [served] }]);
    h.monitor.configure(on);
    await h.advance(0);
    assert.equal(h.calls.length, 2);
    waiting.shift()?.();
    await h.advance(0);
    assert.equal(h.calls.length, 3, "a free slot takes the next queued target");

    await h.monitor.close();
    for (const release of waiting) release();
    await h.advance(INTERVAL * 3);
    assert.equal(h.calls.length, 3);
    assert.equal(h.timers.size, 0);
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.12"), "unprobeable");
    h.monitor.update([{ name: ZONE, healthChecks: [] }]);
    assert.equal(h.monitor.status(ZONE).checks.length, 1, "a closed monitor ignores updates");
  });

  it("reports answer-all as answering every address while nothing is healthy and every address is probed", async () => {
    let answer: () => ProbeResult = refused;
    let hang = false;
    const h = harness((_target, signal) => hang
      ? new Promise<ProbeResult>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, category: "timeout" })))
      : answer());
    const served = check(["10.0.0.11", "10.0.0.12"], { whenNoneHealthy: "answer-all" });
    const plain = check(["10.0.0.11"], { name: `web.${ZONE}` });
    h.monitor.update([{ name: ZONE, healthChecks: [served, plain] }]);

    // Probing off is configuration: nobody is looking, so nothing fails open.
    assert.equal(h.monitor.status(ZONE).checks[0]?.answer, "servfail");
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "unprobeable");

    // Just turned on, before any probe has finished: unknown, and answered in full.
    h.monitor.configure(on);
    assert.deepEqual(h.monitor.status(ZONE).checks[0]?.targets.map((target) => target.status), ["unknown", "unknown"]);
    assert.equal(h.monitor.status(ZONE).checks[0]?.answer, "all");
    assert.equal(h.monitor.status(ZONE).checks[1]?.answer, "servfail", "a policy left at the default still fails closed");
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.11"), "unconfirmed");

    // Failing.
    await h.advance(0);
    assert.deepEqual(h.monitor.status(ZONE).checks[0]?.targets.map((target) => target.status), ["unhealthy", "unhealthy"]);
    assert.equal(h.monitor.status(ZONE).checks[0]?.answer, "all");

    // One healthy address: filtered as usual.
    answer = healthy;
    await h.advance(INTERVAL);
    await h.advance(INTERVAL * 2);
    assert.equal(h.monitor.status(ZONE).checks[0]?.answer, "filtered");

    // Stale.
    hang = true;
    await h.advance(INTERVAL * 2 + 30_001);
    assert.deepEqual(h.monitor.status(ZONE).checks[0]?.targets.map((target) => target.status), ["stale", "stale"]);
    assert.equal(h.monitor.status(ZONE).checks[0]?.answer, "all");
    assert.equal(h.monitor.verdict()(ZONE, served, "10.0.0.12"), "unconfirmed");
    await h.monitor.close();
  });

  it("does not report answer-all for a blocked address or a check with an issue", () => {
    const h = harness(healthy);
    const blocked = check(["10.0.0.11", "203.0.113.7"], { whenNoneHealthy: "answer-all" });
    const broken = check([], { name: `web.${ZONE}`, whenNoneHealthy: "answer-all", issue: "no A record to protect" });
    h.monitor.update([{ name: ZONE, healthChecks: [blocked, broken] }]);
    h.monitor.configure(on);
    const [first, second] = h.monitor.status(ZONE).checks;
    assert.deepEqual(first?.targets.map((target) => target.status), ["unknown", "blocked"]);
    assert.equal(first?.answer, "servfail");
    assert.equal(second?.answer, "servfail");
  });

  it("counts a transport that throws as a connection failure", async () => {
    const h = harness(() => { throw new Error("socket exploded"); });
    const served = check(["10.0.0.11"]);
    h.monitor.update([{ name: ZONE, healthChecks: [served] }]);
    h.monitor.configure(on);
    await h.advance(0);
    assert.equal(h.monitor.status(ZONE).checks[0]?.targets[0]?.lastFailure, "connection");
    assert.equal(h.monitor.status(ZONE).checks[0]?.targets[0]?.status, "unhealthy");
  });
});
