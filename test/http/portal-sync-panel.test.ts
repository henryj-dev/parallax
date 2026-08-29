import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { syncPanel } from "../../public/panels.js";

/**
 * The two verdicts that reached a live deployment wrong, and the ones around
 * them. Both defects were a decision about what a state means, written straight
 * into the page -- so every test passed while the front page said the system was
 * broken and the system was fine.
 */
describe("what the sync panel says", () => {
  const zone = { revision: 3 };

  it("calls a view this process answers itself applied, not failed", () => {
    // No provider publishes the internal view because the listener answers it.
    // Shown in red for a day: the front page said broken, readiness said ready,
    // and readiness was right.
    const panel = syncPanel({
      activeZone: zone,
      records: [{ id: "web" }],
      status: {
        desiredRevision: 3,
        statuses: [
          { view: "internal", state: "applied", appliedRevision: 3 },
          { view: "external", state: "applied", appliedRevision: 3 },
        ],
      },
    });
    assert.equal(panel.overall, "applied");
    assert.equal(panel.percent, 100, "and the track is not stuck at zero");
  });

  it("calls a zone with nothing in it empty, not behind", () => {
    // A zone with no records has no target, so nothing writes a status. Read as
    // "pending", that absence said the system had not caught up to a zone that
    // asked for nothing.
    const panel = syncPanel({ activeZone: { revision: 1 }, records: [], status: { desiredRevision: 1, statuses: [] } });
    assert.equal(panel.kind, "empty");
    assert.equal(panel.overall, "");
  });

  it("still says pending when the zone holds records and nothing has been applied", () => {
    // The same absence, and here it means what it used to be taken to mean. The
    // two are told apart by whether the zone has anything to reconcile.
    const panel = syncPanel({ activeZone: zone, records: [{ id: "web" }], status: { desiredRevision: 3, statuses: [] } });
    assert.equal(panel.kind, "status");
    assert.equal(panel.overall, "pending");
    assert.equal(panel.percent, 0);
  });

  it("still reports a real failure", () => {
    // The guard must not have quietened a view that genuinely could not publish.
    const panel = syncPanel({
      activeZone: zone,
      records: [{ id: "web" }],
      status: {
        desiredRevision: 3,
        statuses: [
          { view: "internal", state: "failed", appliedRevision: 0, error: "no provider is configured" },
          { view: "external", state: "applied", appliedRevision: 3 },
        ],
      },
    });
    assert.equal(panel.overall, "failed");
    assert.equal(panel.views.internal.error, "no provider is configured");
  });

  it("counts a zone as caught up only as far as its furthest-behind view", () => {
    const panel = syncPanel({
      activeZone: { revision: 14 },
      records: [{ id: "web" }],
      status: {
        desiredRevision: 14,
        statuses: [
          { view: "internal", state: "applied", appliedRevision: 14 },
          { view: "external", state: "pending", appliedRevision: 4 },
        ],
      },
    });
    assert.equal(panel.overall, "pending");
    assert.equal(panel.applied, 4, "the lower of the two, which is what a reader needs");
    assert.equal(panel.percent, 29);
    assert.equal(panel.behind, true);
  });

  it("says whether the status record is behind, which is a separate question from drift", () => {
    // What `apply` advances is this number. A view answered by this process
    // publishes nothing, so its plan is empty while this can still trail -- and
    // the plan dialog needs the two answers apart to know whether to offer.
    const caughtUp = syncPanel({
      activeZone: zone,
      records: [{ id: "web" }],
      status: {
        desiredRevision: 3,
        statuses: [
          { view: "internal", state: "applied", appliedRevision: 3 },
          { view: "external", state: "applied", appliedRevision: 3 },
        ],
      },
    });
    assert.equal(caughtUp.behind, false);

    const trailing = syncPanel({
      activeZone: { revision: 49 },
      records: [{ id: "web" }],
      status: {
        desiredRevision: 49,
        statuses: [
          { view: "internal", state: "pending", appliedRevision: 47 },
          { view: "external", state: "applied", appliedRevision: 49 },
        ],
      },
    });
    assert.equal(trailing.behind, true, "one view is enough");
  });

  it("does not call an unreadable status behind", () => {
    // `applied: 0` in the error panel is the absence of a reading, not a lag.
    const panel = syncPanel({ activeZone: zone, records: [{ id: "web" }], statusError: "boom" });
    assert.equal(panel.kind, "error");
    assert.equal(panel.behind, false);
  });

  it("does not call an empty zone behind", () => {
    const panel = syncPanel({ activeZone: { revision: 1 }, records: [], status: { desiredRevision: 1, statuses: [] } });
    assert.equal(panel.kind, "empty");
    assert.equal(panel.behind, false);
  });
});
