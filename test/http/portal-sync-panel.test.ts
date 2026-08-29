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

  it("calls a view nothing publishes unpublished, not pending", () => {
    // The word on the front page for months. Nothing publishes this view and no
    // listener answers it, so the zone's revision rises past it forever and an
    // apply against it fails for want of a provider. "Pending" reads as
    // "catching up", and the answer was to configure something.
    const panel = syncPanel({
      activeZone: { revision: 49 },
      records: [{ id: "web" }],
      status: {
        desiredRevision: 49,
        statuses: [
          { view: "internal", state: "pending", appliedRevision: 0, publisher: "none" },
          { view: "external", state: "applied", appliedRevision: 49, publisher: "provider" },
        ],
      },
    });
    assert.equal(panel.views.internal.state, "unpublished");
    assert.equal(panel.views.external.state, "applied");
    assert.equal(panel.overall, "unpublished", "and the chip says so too");
  });

  it("does not count a view nothing publishes as behind, or as progress lost", () => {
    // No apply can move it, so offering one would offer a button that only
    // fails -- and averaging it into the progress track reported a zone at 0%
    // that is entirely caught up on every view anything can reach.
    const panel = syncPanel({
      activeZone: { revision: 49 },
      records: [{ id: "web" }],
      status: {
        desiredRevision: 49,
        statuses: [
          { view: "internal", state: "pending", appliedRevision: 0, publisher: "none" },
          { view: "external", state: "applied", appliedRevision: 49, publisher: "provider" },
        ],
      },
    });
    assert.equal(panel.behind, false);
    assert.equal(panel.applied, 49);
    assert.equal(panel.percent, 100);
  });

  it("lets a real lag outrank a view nothing publishes", () => {
    // Both are true at once, and only one of them is somebody's next action.
    const panel = syncPanel({
      activeZone: { revision: 49 },
      records: [{ id: "web" }],
      status: {
        desiredRevision: 49,
        statuses: [
          { view: "internal", state: "pending", appliedRevision: 0, publisher: "none" },
          { view: "external", state: "pending", appliedRevision: 47, publisher: "provider" },
        ],
      },
    });
    assert.equal(panel.overall, "pending");
    assert.equal(panel.behind, true, "the external view is still owed an apply");
    assert.equal(panel.applied, 47);
  });

  it("still reports a failure on a view something does publish", () => {
    const panel = syncPanel({
      activeZone: zone,
      records: [{ id: "web" }],
      status: {
        desiredRevision: 3,
        statuses: [
          { view: "internal", state: "failed", appliedRevision: 0, publisher: "listener", error: "provider operation failed" },
          { view: "external", state: "applied", appliedRevision: 3, publisher: "provider" },
        ],
      },
    });
    assert.equal(panel.views.internal.state, "failed");
    assert.equal(panel.overall, "failed");
  });
});
