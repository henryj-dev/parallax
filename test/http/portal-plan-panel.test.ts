import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planPanel } from "../../public/panels.js";

/**
 * Whether the apply-plan dialog offers to apply.
 *
 * The decision used to be the plan alone: no operations meant a disabled button.
 * That is right about the provider and wrong about the zone. A view this process
 * answers out of its own desired state publishes nothing, so its plan is empty
 * every time -- and its status record still names whichever revision the last
 * apply reached. The panel beside the dialog read that as `pending`, correctly,
 * and the only control that clears it was the one being disabled.
 *
 * So these tests are about a button's `disabled` attribute, which sounds cosmetic
 * and was not: the portal reported a state and then refused to let anyone leave
 * it.
 */
describe("whether the apply plan offers to apply", () => {
  const readablePlan = { views: { internal: { operations: [], summary: { untouched: 0 } }, external: { operations: [], summary: { untouched: 0 } } } };
  const records = [{ id: "web" }];

  /** A zone whose views are both applied at `applied`, with `desired` wanted. */
  const status = (applied: number, desired: number, state = "applied") => ({
    desiredRevision: desired,
    statuses: [
      { view: "internal", state, appliedRevision: applied },
      { view: "external", state, appliedRevision: applied },
    ],
  });

  it("offers to apply an empty plan when the status record is behind", () => {
    // The defect. Two revisions landed that changed nothing the provider holds,
    // so the plan is empty -- and the status record stayed at the older number,
    // because a view that falls behind once is not carried forward by later
    // commits. Disabled, this left the panel saying `pending` with no way out.
    const panel = planPanel({ plan: readablePlan, records, status: status(47, 49, "pending") });
    assert.equal(panel.kind, "plan");
    assert.equal(panel.operations.length, 0, "nothing is written to any provider");
    assert.equal(panel.advancesRecord, true);
    assert.equal(panel.applyEnabled, true);
    assert.equal(panel.applied, 47, "and the dialog can say which revision it advances from");
    assert.equal(panel.desired, 49);
  });

  it("stays shut on an empty plan once the record has caught up", () => {
    // The other half of the same question. With nothing to write and nothing to
    // record, applying would be a provider round trip that changes nothing.
    const panel = planPanel({ plan: readablePlan, records, status: status(49, 49) });
    assert.equal(panel.advancesRecord, false);
    assert.equal(panel.applyEnabled, false);
  });

  it("stays shut when a view could not be read, however far behind the record is", () => {
    // Fails closed. An unreadable view may be hiding operations, so advancing the
    // record over it would record a revision as applied that nobody compared.
    const panel = planPanel({
      plan: {
        views: {
          internal: { operations: [], error: "no provider is configured for example.com/internal" },
          external: { operations: [], summary: { untouched: 0 } },
        },
      },
      records,
      status: status(47, 49, "pending"),
    });
    assert.equal(panel.unreadable.length, 1);
    assert.equal(panel.unreadable[0]?.view, "internal");
    assert.equal(panel.advancesRecord, false);
    assert.equal(panel.applyEnabled, false, "and the operator is sent to the reason instead");
  });

  it("lets a failed view be retried from the dialog", () => {
    // A provider that refused a write leaves the view behind while its records
    // still list, so the plan reads clean. Retrying is the operator's next move
    // and this dialog is where they are standing.
    const panel = planPanel({ plan: readablePlan, records, status: status(0, 3, "failed") });
    assert.equal(panel.applyEnabled, true);
  });

  it("still offers to apply a plan that has operations", () => {
    const panel = planPanel({
      plan: { views: { internal: { operations: [{ kind: "create" }], summary: { untouched: 2 } } } },
      records,
      status: status(3, 3),
    });
    assert.equal(panel.operations.length, 1);
    assert.equal(panel.operations[0]?.view, "internal", "and each operation carries the view that owns it");
    assert.equal(panel.untouched, 2);
    assert.equal(panel.advancesRecord, false, "the plan speaks for itself here");
    assert.equal(panel.applyEnabled, true);
  });

  it("still offers to apply unsaved edits, whatever the plan says", () => {
    // Applying saves the desired state first, so an empty plan is expected: it
    // was built before the edit existed.
    const panel = planPanel({ plan: readablePlan, records, status: status(3, 3), dirty: true });
    assert.equal(panel.advancesRecord, false, "the edit is the reason, not the record");
    assert.equal(panel.applyEnabled, true);
  });

  it("stays shut while the plan is still being built, and when it failed", () => {
    const loading = planPanel({ records, status: status(47, 49, "pending") });
    assert.equal(loading.kind, "loading");
    assert.equal(loading.applyEnabled, false);
    const failed = planPanel({ planError: "provider could not be read", records, status: status(47, 49, "pending") });
    assert.equal(failed.kind, "error");
    assert.equal(failed.applyEnabled, false);
  });

  it("stays shut for a zone that holds nothing", () => {
    // No records and no statuses is not a zone that is behind; it is a zone with
    // nothing to be behind on, and the sync panel already says so.
    const panel = planPanel({ plan: { views: {} }, records: [], status: { desiredRevision: 1, statuses: [] } });
    assert.equal(panel.advancesRecord, false);
    assert.equal(panel.applyEnabled, false);
  });

  it("stays shut when the status could not be read at all", () => {
    // An unknown applied revision is not a known lag. Offering to apply here
    // would be acting on the absence of a reading.
    const panel = planPanel({ plan: readablePlan, records, statusError: "status could not be read" });
    assert.equal(panel.advancesRecord, false);
    assert.equal(panel.applyEnabled, false);
  });
});
