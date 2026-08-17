import type { Zone } from "../domain/dns.ts";
import { servedZones } from "../dns/snapshot.ts";

export interface ReadinessMonitor {
  /** Constant-time value safe to serve from a public health endpoint. */
  ready(): boolean;
  /**
   * How old the last successful read is, and how old it may get.
   *
   * Freshness decides membership through `ready()`, and membership is a blunt
   * instrument where one replica also carries DNS: going unready removes a
   * resolver that is still answering correctly from its last snapshot. So the
   * number is reported as well, for a deployment that would rather alert on it
   * than be withdrawn by it.
   */
  staleness(): { readonly ageMs: number | undefined; readonly maxMs: number };
  /** Recomputes readiness from zones a trusted background task already read. */
  update(zones: readonly Zone[]): void;
  /** Fails closed immediately and requests one trailing scan if one is active. */
  invalidate(): void;
  /** Reads the store once; overlapping refreshes share that single read. */
  refresh(): Promise<void>;
}

export interface ReadinessMonitorOptions {
  readonly configurationRevision?: () => number;
  readonly now?: () => number;
  readonly maxStalenessMs?: number;
  readonly onZones?: (zones: readonly Zone[]) => void;
  /** Empty internal views fall through to an upstream when one is configured. */
  readonly forwardsEmptyInternalViews?: boolean;
}

export const DEFAULT_READINESS_MAX_STALENESS_MS = 10_000;

/**
 * Keeps the public readiness route from becoming an unpaginated database-read
 * endpoint. The complete desired state is still checked, but only on the
 * process-owned refresh cadence; request volume can observe, not amplify, it.
 */
export function createReadinessMonitor(
  loadZones: () => Promise<readonly Zone[]>,
  isConfigured: (target: string) => boolean,
  servesInternalView: boolean,
  options: ReadinessMonitorOptions = {},
): ReadinessMonitor {
  let current = false;
  let lastSuccessAt: number | undefined;
  let observedConfigurationRevision = -1;
  let invalidationRevision = 0;
  let trailingRefresh = false;
  let refreshing: Promise<void> | undefined;
  const configurationRevision = options.configurationRevision ?? (() => 0);
  const now = options.now ?? Date.now;
  const forwardsEmptyInternalViews = options.forwardsEmptyInternalViews ?? false;
  const maxStalenessMs = options.maxStalenessMs ?? DEFAULT_READINESS_MAX_STALENESS_MS;
  if (!Number.isFinite(maxStalenessMs) || maxStalenessMs <= 0) {
    throw new Error("readiness max staleness must be positive");
  }
  const publish = (zones: readonly Zone[], revision: number): void => {
    options.onZones?.(zones);
    current = allTargetsServed(zones, isConfigured, servesInternalView, forwardsEmptyInternalViews);
    observedConfigurationRevision = revision;
    lastSuccessAt = now();
  };
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing;
    let publishedByRun = false;
    const run = (async (): Promise<void> => {
      do {
        trailingRefresh = false;
        const invalidationAtStart = invalidationRevision;
        const configurationAtStart = configurationRevision();
        let zones: readonly Zone[];
        try {
          zones = await loadZones();
        } catch (error) {
          current = false;
          throw error;
        }
        if (invalidationAtStart !== invalidationRevision
          || configurationAtStart !== configurationRevision()) {
          current = false;
          trailingRefresh = true;
          continue;
        }
        publish(zones, configurationAtStart);
        publishedByRun = true;
      } while (trailingRefresh);
    })();
    let tracked!: Promise<void>;
    tracked = run.finally(() => {
      if (refreshing !== tracked) return;
      refreshing = undefined;
      // An invalidation can land after the async loop's last condition check
      // but before this cleanup microtask. Start and chain the missing trailing
      // scan instead of leaving DNS on the just-invalidated snapshot.
      if (trailingRefresh
        || (publishedByRun && observedConfigurationRevision !== configurationRevision())) {
        trailingRefresh = false;
        return refresh();
      }
    });
    refreshing = tracked;
    return tracked;
  };
  return {
    staleness: () => ({
      ageMs: lastSuccessAt === undefined ? undefined : Math.max(0, now() - lastSuccessAt),
      maxMs: maxStalenessMs,
    }),
    ready: () => current
      && lastSuccessAt !== undefined
      && Math.max(0, now() - lastSuccessAt) <= maxStalenessMs
      && observedConfigurationRevision === configurationRevision(),
    update: (zones) => publish(zones, configurationRevision()),
    invalidate: () => {
      current = false;
      invalidationRevision += 1;
      if (refreshing) trailingRefresh = true;
    },
    refresh,
  };
}

function allTargetsServed(
  zones: readonly Zone[],
  isConfigured: (target: string) => boolean,
  servesInternalView: boolean,
  forwardsEmptyInternalViews: boolean,
): boolean {
  return unservedTargets(zones, isConfigured, servesInternalView, forwardsEmptyInternalViews).length === 0;
}

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
  forwardsEmptyInternalViews = false,
): string[] {
  // The listener only serves zones that survived the exact materialization
  // used to build its snapshot. An empty or invalid internal view is omitted
  // from that snapshot and therefore must still have a configured provider;
  // treating every desired `internal` target as served would report ready
  // while the listener actually answers REFUSED for that zone.
  const failedMaterialization = new Set<string>();
  const listenerZones = servesInternalView
    ? new Set(servedZones(zones, (zone) => failedMaterialization.add(zone)).map((zone) => zone.name))
    : new Set<string>();
  if (servesInternalView && forwardsEmptyInternalViews) {
    // `servedZones` intentionally leaves a valid-but-empty internal view out:
    // claiming authority would turn every public name into NXDOMAIN. With an
    // upstream configured, that omission is still a served path because the
    // listener forwards the query. A composition failure is different: the
    // desired state is internally inconsistent, so readiness stays fail-closed
    // even though the request path may happen to obtain a public answer.
    for (const zone of zones) {
      if (!failedMaterialization.has(zone.name)) listenerZones.add(zone.name);
    }
  }
  return zones.flatMap((zone) => {
    const views = new Set(zone.views.map((view) => view.name));
    if (views.has("external")) views.add("internal");
    return [...views]
      .map((view) => `${zone.name}/${view}`)
      .filter((target) => !isConfigured(target))
      .filter((target) => !(target.endsWith("/internal") && listenerZones.has(zone.name)));
  });
}
