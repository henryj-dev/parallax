/**
 * Periodically counts the records a provider publishes that the internal view
 * does not answer for (`ControlPlane.providerOnlyRecords`).
 *
 * Why it exists: an authoritative internal zone answers NXDOMAIN or NODATA for
 * anything it does not hold, and the gap is invisible from inside until
 * something trips over it -- on 2026-09-11 it was a certificate whose DNS-01
 * self-check could never see its own TXT. The fallback papers over the gap for
 * one query at a time; this says the gap is there.
 *
 * The count is kept per zone and summed for the gauge, because metric labels
 * here never carry zone names. The names themselves go to the log, once per
 * change, so a steady state is one line and not one line every pass.
 */
export interface DriftMonitorOptions {
  /** The zones to check, read on every pass. */
  readonly zones: () => readonly string[];
  readonly providerOnly: (zone: string) => Promise<readonly { name: string; type: string }[]>;
  /**
   * A zone whose provider could not be read; its last count is kept. `repeated`
   * is true while the same zone keeps failing, so a caller can count every
   * failure and say so only once.
   */
  readonly onFailure: (zone: string, error: unknown, repeated: boolean) => void;
  readonly log: (line: string) => void;
}

/** How many owners a log line names before it says how many more there are. */
const LOGGED_OWNERS = 20;

export function createDriftMonitor(options: DriftMonitorOptions): { runOnce(): Promise<void>; total(): number } {
  const counts = new Map<string, number>();
  const reported = new Map<string, string>();
  const failing = new Set<string>();
  let running = false;
  return {
    /**
     * One pass. A pass still running when the next is due makes the next a
     * no-op: two passes overlapping read the provider twice, and the one that
     * finished last -- possibly the older -- would set the count.
     */
    async runOnce(): Promise<void> {
      if (running) return;
      running = true;
      try {
        await pass();
      } finally {
        running = false;
      }
    },
    total(): number {
      let sum = 0;
      for (const count of counts.values()) sum += count;
      return sum;
    },
  };

  async function pass(): Promise<void> {
    const zones = options.zones();
    // A zone that is no longer served has no gap to count. Left in, its last
    // number would hold the gauge up after the zone itself was gone.
    for (const zone of [...counts.keys(), ...failing]) {
      if (!zones.includes(zone)) {
        counts.delete(zone);
        reported.delete(zone);
        failing.delete(zone);
      }
    }
    for (const zone of zones) {
      let missing: readonly { name: string; type: string }[];
      try {
        missing = await options.providerOnly(zone);
      } catch (error) {
        options.onFailure(zone, error, failing.has(zone));
        failing.add(zone);
        continue;
      }
      failing.delete(zone);
      counts.set(zone, missing.length);
      const owners = missing.slice(0, LOGGED_OWNERS).map((record) => `${record.name} ${record.type}`).join(", ");
      const more = missing.length > LOGGED_OWNERS ? ` (+${missing.length - LOGGED_OWNERS} more)` : "";
      const line = missing.length === 0
        ? `parallax: dns zone ${zone} answers for every record its provider publishes`
        : `parallax: dns zone ${zone} has ${missing.length} provider record(s) the internal view does not answer for: ${owners}${more}`;
      // A clean zone seen for the first time is the expected state, not news.
      if (missing.length === 0 && !reported.has(zone)) {
        reported.set(zone, line);
        continue;
      }
      if (reported.get(zone) !== line) {
        options.log(line);
        reported.set(zone, line);
      }
    }
  }
}
