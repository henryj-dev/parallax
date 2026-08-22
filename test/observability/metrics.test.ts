import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { counter, gauge, render, resetMetrics } from "../../src/observability/metrics.ts";

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
});
