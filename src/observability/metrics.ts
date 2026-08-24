/**
 * The numbers a deployment can alert on.
 *
 * This exists because of one defect. A record the wire could not carry made
 * every query for that name vanish -- no answer, no log line -- and the only
 * way anyone would have found out is a person noticing a name stopped
 * resolving. The fix made it SERVFAIL and print a sentence, which is better,
 * but a sentence on stderr is not something you can put a threshold on.
 *
 * So the rule for what belongs here: a counter earns its place if there is a
 * failure it is the *only* warning of. The log lines stay as they are -- they
 * are written for a person reading them and say things a counter cannot.
 *
 * No zone names, no record names, no client addresses. Label cardinality is
 * the usual reason for that rule; here there is a second one, which is that
 * this endpoint describes the deployment and the zone list is not a thing to
 * hand out. Everything below is a fixed, small label set.
 *
 * Written rather than taken from a library because the exposition format is a
 * dozen lines of text and this project has one runtime dependency.
 */

interface Counter {
  readonly help: string;
  readonly values: Map<string, number>;
}

interface Gauge {
  readonly help: string;
  readonly read: () => number | undefined;
}

interface Histogram {
  readonly help: string;
  readonly buckets: readonly number[];
  /** Label set to per-bucket counts, the total, and how many were observed. */
  readonly values: Map<string, { counts: number[]; sum: number; count: number }>;
}

const counters = new Map<string, Counter>();
const gauges = new Map<string, Gauge>();
const histograms = new Map<string, Histogram>();

/**
 * Declares a counter. Repeated declarations are the same counter.
 *
 * The returned function finds its counter by name on every call rather than
 * closing over the object. That looks like the more expensive spelling and it
 * is the only correct one: `signals.ts` declares its counters once, when the
 * module loads, so a closure that held the object kept pointing at it after
 * `resetMetrics()` had dropped it from the registry -- the increments landed
 * somewhere `render()` could no longer see, and the counter never reappeared
 * for the rest of the process. Measured: visible before the reset, gone after.
 *
 * Nothing in production calls `resetMetrics()`, so the defect only ever showed
 * up in tests -- as a counter that would not move. A helper that quietly
 * reports the wrong thing is worse than no helper, because the test it breaks
 * looks like a finding.
 */
export function counter(name: string, help: string): (labels?: Record<string, string>) => void {
  register(name, help);
  return (labels) => {
    const metric = register(name, help);
    const key = labelKey(labels);
    metric.values.set(key, (metric.values.get(key) ?? 0) + 1);
  };
}

function register(name: string, help: string): Counter {
  const existing = counters.get(name);
  if (existing) return existing;
  const created = { help, values: new Map<string, number>() };
  counters.set(name, created);
  return created;
}

/**
 * Declares a gauge that is read at scrape time.
 *
 * A callback rather than a setter because every gauge here already has an
 * owner that knows the current value -- readiness knows its own staleness, the
 * listener knows how many zones it answers for. Copying those into a second
 * place is how the copy goes stale.
 *
 * `undefined` means "not applicable in this deployment" and the series is left
 * out entirely, which is different from zero: a listener that is switched off
 * has no zone count, and reporting 0 would read as one that is broken.
 */
export function gauge(name: string, help: string, read: () => number | undefined): void {
  gauges.set(name, { help, read });
}

/**
 * Declares a histogram: how long something took, in buckets.
 *
 * A counter says how often and a gauge says what it is now; neither answers
 * "is this slower than it was", which is the question a latency has. The
 * buckets are given rather than derived, because the useful boundaries are a
 * fact about the thing being measured -- a forwarded DNS query and an HTTP
 * request do not share a scale.
 *
 * The rule above still holds: a small fixed label set, and no zone names,
 * record names or client addresses.
 */
export function histogram(
  name: string,
  help: string,
  buckets: readonly number[],
): (value: number, labels?: Record<string, string>) => void {
  registerHistogram(name, help, buckets);
  return (value, labels) => {
    const metric = registerHistogram(name, help, buckets);
    const key = labelKey(labels);
    const observed = metric.values.get(key)
      ?? { counts: Array.from({ length: metric.buckets.length }, () => 0), sum: 0, count: 0 };
    for (const [index, bound] of metric.buckets.entries()) {
      if (value <= bound) observed.counts[index] = (observed.counts[index] ?? 0) + 1;
    }
    observed.sum += value;
    observed.count += 1;
    metric.values.set(key, observed);
  };
}

function registerHistogram(name: string, help: string, buckets: readonly number[]): Histogram {
  const existing = histograms.get(name);
  if (existing) return existing;
  const created: Histogram = {
    help,
    buckets: [...buckets].sort((left, right) => left - right),
    values: new Map(),
  };
  histograms.set(name, created);
  return created;
}

/** The Prometheus text exposition format, version 0.0.4. */
export function render(): string {
  const lines: string[] = [];
  for (const [name, metric] of [...counters].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} counter`);
    // A counter with no observations still reports zero. A series that appears
    // only after the first failure is one whose absence and whose zero look the
    // same to a query, which is exactly wrong for "has this ever happened".
    if (metric.values.size === 0) lines.push(`${name} 0`);
    for (const [labels, value] of [...metric.values].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`${name}${labels} ${value}`);
    }
  }
  for (const [name, metric] of [...gauges].sort(([left], [right]) => left.localeCompare(right))) {
    const value = metric.read();
    if (value === undefined) continue;
    lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
  }
  for (const [name, metric] of [...histograms].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} histogram`);
    for (const [labels, observed] of [...metric.values].sort(([left], [right]) => left.localeCompare(right))) {
      // Prometheus buckets are cumulative and `+Inf` must equal the count.
      for (const [index, bound] of metric.buckets.entries()) {
        lines.push(`${name}_bucket${withLabel(labels, "le", String(bound))} ${observed.counts[index] ?? 0}`);
      }
      lines.push(`${name}_bucket${withLabel(labels, "le", "+Inf")} ${observed.count}`);
      lines.push(`${name}_sum${labels} ${observed.sum}`);
      lines.push(`${name}_count${labels} ${observed.count}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Adds one label to an already-rendered label set, keeping the format valid. */
function withLabel(labels: string, name: string, value: string): string {
  const pair = `${name}="${escapeLabel(value)}"`;
  return labels === "" ? `{${pair}}` : `${labels.slice(0, -1)},${pair}}`;
}

/** Test-only: forget every declared metric so one case cannot see another's. */
export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

function labelKey(labels: Record<string, string> | undefined): string {
  const entries = Object.entries(labels ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "";
  return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n");
}
