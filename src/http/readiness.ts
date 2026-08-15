import type { Zone } from "../domain/dns.ts";

/**
 * The `<zone>/<view>` targets nothing would serve, which is what makes a
 * deployment not ready.
 *
 * Split-horizon materializes `internal` from `external`, so a zone with a
 * public view has an internal one whether or not anybody wrote it down.
 *
 * The built-in DNS listener answers the internal view out of the desired state
 * itself, so where it is running that view is served and needs no provider.
 * Without this, a deployment that uses the listener instead of publishing into
 * CoreDNS or PowerDNS would fail its readiness probe forever while answering
 * every query correctly -- and would never be sent traffic to prove it.
 */
export function unservedTargets(
  zones: readonly Zone[],
  isConfigured: (target: string) => boolean,
  servesInternalView: boolean,
): string[] {
  return zones.flatMap((zone) => {
    const views = new Set(zone.views.map((view) => view.name));
    if (views.has("external")) views.add("internal");
    return [...views]
      .map((view) => `${zone.name}/${view}`)
      .filter((target) => !isConfigured(target))
      .filter((target) => !(servesInternalView && target.endsWith("/internal")));
  });
}
