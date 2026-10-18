import type { ProbeFailure } from "./transport.ts";

/**
 * What one address's probe history says about it, and nothing about why.
 *
 * Pure: every function takes the time it is asked about, so the monitor owns
 * the clock and the tests own the monitor's.
 *
 * The thresholds are asymmetric on purpose. A healthy address survives two
 * failed probes, because one dropped SYN should not take a name out of the
 * answer. An address that has been seen failing needs two successes in a row
 * before it is trusted again, because one lucky connection to a process that
 * is restarting is not recovery. An address nobody has observed failing is
 * trusted on its first success, so a new policy does not hold its name in
 * SERVFAIL for two probe intervals.
 */

export const HEALTH_PROBE_INTERVAL_MS = 10_000;
/** A result older than this says nothing about now. Three missed intervals. */
export const HEALTH_RESULT_FRESHNESS_MS = 30_000;
export const HEALTHY_AFTER_SUCCESSES = 2;
export const UNHEALTHY_AFTER_FAILURES = 3;

export type ProbeStatus = "unknown" | "healthy" | "unhealthy";
export type EffectiveStatus = ProbeStatus | "stale";

export interface ProbeState {
  readonly status: ProbeStatus;
  readonly successes: number;
  readonly failures: number;
  /** A failure was seen and no recovery has been confirmed since. */
  readonly observedFailure: boolean;
  /** When the last result was recorded; undefined until the first one. */
  readonly checkedAt?: number;
  readonly lastFailure?: ProbeFailure;
  readonly lastStatusCode?: number;
}

export const INITIAL_PROBE_STATE: ProbeState = Object.freeze({
  status: "unknown",
  successes: 0,
  failures: 0,
  observedFailure: false,
});

export interface RecordedProbe {
  readonly ok: boolean;
  readonly category?: ProbeFailure;
  readonly status?: number;
}

/**
 * The state after one more result.
 *
 * A previous result that went stale before this one arrived is not continued
 * from: the counts it carried describe a stretch of time nobody observed. The
 * address starts over from unknown, remembering only whether it had been
 * failing, so a gap in probing cannot turn one success into a recovery.
 */
export function recordProbe(
  state: ProbeState,
  result: RecordedProbe,
  now: number,
  freshnessMs = HEALTH_RESULT_FRESHNESS_MS,
): ProbeState {
  const base = isStale(state, now, freshnessMs)
    ? { ...INITIAL_PROBE_STATE, observedFailure: state.observedFailure || state.status === "unhealthy" }
    : state;
  const detail = {
    checkedAt: now,
    ...(result.ok ? {} : { lastFailure: result.category ?? "connection" }),
    ...(result.status === undefined ? {} : { lastStatusCode: result.status }),
  };
  if (result.ok) {
    const successes = base.successes + 1;
    const recovered = base.status === "healthy"
      || (base.status === "unknown" && !base.observedFailure)
      || successes >= HEALTHY_AFTER_SUCCESSES;
    return recovered
      ? { status: "healthy", successes, failures: 0, observedFailure: false, ...detail }
      : { status: base.status, successes, failures: 0, observedFailure: base.observedFailure, ...detail };
  }
  const failures = base.failures + 1;
  const status: ProbeStatus = base.status === "healthy" && failures < UNHEALTHY_AFTER_FAILURES ? "healthy" : "unhealthy";
  return { status, successes: 0, failures, observedFailure: true, ...detail };
}

/** The status as of `now`, which is the only one an answer may act on. */
export function effectiveStatus(state: ProbeState, now: number, freshnessMs = HEALTH_RESULT_FRESHNESS_MS): EffectiveStatus {
  if (state.checkedAt === undefined) return "unknown";
  if (isStale(state, now, freshnessMs)) return "stale";
  return state.status;
}

function isStale(state: ProbeState, now: number, freshnessMs: number): boolean {
  return state.checkedAt !== undefined && now - state.checkedAt > freshnessMs;
}
