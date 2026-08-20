import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fallbackPanel } from "../../public/panels.js";

/**
 * What the override panel says, and whether it offers to write.
 *
 * The panel exists because the answer to "why is this zone not covered?" was a
 * shell on the pod. So the part that answers it -- the reason per excluded zone
 * -- has to survive the failure that usually accompanies the question: the
 * provider call that cannot be made. Coverage comes from state this control
 * plane already holds, so it is drawn either way.
 */
const COVERAGE = [
  { zone: "tinyuniver.se", covered: true, reason: "covered", profile: "main" },
  { zone: "tinymail.app", covered: false, reason: "empty", profile: "main" },
  { zone: "other.example", covered: false, reason: "otherProfile", profile: "second" },
  { zone: "stray.test", covered: false, reason: "unbound" },
];

describe("the override panel", () => {
  it("still explains every exclusion when the provider cannot be read", () => {
    const panel = fallbackPanel({
      fallbackProfile: "main",
      fallbackCoverage: COVERAGE,
      fallbackPlan: null,
      fallbackPlanError: "Cloudflare API request failed (HTTP 403)",
      settings: { fallbackResolver: "10.17.192.70" },
    });
    assert.deepEqual(panel.covered, ["tinyuniver.se"]);
    assert.deepEqual(panel.excluded, [
      { zone: "tinymail.app", reason: "empty", profile: "main" },
      { zone: "other.example", reason: "otherProfile", profile: "second" },
      { zone: "stray.test", reason: "unbound" },
    ]);
    assert.equal(panel.plan, null);
    assert.match(panel.planError, /HTTP 403/u);
    assert.equal(panel.syncable, false, "there is nothing to write against a list nobody could read");
    assert.equal(panel.inStep, false, "and not knowing is not the same as being in step");
  });

  it("does not offer to write without a resolver to write", () => {
    // `plan` refuses without one, so a button that could only fail is closed and
    // the panel says which setting is missing instead.
    const panel = fallbackPanel({
      fallbackProfile: "main",
      fallbackCoverage: COVERAGE,
      fallbackPlan: { add: [{ suffix: "tinyuniver.se" }], update: [], adopt: [], remove: [], conflict: [], unchanged: 0, untouched: 3 },
      settings: { fallbackResolver: "  " },
    });
    assert.equal(panel.resolverMissing, true);
    assert.equal(panel.syncable, false);
    assert.equal(panel.pending, 1, "the work is still reported; only writing it is closed");
  });

  it("offers to write when there is something to write and somewhere to send it", () => {
    const panel = fallbackPanel({
      fallbackProfile: "main",
      fallbackCoverage: COVERAGE,
      fallbackPlan: {
        add: [{ suffix: "tinyuniver.se" }],
        update: [], adopt: [{ suffix: "already.example" }],
        remove: [{ suffix: "gone.example" }],
        conflict: [{ suffix: "theirs.example", reason: "an entry for this suffix sends it somewhere else" }],
        unchanged: 2, untouched: 6,
      },
      settings: { fallbackResolver: "10.17.192.70" },
    });
    assert.equal(panel.syncable, true);
    assert.equal(panel.pending, 3, "add, adopt and remove; a conflict is not work this will do");
    assert.deepEqual(panel.plan?.conflict.map((entry) => entry.suffix), ["theirs.example"]);
    assert.equal(panel.inStep, false);
  });

  it("says there is nothing to do rather than offering a write that changes nothing", () => {
    const panel = fallbackPanel({
      fallbackProfile: "main",
      fallbackCoverage: [COVERAGE[0]],
      fallbackPlan: { add: [], update: [], adopt: [], remove: [], conflict: [], unchanged: 1, untouched: 3 },
      settings: { fallbackResolver: "10.17.192.70" },
    });
    assert.equal(panel.inStep, true);
    assert.equal(panel.syncable, false);
    assert.deepEqual(panel.excluded, []);
  });

  it("reads an empty state without inventing one", () => {
    const panel = fallbackPanel({});
    assert.deepEqual(panel.covered, []);
    assert.deepEqual(panel.excluded, []);
    assert.equal(panel.plan, null);
    assert.equal(panel.resolverMissing, true);
    assert.equal(panel.syncable, false);
    assert.equal(panel.inStep, false);
  });

  it("exposes deletion only for entries the server says this control plane owns", () => {
    const panel = fallbackPanel({
      fallbackEntries: [
        { suffix: "localhost" },
        { suffix: "lan", owned: false },
        { suffix: "tinyuniver.se", dnsServer: ["10.17.192.70"], owned: true },
      ],
    });
    assert.deepEqual(panel.entries.map((entry) => [entry.suffix, entry.owned, entry.actions]), [
      ["localhost", false, []], ["lan", false, []], ["tinyuniver.se", true, ["delete"]],
    ]);
  });
});
