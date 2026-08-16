/**
 * What a panel should say, decided without touching the DOM.
 *
 * Two portal defects reached a live deployment in one day, and both were the
 * same shape: a decision about what a state means, written straight into
 * `textContent`. The decision was wrong and the writing was fine, so nothing
 * failed -- the screen simply said something untrue, and it said it on the front
 * page. Neither was caught by a test, because every test looked at what the
 * store returned and none looked at what a person would read.
 *
 * Separating the decision from the writing is what makes the first half
 * testable. A view still renders; it just no longer decides.
 */

/**
 * The sync panel: one verdict per view, one overall, and the progress line.
 *
 * @param {{
 *   status?: { desiredRevision?: number, statuses?: { view?: string, state?: string, appliedRevision?: number, error?: string }[] },
 *   activeZone?: { revision?: number },
 *   records?: unknown[],
 * }} state
 */
export function syncPanel(state) {
  const statuses = Array.isArray(state?.status?.statuses) ? state.status.statuses : [];
  const records = Array.isArray(state?.records) ? state.records : [];
  const desired = Number(state?.status?.desiredRevision ?? state?.activeZone?.revision ?? 0);

  // A zone holding no records has no target to reconcile, so nothing ever writes
  // a status for it. Reading that absence as "pending" says the system has not
  // caught up, when there is nothing for it to catch up to.
  if (statuses.length === 0 && records.length === 0) {
    return {
      kind: "empty",
      overall: "",
      views: { internal: { state: "", appliedRevision: 0, error: "" }, external: { state: "", appliedRevision: 0, error: "" } },
      percent: 0,
      desired,
    };
  }

  const forView = (view) => {
    const found = statuses.find((status) => status?.view === view);
    return {
      state: String(found?.state ?? "pending").toLowerCase(),
      appliedRevision: Number(found?.appliedRevision ?? 0),
      error: String(found?.error ?? ""),
    };
  };
  const views = { internal: forView("internal"), external: forView("external") };
  const states = [views.internal.state, views.external.state];
  const overall = states.includes("failed")
    ? "failed"
    : states.every((value) => value === "applied") ? "applied" : "pending";
  // The lower of the two: a zone is only as caught up as its furthest-behind view.
  const applied = Math.min(views.internal.appliedRevision, views.external.appliedRevision);
  const percent = desired > 0
    ? Math.min(100, Math.round((applied / desired) * 100))
    : overall === "applied" ? 100 : 0;
  return { kind: "status", overall, views, percent, desired, applied };
}
