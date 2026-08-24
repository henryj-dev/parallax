import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { counter, gauge, histogram, render, resetMetrics } from "../../src/observability/metrics.ts";

afterEach(() => { resetMetrics(); });

describe("the metrics a deployment can alert on", () => {
  /**
   * The distinction this whole endpoint exists for.
   *
   * A counter that only appears after its first failure is one whose absence
   * and whose zero look identical to a query -- so `rate(...) == 0` cannot tell
   * "nothing has gone wrong" from "the series does not exist", and an alert
   * written against it never fires. H2 was exactly a failure nobody could see.
   */
  it("reports zero for a failure that has not happened yet", () => {
    counter("parallax_test_failures_total", "Failures.");
    assert.match(render(), /^parallax_test_failures_total 0$/mu);
  });

  it("counts per label set", () => {
    const failed = counter("parallax_test_refresh_failures_total", "Refreshes that failed.");
    failed({ subsystem: "settings" });
    failed({ subsystem: "settings" });
    failed({ subsystem: "credentials" });

    const text = render();
    assert.match(text, /^parallax_test_refresh_failures_total\{subsystem="settings"\} 2$/mu);
    assert.match(text, /^parallax_test_refresh_failures_total\{subsystem="credentials"\} 1$/mu);
  });

  it("declares help and type before every series", () => {
    counter("parallax_test_thing_total", "A thing.");
    const lines = render().split("\n");
    assert.equal(lines[0], "# HELP parallax_test_thing_total A thing.");
    assert.equal(lines[1], "# TYPE parallax_test_thing_total counter");
  });

  /**
   * A gauge with nothing to report is left out entirely, which is not the same
   * as zero. A DNS listener that is switched off has no zone count; saying 0
   * would read as one that is running and answering for nothing.
   */
  it("omits a gauge that does not apply to this deployment", () => {
    gauge("parallax_test_present", "Present.", () => 3);
    gauge("parallax_test_absent", "Absent.", () => undefined);

    const text = render();
    assert.match(text, /^parallax_test_present 3$/mu);
    assert.doesNotMatch(text, /parallax_test_absent/u);
  });

  it("reads a gauge at scrape time rather than when it was declared", () => {
    let served = 1;
    gauge("parallax_test_zones", "Zones.", () => served);
    assert.match(render(), /^parallax_test_zones 1$/mu);
    served = 7;
    assert.match(render(), /^parallax_test_zones 7$/mu);
  });

  it("escapes a label value that would otherwise break the format", () => {
    const odd = counter("parallax_test_odd_total", "Odd.");
    odd({ reason: 'a"b\\c' });
    assert.match(render(), /\{reason="a\\"b\\\\c"\}/u);
  });

  /**
   * The helper every other case in this file leans on, which was itself wrong.
   *
   * `signals.ts` declares its counters when the module loads -- once per
   * process, before any test runs. The increment function used to hold the
   * counter object, so `resetMetrics()` dropping it from the registry left the
   * two disconnected: the calls still landed, `render()` no longer saw them,
   * and no later reset could bring the counter back. Nothing in production
   * calls `resetMetrics()`, so this could only ever surface as a test that
   * would not move -- which reads as a finding about the code under test.
   */
  it("keeps a counter declared before the reset usable after it", () => {
    const bump = counter("parallax_test_survivor_total", "Survivor.");
    bump();
    assert.match(render(), /^parallax_test_survivor_total 1$/mu);

    resetMetrics();
    assert.doesNotMatch(render(), /parallax_test_survivor_total/u, "the reset forgot it, as it says it does");

    bump();
    assert.match(render(), /^parallax_test_survivor_total 1$/mu, "and the same function re-declares it");
  });
});

/**
 * A counter says how often and a gauge says what it is now. Neither answers
 * "is this slower than it was", which is the question a latency has -- and it
 * is the question nobody could ask of this deployment at all.
 */
describe("histograms", () => {
  it("reports cumulative buckets, a sum and a count", () => {
    const observe = histogram("parallax_test_seconds", "Test.", [0.1, 1]);
    observe(0.05);
    observe(0.5);
    observe(5);

    const text = render();
    assert.match(text, /^# TYPE parallax_test_seconds histogram$/mu);
    assert.match(text, /^parallax_test_seconds_bucket\{le="0.1"\} 1$/mu);
    assert.match(text, /^parallax_test_seconds_bucket\{le="1"\} 2$/mu, "cumulative, so 0.05 counts here too");
    assert.match(text, /^parallax_test_seconds_bucket\{le="\+Inf"\} 3$/mu);
    assert.match(text, /^parallax_test_seconds_sum 5.55$/mu);
    assert.match(text, /^parallax_test_seconds_count 3$/mu);
  });

  it("keeps a label set apart and puts `le` beside it, not over it", () => {
    const observe = histogram("parallax_test_labelled_seconds", "Test.", [1]);
    observe(0.5, { outcome: "answered" });
    observe(2, { outcome: "failed" });

    const text = render();
    assert.match(text, /^parallax_test_labelled_seconds_bucket\{outcome="answered",le="1"\} 1$/mu);
    assert.match(text, /^parallax_test_labelled_seconds_bucket\{outcome="failed",le="1"\} 0$/mu);
    assert.match(text, /^parallax_test_labelled_seconds_count\{outcome="failed"\} 1$/mu);
  });

  it("sorts the buckets it was given, so the output is monotonic either way", () => {
    const observe = histogram("parallax_test_unsorted_seconds", "Test.", [1, 0.1]);
    observe(0.5);
    const lines = render().split("\n").filter((line) => line.startsWith("parallax_test_unsorted_seconds_bucket"));
    assert.deepEqual(lines, [
      'parallax_test_unsorted_seconds_bucket{le="0.1"} 0',
      'parallax_test_unsorted_seconds_bucket{le="1"} 1',
      'parallax_test_unsorted_seconds_bucket{le="+Inf"} 1',
    ]);
  });

  it("survives a reset the same way a counter does", () => {
    const observe = histogram("parallax_test_reset_seconds", "Test.", [1]);
    observe(0.5);
    resetMetrics();
    observe(0.5);
    assert.match(render(), /^parallax_test_reset_seconds_count 1$/mu);
  });
});
