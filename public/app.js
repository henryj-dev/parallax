import { createApiClient } from "./api-client.js";
import { fallbackPanel, recordOwnership, recordRow, syncPanel } from "./panels.js";
import { createStore, isNonGlobalAddress, ERROR_SCOPES, HISTORY_PAGE_SIZE } from "./store.js";
import { effectiveExternalTtl, isValidDnsOnlyTtl } from "./ttl.js";
import {
  createSemanticMessage,
  createTranslator,
  escapeHtml,
  localizeAuditAction,
  localizedValidationMessage,
  localizeProviderError,
  localizeViewName,
  pluralKey,
  readPersistedLocale,
  renderSemanticMessage,
  resolveLocale,
  translateDocument,
  writePersistedLocale,
} from "./i18n.js";

/**
 * The portal's only job is to draw the store's state and report what the user
 * did. It owns no data: swap this file for a different layout and the whole
 * application still works, because every behaviour lives behind the store and
 * every server call behind the API client.
 */

const store = createStore(createApiClient());

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let locale = resolveLocale({
  persistedLocale: readStoredLocale(),
  browserLocales: globalThis.navigator?.languages || [globalThis.navigator?.language],
});
let t = createTranslator(locale);
const liveMessages = new Map();

// ---- localisation ---------------------------------------------------------

function readStoredLocale() {
  try { return readPersistedLocale(globalThis.localStorage); } catch { return null; }
}

function setLocale(next) {
  locale = resolveLocale({ persistedLocale: next });
  t = createTranslator(locale);
  try { writePersistedLocale(globalThis.localStorage, locale); } catch { /* private mode */ }
  document.documentElement.lang = locale;
  document.title = t("meta.title");
  const description = $('meta[name="description"]');
  if (description) description.content = t("meta.description");
  $("#locale-select").value = locale;
  translateDocument(document, t);
  for (const [element, message] of liveMessages) {
    if (!element.isConnected) liveMessages.delete(element);
    else element.textContent = renderSemanticMessage(message, t);
  }
  for (const field of $$("[data-validation-label]")) updateLocalizedValidity(field);
  render(store.getState());
}

function setLiveMessage(element, key, values = {}) {
  const message = createSemanticMessage(key, values);
  liveMessages.set(element, message);
  element.textContent = renderSemanticMessage(message, t);
}

/**
 * A modal dialog lives in the top layer, which no stacking order can reach past,
 * so a notice raised while one is open was painted under its backdrop -- and the
 * notices that matter most are the ones a dialog's own buttons produce.
 *
 * The region joins the top layer too, as a popover, and re-enters it for each
 * notice so it sits above whatever was opened in the meantime. The attribute is
 * set here rather than in the markup: a `popover` element is hidden until it is
 * shown, so declaring it where the API is missing would hide the notices
 * entirely -- worse than the backdrop covering them.
 */
const toastRegion = $("#toast-region");
const toastsCanRise = typeof toastRegion.showPopover === "function";
if (toastsCanRise) toastRegion.setAttribute("popover", "manual");

function raiseToasts(show) {
  if (!toastsCanRise) return;
  try {
    if (show) {
      toastRegion.hidePopover();
      toastRegion.showPopover();
    } else {
      toastRegion.hidePopover();
    }
  } catch {
    // Already in the state asked for, which is not a failure worth reporting.
  }
}

function toast({ key, values, level }) {
  const element = document.createElement("div");
  element.className = `toast ${level}`;
  setLiveMessage(element, key, values);
  toastRegion.append(element);
  raiseToasts(true);
  setTimeout(() => {
    liveMessages.delete(element);
    element.remove();
    if (!toastRegion.firstChild) raiseToasts(false);
  }, 5200);
}

// ---- shared formatting ----------------------------------------------------

const zoneLabel = (state) => state.activeZone?.name ?? "";
const displayName = (name) => (name === "@" ? zoneLabel(store.getState()) : `${name}.${zoneLabel(store.getState())}`);
const formatTtl = (value) => (Number(value) === 1 ? t("ttl.auto") : t("ttl.seconds", { seconds: Number(value) }));

function formatDate(value) {
  if (!value) return t("date.unknown");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/**
 * Where each error the store can record is drawn. Deriving the list from the
 * store's own scopes means a new scope cannot be added and left invisible.
 */
const ERROR_TARGETS = {
  zone: "#zone-form-error",
  auth: "#auth-form-error",
  record: "#record-form-error",
  profile: "#profile-form-error",
  credential: "#credential-form-error",
  settings: "#settings-form-error",
  token: "#token-form-error",
  fallback: "#fallback-form-error",
};

function renderErrors() {
  const { errors } = store.getState();
  for (const scope of ERROR_SCOPES) {
    const element = $(ERROR_TARGETS[scope]);
    const problem = errors[scope];
    if (!problem) {
      element.hidden = true;
      continue;
    }
    setLiveMessage(element, problem.key, problem.values);
    element.hidden = false;
  }
}

// ---- rendering ------------------------------------------------------------

function render(state) {
  renderConnection(state);
  renderZoneList(state);
  renderWorkspace(state);
  if ($("#plan-dialog").open) renderPlan(state);
  if ($("#revisions-dialog").open) renderRevisions(state);
  if ($("#credential-dialog").open) renderAdministration(state);
  if ($("#credential-dialog").open && !$("#panel-fallback").hidden) renderFallback(state);
  if ($("#record-dialog").open) renderRecordDialogHeading();
  $("#sign-out-button").hidden = !state.authRequired || !state.authenticated;
  syncRoleVisibility(state);
  // Every error the store records reaches the surface that caused it, or a
  // refused action would look like nothing happened at all.
  renderErrors();
}

function renderConnection(state) {
  $(".pulse").className = `pulse ${state.connection === "connecting" ? "" : state.connection}`;
  $("#global-status").textContent = t(state.connection === "online"
    ? "status.online"
    : state.connection === "error" ? "status.unavailable" : "status.connecting");
}

function renderZoneList(state) {
  const list = $("#zone-list");
  if (state.zonesError) {
    $("#zone-count").textContent = "—";
    list.innerHTML = `<div class="mini-empty">${escapeHtml(t("zones.loadFailed"))}<br>${escapeHtml(state.zonesError)}<br><button class="button compact" type="button" data-action="retry-zones">${escapeHtml(t("zones.retry"))}</button></div>`;
    return;
  }
  const query = $("#zone-search").value.trim().toLowerCase();
  const zones = state.zones.filter((zone) => zone.name.toLowerCase().includes(query));
  $("#zone-count").textContent = String(state.zones.length).padStart(2, "0");
  if (zones.length === 0) {
    list.innerHTML = `<div class="mini-empty">${escapeHtml(t(state.zones.length ? "zones.noMatch" : "zones.none"))}</div>`;
    return;
  }
  list.innerHTML = zones.map((zone) => {
    const active = zone.name === zoneLabel(state);
    // How far the zone is applied, from the server's own verdict. This row used
    // to carry a fixed `Not observed` and a dot permanently classed `unknown`,
    // so it said the same thing about a zone fully applied and a zone whose
    // last apply failed -- while the stylesheet had carried the three states it
    // never received since the day it was written.
    const applied = ["applied", "pending", "failed"].includes(zone.state) ? zone.state : "";
    return `<button class="zone-item${active ? " active" : ""}" type="button" data-zone="${escapeHtml(zone.name)}" aria-current="${active ? "page" : "false"}">
      <span class="dot ${applied || "unknown"}" aria-hidden="true"></span>
      <span><b>${escapeHtml(zone.name)}</b><small>${escapeHtml(applied ? t(`status.${applied}`) : t("zones.stateUnknown"))}</small></span>
      <span class="zone-rev">r${escapeHtml(zone.revision ?? "—")}</span>
    </button>`;
  }).join("");
}

function renderWorkspace(state) {
  const active = Boolean(state.activeZone);
  $("#welcome-state").hidden = active;
  $("#zone-workspace").hidden = !active;
  for (const id of ["#refresh-button", "#preview-button", "#adopt-button"]) $(id).disabled = state.loadingZone;
  $("#apply-button").disabled = state.loadingZone || state.applying;
  $("#apply-button").textContent = t(state.applying ? "zone.applying" : "zone.apply");
  if (!active) return;

  $("#zone-name").textContent = state.loadingZone && !state.records.length
    ? (zoneLabel(state) || t("zone.loading"))
    : zoneLabel(state);
  $("#zone-id-label").textContent = "";
  $("#revision-label").textContent = t("zone.desiredRevision", { revision: state.activeZone.revision ?? 0 });
  $("#updated-label").textContent = t("zone.lastChanged", { date: formatDate(state.activeZone.updatedAt) });

  renderRecords(state);
  renderFocusOptions(state);
  renderSync(state);
  renderHistory(state);
}

/** One side's answer, or the message that stands in for the absence of one. */
function answerCell(answer) {
  const text = answer.text || (answer.absent ? t(`record.${answer.absent}`) : "");
  const badge = answer.proxied ? `<span class="proxy-badge">${escapeHtml(t("record.proxied"))}</span>` : "";
  return `<div class="record-answer${answer.inherited ? " inherited" : ""}">${escapeHtml(text)}${badge}</div>`;
}

/**
 * Who owns the record at the provider, where the provider has been asked.
 *
 * Silent otherwise: an absent badge means nobody has looked, and dressing that
 * up as "not ours" would invite exactly the edit the badge exists to prevent.
 */
function ownershipBadge(verdict) {
  if (!verdict) return "";
  return `<span class="owner-badge ${verdict}" title="${escapeHtml(t(`record.owner.${verdict}Hint`))}">${escapeHtml(t(`record.owner.${verdict}`))}</span>`;
}

function renderRecords(state) {
  $("#records-empty").hidden = state.records.length > 0;
  $(".table-wrap").hidden = state.records.length === 0;
  const owners = recordOwnership(state.records, state.plan);
  $("#record-rows").innerHTML = state.records.map((record, index) => {
    // What the row is, and what it offers, is decided in `panels.js` where a
    // test can read it; this only writes it down. The stored DNS value goes on
    // the answer cells as a title for a locked row, which is the one case where
    // the text shown is not the value held.
    const row = recordRow(record, state.records);
    const stored = row.locked ? ` title="${escapeHtml(row.stored)}"` : "";
    const button = (action, index) =>
      `<button class="row-action${action === "delete" ? " danger" : ""}" type="button" data-${action}-record="${index}">${escapeHtml(t(`record.${action}`))}</button>`;
    const actions = row.actions.length === 0
      ? ""
      : `<div class="row-actions">${row.actions.map((action) => button(action, index)).join("")}</div>`;
    return `<tr${row.locked ? ` class="provider-owned" title="${escapeHtml(t("record.providerOwnedHint"))}"` : ""}>
      <td><span class="record-identity"><b>${escapeHtml(displayName(record.name))}</b><small${row.locked ? ' class="service-type"' : ""}>${escapeHtml(row.typeLabel)}</small></span></td>
      <td data-label="${escapeHtml(t("record.internalAnswer"))}"${stored}>${answerCell(row.inside)}</td>
      <td data-label="${escapeHtml(t("record.externalAnswer"))}"${stored}>${answerCell(row.outside)}${ownershipBadge(owners.get(record.id))}</td>
      <td data-label="TTL"><span class="record-answer">${escapeHtml(formatTtl(record.views.internal.ttl))} / ${escapeHtml(formatTtl(record.views.external.ttl))}</span></td>
      <td>${actions}</td>
    </tr>`;
  }).join("");
}

function renderFocusOptions(state) {
  const focus = $("#focus-record");
  const previous = focus.value;
  focus.innerHTML = state.records.length
    ? state.records.map((record, index) => `<option value="${index}">${escapeHtml(displayName(record.name))} · ${escapeHtml(record.type)}</option>`).join("")
    : `<option value="">${escapeHtml(t("record.none"))}</option>`;
  if (previous && Number(previous) < state.records.length) focus.value = previous;
  renderLens(state);
}

function renderLens(state) {
  const record = state.records[Number($("#focus-record").value) || 0];
  const overridden = record && state.records.some((candidate) => candidate.name === record.name
    && candidate.type === record.type && candidate.views.internal.content);
  // A name its provider serves answers the same thing on both sides, and the
  // lens says so for the same reason the table does: the placeholder stored
  // inside is the one answer the resolver never gives.
  const owned = Boolean(record?.views.external.managed);
  const internal = (owned ? record?.views.external.label : record?.views.internal.content)
    || (overridden ? t("record.overridden") : record?.views.external.content)
    || t("record.noAnswerDefined");
  $("#internal-answer").textContent = record ? internal : t("record.noneYet");
  $("#external-answer").textContent = record
    ? (record.views.external.label || record.views.external.content || t("record.noAnswerDefined"))
    : t("record.noneYet");
  $("#internal-type").textContent = record?.typeLabel || record?.type || "—";
  $("#external-type").textContent = record?.typeLabel || record?.type || "—";
  $("#internal-ttl").textContent = t("ttl.label", { value: record ? formatTtl(record.views.internal.ttl) : "—" });
  $("#external-ttl").textContent = t("ttl.label", { value: record ? formatTtl(record.views.external.ttl) : "—" });
  $("#proxy-label").textContent = t(record?.views.external.proxied ? "record.proxiedLabel" : "record.dnsOnly");
}

function renderSync(state) {
  const panel = syncPanel(state);
  if (panel.kind === "empty") return renderNothingToSync();
  for (const prefix of ["internal", "external"]) {
    const view = panel.views[prefix];
    const label = $(`#${prefix}-sync`);
    label.className = `target-status ${view.state}`;
    label.textContent = t(`status.${view.state}`);
    $(`#${prefix}-sync-detail`).textContent = view.error
      ? localizeProviderError(view.error, t)
      : t("sync.appliedRevision", { revision: view.appliedRevision });
  }
  const chip = $("#sync-overall");
  chip.className = `status-chip ${panel.overall}`;
  chip.textContent = t(`status.${panel.overall}`);
  $("#revision-progress").style.width = `${panel.percent}%`;
  $("#revision-caption").textContent = panel.desired
    ? t("sync.progress", { applied: panel.applied, desired: panel.desired })
    : t("sync.noneApplied");
}

/** The panel for a zone that has nothing in it yet: idle, not behind. */
function renderNothingToSync() {
  for (const prefix of ["internal", "external"]) {
    const label = $(`#${prefix}-sync`);
    label.className = "target-status";
    label.textContent = t("sync.empty");
    $(`#${prefix}-sync-detail`).textContent = t("sync.emptyDetail");
  }
  const chip = $("#sync-overall");
  chip.className = "status-chip";
  chip.textContent = t("sync.empty");
  $("#revision-progress").style.width = "0%";
  $("#revision-caption").textContent = t("sync.emptyDetail");
}

/**
 * The counts, when the entry carries them. Without them a revision that emptied
 * a zone reads like every other line: an action, a time and an actor.
 */
function changeCounts(entry, t) {
  if (typeof entry.added !== "number") return "";
  return ` · ${escapeHtml(t("history.counts", { added: entry.added, removed: entry.removed, changed: entry.changed }))}`;
}

function renderHistory(state) {
  const entries = state.history.slice(0, HISTORY_PAGE_SIZE);
  $("#history-empty").hidden = entries.length > 0;
  $("#history-list").innerHTML = entries.map((entry) => `<li><b>${escapeHtml(localizeAuditAction(entry.action, t))}</b><time>${escapeHtml(formatDate(entry.at))}</time><small>${escapeHtml(entry.actor || t("history.system"))}${entry.revision ? ` · ${escapeHtml(t("history.revision", { revision: entry.revision }))}` : ""}${changeCounts(entry, t)}</small></li>`).join("");
}

function renderPlan(state) {
  const summary = $("#plan-summary");
  const content = $("#plan-content");
  if (state.planError) {
    summary.textContent = t("plan.failed");
    content.innerHTML = `<div class="form-error">${escapeHtml(t("plan.failedHelp", { error: state.planError }))}</div>`;
    $("#apply-from-plan").disabled = true;
    return;
  }
  if (!state.plan) {
    summary.textContent = t("plan.comparing");
    content.innerHTML = '<div class="skeleton plan-skeleton"></div><div class="skeleton plan-skeleton"></div>';
    $("#apply-from-plan").disabled = true;
    return;
  }
  const entries = Object.entries(state.plan.views ?? {});
  const operations = entries
    .flatMap(([target, plan]) => (plan?.operations ?? []).map((operation) => ({ ...operation, target })));
  // A view that could not be read produces an empty plan, which would otherwise
  // be indistinguishable from one with nothing to do -- the reading that would
  // let an operator apply believing they had seen everything.
  const unreadable = entries.filter(([, plan]) => plan?.error);
  summary.textContent = unreadable.length
    ? t(pluralKey("plan.unreadable", unreadable.length), { count: unreadable.length })
    : operations.length
      ? t(pluralKey("plan.operations", operations.length), { count: operations.length })
      : t("plan.noChanges");
  const warnings = unreadable
    .map(([target, plan]) => `<div class="plan-unreadable" role="alert">${escapeHtml(t("plan.viewUnreadable", { view: localizeViewName(target, t), error: String(plan.error) }))}</div>`)
    .join("");
  content.innerHTML = warnings + (operations.length
    ? operations.map((operation) => {
      const kind = String(operation.kind ?? "update").toLowerCase();
      const record = operation.desired ?? operation.actual ?? {};
      return `<article class="plan-operation"><span class="operation-kind ${escapeHtml(kind)}">${escapeHtml(t(`operation.${kind}`))}</span><div><b>${escapeHtml(displayName(record.name ?? t("plan.record")))} ${escapeHtml(record.type ?? "")}</b><small>${escapeHtml(localizeViewName(operation.target, t))} · ${escapeHtml(record.content ?? t("plan.reconciled"))}</small></div></article>`;
    }).join("")
    : `<div class="mini-empty">${escapeHtml(t("plan.noDrift"))}</div>`);
  // Nothing to do is not the same as nothing being there. Records the provider
  // holds that Parallax neither owns nor describes produce no operation, so an
  // empty plan reads as an empty zone unless the count is said out loud.
  const untouched = entries.reduce((total, [, plan]) => total + Number(plan?.summary?.untouched ?? 0), 0);
  if (untouched > 0) {
    content.innerHTML += `<div class="mini-empty">${escapeHtml(t(pluralKey("plan.untouched", untouched), { count: untouched }))}</div>`;
  }
  $("#apply-from-plan").disabled = operations.length === 0 && !state.dirty;
}

/**
 * What a revision actually holds, so it can be read before it is restored.
 *
 * Restoring makes this snapshot the current intent and the next apply carries it
 * out, so the question is not how old it is but whether what is written here
 * should happen now. A count alone cannot answer that.
 */
function renderRevisionSnapshot(state) {
  if (state.inspectedRevisionError) {
    return `<div class="form-error">${escapeHtml(t("revisions.inspectFailed", { error: state.inspectedRevisionError }))}</div>`;
  }
  const views = state.inspectedRevision?.views ?? [];
  const rows = views.flatMap((view) => (view.records ?? []).map((record) =>
    `<tr><td>${escapeHtml(localizeViewName(view.name, t))}</td><td>${escapeHtml(displayName(record.name))}</td>`
    + `<td>${escapeHtml(record.type)}</td><td class="revision-content">${escapeHtml(record.content)}</td>`
    + `<td>${escapeHtml(String(record.ttl))}</td></tr>`));
  if (rows.length === 0) return `<div class="mini-empty">${escapeHtml(t("revisions.snapshotEmpty"))}</div>`;
  return `<div class="revision-snapshot"><table><thead><tr>`
    + `<th>${escapeHtml(t("revisions.colView"))}</th><th>${escapeHtml(t("revisions.colName"))}</th>`
    + `<th>${escapeHtml(t("revisions.colType"))}</th><th>${escapeHtml(t("revisions.colContent"))}</th>`
    + `<th>${escapeHtml(t("revisions.colTtl"))}</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function renderRevisions(state) {
  const content = $("#revisions-content");
  if (state.revisionsError) {
    content.innerHTML = `<div class="form-error">${escapeHtml(t("revisions.loadFailed", { error: state.revisionsError }))}</div>`;
    return;
  }
  if (state.revisions.length === 0) {
    content.innerHTML = `<div class="mini-empty">${escapeHtml(t("revisions.none"))}</div>`;
    return;
  }
  content.innerHTML = [...state.revisions].reverse().map((revision) => {
    const records = (revision.views ?? []).reduce((count, view) => count + (view.records?.length ?? 0), 0);
    const current = revision.revision === state.activeZone?.revision;
    const open = state.inspectedRevision?.revision === revision.revision;
    return `<article class="revision-item"><span><b>${escapeHtml(t("revisions.item", { revision: revision.revision, currentText: current ? t("revisions.current") : "" }))}</b><small>${escapeHtml(formatDate(revision.updatedAt))} · ${escapeHtml(t(pluralKey("revisions.records", records), { count: records }))}</small></span><span class="revision-actions"><button class="button compact quiet" type="button" data-inspect-revision="${escapeHtml(revision.revision)}" aria-expanded="${open}">${escapeHtml(t(open ? "revisions.hide" : "revisions.inspect"))}</button>${current ? "" : `<button class="button compact" type="button" data-restore-revision="${escapeHtml(revision.revision)}">${escapeHtml(t("revisions.restore"))}</button>`}</span></article>${open ? renderRevisionSnapshot(state) : ""}`;
  }).join("");
}

function renderAdministration(state) {
  const access = $("#credential-access-message");
  if (state.providerAccess) {
    setLiveMessage(access, state.providerAccess.key, state.providerAccess.values ?? {});
    access.className = `credential-access-message${state.providerAccess.denied ? " denied" : ""}`;
    access.hidden = false;
  } else {
    access.hidden = true;
  }
  setEditorsEnabled(!state.providerAccess);

  $("#profile-list").innerHTML = state.profiles.length
    ? state.profiles.map((profile) => {
      const zones = profile.zones?.length
        ? `<span class="credential-zones">${profile.zones.map((zone) => `<span>${escapeHtml(zone)}</span>`).join("")}</span>`
        : `<small>${escapeHtml(t("credentials.profileUnused"))}</small>`;
      return `<article class="credential-item${profile.name === state.selectedProfile ? " selected" : ""}"><button class="credential-pick" type="button" data-profile="${escapeHtml(profile.name)}"><b>${escapeHtml(profile.name)}</b><small>${escapeHtml(profile.accountId ? t("credentials.accountIdValue", { id: profile.accountId }) : t("credentials.accountIdMissing"))}</small><small>${escapeHtml(t("credentials.updated", { date: formatDate(profile.updatedAt) }))}</small>${zones}</button></article>`;
    }).join("")
    : `<div class="mini-empty">${escapeHtml(t("credentials.profilesNone"))}</div>`;

  $("#credential-list").innerHTML = state.bindings.length
    ? state.bindings.map((binding) => `<article class="credential-item${binding.zone === state.selectedBinding ? " selected" : ""}"><button class="credential-pick" type="button" data-binding="${escapeHtml(binding.zone)}"><b>${escapeHtml(binding.zone)}</b><small>${escapeHtml(t("credentials.profileValue", { name: binding.profile }))}</small><small>${escapeHtml(t("credentials.zoneIdValue", { id: binding.zoneId }))}</small><small>${escapeHtml(t("credentials.updated", { date: formatDate(binding.updatedAt) }))}</small></button></article>`).join("")
    : `<div class="mini-empty">${escapeHtml(t("credentials.none"))}</div>`;

  const select = $("#credential-profile-select");
  const previous = select.value;
  select.innerHTML = state.profiles.length
    ? state.profiles.map((profile) => `<option value="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</option>`).join("")
    : `<option value="">${escapeHtml(t("credentials.profilesNone"))}</option>`;
  if (previous && state.profiles.some((profile) => profile.name === previous)) select.value = previous;

  $("#credential-zone-options").innerHTML = state.zones
    .map((zone) => `<option value="${escapeHtml(zone.name)}"></option>`).join("");

  $("#token-list").innerHTML = state.tokens.length
    ? state.tokens.map((token) => {
      const action = token.managed
        ? `<small>${escapeHtml(t("tokens.environment"))}</small>`
        : `<button class="button compact" type="button" data-revoke-token="${escapeHtml(token.id)}">${escapeHtml(t("tokens.revoke"))}</button>`;
      const role = `tokens.role${token.role.charAt(0).toUpperCase()}${token.role.slice(1)}`;
      return `<article class="credential-item"><b>${escapeHtml(token.subject)}</b><small><span class="token-role">${escapeHtml(t(role))}</span></small><small>${escapeHtml(t("credentials.updated", { date: formatDate(token.createdAt) }))}</small>${action}</article>`;
    }).join("")
    : `<div class="mini-empty">${escapeHtml(t("tokens.none"))}</div>`;

  $("#issued-token").hidden = !state.issuedToken;
  $("#issued-token-value").textContent = state.issuedToken;

}

function setEditorsEnabled(enabled) {
  for (const name of ["name", "accountId", "token", "probeZone"]) $("#profile-form").elements[name].disabled = !enabled;
  for (const name of ["zone", "profile"]) $("#credential-form").elements[name].disabled = !enabled;
  for (const id of ["#delete-profile-button", "#test-profile-button", "#save-profile-button",
    "#delete-credential-button", "#test-credential-button", "#save-credential-button"]) $(id).disabled = !enabled;
}

/** Settings and selection populate inputs, so they run on load, not on redraw. */
function fillSettingsForm(state) {
  if (!state.settings) return;
  const form = $("#settings-form");
  form.elements.allowLocalProvider.checked = Boolean(state.settings.allowLocalProvider);
  form.elements.trustForwardedHeaders.checked = Boolean(state.settings.trustForwardedHeaders);
  form.elements.publicOrigin.value = state.settings.publicOrigin ?? "";
  form.elements.revisionRetention.value = String(state.settings.revisionRetention ?? 0);
  form.elements.auditRetentionDays.value = String(state.settings.auditRetentionDays ?? 0);
}

// ---- record dialog --------------------------------------------------------

function openRecordDialog(index = null) {
  const form = $("#record-form");
  form.reset();
  form.elements.internalTtl.value = "300";
  form.elements.externalTtl.value = "300";
  $("#record-form-error").hidden = true;
  if (index === null) {
    delete form.dataset.index;
  } else {
    const record = store.getState().records[index];
    form.dataset.index = String(index);
    form.elements.name.value = record.name;
    form.elements.type.value = record.type;
    form.elements.internalContent.value = record.views.internal.content;
    form.elements.externalContent.value = record.views.external.content;
    form.elements.proxied.checked = record.views.external.proxied;
    form.elements.acknowledgeNonGlobalIp.checked = record.views.external.acknowledgeNonGlobalIp;
    form.elements.internalTtl.value = record.views.internal.ttl;
    form.elements.externalTtl.value = record.views.external.ttl;
  }
  renderRecordDialogHeading();
  syncProxyAvailability();
  syncExternalTtl();
  syncAddressSafetyWarning();
  $("#record-dialog").showModal();
  queueMicrotask(() => form.elements.name.focus());
}

function renderRecordDialogHeading() {
  const form = $("#record-form");
  const index = form.dataset.index === undefined ? null : Number(form.dataset.index);
  $("#record-dialog-title").textContent = t(index === null ? "record.add" : "record.editDesired");
  $("#record-dialog-mode").textContent = index === null
    ? t("record.desired")
    : displayName(store.getState().records[index]?.name || form.elements.name.value);
}

function syncProxyAvailability() {
  const form = $("#record-form");
  const supported = ["A", "AAAA", "CNAME"].includes(form.elements.type.value);
  form.elements.proxied.disabled = !supported;
  if (!supported) form.elements.proxied.checked = false;
}

function syncExternalTtl() {
  const form = $("#record-form");
  const ttl = form.elements.externalTtl;
  if (form.elements.proxied.checked && !form.elements.proxied.disabled) {
    ttl.value = "1";
    ttl.disabled = true;
    ttl.setCustomValidity("");
    $("#external-ttl-help").textContent = t("recordDialog.proxiedTtlHelp");
    return;
  }
  ttl.disabled = false;
  updateLocalizedValidity(ttl);
  $("#external-ttl-help").textContent = t("recordDialog.ttlHelp");
}

function updateLocalizedValidity(field) {
  field.setCustomValidity("");
  if (field.disabled) return;
  const label = t(field.dataset.validationLabel);
  let message = localizedValidationMessage({ validity: field.validity, label, min: field.min, max: field.max, step: field.step }, t);
  if (!message && field.name === "externalTtl" && !isValidDnsOnlyTtl(field.value)) message = t("recordDialog.ttlInvalid");
  field.setCustomValidity(message);
}

function syncAddressSafetyWarning() {
  const form = $("#record-form");
  const address = form.elements.externalContent.value.trim();
  const show = ["A", "AAAA"].includes(form.elements.type.value) && address !== "" && isNonGlobalAddress(address);
  $("#non-global-warning").hidden = !show;
  form.elements.acknowledgeNonGlobalIp.required = show;
  if (!show) form.elements.acknowledgeNonGlobalIp.checked = false;
  updateLocalizedValidity(form.elements.acknowledgeNonGlobalIp);
}

/** Reads the dialog into the row shape the store keeps. */
function readRecordForm(form) {
  const data = new FormData(form);
  const index = form.dataset.index === undefined ? null : Number(form.dataset.index);
  const name = String(data.get("name")).trim();
  const type = String(data.get("type"));
  const proxied = data.get("proxied") === "on";
  const externalTtl = effectiveExternalTtl(form.elements.externalTtl.value, proxied);
  const id = index === null
    ? store.proposeRecordId(name, type)
    : store.getState().records[index].id;
  return {
    index,
    record: {
      id,
      name,
      type,
      views: {
        internal: { id, content: String(data.get("internalContent")).trim(), ttl: Number(data.get("internalTtl")) },
        external: {
          id,
          content: String(data.get("externalContent")).trim(),
          ttl: externalTtl,
          proxied,
          acknowledgeNonGlobalIp: data.get("acknowledgeNonGlobalIp") === "on",
        },
      },
    },
  };
}

// ---- dialogs --------------------------------------------------------------

/**
 * Administration surfaces are admin-only in the API, so a caller who is not one
 * is not offered them. Hidden rather than disabled: a disabled control still
 * says "this exists for you", and it does not.
 */
function syncRoleVisibility(state) {
  $("#credential-settings-button").hidden = state.authRequired && state.role !== "admin";
}

function openAuthDialog() {
  const dialog = $("#auth-dialog");
  const identity = $("#auth-identity");
  identity.hidden = !store.getState().identityProvider;
  if (!identity.hidden) {
    // Come back to the page that was being asked for, not to the root.
    const next = `${location.pathname}${location.search}${location.hash}`;
    $("#auth-identity-link").href = `/auth/login?next=${encodeURIComponent(next)}`;
  }
  if (!dialog.open) dialog.showModal();
  queueMicrotask(() => $("#auth-form").elements.token.focus());
}

/**
 * A sign-in that failed comes back as a redirect with the reason in the query,
 * because there is no page to show it on until the browser has landed here.
 */
function reportSignInError() {
  const reason = new URLSearchParams(location.search).get("signin_error");
  if (!reason) return;
  store.reportSignInFailure(reason);
  const clean = new URL(location.href);
  clean.searchParams.delete("signin_error");
  history.replaceState(null, "", clean);
}

function selectProviderPanel(panel) {
  for (const tab of $$(".provider-tab")) tab.setAttribute("aria-selected", String(tab.dataset.panel === panel));
  for (const name of ["profiles", "bindings", "settings", "fallback", "tokens"]) $(`#panel-${name}`).hidden = panel !== name;
  // Read on opening rather than with the rest of the administration state: it
  // costs two provider calls, and most visits to this dialog are not about it.
  if (panel === "fallback") void loadFallbackPanel();
}

/** Loads the report for whichever profile the picker is on, or the first one. */
function loadFallbackPanel() {
  const state = store.getState();
  const chosen = $("#fallback-profile").value || state.fallbackProfile || state.profiles[0]?.name || "";
  if (!chosen) {
    renderFallback(state);
    return Promise.resolve(false);
  }
  return store.loadFallback(chosen);
}

function renderFallback(state) {
  const picker = $("#fallback-profile");
  const previous = picker.value;
  picker.innerHTML = state.profiles.length
    ? state.profiles.map((profile) => `<option value="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</option>`).join("")
    : `<option value="">${escapeHtml(t("credentials.profilesNone"))}</option>`;
  const wanted = state.fallbackProfile || previous;
  if (wanted && state.profiles.some((profile) => profile.name === wanted)) picker.value = wanted;

  const panel = fallbackPanel(state);
  $("#fallback-sync-button").disabled = !panel.syncable;
  if (state.profiles.length === 0) {
    $("#fallback-report").innerHTML = `<div class="mini-empty">${escapeHtml(t("credentials.profilesNone"))}</div>`;
    return;
  }

  const list = (items) => items.map((item) => `<code>${escapeHtml(item)}</code>`).join(" ");
  const section = (label, body) => `<div class="fallback-section"><span class="eyebrow">${escapeHtml(label)}</span>${body}</div>`;
  const covered = panel.covered.length
    ? section(t("fallback.covered"), `<div class="fallback-suffixes">${list(panel.covered)}</div>`)
    : section(t("fallback.covered"), `<div class="mini-empty">${escapeHtml(t("fallback.coveredNone"))}</div>`);
  // The half that answers the question this panel exists for: a zone missing
  // from the overrides looks the same for four different reasons, and each one
  // is repaired differently.
  const excluded = panel.excluded.length === 0
    ? ""
    : section(t("fallback.excluded"), `<ul class="fallback-reasons">${panel.excluded.map((row) =>
      `<li><code>${escapeHtml(row.zone)}</code> <span>${escapeHtml(t(`fallback.reason.${row.reason}`, { profile: row.profile ?? "" }))}</span>${
        row.detail ? `<small>${escapeHtml(row.detail)}</small>` : ""}</li>`).join("")}</ul>`);

  const planBody = panel.planError
    ? `<div class="mini-empty">${escapeHtml(t("fallback.planFailed", { error: panel.planError }))}</div>`
    : panel.inStep
      ? `<div class="mini-empty">${escapeHtml(t("fallback.inStep"))}</div>`
      : `<ul class="fallback-reasons">${[
        ["add", panel.plan?.add ?? []], ["update", panel.plan?.update ?? []],
        ["adopt", panel.plan?.adopt ?? []], ["remove", panel.plan?.remove ?? []],
      ].filter(([, items]) => items.length > 0)
        .map(([kind, items]) => `<li><span>${escapeHtml(t(`fallback.plan.${kind}`))}</span> ${list(items)}</li>`)
        .join("")}${(panel.plan?.conflict ?? []).map((entry) =>
          `<li class="fallback-conflict"><code>${escapeHtml(entry.suffix)}</code> <span>${escapeHtml(t("fallback.plan.conflict"))}</span><small>${escapeHtml(entry.reason)}</small></li>`).join("")}</ul>`;

  const resolver = panel.resolverMissing
    ? `<div class="mini-empty">${escapeHtml(t("fallback.resolverMissing"))}</div>`
    : `<div class="fallback-suffixes"><code>${escapeHtml(panel.resolver)}</code></div>`;

  $("#fallback-report").innerHTML = section(t("fallback.resolver"), resolver) + covered + excluded
    + section(t("fallback.plan.title"), planBody)
    + section(t("fallback.live"), panel.entries.length
      ? `<div class="fallback-suffixes">${panel.entries.map((entry) =>
        `<code>${escapeHtml(entry.suffix)}${entry.dnsServer.length ? ` → ${escapeHtml(entry.dnsServer.join(", "))}` : ""}</code>`).join(" ")}</div>`
      : `<div class="mini-empty">${escapeHtml(t("fallback.liveNone"))}</div>`);
}

async function openProviderSettings() {
  $("#profile-form").reset();
  $("#credential-form").reset();
  selectProviderPanel("profiles");
  setEditorsEnabled(false);
  $("#profile-list").innerHTML = '<div class="skeleton plan-skeleton"></div>';
  $("#credential-list").innerHTML = '<div class="skeleton plan-skeleton"></div>';
  $("#credential-dialog").showModal();
  await store.loadAdministration();
  fillSettingsForm(store.getState());
}

// ---- wiring ---------------------------------------------------------------

store.subscribe(render);
store.onNotice(toast);
store.onIntent((event) => {
  if (event.type === "auth-required") openAuthDialog();
});

$("#locale-select").addEventListener("change", (event) => setLocale(event.currentTarget.value));
$("#zone-search").addEventListener("input", () => renderZoneList(store.getState()));
$("#zone-list").addEventListener("click", (event) => {
  if (event.target.closest('[data-action="retry-zones"]')) return void store.loadZones();
  const button = event.target.closest("[data-zone]");
  if (button) void selectZoneGuarded(button.dataset.zone);
});

async function selectZoneGuarded(name) {
  const state = store.getState();
  if (state.dirty && name !== zoneLabel(state) && !confirm(t("zone.discardChanges"))) return;
  await store.selectZone(name);
}

$("#add-zone-button").addEventListener("click", () => {
  $("#zone-form-error").hidden = true;
  $("#zone-dialog").showModal();
  queueMicrotask(() => $("#zone-form").elements.name.focus());
});
$("#zone-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) return form.reportValidity();
  const button = $("#create-zone-submit");
  button.disabled = true;
  button.textContent = t("zone.creating");
  const name = String(new FormData(form).get("name")).trim().toLowerCase().replace(/\.$/u, "");
  if (await store.createZone(name)) {
    $("#zone-dialog").close();
    form.reset();
  }
  button.disabled = false;
  button.textContent = t("zones.create");
});

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const token = String(new FormData(form).get("token") || "").trim();
  if (!token) return;
  if (await store.signIn(token)) {
    $("#auth-dialog").close();
    form.reset();
  }
});
$("#sign-out-button").addEventListener("click", () => void store.signOut());

$("#refresh-button").addEventListener("click", () => void store.selectZone(zoneLabel(store.getState())));
$("#delete-zone-button").addEventListener("click", () => {
  const name = zoneLabel(store.getState());
  if (name && confirm(t("zone.deleteConfirm", { name }))) void store.deleteActiveZone();
});

$("#add-record-button").addEventListener("click", () => openRecordDialog());
$("#record-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) return form.reportValidity();
  const { index, record } = readRecordForm(form);
  if (store.stageRecord(record, index)) $("#record-dialog").close();
});
$("#record-form [name=type]").addEventListener("change", () => {
  syncProxyAvailability();
  syncExternalTtl();
  syncAddressSafetyWarning();
});
$("#record-form [name=proxied]").addEventListener("change", syncExternalTtl);
$("#record-form [name=externalTtl]").addEventListener("input", syncExternalTtl);
$("#record-form [name=externalContent]").addEventListener("input", syncAddressSafetyWarning);
for (const field of $$("[data-validation-label]")) {
  for (const type of ["invalid", "input", "change"]) {
    field.addEventListener(type, () => updateLocalizedValidity(field));
  }
}
$("#record-rows").addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit-record]");
  if (edit) return openRecordDialog(Number(edit.dataset.editRecord));
  const remove = event.target.closest("[data-delete-record]");
  if (!remove) return;
  const index = Number(remove.dataset.deleteRecord);
  const record = store.getState().records[index];
  if (confirm(t("record.removeConfirm", { name: displayName(record.name), type: record.type }))) {
    store.removeRecord(index);
  }
});
$("#focus-record").addEventListener("change", () => renderLens(store.getState()));

for (const id of ["#preview-button", "#apply-button"]) {
  $(id).addEventListener("click", async () => {
    $("#plan-dialog").showModal();
    await store.preview();
  });
}
$("#apply-from-plan").addEventListener("click", async () => {
  if (await store.apply()) $("#plan-dialog").close();
});
for (const id of ["#close-plan", "#cancel-plan"]) $(id).addEventListener("click", () => $("#plan-dialog").close());

$("#adopt-button").addEventListener("click", async () => {
  // Adoption writes a revision, so it asks first -- and says what it will not
  // do, because "adopt" reads like taking ownership and it is the opposite.
  if (!globalThis.confirm(t("zone.adoptConfirm"))) return;
  await store.adopt();
});

$("#revisions-button").addEventListener("click", async () => {
  $("#revisions-dialog").showModal();
  $("#revisions-content").innerHTML = '<div class="skeleton plan-skeleton"></div><div class="skeleton plan-skeleton"></div>';
  await store.loadRevisions();
});
$("#close-revisions").addEventListener("click", () => $("#revisions-dialog").close());
$("#revisions-content").addEventListener("click", async (event) => {
  const clicked = event.target instanceof Element ? event.target : null;
  const inspect = clicked?.closest("[data-inspect-revision]");
  if (inspect) {
    await store.inspectRevision(Number(inspect.dataset.inspectRevision));
    return;
  }
  const button = event.target.closest("[data-restore-revision]");
  if (!button) return;
  const revision = button.dataset.restoreRevision;
  if (!confirm(t("revisions.restoreConfirm", { revision }))) return;
  if (await store.restoreRevision(revision)) $("#revisions-dialog").close();
});

$("#credential-settings-button").addEventListener("click", () => void openProviderSettings());
for (const tab of $$(".provider-tab")) {
  tab.addEventListener("click", () => selectProviderPanel(tab.dataset.panel));
}
$("#fallback-profile").addEventListener("change", () => void loadFallbackPanel());
$("#fallback-refresh-button").addEventListener("click", () => void loadFallbackPanel());
$("#fallback-sync-button").addEventListener("click", () => {
  // Written to a setting the whole organization shares, so it is confirmed
  // like the other writes that reach beyond this control plane.
  const profile = $("#fallback-profile").value;
  if (!profile || !globalThis.confirm(t("fallback.syncConfirm", { profile }))) return;
  void store.syncFallback(profile);
});
$("#profile-list").addEventListener("click", (event) => {
  const pick = event.target.closest("[data-profile]");
  if (!pick) return;
  const profile = store.getState().profiles.find((candidate) => candidate.name === pick.dataset.profile);
  if (!profile) return;
  store.selectProfile(profile.name);
  const form = $("#profile-form");
  form.elements.name.value = profile.name;
  form.elements.accountId.value = profile.accountId ?? "";
  form.elements.token.value = "";
  render(store.getState());
});
$("#credential-list").addEventListener("click", (event) => {
  const pick = event.target.closest("[data-binding]");
  if (!pick) return;
  const binding = store.getState().bindings.find((candidate) => candidate.zone === pick.dataset.binding);
  if (!binding) return;
  store.selectBinding(binding.zone);
  const form = $("#credential-form");
  form.elements.zone.value = binding.zone;
  form.elements.profile.value = binding.profile;
  render(store.getState());
});

$("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) return form.reportValidity();
  const saved = await store.saveProfile(String(form.elements.name.value).trim().toLowerCase(), {
    token: String(form.elements.token.value),
    accountId: String(form.elements.accountId.value).trim(),
  });
  if (saved) form.elements.token.value = "";
});
$("#test-profile-button").addEventListener("click", () => {
  const form = $("#profile-form");
  void store.testProfile(String(form.elements.name.value).trim().toLowerCase(), {
    zone: String(form.elements.probeZone.value).trim(),
    token: String(form.elements.token.value),
  });
});
$("#delete-profile-button").addEventListener("click", async () => {
  const form = $("#profile-form");
  const name = String(form.elements.name.value).trim().toLowerCase();
  if (!name || !confirm(t("credentials.profileDeleteConfirm", { name }))) return;
  if (await store.deleteProfile(name)) form.reset();
});

$("#credential-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) return form.reportValidity();
  await store.saveBinding(String(form.elements.zone.value).trim().toLowerCase().replace(/\.$/u, ""), {
    profile: String(form.elements.profile.value),
  });
});
$("#test-credential-button").addEventListener("click", () => {
  const form = $("#credential-form");
  // The selected profile is sent so a domain can be checked before it is bound.
  void store.testBinding(
    String(form.elements.zone.value).trim().toLowerCase().replace(/\.$/u, ""),
    { profile: String(form.elements.profile.value) },
  );
});
$("#delete-credential-button").addEventListener("click", async () => {
  const form = $("#credential-form");
  const zone = String(form.elements.zone.value).trim().toLowerCase().replace(/\.$/u, "");
  if (!zone || !confirm(t("credentials.deleteConfirm", { zone }))) return;
  if (await store.deleteBinding(zone)) form.reset();
});

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) return form.reportValidity();
  $("#save-settings-button").disabled = true;
  await store.saveSettings({
    allowLocalProvider: form.elements.allowLocalProvider.checked,
    trustForwardedHeaders: form.elements.trustForwardedHeaders.checked,
    publicOrigin: String(form.elements.publicOrigin.value).trim(),
    revisionRetention: Number(form.elements.revisionRetention.value),
    auditRetentionDays: Number(form.elements.auditRetentionDays.value),
  });
  fillSettingsForm(store.getState());
  $("#save-settings-button").disabled = false;
});

$("#token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) return form.reportValidity();
  $("#issue-token-button").disabled = true;
  if (await store.issueToken({ subject: String(form.elements.subject.value).trim(), role: form.elements.role.value })) {
    form.elements.subject.value = "";
  }
  $("#issue-token-button").disabled = false;
});
$("#token-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-revoke-token]");
  if (!button) return;
  const token = store.getState().tokens.find((candidate) => candidate.id === button.dataset.revokeToken);
  if (token && confirm(t("tokens.revokeConfirm", { subject: token.subject }))) {
    void store.revokeToken(token.id);
  }
});

document.addEventListener("click", (event) => {
  // A click can land on a text node's parent or on the document itself, so the
  // target is only an element some of the time.
  const clicked = event.target instanceof Element ? event.target : null;
  const closeButton = clicked?.closest("[data-close-dialog]");
  if (closeButton) closeButton.closest("dialog")?.close();
  if (clicked?.closest('[data-action="open-create"]')) $("#add-zone-button").click();
  if (clicked?.closest('[data-action="add-record"]')) openRecordDialog();
});

window.addEventListener("beforeunload", (event) => {
  if (store.getState().dirty) event.preventDefault();
});

setLocale(locale);
reportSignInError();
void store.readAuthenticationMode();
void store.loadZones();
