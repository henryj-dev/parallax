import { materializeProviderViews, protectedRRsetsFor } from "../application/control-plane.ts";
import type { Zone } from "../domain/dns.ts";
import { healthCheckKey, healthChecksOf, type ProtectedRRset } from "../domain/health-checks.ts";
import { probeAddress } from "./health/address.ts";
import type { ServedHealthCheck } from "./health/targets.ts";
import type { ServedZone } from "./server.ts";

/**
 * Turns the desired state into the zones the listener answers from.
 *
 * This is the internal view and nothing else. The external view is what a
 * public resolver already answers, and serving it here would put this process
 * in front of records it does not own.
 *
 * Nothing is reconciled on the way: no provider is called, no ownership marker
 * is written, and no state is compared. That is the difference between this
 * listener and a provider adapter, which publishes the same view into a server
 * that then answers for it. Here the desired state is the answer, which is why
 * a change is visible as soon as the snapshot is re-read and why
 * `parallax apply` is not involved.
 */
export function servedZones(zones: readonly Zone[], onSkipped?: (zone: string, reason: string) => void): ServedZone[] {
  const served: ServedZone[] = [];
  for (const zone of zones) {
    let internal;
    try {
      internal = materializeProviderViews(zone.views).find((view) => view.name === "internal");
    } catch (error) {
      // A zone whose views cannot be composed is left to the forwarder rather
      // than answered for wrongly, and whoever can fix it is told which zone.
      onSkipped?.(zone.name, error instanceof Error ? error.message : "unknown error");
      continue;
    }
    // An empty internal view is the normal state right after adopting a zone.
    // Claiming authority for it would answer NXDOMAIN for every name the zone
    // holds -- taking the whole zone down internally at the moment it is added,
    // which is the opposite of what adopting it was for. Left out, the names go
    // to the forwarder and keep resolving publicly until an override exists.
    if (!internal || internal.records.length === 0) continue;
    served.push({
      name: zone.name,
      // The revision is already what rises on every published change, so it is
      // the serial. Inventing a second counter would leave two numbers that
      // have to agree about the same thing.
      serial: zone.revision,
      records: internal.records.map((record) => ({
        name: record.name,
        type: record.type,
        content: record.content,
        ttl: record.ttl,
      })),
      // Read from the overrides as written, not from the composed view: the
      // composed view also holds everything inherited from `external`, and an
      // inherited record is exactly the kind of answer the fallback may replace.
      overrideNames: new Set(
        (zone.views.find((view) => view.name === "internal")?.records ?? []).map((record) => record.name.toLowerCase()),
      ),
      ...servedHealthChecks(zone),
    });
  }
  return served;
}

/**
 * The enabled health checks, resolved against the same composed view the
 * answers come from. A policy that no longer resolves -- its RRset was removed
 * by some path the commit guard did not see, or now holds a provider-owned
 * address -- is kept with its issue rather than dropped, because dropping it
 * would answer the full RRset, and a policy someone enabled is a promise that
 * an unchecked address is not given out.
 */
function servedHealthChecks(zone: Zone): { healthChecks?: ServedHealthCheck[] } {
  const policies = healthChecksOf(zone.views.find((view) => view.name === "internal")).filter((policy) => policy.enabled);
  if (policies.length === 0) return {};
  let resolved: ProtectedRRset[];
  let failure: string | undefined;
  try {
    resolved = protectedRRsetsFor(zone.views).rrsets;
  } catch (error) {
    resolved = [];
    failure = error instanceof Error ? error.message : "the zone's views could not be composed";
  }
  const byKey = new Map(resolved.map((rrset) => [healthCheckKey(rrset.policy), rrset]));
  return {
    healthChecks: policies.map((policy): ServedHealthCheck => {
      const owner = absolute(policy.name, zone.name);
      const rrset = byKey.get(healthCheckKey(policy));
      const failOpen = policy.whenNoneHealthy === "answer-all" ? { whenNoneHealthy: policy.whenNoneHealthy } : {};
      if (!rrset) {
        return {
          name: owner,
          type: policy.type,
          ttl: policy.responseTtlSeconds,
          probe: policy.probe,
          addresses: [],
          issue: failure ?? `health check ${policy.name} ${policy.type} does not match a probeable RRset`,
          ...failOpen,
        };
      }
      return {
        name: owner,
        type: policy.type,
        ttl: rrset.ttl,
        probe: policy.probe,
        addresses: rrset.addresses.map((address) => probeAddress(address)),
        ...failOpen,
      };
    }),
  };
}

function absolute(name: string, zone: string): string {
  return name === "@" ? zone : `${name}.${zone}`.toLowerCase();
}
