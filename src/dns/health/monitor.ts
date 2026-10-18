import { MAX_HEALTH_CHECK_TARGETS } from "../../domain/health-checks.ts";
import { dnsHealthProbes, dnsHealthTransitions } from "../../observability/signals.ts";
import { compileProbeAllowList, probeBlockReason, type ProbeAllowList, type ProbeBlockReason } from "./address.ts";
import {
  effectiveStatus,
  HEALTH_PROBE_INTERVAL_MS,
  HEALTH_RESULT_FRESHNESS_MS,
  INITIAL_PROBE_STATE,
  recordProbe,
  type EffectiveStatus,
  type ProbeState,
} from "./state.ts";
import { healthTargetKey, healthTargetsOf, type HealthTarget, type HealthVerdict, type ServedHealthCheck } from "./targets.ts";
import type { ProbeFailure, ProbeResult, ProbeTransport } from "./transport.ts";

/**
 * Probes the addresses the served zones' health checks name, and answers, per
 * address, whether the listener may give it out.
 *
 * Process-local on purpose. Each replica judges the addresses from where it
 * sits, which is where its clients sit; nothing is written to the store, so a
 * probe never changes a revision, a serial or the audit trail.
 *
 * The answer to "may this address be given out" is no unless this process has
 * a fresh success for it. Off, blocked, over the limit, not yet probed, stale
 * -- every state but healthy fails closed, and the listener answers SERVFAIL
 * when no address of an RRset is left.
 */

export const HEALTH_PROBE_CONCURRENCY = 16;
/** Up to 10% of the interval, so replicas that started together drift apart. */
const JITTER_FRACTION = 0.1;

export interface HealthMonitorSettings {
  readonly dnsHealthChecksEnabled: boolean;
  readonly dnsHealthCheckAllowCidrs: readonly string[];
  readonly dnsHealthCheckAllowPorts: readonly number[];
}

export type TargetStatus =
  | "disabled"
  | "blocked"
  | "unsupported_target"
  | "over_limit"
  | EffectiveStatus;

export interface HealthTargetStatus {
  readonly address: string;
  readonly status: TargetStatus;
  readonly blockedReason?: ProbeBlockReason;
  readonly lastFailure?: ProbeFailure;
  readonly lastStatusCode?: number;
  /** ISO time of the last result, if there has been one. */
  readonly checkedAt?: string;
}

export interface HealthCheckStatus {
  /** Absolute owner name. */
  readonly name: string;
  readonly type: "A" | "AAAA";
  readonly ttl: number;
  readonly issue?: string;
  /** `filtered` answers the healthy addresses; `servfail` answers nothing. */
  readonly answer: "filtered" | "servfail";
  readonly healthyAddresses: number;
  readonly targets: readonly HealthTargetStatus[];
}

export interface ZoneHealthStatus {
  /** Whether this process serves the zone and so judges its addresses. */
  readonly servedHere: boolean;
  readonly probing: boolean;
  readonly checks: readonly HealthCheckStatus[];
}

export interface HealthSummary {
  readonly targets: number;
  readonly healthy: number;
  readonly unhealthy: number;
  readonly unknown: number;
  readonly blocked: number;
  readonly overLimit: number;
}

export interface HealthTransition {
  readonly zone: string;
  readonly name: string;
  readonly type: "A" | "AAAA";
  readonly address: string;
  readonly from: TargetStatus;
  readonly to: TargetStatus;
  readonly lastFailure?: ProbeFailure;
  readonly lastStatusCode?: number;
}

export interface HealthMonitorTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HealthMonitorOptions {
  readonly transport: ProbeTransport;
  readonly now?: () => number;
  readonly timers?: HealthMonitorTimers;
  readonly random?: () => number;
  /** Zones whose internal view is published to a provider, not this listener. */
  readonly unsupported?: (zone: string) => boolean;
  /** Called once per status change, never per probe. */
  readonly onTransition?: (transition: HealthTransition) => void;
  readonly intervalMs?: number;
  readonly freshnessMs?: number;
  readonly concurrency?: number;
  readonly maxTargets?: number;
}

export type { HealthVerdict };

export interface HealthMonitor {
  /** Replaces the zones to watch. Targets whose fingerprint is unchanged keep their state. */
  update(zones: readonly { readonly name: string; readonly healthChecks?: readonly ServedHealthCheck[] }[]): void;
  configure(settings: HealthMonitorSettings): void;
  /** A verdict bound to one moment, so a whole answer is judged against one clock reading. */
  verdict(): HealthVerdict;
  status(zone: string): ZoneHealthStatus;
  summary(): HealthSummary;
  close(): Promise<void>;
}

interface Entry {
  target: HealthTarget;
  state: ProbeState;
  generation: number;
  nextAt: number;
  queued: boolean;
  overLimit: boolean;
  unsupported: boolean;
  blocked?: ProbeBlockReason;
  inFlight?: AbortController;
  reported: TargetStatus;
}

const defaultTimers: HealthMonitorTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createHealthMonitor(options: HealthMonitorOptions): HealthMonitor {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? defaultTimers;
  const random = options.random ?? Math.random;
  const intervalMs = options.intervalMs ?? HEALTH_PROBE_INTERVAL_MS;
  const freshnessMs = options.freshnessMs ?? HEALTH_RESULT_FRESHNESS_MS;
  const concurrency = Math.max(1, options.concurrency ?? HEALTH_PROBE_CONCURRENCY);
  const maxTargets = Math.max(0, options.maxTargets ?? MAX_HEALTH_CHECK_TARGETS);

  const entries = new Map<string, Entry>();
  const zoneChecks = new Map<string, readonly ServedHealthCheck[]>();
  // Every zone the listener answers for, policies or not: whether this
  // process serves a zone is not the same question as whether it has checks.
  const servedZones = new Set<string>();
  const queue: Entry[] = [];
  const running = new Set<Promise<void>>();
  let updated = false;
  let enabled = false;
  let allow: ProbeAllowList = compileProbeAllowList([], []);
  let allowFingerprint = JSON.stringify([[], []]);
  let timer: unknown;
  let timerAt = Number.POSITIVE_INFINITY;
  let closed = false;

  const eligible = (entry: Entry): boolean =>
    enabled && !closed && !entry.overLimit && !entry.unsupported && entry.blocked === undefined;

  function statusOf(entry: Entry, at: number): TargetStatus {
    if (entry.unsupported) return "unsupported_target";
    if (!enabled) return "disabled";
    if (entry.blocked !== undefined) return "blocked";
    if (entry.overLimit) return "over_limit";
    return effectiveStatus(entry.state, at, freshnessMs);
  }

  function report(entry: Entry, at: number): void {
    const next = statusOf(entry, at);
    if (next === entry.reported) return;
    const from = entry.reported;
    entry.reported = next;
    dnsHealthTransitions({ to: next });
    options.onTransition?.({
      zone: entry.target.zone,
      name: entry.target.check.name,
      type: entry.target.check.type,
      address: entry.target.address,
      from,
      to: next,
      ...(entry.state.lastFailure && next !== "healthy" ? { lastFailure: entry.state.lastFailure } : {}),
      ...(entry.state.lastStatusCode !== undefined && next !== "healthy" ? { lastStatusCode: entry.state.lastStatusCode } : {}),
    });
  }

  /** Forgets everything known about an entry and abandons its probe. */
  function reset(entry: Entry, at: number): void {
    entry.generation += 1;
    entry.state = INITIAL_PROBE_STATE;
    entry.inFlight?.abort();
    entry.inFlight = undefined;
    entry.queued = false;
    entry.nextAt = at;
  }

  function blockedReason(target: HealthTarget): ProbeBlockReason | undefined {
    return probeBlockReason(target.address, target.check.probe.port, allow);
  }

  function arm(): void {
    if (closed) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of entries.values()) {
      if (!eligible(entry) || entry.inFlight || entry.queued) continue;
      earliest = Math.min(earliest, entry.nextAt);
    }
    if (earliest === timerAt) return;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    timerAt = earliest;
    if (earliest === Number.POSITIVE_INFINITY) return;
    timer = timers.setTimeout(fire, Math.max(0, earliest - now()));
  }

  function fire(): void {
    timer = undefined;
    timerAt = Number.POSITIVE_INFINITY;
    if (closed) return;
    const at = now();
    for (const entry of entries.values()) {
      // Freshness is a property of time, not of probes: an address whose probes
      // stopped completing goes stale here even though nothing arrived.
      report(entry, at);
      if (!eligible(entry) || entry.inFlight || entry.queued || entry.nextAt > at) continue;
      entry.queued = true;
      queue.push(entry);
    }
    pump();
    arm();
  }

  function pump(): void {
    while (!closed && running.size < concurrency && queue.length > 0) {
      const entry = queue.shift()!;
      if (!entry.queued) continue;
      entry.queued = false;
      if (entries.get(entry.target.key) !== entry || !eligible(entry) || entry.inFlight) continue;
      start(entry);
    }
  }

  function start(entry: Entry): void {
    const generation = entry.generation;
    const controller = new AbortController();
    entry.inFlight = controller;
    const { target } = entry;
    // Checked again at the moment of connecting. The verdict cached on the
    // entry is from the last configure; this costs nothing and means no code
    // path can reach the transport with an address the allow-list refuses.
    const reason = blockedReason(target);
    const attempt: Promise<ProbeResult> = reason !== undefined
      ? Promise.resolve({ ok: false, category: "blocked" })
      : options.transport
        .probe({ address: target.address, probe: target.check.probe, host: target.check.name }, controller.signal)
        .catch((): ProbeResult => ({ ok: false, category: "connection" }));
    const settled = attempt.then((result) => {
      running.delete(settled);
      // A result for a question nobody is asking any more: the target was
      // removed, reset, or the process is stopping.
      if (closed || controller.signal.aborted || entries.get(target.key) !== entry || entry.generation !== generation) {
        pump();
        arm();
        return;
      }
      entry.inFlight = undefined;
      const at = now();
      dnsHealthProbes({ result: result.ok ? "success" : result.category });
      entry.state = recordProbe(entry.state, result, at, freshnessMs);
      entry.nextAt = at + intervalMs + Math.floor(random() * intervalMs * JITTER_FRACTION);
      report(entry, at);
      pump();
      arm();
    });
    running.add(settled);
  }

  function reconcile(at: number): void {
    for (const entry of entries.values()) {
      const blocked = blockedReason(entry.target);
      if (blocked !== entry.blocked) {
        entry.blocked = blocked;
        reset(entry, at);
      }
    }
  }

  return {
    update(zones) {
      if (closed) return;
      updated = true;
      const at = now();
      zoneChecks.clear();
      servedZones.clear();
      for (const zone of zones) {
        servedZones.add(zone.name);
        if (zone.healthChecks && zone.healthChecks.length > 0) zoneChecks.set(zone.name, zone.healthChecks);
      }
      const targets = healthTargetsOf(zones);
      const keep = new Set<string>();
      let counted = 0;
      for (const target of targets) {
        keep.add(target.key);
        const unsupported = options.unsupported?.(target.zone) ?? false;
        // Unsupported zones are never probed, so they do not take a slot from
        // a zone that is.
        const overLimit = !unsupported && counted >= maxTargets;
        if (!unsupported) counted += 1;
        const existing = entries.get(target.key);
        if (existing) {
          existing.target = target;
          if (existing.overLimit !== overLimit || existing.unsupported !== unsupported) {
            existing.overLimit = overLimit;
            existing.unsupported = unsupported;
            reset(existing, at);
          }
          report(existing, at);
          continue;
        }
        const entry: Entry = {
          target,
          state: INITIAL_PROBE_STATE,
          generation: 0,
          nextAt: at,
          queued: false,
          overLimit,
          unsupported,
          blocked: blockedReason(target),
          reported: "unknown",
        };
        entry.reported = statusOf(entry, at);
        entries.set(target.key, entry);
      }
      for (const [key, entry] of entries) {
        if (keep.has(key)) continue;
        entry.inFlight?.abort();
        entry.queued = false;
        entries.delete(key);
      }
      arm();
    },

    configure(settings) {
      if (closed) return;
      const at = now();
      const fingerprint = JSON.stringify([settings.dnsHealthCheckAllowCidrs, settings.dnsHealthCheckAllowPorts]);
      const wasEnabled = enabled;
      if (fingerprint !== allowFingerprint) {
        allow = compileProbeAllowList(settings.dnsHealthCheckAllowCidrs, settings.dnsHealthCheckAllowPorts);
        allowFingerprint = fingerprint;
        reconcile(at);
      }
      enabled = settings.dnsHealthChecksEnabled;
      // Turning probing off throws the results away rather than freezing them:
      // turned back on, an address is judged on what it does then, not on what
      // it did before somebody stopped looking.
      if (enabled !== wasEnabled) for (const entry of entries.values()) reset(entry, at);
      for (const entry of entries.values()) report(entry, at);
      arm();
    },

    verdict() {
      const at = now();
      return (zone, check, address) => {
        const entry = entries.get(healthTargetKey(zone, check, address));
        return entry !== undefined && eligible(entry) && effectiveStatus(entry.state, at, freshnessMs) === "healthy";
      };
    },

    status(zone) {
      const at = now();
      const checks = zoneChecks.get(zone) ?? [];
      return {
        servedHere: updated && servedZones.has(zone),
        probing: enabled,
        checks: checks.map((check) => {
          const targets = check.issue ? [] : check.addresses.map((address): HealthTargetStatus => {
            const entry = entries.get(healthTargetKey(zone, check, address));
            if (!entry) return { address, status: "unknown" };
            const state = entry.state;
            return {
              address,
              status: statusOf(entry, at),
              ...(entry.blocked ? { blockedReason: entry.blocked } : {}),
              ...(state.lastFailure ? { lastFailure: state.lastFailure } : {}),
              ...(state.lastStatusCode !== undefined ? { lastStatusCode: state.lastStatusCode } : {}),
              ...(state.checkedAt !== undefined ? { checkedAt: new Date(state.checkedAt).toISOString() } : {}),
            };
          });
          const healthyAddresses = targets.filter((target) => target.status === "healthy").length;
          return {
            name: check.name,
            type: check.type,
            ttl: check.ttl,
            ...(check.issue ? { issue: check.issue } : {}),
            answer: healthyAddresses > 0 ? "filtered" : "servfail",
            healthyAddresses,
            targets,
          };
        }),
      };
    },

    summary() {
      const at = now();
      const summary = { targets: entries.size, healthy: 0, unhealthy: 0, unknown: 0, blocked: 0, overLimit: 0 };
      for (const entry of entries.values()) {
        const status = statusOf(entry, at);
        if (status === "healthy") summary.healthy += 1;
        else if (status === "unhealthy") summary.unhealthy += 1;
        else if (status === "blocked") summary.blocked += 1;
        else if (status === "over_limit") summary.overLimit += 1;
        else if (status === "unknown" || status === "stale") summary.unknown += 1;
      }
      return summary;
    },

    async close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      queue.length = 0;
      for (const entry of entries.values()) entry.inFlight?.abort();
      await Promise.allSettled(running);
    },
  };
}
