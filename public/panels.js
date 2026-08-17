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
 * One row of the record table: what it says, and what it offers.
 *
 * Here for the reason this file exists. A record its provider owns has no edit
 * and no delete, and both answers name the service rather than the DNS value it
 * is stored as -- decisions about what a state means, and until now they lived
 * in a template string where no test could reach them. The store's own tests
 * check that the row is flagged; nothing checked that the flag removed a button.
 *
 * Returns data, not markup: the view still writes the HTML and translates the
 * absences, it just no longer decides what the row is.
 *
 * @param {{ type?: string, typeLabel?: string, name?: string, views?: {
 *   internal?: { content?: string },
 *   external?: { content?: string, label?: string, proxied?: boolean, managed?: string },
 * } }} record
 * @param {readonly unknown[]} records every row, for reading whether an RRset overrides this name
 * @returns {{
 *   typeLabel: string,
 *   locked: boolean,
 *   stored: string,
 *   actions: string[],
 *   inside: { text: string, absent: string, inherited: boolean },
 *   outside: { text: string, absent: string, proxied: boolean },
 * }}
 */
export function recordRow(record, records) {
  const external = record?.views?.external ?? {};
  const stored = String(external.content ?? "");
  const proxied = Boolean(external.proxied);
  const typeLabel = String(record?.typeLabel || record?.type || "");
  if (external.managed) {
    // The same answer on both sides, because that is what both sides resolve
    // to: for a placeholder address the internal resolver relays the query to
    // the public answer, so the value stored here is the one it never gives.
    const service = String(external.label ?? "");
    return {
      typeLabel,
      locked: true,
      stored,
      actions: [],
      inside: { text: service, absent: "", inherited: false },
      outside: { text: service, absent: "", proxied },
    };
  }
  const overridden = (Array.isArray(records) ? records : []).some((candidate) =>
    candidate?.name === record?.name && candidate?.type === record?.type && candidate?.views?.internal?.content);
  const own = String(record?.views?.internal?.content ?? "");
  const inside = own || (overridden ? "" : stored);
  return {
    typeLabel,
    locked: false,
    stored,
    actions: ["edit", "delete"],
    inside: { text: inside, absent: inside ? "" : overridden ? "overridden" : "noAnswer", inherited: own === "" },
    outside: { text: stored, absent: stored ? "" : "noAnswer", proxied },
  };
}

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
