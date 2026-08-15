import { ApiError } from "./api-client.js";
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

export const HISTORY_PAGE_SIZE = 5;
export const REVISION_PAGE_SIZE = 50;

/** Scopes a view can surface an inline error against. */
export const ERROR_SCOPES = ["zone", "record", "credential", "profile", "settings", "token", "auth"];

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
    history: [],

    plan: null,
    planError: "",
    previewRevision: null,
    applying: false,

    revisions: [],
    revisionsError: "",
    inspectedRevision: null,
    inspectedRevisionError: "",

    profiles: [],
    bindings: [],
    selectedProfile: null,
    selectedBinding: null,
    settings: null,
    tokens: [],
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
      emitChange();

      try {
        const [detail, status, history] = await Promise.all([
          client.getZone(name),
          client.zoneStatus(name).catch(() => null),
          client.history(name, HISTORY_PAGE_SIZE).catch(() => ({ entries: [] })),
        ]);
        // A slower answer for a zone the user has since left must not win.
        if (activeName() !== name) return true;
        state.activeZone = detail;
        state.records = readRecords(detail);
        state.status = status;
        state.history = history?.entries ?? [];
        return true;
      } catch (error) {
        if (activeName() !== name) return true;
        handleUnauthorized(error);
        state.records = [];
        state.status = null;
        state.history = [];
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
        const result = await client.deleteZone(name, activeRevision());
        state.activeZone = null;
        state.records = [];
        const withdrawn = result?.removedProviderRecords?.length ?? 0;
        if (withdrawn > 0) notice("zone.deletedRecords", { name, count: withdrawn });
        else notice("zone.deleted", { name });
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
        const result = await client.adopt(activeName(), state.status?.revision);
        notice("zone.adopted", { seen: String(result.seen), adopted: String(result.adopted.length) });
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
        notice(result?.revision ? "apply.startedRevision" : "apply.started", result?.revision ? { revision: result.revision } : {});
        await this.selectZone(activeName());
        await this.loadZones({ preserveSelection: true });
        return true;
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
      state.revisionsError = "";
      emitChange();
      try {
        const payload = await client.listRevisions(activeName(), REVISION_PAGE_SIZE);
        state.revisions = payload?.revisions ?? [];
      } catch (error) {
        handleUnauthorized(error);
        state.revisionsError = error.message;
      }
      emitChange();
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
 * Folds a zone's two views into one row per record, so a name that differs
 * inside and outside is a single thing with two answers.
 */
export function readRecords(zone) {
  const views = Array.isArray(zone?.views) ? zone.views : [];
  const internal = views.find((view) => view.name === "internal")?.records ?? [];
  const external = views.find((view) => view.name === "external")?.records ?? [];
  const key = (record) => `${record.id} ${record.name} ${record.type}`;
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

function toRow(external, internal) {
  const source = external ?? internal;
  const proxied = Boolean(external?.proxied);
  return {
    id: source.id,
    name: source.name,
    type: source.type,
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
