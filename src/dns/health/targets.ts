import type { HealthCheckProbe } from "../../domain/health-checks.ts";

/**
 * A health check as the listener serves it: one RRset, the addresses in it, and
 * the probe that judges each of them.
 *
 * Only enabled policies become one. A disabled policy is an RRset answered in
 * full, which is what the listener does for a name with no policy at all.
 */
export interface ServedHealthCheck {
  /** Absolute owner name, lowercased, no trailing dot. */
  readonly name: string;
  readonly type: "A" | "AAAA";
  /** The one TTL a filtered answer carries. */
  readonly ttl: number;
  readonly probe: HealthCheckProbe;
  /** Canonical literal addresses, as the RRset holds them. */
  readonly addresses: readonly string[];
  /**
   * Why the policy cannot be honoured as written -- a missing RRset, a
   * provider-owned address. The answer fails closed: SERVFAIL for this RRset
   * until somebody fixes the zone or the policy, whatever `whenNoneHealthy`
   * says.
   */
  readonly issue?: string;
  /**
   * `answer-all` answers every address when none is healthy, provided each of
   * them is one this process is probing and simply has no fresh success.
   * Absent means SERVFAIL.
   */
  readonly whenNoneHealthy?: "answer-all";
}

/**
 * What this process may say about one address right now.
 *
 * - `healthy`: a fresh success; the address may be given out.
 * - `unconfirmed`: probed, or about to be, with no fresh success -- failing,
 *   stale, or not yet known. A policy set to `answer-all` may still hand it out
 *   when nothing in the RRset is healthy.
 * - `unprobeable`: nobody is looking -- probing is off, the address or port is
 *   outside the allow-list, or the address is past the process limit. That is
 *   configuration, not an observation, so it never fails open.
 */
export type HealthJudgement = "healthy" | "unconfirmed" | "unprobeable";

/** The judgement on one address of one served check. */
export type HealthVerdict = (zone: string, check: ServedHealthCheck, address: string) => HealthJudgement;

/** One address one policy probes, and where it came from. */
export interface HealthTarget {
  readonly key: string;
  readonly zone: string;
  readonly check: ServedHealthCheck;
  readonly address: string;
}

/**
 * Everything that makes two targets the same target. A change to any part is a
 * different question, so its state starts over: an address that answered on
 * port 80 has told nobody anything about port 443.
 */
export function healthTargetKey(zone: string, check: ServedHealthCheck, address: string): string {
  const probe = check.probe;
  return JSON.stringify([
    zone,
    check.name,
    check.type,
    address,
    probe.kind,
    probe.port,
    probe.kind === "tcp" ? "" : probe.path,
  ]);
}

/**
 * Every target the zones describe, in a fixed order.
 *
 * The order decides which targets fit under the process limit, so it must not
 * depend on the order zones were loaded in: zone, then owner, then type, then
 * address. A check with an issue has no targets -- it is answered SERVFAIL
 * without anything being probed.
 */
export function healthTargetsOf(
  zones: readonly { readonly name: string; readonly healthChecks?: readonly ServedHealthCheck[] }[],
): HealthTarget[] {
  const targets: HealthTarget[] = [];
  const seen = new Set<string>();
  for (const zone of zones) {
    for (const check of zone.healthChecks ?? []) {
      if (check.issue) continue;
      for (const address of check.addresses) {
        const key = healthTargetKey(zone.name, check, address);
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ key, zone: zone.name, check, address });
      }
    }
  }
  return targets.sort((left, right) =>
    compare(left.zone, right.zone)
    || compare(left.check.name, right.check.name)
    || compare(left.check.type, right.check.type)
    || compare(left.address, right.address)
    || compare(left.key, right.key));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
