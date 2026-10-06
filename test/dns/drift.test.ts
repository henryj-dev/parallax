import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDriftMonitor } from "../../src/dns/drift.ts";

/**
 * The provider-only check (`src/dns/drift.ts`): a count for the gauge and one
 * log line per change, so a steady gap is one line and not one per pass.
 */
describe("provider-only check", () => {
  function monitor(answers: Map<string, Array<{ name: string; type: string }> | Error>, zones = () => [...answers.keys()]) {
    const lines: string[] = [];
    const failures: string[] = [];
    const drift = createDriftMonitor({
      zones,
      providerOnly: async (zone) => {
        const answer = answers.get(zone);
        if (answer instanceof Error) throw answer;
        return answer ?? [];
      },
      onFailure: (zone) => failures.push(zone),
      log: (line) => lines.push(line),
    });
    return { drift, lines, failures };
  }

  it("sums the gaps for the gauge and names them in one line per zone", async () => {
    const answers = new Map([
      ["example.com", [{ name: "@", type: "TXT" }, { name: "_dmarc", type: "TXT" }]],
      ["example.net", [{ name: "@", type: "MX" }]],
    ]);
    const { drift, lines } = monitor(answers);
    await drift.runOnce();
    assert.equal(drift.total(), 3);
    assert.deepEqual(lines, [
      "parallax: dns zone example.com has 2 provider record(s) the internal view does not answer for: @ TXT, _dmarc TXT",
      "parallax: dns zone example.net has 1 provider record(s) the internal view does not answer for: @ MX",
    ]);
  });

  it("logs a change once, and says nothing for a steady state or a clean first sight", async () => {
    const answers = new Map<string, Array<{ name: string; type: string }>>([["example.com", []]]);
    const { drift, lines } = monitor(answers);
    await drift.runOnce();
    assert.deepEqual(lines, [], "a zone that was clean all along is not news");
    answers.set("example.com", [{ name: "api", type: "A" }]);
    await drift.runOnce();
    await drift.runOnce();
    assert.equal(lines.length, 1, "the same gap twice is one line");
    answers.set("example.com", []);
    await drift.runOnce();
    assert.equal(lines.at(-1), "parallax: dns zone example.com answers for every record its provider publishes");
    assert.equal(drift.total(), 0);
  });

  it("keeps a zone's last count when its provider cannot be read, and reports the failure", async () => {
    const answers = new Map<string, Array<{ name: string; type: string }> | Error>([["example.com", [{ name: "api", type: "A" }]]]);
    const { drift, failures } = monitor(answers);
    await drift.runOnce();
    answers.set("example.com", new Error("provider down"));
    await drift.runOnce();
    assert.equal(drift.total(), 1, "the last number that was true, not a zero that is not");
    assert.deepEqual(failures, ["example.com"]);
  });

  it("forgets a zone that is no longer served", async () => {
    const answers = new Map([["example.com", [{ name: "api", type: "A" }]]]);
    let served = ["example.com"];
    const { drift } = monitor(answers, () => served);
    await drift.runOnce();
    served = [];
    await drift.runOnce();
    assert.equal(drift.total(), 0);
  });

  it("names at most twenty owners and says how many more", async () => {
    const many = Array.from({ length: 23 }, (_, index) => ({ name: `h${index}`, type: "A" }));
    const { drift, lines } = monitor(new Map([["example.com", many]]));
    await drift.runOnce();
    assert.match(lines[0] ?? "", /has 23 provider record\(s\).*h19 A \(\+3 more\)$/u);
  });
});
