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
 * The client-side resolver overrides for one profile: what covers what, what a
 * sync would change, and whether syncing is even possible.
 *
 * Split in two because the two halves fail independently. Coverage is computed
 * from state this control plane already holds and needs no provider at all, so
 * it answers on the day the token or the permission is the broken thing -- which
 * is exactly when somebody asks why a zone is missing from the overrides. The
 * plan needs the provider, and when it cannot be read the panel still shows the
 * half that explains the question.
 *
 * @param {{
 *   fallbackProfile?: string,
 *   fallbackCoverage?: { zone?: string, covered?: boolean, reason?: string, profile?: string, detail?: string }[],
 *   fallbackEntries?: { suffix?: string, dnsServer?: string[], owned?: boolean }[],
 *   fallbackPlan?: {
 *     add?: { suffix?: string }[], update?: { suffix?: string }[], adopt?: { suffix?: string }[],
 *     remove?: { suffix?: string }[], conflict?: { suffix?: string, reason?: string }[],
 *     unchanged?: number, untouched?: number,
 *   } | null,
 *   fallbackPlanError?: string,
 *   settings?: { fallbackResolver?: string },
 * }} state
 */
export function fallbackPanel(state) {
  const rows = Array.isArray(state?.fallbackCoverage) ? state.fallbackCoverage : [];
  const resolver = String(state?.settings?.fallbackResolver ?? "").trim();
  const raw = state?.fallbackPlan;
  const plan = raw && typeof raw === "object" ? raw : null;
  const suffixes = (key) => (Array.isArray(plan?.[key]) ? plan[key] : []).map((entry) => String(entry?.suffix ?? ""));
  const add = suffixes("add");
  const update = suffixes("update");
  const adopt = suffixes("adopt");
  const remove = suffixes("remove");
  const conflict = (Array.isArray(plan?.conflict) ? plan.conflict : [])
    .map((entry) => ({ suffix: String(entry?.suffix ?? ""), reason: String(entry?.reason ?? "") }));
  const pending = add.length + update.length + adopt.length + remove.length;
  return {
    profile: String(state?.fallbackProfile ?? ""),
    resolver,
    // The plan refuses without one, so the panel says so before offering a
    // button that can only fail.
    resolverMissing: resolver === "",
    covered: rows.filter((row) => row?.covered).map((row) => String(row.zone)),
    excluded: rows.filter((row) => !row?.covered).map((row) => ({
      zone: String(row.zone),
      reason: String(row.reason ?? ""),
      ...(row.profile ? { profile: String(row.profile) } : {}),
      ...(row.detail ? { detail: String(row.detail) } : {}),
    })),
    entries: (Array.isArray(state?.fallbackEntries) ? state.fallbackEntries : []).map((entry) => ({
      suffix: String(entry?.suffix ?? ""),
      dnsServer: Array.isArray(entry?.dnsServer) ? entry.dnsServer.map(String) : [],
      owned: entry?.owned === true,
      actions: entry?.owned === true ? ["delete"] : [],
    })),
    plan: plan ? { add, update, adopt, remove, conflict, unchanged: Number(plan.unchanged ?? 0), untouched: Number(plan.untouched ?? 0) } : null,
    planError: String(state?.fallbackPlanError ?? ""),
    pending,
    /** Nothing to write, and the provider was read successfully enough to know. */
    inStep: plan !== null && pending === 0,
    syncable: plan !== null && pending > 0 && resolver !== "",
  };
}

/**
 * Who each record belongs to, read off the last plan.
 *
 * Ownership is a marker on the provider's copy, so only a provider read can
 * answer it -- and the plan is where that read already happened. The verdicts
 * are deliberately four, because "no operation" hides two very different
 * records: one of ours that already matches, and somebody else's that happens
 * to say the same thing. An operator may rewrite the first and must not touch
 * the second, and until now the table showed them identically.
 *
 * `""` means nobody has asked the provider yet. Not "unowned" -- the difference
 * matters, because an empty answer here must never read as "safe to change".
 *
 * @param {{ views?: Record<string, { actual?: { name?: string, type?: string, content?: string, managed?: boolean }[] }> }} plan
 * @returns {Map<string, string>} row key to `ours`, `theirs`, `absent` or `""`
 */
export function recordOwnership(records, plan, view = "external") {
  const rows = Array.isArray(records) ? records : [];
  const actual = plan?.views?.[view]?.actual;
  // A view whose provider could not be read carries no list, which is not the
  // same as a provider holding nothing.
  if (!Array.isArray(actual)) return new Map();
  const key = (name, type) => `${String(name ?? "")}\0${String(type ?? "")}`;
  const held = new Map();
  const atName = new Map();
  for (const entry of actual) {
    const managed = entry?.managed === true;
    held.set(`${key(entry?.name, entry?.type)}\0${String(entry?.content ?? "")}`, managed);
    const group = atName.get(key(entry?.name, entry?.type)) ?? [];
    group.push(managed);
    atName.set(key(entry?.name, entry?.type), group);
  }
  const verdicts = new Map();
  for (const row of rows) {
    const content = String(row?.views?.[view]?.content ?? "");
    // A row with no answer on this side describes nothing here, so there is
    // nothing at the provider for it to be.
    if (!content) continue;
    const rowKey = key(row?.name, row?.type);
    const exact = held.get(`${rowKey}\0${content}`);
    if (exact !== undefined) {
      verdicts.set(row.id, exact ? "ours" : "theirs");
      continue;
    }
    // No exact match, which is not the same as nothing being there. The value
    // was edited, or is new, and what applying would do depends entirely on who
    // holds the name: reconciliation updates an RRset this control plane owns
    // and refuses one it does not, reporting a conflict rather than a write.
    // Reading "no exact match" as "not published" told an operator their edit
    // would be created, when it would be refused -- the one case where the
    // difference decides whether to go and change it at the provider instead.
    const others = atName.get(rowKey);
    if (!others) verdicts.set(row.id, "absent");
    else verdicts.set(row.id, others.every((managed) => managed) ? "ours" : "contested");
  }
  return verdicts;
}

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
 *   statusError?: string,
 * }} state
 */
export function syncPanel(state) {
  const desired = Number(state?.status?.desiredRevision ?? state?.activeZone?.revision ?? 0);
  if (state?.statusError) {
    return {
      kind: "error",
      error: String(state.statusError),
      overall: "failed",
      views: { internal: { state: "", appliedRevision: 0, error: "" }, external: { state: "", appliedRevision: 0, error: "" } },
      percent: 0,
      desired,
      applied: 0,
    };
  }
  const statuses = Array.isArray(state?.status?.statuses) ? state.status.statuses : [];
  const records = Array.isArray(state?.records) ? state.records : [];

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
