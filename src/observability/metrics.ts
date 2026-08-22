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

const counters = new Map<string, Counter>();
const gauges = new Map<string, Gauge>();

/** Declares a counter. Repeated declarations are the same counter. */
export function counter(name: string, help: string): (labels?: Record<string, string>) => void {
  const existing = counters.get(name) ?? { help, values: new Map<string, number>() };
  counters.set(name, existing);
  return (labels) => {
    const key = labelKey(labels);
    existing.values.set(key, (existing.values.get(key) ?? 0) + 1);
  };
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
  return `${lines.join("\n")}\n`;
}

/** Test-only: forget every declared metric so one case cannot see another's. */
export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
}

function labelKey(labels: Record<string, string> | undefined): string {
  const entries = Object.entries(labels ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "";
  return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n");
}
