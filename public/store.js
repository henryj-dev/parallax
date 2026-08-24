import { ApiError } from "./api-client.js";
import { pluralKey } from "./i18n.js";
import { effectiveExternalTtl } from "./ttl.js";

/**
 * Everything the portal knows, and every flow that changes it.
 *
 * The store never touches the DOM. A view subscribes to state and renders it,
 * reports what the user did, and listens for notices and intents; it is free to
 * lay itself out any way it likes because none of the behaviour lives there.
 *
 * Flows do not throw for expected failures: they record the problem on the
 * state, emit a notice, and answer whether they succeeded, so a view never has
 * to know which call inside a flow went wrong.
 */

/**
 * How much of each trail one request asks for.
 *
 * Both were declared and then never used: the client drained every page to the
 * end instead, so the API's 500-row cap bought nothing and the history panel
 * pulled a year of audit into the browser. They are the fetch size now, and
 * "load more" is what asks for the next one.
 */
export const HISTORY_PAGE_SIZE = 50;
export const REVISION_PAGE_SIZE = 50;

/** Scopes a view can surface an inline error against. */
export const ERROR_SCOPES = ["zone", "record", "credential", "profile", "settings", "token", "auth", "fallback"];

export function editorControlsVisible(state) {
  return !state.authRequired || state.role === "admin" || state.role === "editor";
}

export function adminControlsVisible(state) {
  return !state.authRequired || state.role === "admin";
}

export function createStore(client) {
  const state = {
    connection: "connecting",
    authRequired: true,
    authenticated: false,

    zones: [],
    zonesError: "",
    activeZone: null,
    records: [],
    dirty: false,
    loadingZone: false,
    status: null,
    statusError: "",
    history: [],
    historyError: "",
    historyScope: "zone",
    historyHasMore: false,
    loadingMoreHistory: false,

    plan: null,
    planError: "",
    previewRevision: null,
    applying: false,

    revisions: [],
    revisionsError: "",
    revisionsHasMore: false,
    loadingMoreRevisions: false,
    inspectedRevision: null,
    inspectedRevisionError: "",

    profiles: [],
    bindings: [],
    selectedProfile: null,
    selectedBinding: null,
    settings: null,
    tokens: [],
    fallbackProfile: "",
    fallbackCoverage: [],
    fallbackEntries: [],
    fallbackPlan: null,
    fallbackPlanError: "",
    issuedToken: "",
    providerAccess: null,

    errors: Object.fromEntries(ERROR_SCOPES.map((scope) => [scope, null])),
  };

  const changeListeners = new Set();
  const noticeListeners = new Set();
  const intentListeners = new Set();

  const emitChange = () => { for (const listener of changeListeners) listener(state); };
  const notice = (key, values = {}, level = "success") => {
    for (const listener of noticeListeners) listener({ key, values, level });
  };
  const intent = (type, detail = {}) => {
    for (const listener of intentListeners) listener({ type, ...detail });
  };

  function setError(scope, key, values = {}) {
    state.errors[scope] = key === null ? null : { key, values };
    emitChange();
  }
  function clearErrors() {
    for (const scope of ERROR_SCOPES) state.errors[scope] = null;
  }

  /**
   * Signing in is the only cure for a 401, so a flow that hits one asks the view
   * to offer it rather than reporting a failure the user cannot act on.
   */
  function handleUnauthorized(error) {
    if (!(error instanceof ApiError) || error.status !== 401) return false;
    state.authenticated = false;
    emitChange();
    intent("auth-required");
    return true;
  }

  const activeName = () => state.activeZone?.name ?? "";
  const activeRevision = () => state.activeZone?.revision ?? undefined;

  // Checked against the declaration the view compiles against, so the two cannot
  // drift: a command renamed here without being renamed there stops building.
  /** @type {import("./store.d.ts").Store} */
  const store = {
    getState: () => state,
    subscribe(listener) { changeListeners.add(listener); return () => changeListeners.delete(listener); },
    onNotice(listener) { noticeListeners.add(listener); return () => noticeListeners.delete(listener); },
    onIntent(listener) { intentListeners.add(listener); return () => intentListeners.delete(listener); },

    // ---- session ---------------------------------------------------------

    /**
     * Carries a failed provider sign-in into the same error channel the token
     * form uses. Writing it into the DOM directly does not work: the next
     * render reads the store, finds no error, and hides the line again -- so
     * the one thing that explains the failure disappears as it is drawn.
     */
    reportSignInFailure(reason) {
      setError("auth", "auth.identityFailed", { reason });
    },

    async readAuthenticationMode() {
      try {
        const answer = await client.authenticationMode();
        state.authRequired = answer.mode !== "disabled";
        state.identityProvider = answer.identityProvider;
        // A session may already exist -- an identity provider leaves one behind
        // without this page ever having asked for it.
        state.role = await client.readSession().then((session) => session.role, () => null);
        state.authenticated = state.role !== null;
      } catch {
        // Unreachable is treated as protected: drawing an open control plane
        // that turns out to be closed is the worse of the two mistakes.
        state.authRequired = true;
        state.identityProvider = false;
      }
      emitChange();
    },

    async signIn(token) {
      setError("auth", null);
      try {
        const session = await client.createSession(token);
        state.authenticated = true;
        state.role = session.role;
        emitChange();
        await this.loadZones();
        return true;
      } catch (error) {
        state.authenticated = false;
        setError("auth", error instanceof ApiError && error.status === 403 ? "auth.forbidden" : "auth.rejected");
        return false;
      }
    },

    async signOut() {
      try {
        await client.endIdentitySession();
      } catch {
        // Token-only deployments have no identity route; the session delete below still ends it.
      }
      try {
        await client.deleteSession();
      } catch {
        // The cookie is cleared either way; a failed sign-out still ends it here.
      }
      state.authenticated = false;
      state.zones = [];
      state.activeZone = null;
      state.records = [];
      emitChange();
      intent("auth-required");
    },

    // ---- zones -----------------------------------------------------------

    async loadZones({ preserveSelection = false } = {}) {
      state.connection = "connecting";
      emitChange();
      try {
        const payload = await client.listZones();
        state.zones = payload?.zones ?? [];
        state.zonesError = "";
        state.connection = "online";
        state.authenticated = true;
        // How far each zone is applied, read once for the whole list. Its own
        // failure is not the list's: a zone list that draws is worth more than
        // one that refuses because a dot beside it could not be decided, so the
        // state is simply absent and the row says nothing rather than guessing.
        try {
          const overview = await client.statusOverview();
          const states = new Map((overview?.zones ?? []).map((entry) => [entry.zone, entry.state]));
          state.zones = state.zones.map((zone) => {
            const applied = states.get(zone.name);
            return applied ? { ...zone, state: applied } : zone;
          });
        } catch {
          // Left unset, which the view draws as no verdict at all.
        }
        emitChange();
        if (!preserveSelection && state.zones.length > 0) await this.selectZone(state.zones[0].name);
        return true;
      } catch (error) {
        handleUnauthorized(error);
        state.zonesError = error.message;
        state.connection = "error";
        emitChange();
        return false;
      }
    },

    /** Loads a zone's desired state, apply status and recent history together. */
    async selectZone(name) {
      state.activeZone = state.zones.find((zone) => zone.name === name) ?? { name };
      state.dirty = false;
      state.plan = null;
      state.planError = "";
      state.previewRevision = null;
      state.loadingZone = true;
      state.statusError = "";
      state.historyError = "";
      state.historyScope = "zone";
      emitChange();

      try {
        const [detail, statusResult, historyResult] = await Promise.all([
          client.getZone(name),
          client.zoneStatus(name).then(
            (status) => ({ status, error: "" }),
            (error) => ({ status: null, error: error.message }),
          ),
          client.history(name, { limit: HISTORY_PAGE_SIZE, offset: 0 }).then(
            (history) => ({ history, error: "" }),
            (error) => ({ history: null, error: error.message }),
          ),
        ]);
        // A slower answer for a zone the user has since left must not win.
        if (activeName() !== name) return true;
        state.activeZone = detail;
        state.records = readRecords(detail);
        state.status = statusResult.status;
        state.statusError = statusResult.error;
        state.history = historyResult.history?.entries ?? [];
        state.historyHasMore = historyResult.history?.hasMore === true;
        state.historyError = historyResult.error;
        return true;
      } catch (error) {
        if (activeName() !== name) return true;
        handleUnauthorized(error);
        state.records = [];
        state.status = null;
        state.statusError = "";
        state.history = [];
        state.historyHasMore = false;
        state.historyError = "";
        notice("zone.detailsFailed", { error: error.message }, "error");
        return false;
      } finally {
        state.loadingZone = false;
        emitChange();
      }
    },

    async createZone(name) {
      setError("zone", null);
      try {
        await client.createZone(name);
        await this.loadZones({ preserveSelection: true });
        await this.selectZone(name);
        notice("zone.created", { name });
        return true;
      } catch (error) {
        handleUnauthorized(error);
        setError("zone", "zone.createFailed", { error: error.message });
        return false;
      }
    },

    async deleteActiveZone() {
      const name = activeName();
      if (!name) return false;
      try {
        const result = await client.deleteZone(name, activeRevision(), { abandonProviderRecords: true });
        state.activeZone = null;
        state.records = [];
        const withdrawn = result?.removedProviderRecords?.length ?? 0;
        // `pluralKey`, because a notice goes straight to `translate()` with no
        // pluralization on the way. Without it the catalog has only `.one` and
        // `.other`, the lookup misses, and the toast prints the key itself --
        // which is what it had been doing.
        if (withdrawn > 0) notice(pluralKey("zone.deletedRecords", withdrawn), { name, count: withdrawn });
        else notice("zone.deleted", { name });
        // The delete is always sent with `abandonProviderRecords`, so a target
        // the provider could not be read for does not block it -- the confirm
        // text says so. What it did not say is which targets, and the server
        // returns exactly that so the blast radius can be seen. Dropping it
        // meant a broken token left live records nobody tracks, under a notice
        // that said "deleted".
        const abandoned = (result?.abandonedProviderTargets ?? []).map((entry) => String(entry?.target ?? entry?.view ?? ""));
        if (abandoned.length > 0) {
          notice(pluralKey("zone.deletedAbandoned", abandoned.length), { count: abandoned.length, targets: abandoned.join(", ") }, "warning");
        }
        await this.loadZones();
        return true;
      } catch (error) {
        handleUnauthorized(error);
        notice("zone.deleteFailed", { error: error.message }, "error");
        return false;
      }
    },

    // ---- desired-state editing (local until applied) ----------------------

    /**
     * Records are edited locally and sent as one desired state, so a half-built
     * change never reaches a provider. `dirty` marks work not yet applied.
     */
    stageRecord(record, index = null) {
      setError("record", null);
      // One side or the other has to answer. A row with neither is dropped by
      // `desiredState` on both views, so saving it would report success and
      // change nothing -- and the record would be gone from the table on the
      // next load with no error ever shown.
      if (!record.views.external.content && !record.views.internal.content) {
        setError("record", "record.answerRequired");
        return false;
      }
      const duplicate = state.records.findIndex((item, position) => item.name === record.name
        && item.type === record.type && position !== index
        && ((item.views.external.content && item.views.external.content === record.views.external.content)
          || (item.views.internal.content && item.views.internal.content === record.views.internal.content)));
      if (duplicate >= 0) {
        setError("record", "record.duplicate");
        return false;
      }
      const cnameConflict = state.records.findIndex((item, position) => item.name === record.name
        && position !== index && (item.type === "CNAME" || record.type === "CNAME"));
      if (cnameConflict >= 0) {
        setError("record", "record.cnameConflict");
        return false;
      }

      if (index === null) state.records.push(record);
      else state.records[index] = record;
      markDirty();
      notice("record.updatedLocal");
      return true;
    },

    removeRecord(index) {
      state.records.splice(index, 1);
      markDirty();
      notice("record.removedLocal");
    },

    /** A stable identifier for a new record that no existing one already uses. */
    proposeRecordId(name, type) {
      const base = String(name || "record").toLowerCase()
        .replace(/^@$/u, "root").replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "") || "record";
      const candidate = `${base}-${String(type || "record").toLowerCase()}`.slice(0, 63);
      const used = new Set(state.records.flatMap((record) => [record.id, record.views.internal.id, record.views.external.id]));
      if (!used.has(candidate)) return candidate;
      for (let suffix = 2; suffix < 1000; suffix += 1) {
        const numbered = `${candidate.slice(0, 63 - String(suffix).length - 1)}-${suffix}`;
        if (!used.has(numbered)) return numbered;
      }
      return `${candidate.slice(0, 54)}-${state.records.length}`;
    },

    // ---- preview and apply ------------------------------------------------

    /**
     * Brings what the provider already holds into the desired state.
     *
     * Reports `seen` as well as what it took, because those two numbers are the
     * difference between "the view was already complete" and "nothing could be
     * read at all" -- and a run that adopted nothing looks identical otherwise.
     */
    async adopt() {
      setError("zone", null);
      try {
        const result = await client.adopt(activeName(), state.activeZone?.revision);
        notice("zone.adopted", { seen: String(result.seen), adopted: String(result.adopted.length) });
        // Adoption reports things no count can carry: that this process just
        // became the authority for a whole zone, or that it could not read
        // which names Workers and R2 own -- in which case no row gained a
        // label and nothing else on the page would say why. The page dropped
        // them, so the CLI told an operator what the portal did not.
        for (const warning of Array.isArray(result.warnings) ? result.warnings : []) {
          notice("zone.adoptWarning", { warning: String(warning) }, "warning");
        }
        await this.selectZone(activeName());
        return true;
      } catch (error) {
        handleUnauthorized(error);
        setError("zone", "zone.adoptFailed", { error: error.message });
        return false;
      }
    },

    async preview() {
      state.plan = null;
      state.planError = "";
      state.previewRevision = null;
      emitChange();
      try {
        const result = await client.preview(activeName(), desiredState(state.records));
        state.plan = result;
        state.previewRevision = result.revision;
        emitChange();
        return true;
      } catch (error) {
        handleUnauthorized(error);
        state.planError = error.message;
        emitChange();
        return false;
      }
    },

    async apply() {
      state.applying = true;
      emitChange();
      try {
        let expected = state.previewRevision;
        if (state.dirty) {
          const saved = await client.replaceDesired(activeName(), desiredState(state.records), activeRevision());
          state.activeZone = saved;
          expected = saved.revision;
        }
        const result = await client.apply(activeName(), expected);
        state.dirty = false;
        state.plan = null;
        state.planError = "";
        state.previewRevision = null;
        // `apply` does not throw when a provider refuses. It answers 200 with
        // the failure inside `statuses`, which is right -- one view failing is
        // not a reason to hide another view's result -- and it means the caller
        // has to look. This one did not, so every apply reported success in
        // green and the only correction was the status dot redrawing later.
        const failed = (result?.statuses ?? []).filter((status) => status?.state === "failed");
        if (applyVerdict(result?.statuses) === "failed") {
          const views = failed.map((status) => String(status.view)).join(", ");
          const first = failed[0] ?? {};
          // How far it got is the value that decides what to do next: a view
          // left part-applied is answering for part of the change already.
          const partial = Number.isFinite(first.completedOperations) && Number.isFinite(first.plannedOperations);
          notice(partial ? "apply.viewsFailedPartial" : "apply.viewsFailed", {
            views,
            error: String(first.error ?? ""),
            ...(partial ? { completed: String(first.completedOperations), planned: String(first.plannedOperations) } : {}),
          }, "error");
        } else {
          notice(result?.revision ? "apply.startedRevision" : "apply.started", result?.revision ? { revision: result.revision } : {});
        }
        await this.selectZone(activeName());
        await this.loadZones({ preserveSelection: true });
        return failed.length === 0;
      } catch (error) {
        handleUnauthorized(error);
        notice("apply.failed", { error: error.message }, "error");
        return false;
      } finally {
        state.applying = false;
        emitChange();
      }
    },

    // ---- revisions --------------------------------------------------------

    async loadRevisions() {
      state.revisions = [];
      state.revisionsHasMore = false;
      state.revisionsError = "";
      emitChange();
      try {
        const payload = await client.listRevisions(activeName(), { limit: REVISION_PAGE_SIZE, offset: 0 });
        state.revisions = payload?.revisions ?? [];
        state.revisionsHasMore = payload?.hasMore === true;
      } catch (error) {
        handleUnauthorized(error);
        state.revisionsHasMore = false;
        state.revisionsError = error.message;
      }
      emitChange();
    },

    /** The next page of snapshots, appended to the ones already listed. */
    async loadMoreRevisions() {
      if (!state.revisionsHasMore || state.loadingMoreRevisions) return false;
      state.loadingMoreRevisions = true;
      emitChange();
      try {
        const payload = await client.listRevisions(activeName(), {
          limit: REVISION_PAGE_SIZE,
          offset: state.revisions.length,
        });
        const revisions = payload?.revisions ?? [];
        state.revisions = [...state.revisions, ...revisions];
        state.revisionsHasMore = payload?.hasMore === true && revisions.length > 0;
        return true;
      } catch (error) {
        handleUnauthorized(error);
        state.revisionsError = error.message;
        return false;
      } finally {
        state.loadingMoreRevisions = false;
        emitChange();
      }
    },

    /**
     * Reads one snapshot so it can be seen before it is restored.
     *
     * Fetched rather than taken from the loaded page: the list is bounded, and
     * the revision somebody wants to look at is often an old one. Restoring is
     * not undoing -- it makes that snapshot the current intent, and the next
     * apply carries it out -- so what is in it has to be readable first.
     */
    async inspectRevision(revision) {
      if (state.inspectedRevision?.revision === revision) {
        state.inspectedRevision = null;
        emitChange();
        return true;
      }
      state.inspectedRevision = null;
      state.inspectedRevisionError = "";
      emitChange();
      try {
        state.inspectedRevision = await client.getRevision(activeName(), revision);
        emitChange();
        return true;
      } catch (error) {
        handleUnauthorized(error);
        state.inspectedRevisionError = error.message;
        emitChange();
        return false;
      }
    },

    async restoreRevision(revision) {
      try {
        await client.restoreRevision(activeName(), revision, activeRevision());
        notice("revisions.restored", { revision });
        await this.selectZone(activeName());
        return true;
      } catch (error) {
        handleUnauthorized(error);
        notice("revisions.restoreFailed", { error: error.message }, "error");
        return false;
      }
    },

    // ---- provider settings, server settings, tokens -----------------------

    /**
     * The override report for one profile.
     *
     * Coverage and the plan are loaded separately and independently on purpose.
     * Coverage reaches no provider, so it is the half that still answers when
     * the token, the account id or the permission is the broken thing -- and
     * that is precisely when somebody is asking why a zone is not covered. A
     * plan that cannot be read leaves its reason on the state and the coverage
     * table intact, rather than blanking the panel.
     */
    async loadFallback(profile) {
      setError("fallback", null);
      state.fallbackProfile = profile;
      state.fallbackCoverage = [];
      state.fallbackPlan = null;
      state.fallbackEntries = [];
      state.fallbackPlanError = "";
      emitChange();
      let ok = true;
      try {
        const coverage = await client.fallbackCoverage(profile);
        state.fallbackCoverage = coverage?.zones ?? [];
      } catch (error) {
        handleUnauthorized(error);
        setError("fallback", "fallback.coverageFailed", { error: error.message });
        ok = false;
      }
      try {
        const [entries, plan] = await Promise.all([client.fallbackList(profile), client.fallbackPreview(profile)]);
        state.fallbackEntries = Array.isArray(entries) ? entries : entries?.domains ?? [];
        state.fallbackPlan = plan ?? null;
      } catch (error) {
        handleUnauthorized(error);
        state.fallbackPlanError = error.message;
        ok = false;
      }
      emitChange();
      return ok;
    },

    /** Points one suffix at a resolver, leaving every other entry alone. */
    async setFallbackSuffix(profile, suffix, dnsServer) {
      setError("fallback", null);
      try {
        const result = await client.setFallbackSuffix(profile, suffix, dnsServer);
        const outcome = result?.outcome ?? "added";
        notice(
          outcome === "unchanged" ? "fallback.unchanged"
            : outcome === "updated" ? "fallback.updated" : "fallback.added",
          { suffix },
        );
        await this.loadFallback(profile);
        return true;
      } catch (error) {
        handleUnauthorized(error);
        setError("fallback", "fallback.setFailed", { error: error.message });
        return false;
      }
    },

    /** Removes one suffix from the override list. */
    async deleteFallbackSuffix(profile, suffix) {
      setError("fallback", null);
      try {
        const result = await client.deleteFallbackSuffix(profile, suffix);
        notice(result?.outcome === "unchanged" ? "fallback.unchanged" : "fallback.removed", { suffix });
        await this.loadFallback(profile);
        return true;
      } catch (error) {
        handleUnauthorized(error);
        setError("fallback", "fallback.deleteFailed", { error: error.message });
        return false;
      }
    },

    /** Newest first across every zone, not only the one currently open. */
    async loadGlobalHistory() {
      state.historyError = "";
      state.historyScope = "global";
      emitChange();
      try {
        const history = await client.globalHistory({ limit: HISTORY_PAGE_SIZE, offset: 0 });
        state.history = history?.entries ?? [];
        state.historyHasMore = history?.hasMore === true;
        emitChange();
        return true;
      } catch (error) {
        handleUnauthorized(error);
        state.history = [];
        state.historyHasMore = false;
        state.historyError = error.message;
        emitChange();
        return false;
      }
    },

    /**
     * The next page of whichever trail is on screen.
     *
     * Appends rather than replaces, and refuses to run twice at once: the
     * button stays visible while the request is in flight, and a second press
     * would otherwise ask for the same offset and show the page twice.
     */
    async loadMoreHistory() {
      if (!state.historyHasMore || state.loadingMoreHistory) return false;
      state.loadingMoreHistory = true;
      emitChange();
      try {
        const offset = state.history.length;
        const page = state.historyScope === "global"
          ? await client.globalHistory({ limit: HISTORY_PAGE_SIZE, offset })
          : await client.history(activeName(), { limit: HISTORY_PAGE_SIZE, offset });
        const entries = page?.entries ?? [];
        state.history = [...state.history, ...entries];
        // A page that claims more but delivers nothing would leave the button
        // forever. Believe the rows, not the flag.
        state.historyHasMore = page?.hasMore === true && entries.length > 0;
        return true;
      } catch (error) {
        handleUnauthorized(error);
        state.historyError = error.message;
        return false;
      } finally {
        state.loadingMoreHistory = false;
        emitChange();
      }
    },

    /** Writes the overrides for one profile, then reads the result back. */
    async syncFallback(profile) {
      setError("fallback", null);
      try {
        const result = await client.fallbackSync(profile);
        const plan = result?.plan ?? {};
        const changed = ["add", "update", "remove", "adopt"]
          .reduce((total, key) => total + (Array.isArray(plan[key]) ? plan[key].length : 0), 0);
        notice(changed > 0 ? "fallback.synced" : "fallback.alreadyInStep", { count: String(changed) });
        await this.loadFallback(profile);
        return true;
      } catch (error) {
        handleUnauthorized(error);
        setError("fallback", "fallback.syncFailed", { error: error.message });
        return false;
      }
    },

    async loadAdministration() {
      state.providerAccess = null;
      clearErrors();
      try {
        const [profiles, bindings] = await Promise.all([
          client.listProfiles().catch(absentAsEmpty({ profiles: [] })),
          client.listBindings().catch(absentAsEmpty({ credentials: [] })),
        ]);
        state.profiles = profiles?.profiles ?? [];
        state.bindings = bindings?.credentials ?? [];
        const [settings, tokens] = await Promise.all([client.getSettings(), client.listTokens()]);
        state.settings = settings?.settings ?? null;
        state.tokens = tokens?.tokens ?? [];
        emitChange();
        return true;
      } catch (error) {
        if (handleUnauthorized(error)) return false;
        state.profiles = [];
        state.bindings = [];
        state.providerAccess = error instanceof ApiError && error.status === 403
          ? { key: "credentials.adminView", denied: true }
          : error instanceof ApiError && error.status === 404
            ? { key: "credentials.disabled", denied: false }
            : { key: "credentials.loadFailed", values: { error: error.message }, denied: true };
        emitChange();
        return false;
      }
    },

    selectProfile(name) {
      state.selectedProfile = name;
      setError("profile", null);
    },

    selectBinding(zone) {
      state.selectedBinding = zone;
      setError("credential", null);
    },

    async saveProfile(name, { token, accountId }) {
      setError("profile", null);
      if (!token.trim()) {
        setError("profile", "credentials.profileTokenRequired");
        return false;
      }
      return administer("profile", "credentials.profileSaved", { name }, async () => {
        await client.saveProfile(name, { token, ...(accountId ? { accountId } : {}) });
        state.selectedProfile = name;
      });
    },

    async testProfile(name, { zone, token }) {
      setError("profile", null);
      if (!name) {
        setError("profile", "credentials.profileNameRequired");
        return false;
      }
      // Cloudflare has no token-only probe, so the profile is exercised against a
      // domain -- either one the operator names or one already using this profile.
      const probe = zone || state.bindings.find((binding) => binding.profile === name)?.zone || "";
      if (!probe) {
        setError("profile", "credentials.probeZoneRequired");
        return false;
      }
      return administer("profile", "credentials.profileAccepted", { name }, async () => {
        await client.testProfile(name, { zone: probe, ...(token.trim() ? { token } : {}) });
      }, { refresh: false });
    },

    async deleteProfile(name) {
      return administer("profile", "credentials.profileDeleted", { name }, async () => {
        await client.deleteProfile(name);
        state.selectedProfile = null;
      }, {
        errorKeyFor: (error) => (error.status === 409 ? "credentials.profileInUse" : undefined),
      });
    },

    async saveBinding(zone, { profile }) {
      setError("credential", null);
      if (!profile) {
        setError("credential", "credentials.profileRequired");
        return false;
      }
      return administer("credential", "credentials.saved", { zone }, async () => {
        await client.saveBinding(zone, { profile });
        state.selectedBinding = zone;
      });
    },

    /** @param {string} zone @param {{ profile?: string }} [binding] */
    async testBinding(zone, { profile } = {}) {
      setError("credential", null);
      if (!zone) {
        setError("credential", "credentials.selectZone");
        return false;
      }
      // With a profile the check runs against an unsaved pairing, which is the
      // order an operator expects: find out it works, then commit it.
      return administer("credential", "credentials.accepted", { zone }, async () => {
        await client.testBinding(zone, profile ? { profile } : undefined);
      }, {
        refresh: false,
        failureKey: "credentials.testFailed",
        // Testing a domain that was never bound is the ordinary mistake here --
        // the form is filled in and the button is right there -- so it gets an
        // answer that says what to do rather than one that reads like a fault.
        errorKeyFor: (error) => (error.status === 404 ? "credentials.testNeedsBinding" : undefined),
      });
    },

    async deleteBinding(zone) {
      return administer("credential", "credentials.deleted", { zone }, async () => {
        await client.deleteBinding(zone);
        state.selectedBinding = null;
      });
    },

    async saveSettings(values) {
      let warnings = [];
      const saved = await administer("settings", "settings.saved", {}, async () => {
        const payload = await client.saveSettings(values);
        state.settings = payload?.settings ?? state.settings;
        warnings = payload?.warnings ?? [];
      }, { refresh: false, failureKey: "settings.saveFailed" });
      // A legal change can still cost something. Whoever made it is the only
      // person who can still act on that, so it is said here rather than left
      // in a log for somebody else to find.
      for (const message of warnings) notice("settings.warning", { message }, "warning");
      return saved;
    },

    async issueToken({ subject, role }) {
      setError("token", null);
      try {
        const issued = await client.issueToken({ subject, role });
        // Shown once: the server keeps only a digest and cannot show it again.
        state.issuedToken = issued.token;
        notice("tokens.issued", { subject: issued.metadata.subject });
        try {
          await this.loadAdministration();
        } catch {
          // handled below
        }
        // Issuing the first token turns authentication on mid-operation, so the
        // very request that would list it is the first to need a session.
        if (state.providerAccess || state.tokens.length === 0) {
          state.authRequired = true;
          setError("token", "tokens.nowRequired");
        }
        emitChange();
        return true;
      } catch (error) {
        setError("token", error instanceof ApiError && error.status === 403
          ? "credentials.adminSave"
          : "tokens.issueFailed", { error: error.message });
        return false;
      }
    },

    async revokeToken(id) {
      const token = state.tokens.find((candidate) => candidate.id === id);
      return administer("token", "tokens.revoked", { subject: token?.subject ?? id }, async () => {
        await client.revokeToken(id);
      }, { failureKey: "tokens.revokeFailed" });
    },

  };

  /**
   * Shared shape for the administration flows: run, report, refresh.
   *
   * @param {string} scope
   * @param {string} successKey
   * @param {Record<string, string>} values
   * @param {() => Promise<unknown>} work
   * @param {{ refresh?: boolean, failureKey?: string, errorKeyFor?: (error: import("./api-client.js").ApiError) => string | undefined }} [options]
   */
  async function administer(scope, successKey, values, work, { refresh = true, failureKey, errorKeyFor } = {}) {
    setError(scope, null);
    try {
      await work();
      if (refresh) await store.loadAdministration();
      notice(successKey, values);
      emitChange();
      return true;
    } catch (error) {
      const specific = error instanceof ApiError ? errorKeyFor?.(error) : undefined;
      const forbidden = error instanceof ApiError && error.status === 403;
      setError(
        scope,
        specific ?? (forbidden ? "credentials.adminSave" : failureKey ?? "credentials.saveFailed"),
        specific || forbidden ? {} : { error: error.message },
      );
      return false;
    }
  }

  function markDirty() {
    state.dirty = true;
    state.plan = null;
    state.planError = "";
    state.previewRevision = null;
    emitChange();
  }

  return store;

}

/** A route the deployment does not offer is an empty list, not a failure. */
function absentAsEmpty(fallback) {
  return (error) => {
    if (error instanceof ApiError && error.status === 404) return fallback;
    throw error;
  };
}

/**
 * One verdict for a zone from its views' statuses.
 *
 * Mirrors `overallApplyState` in `src/application/control-plane.ts`, which is
 * the same rule the server uses to colour the dot beside a zone. Duplicated
 * rather than imported because the portal is a static page with no build step
 * -- the same reason `providerManagedReason` is duplicated -- and kept honest
 * by a test that runs both over one table.
 */
export function applyVerdict(statuses) {
  const rows = Array.isArray(statuses) ? statuses : [];
  if (rows.length === 0) return "";
  if (rows.some((status) => status?.state === "failed")) return "failed";
  return rows.every((status) => status?.state === "applied") ? "applied" : "pending";
}

/**
 * Folds a zone's two views into one row per record, so a name that differs
 * inside and outside is a single thing with two answers.
 */
export function readRecords(zone) {
  const views = Array.isArray(zone?.views) ? zone.views : [];
  const internal = views.find((view) => view.name === "internal")?.records ?? [];
  const external = views.find((view) => view.name === "external")?.records ?? [];
  const key = (record) => `${record.id}\0${record.name}\0${record.type}`;
  const remaining = new Map(internal.map((record) => [key(record), record]));

  const rows = external.map((record) => {
    const override = remaining.get(key(record));
    if (override) remaining.delete(key(record));
    return toRow(record, override);
  });
  for (const record of remaining.values()) rows.push(toRow(undefined, record));
  return rows.sort((left, right) => left.name.localeCompare(right.name)
    || left.type.localeCompare(right.type)
    || left.id.localeCompare(right.id));
}

/**
 * Mirrors `providerManagement` in `src/domain/dns.ts`.
 *
 * Duplicated rather than fetched because the portal is a static page with no
 * build step, and asking the server "may I edit this?" would be a request per
 * row. The copy is kept honest by a test that runs both over the same table: if
 * one learns a new placeholder and the other does not, that test fails.
 */
export function providerManagedReason(record) {
  const content = String(record?.content ?? "").trim();
  if (managingService(record)) return "service";
  if (record?.type === "A" && content === "192.0.2.0") return "originless";
  if (record?.type === "AAAA" && isDiscardAddress(content)) return "originless";
  if (record?.type === "CNAME" && content.replace(/\.$/u, "").toLowerCase().endsWith(".r2.dev")) return "service";
  return "";
}

/**
 * Mirrors `MANAGING_SERVICE_LABELS` in `src/domain/dns.ts`.
 *
 * A record a provider service publishes is stored as the CNAME it is, and that
 * is not what it is. The table says `Worker` or `R2` and names the worker or
 * bucket, as the provider's own table does, because reading the DNS value as a
 * target is what invites the edit that breaks the binding.
 */
const SERVICE_LABELS = { worker: "Worker", r2: "R2" };

/** The service binding on a record, or `undefined` when nothing claims it. */
function managingService(record) {
  const binding = record?.managedBy;
  if (!binding || typeof binding !== "object") return undefined;
  const label = SERVICE_LABELS[binding.service];
  return label && binding.resource ? { label, resource: String(binding.resource) } : undefined;
}

/** `100::` however it is spelled. */
function isDiscardAddress(content) {
  const text = content.toLowerCase();
  if (text.includes(".")) return false;
  const halves = text.split("::");
  if (halves.length > 2) return false;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const filled = halves.length === 2 ? Array.from({ length: 8 - head.length - tail.length }, () => "0") : [];
  const groups = [...head, ...filled, ...tail];
  if (groups.length !== 8) return false;
  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/u.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  if (parsed.some(Number.isNaN)) return false;
  return parsed[0] === 0x0100 && parsed.slice(1).every((group) => group === 0);
}

function toRow(external, internal) {
  const source = external ?? internal;
  const proxied = Boolean(external?.proxied);
  const service = external ? managingService(external) : undefined;
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    // What the row shows where it shows a type and an outside answer. The
    // stored CNAME is still `type` and `content`, because that is what is
    // saved and reconciled; these two are what the record means.
    typeLabel: service ? service.label : source.type,
    ...(service ? { managedBy: { ...external.managedBy } } : {}),
    views: {
      internal: {
        id: internal?.id ?? source.id,
        content: internal?.content ?? "",
        ttl: internal?.ttl ?? source.ttl ?? 300,
      },
      external: {
        id: external?.id ?? source.id,
        content: external?.content ?? "",
        ttl: effectiveExternalTtl(external?.ttl ?? source.ttl ?? 300, proxied),
        proxied,
        acknowledgeNonGlobalIp: Boolean(external?.acknowledgeNonGlobalIp),
        // Why the provider owns this record, or "" when nobody but us does.
        managed: external ? providerManagedReason(external) : "",
        /** What the outside answer is, named as the thing that owns it. */
        label: service ? service.resource : (external?.content ?? ""),
      },
    },
  };
}

/**
 * Whether an address should not be published externally. The server decides
 * authoritatively; this mirrors it closely enough to warn before a round trip.
 */
export function isNonGlobalAddress(value) {
  if (value.includes(":")) {
    const address = value.toLowerCase();
    return address === "::" || address === "::1"
      || /^f[cdef]/u.test(address) || /^[fd]/u.test(address)
      || address.startsWith("2001:db8:") || address.startsWith("100:");
  }
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

/** Turns the edited rows back into the two views the API stores. */
export function desiredState(records) {
  const asRecord = (row, view) => ({
    id: row.views[view].id || row.id,
    name: row.name,
    type: row.type,
    content: view === "internal"
      ? (row.views.internal.content || row.views.external.content)
      : row.views.external.content,
    ttl: row.views[view].ttl,
    ...(view === "external"
      ? {
        ...(["A", "AAAA", "CNAME"].includes(row.type) ? { proxied: row.views.external.proxied } : {}),
        ...(row.views.external.acknowledgeNonGlobalIp ? { acknowledgeNonGlobalIp: true } : {}),
        // Sent back untouched. The server treats a missing binding as a
        // changed record and refuses the save, which is what stops a page
        // that forgot the field from quietly unlocking every locked row.
        ...(row.managedBy ? { managedBy: row.managedBy } : {}),
      }
      : {}),
  });
  return {
    views: [
      { name: "internal", records: records.filter((row) => row.views.internal.content).map((row) => asRecord(row, "internal")) },
      { name: "external", records: records.filter((row) => row.views.external.content).map((row) => asRecord(row, "external")) },
    ],
  };
}
