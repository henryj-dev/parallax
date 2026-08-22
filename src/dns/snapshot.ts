import { materializeProviderViews } from "../application/control-plane.ts";
import type { Zone } from "../domain/dns.ts";
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
    });
  }
  return served;
}
