import { effectiveExternalTtl, isValidDnsOnlyTtl } from "./ttl.js";
import { createSemanticMessage, createTranslator, escapeHtml, localizeAuditAction, localizedValidationMessage, localizeProviderError, localizeViewName, pluralKey, readPersistedLocale, renderSemanticMessage, resolveLocale, translateDocument, writePersistedLocale } from "./i18n.js";

const API_ROOT = "/api/v1";
// The server orders history newest first and bounds every page, so the portal
// asks for exactly what it renders.
const HISTORY_PAGE_SIZE = 5;
const REVISION_PAGE_SIZE = 50;

const state = {
  zones: [],
  activeZone: null,
  records: [],
  dirty: false,
  previewRevision: null,
  loadingZone: false,
  authenticated: false,
  locale: resolveLocale({
    persistedLocale: readStoredLocale(),
    browserLocales: globalThis.navigator?.languages || [globalThis.navigator?.language],
  }),
  statusPayload: null,
  historyPayload: [],
  planPayload: null,
  planError: "",
  credentials: [],
  revisions: [],
  zonesLoadError: "",
  revisionsLoadError: "",
};

let t = createTranslator(state.locale);
const liveMessages = new Map();

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function readStoredLocale() {
  try { return readPersistedLocale(globalThis.localStorage); } catch { return null; }
}

function setLocale(locale) {
  state.locale = resolveLocale({ persistedLocale: locale });
  t = createTranslator(state.locale);
  try { writePersistedLocale(globalThis.localStorage, state.locale); } catch {}
  document.documentElement.lang = state.locale;
  document.title = t("meta.title");
  const description = $('meta[name="description"]');
  if (description) description.content = t("meta.description");
  $("#locale-select").value = state.locale;
  translateDocument(document, t);
  for (const [element, message] of liveMessages) {
    if (!element.isConnected) liveMessages.delete(element);
    else element.textContent = renderSemanticMessage(message, t);
  }
  for (const field of $$('[data-validation-label]')) updateLocalizedValidity(field);
  renderLocalizedState();
}

function renderLocalizedState() {
  if (state.zonesLoadError) renderZoneListError(state.zonesLoadError);
  else renderZoneList();
  setGlobalStatus($(".pulse").classList.contains("error") ? "error" : $(".pulse").classList.contains("online") ? "online" : "connecting");
  if (state.activeZone) renderActiveZone(state.statusPayload, state.historyPayload);
  else showWelcome(true);
  if ($("#plan-dialog").open) {
    if (state.planPayload) renderPlan(state.planPayload);
    else if (state.planError) renderPlanError(state.planError);
  }
  if ($("#revisions-dialog").open) {
    if (state.revisionsLoadError) renderRevisionListError(state.revisionsLoadError);
    else renderRevisionList(state.revisions);
  }
  if ($("#credential-dialog").open) renderCredentialList(state.credentials);
  if ($("#record-dialog").open) renderRecordDialogHeading();
  syncExternalTtl();
}

async function api(path, options = {}) {
  // The session cookie is HttpOnly, so it is attached by the browser and never
  // read by this script. `same-origin` keeps it off any cross-site request.
  const response = await fetch(`${API_ROOT}${path}`, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    },
    ...options,
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      detail = body.message || body.error || detail;
    } catch {}
    if (response.status === 401) {
      state.authenticated = false;
      syncSessionControls();
      openAuthDialog();
    }
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function normalizeZones(payload) {
  const values = Array.isArray(payload) ? payload : payload?.zones || payload?.items || [];
  return values.map((zone) => typeof zone === "string" ? { name: zone } : zone);
}

function normalizeRecords(zone) {
  if (Array.isArray(zone?.records)) return zone.records.map(normalizeRecord);
  const viewList = Array.isArray(zone?.views) ? zone.views : [];
  const internal = (viewList.find((view) => view.name === "internal") || zone?.views?.internal)?.records || [];
  const external = (viewList.find((view) => view.name === "external") || zone?.views?.external)?.records || [];
  const rowKey = (record) => `${record.id}\u0000${record.name}\u0000${record.type}`;
  const internalById = new Map(internal.map((record) => [rowKey(record), record]));
  const records = external.map((record) => {
    const key = rowKey(record);
    const matchingInternal = internalById.get(key);
    if (matchingInternal) internalById.delete(key);
    return normalizeRecord({ ...record, views: { external: record, ...(matchingInternal ? { internal: matchingInternal } : {}) } });
  });
  for (const record of internalById.values()) {
    records.push(normalizeRecord({ ...record, content: undefined, views: { internal: record } }));
  }
  return records.sort((left, right) => left.name.localeCompare(right.name) || left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
}

function normalizeRecord(record) {
  const internal = record.views?.internal || (record.internal ? { content: record.internal } : {});
  const external = record.views?.external || (record.external ? { content: record.external } : {});
  return {
    id: record.id || createRecordId(record.name, record.type),
    name: record.name || "@",
    type: record.type || "A",
    ttl: effectiveExternalTtl(external.ttl ?? record.ttl ?? internal.ttl ?? 300, Boolean(external.proxied ?? record.proxied)),
    views: {
      internal: { id: internal.id || record.id || createRecordId(record.name, record.type), content: internal.content ?? record.internalContent ?? "", ttl: internal.ttl ?? record.internalTtl ?? record.ttl ?? 300 },
      external: { id: external.id || record.id || createRecordId(record.name, record.type), content: external.content ?? record.content ?? record.externalContent ?? "", ttl: effectiveExternalTtl(external.ttl ?? record.externalTtl ?? record.ttl ?? 300, Boolean(external.proxied ?? record.proxied)), proxied: Boolean(external.proxied ?? record.proxied), acknowledgeNonGlobalIp: Boolean(external.acknowledgeNonGlobalIp ?? record.acknowledgeNonGlobalIp) },
    },
  };
}

function zoneName(zone) { return zone?.name || zone?.domain || zone?.id || ""; }
function encodeZone(zone) { return encodeURIComponent(zoneName(zone)); }
function statusOf(zone) {
  const value = zone?.status?.overall || zone?.status || zone?.syncStatus || "unknown";
  return typeof value === "string" ? value.toLowerCase() : "unknown";
}

function activeRevisionHeaders() {
  const revision = state.activeZone?.desiredRevision ?? state.activeZone?.revision;
  return revision ? { "If-Match": `"${revision}"` } : {};
}

async function loadZones({ preserveSelection = false } = {}) {
  setGlobalStatus("connecting");
  try {
    const payload = await api("/zones");
    state.zones = normalizeZones(payload);
    state.zonesLoadError = "";
    state.authenticated = true;
    syncSessionControls();
    renderZoneList();
    setGlobalStatus("online");
    if (!preserveSelection && state.zones.length) await selectZone(state.zones[0]);
    else if (!state.zones.length) showWelcome(true);
  } catch (error) {
    state.zonesLoadError = error.message;
    setGlobalStatus("error");
    renderZoneListError(error.message);
    showWelcome(true);
  }
}

function setGlobalStatus(mode) {
  const label = $("#global-status");
  const pulse = $(".pulse");
  pulse.className = `pulse ${mode === "connecting" ? "" : mode}`;
  label.textContent = t(mode === "online" ? "status.online" : mode === "error" ? "status.unavailable" : "status.connecting");
}

function renderZoneList() {
  const query = $("#zone-search").value.trim().toLowerCase();
  const zones = state.zones.filter((zone) => zoneName(zone).toLowerCase().includes(query));
  $("#zone-count").textContent = String(state.zones.length).padStart(2, "0");
  if (!zones.length) {
    $("#zone-list").innerHTML = `<div class="mini-empty">${escapeHtml(t(state.zones.length ? "zones.noMatch" : "zones.none"))}</div>`;
    return;
  }
  $("#zone-list").innerHTML = zones.map((zone) => {
    const name = zoneName(zone);
    const active = zoneName(state.activeZone) === name;
    const status = statusOf(zone);
    const revision = zone.desiredRevision ?? zone.revision ?? "—";
    return `<button class="zone-item${active ? " active" : ""}" type="button" data-zone="${escapeHtml(name)}" aria-current="${active ? "page" : "false"}">
      <span class="dot ${escapeHtml(status)}" aria-hidden="true"></span>
      <span><b>${escapeHtml(name)}</b><small>${escapeHtml(status === "unknown" ? t("zones.notObserved") : t(`status.${status}`))}</small></span>
      <span class="zone-rev">r${escapeHtml(revision)}</span>
    </button>`;
  }).join("");
}

function renderZoneListError(error) {
  $("#zone-count").textContent = "—";
  $("#zone-list").innerHTML = `<div class="mini-empty">${escapeHtml(t("zones.loadFailed"))}<br>${escapeHtml(error)}<br><button class="button compact" type="button" data-action="retry-zones">${escapeHtml(t("zones.retry"))}</button></div>`;
}

async function selectZone(zone) {
  if (state.dirty && zoneName(zone) !== zoneName(state.activeZone) && !confirm(t("zone.discardChanges"))) return;
  state.activeZone = zone;
  state.dirty = false;
  state.previewRevision = null;
  state.planPayload = null;
  state.planError = "";
  renderZoneList();
  showWelcome(false);
  setZoneLoading(true);
  const name = zoneName(zone);
  try {
    const [detail, status, history] = await Promise.all([
      api(`/zones/${encodeURIComponent(name)}`),
      api(`/zones/${encodeURIComponent(name)}/status`).catch(() => null),
      api(`/zones/${encodeURIComponent(name)}/history?limit=${HISTORY_PAGE_SIZE}`).catch(() => []),
    ]);
    if (zoneName(state.activeZone) !== name) return;
    state.activeZone = { ...zone, ...detail };
    state.records = normalizeRecords(detail);
    state.statusPayload = status;
    state.historyPayload = history;
    renderActiveZone(status, history);
  } catch (error) {
    if (zoneName(state.activeZone) !== name) return;
    toast("zone.detailsFailed", { error: error.message }, "error");
    state.records = [];
    renderActiveZone(null, []);
  } finally {
    setZoneLoading(false);
  }
}

function showWelcome(show) {
  $("#welcome-state").hidden = !show;
  $("#zone-workspace").hidden = show;
}

function setZoneLoading(loading) {
  state.loadingZone = loading;
  $("#refresh-button").disabled = loading;
  $("#preview-button").disabled = loading;
  $("#apply-button").disabled = loading;
  if (loading) {
    $("#zone-name").textContent = zoneName(state.activeZone) || t("zone.loading");
    $("#record-rows").innerHTML = `<tr><td colspan="5"><div class="skeleton" style="height:48px"></div></td></tr>`;
  }
}

function renderActiveZone(statusPayload, historyPayload) {
  const zone = state.activeZone;
  const name = zoneName(zone);
  const revision = zone.desiredRevision ?? zone.revision ?? 0;
  $("#zone-name").textContent = name;
  $("#zone-id-label").textContent = zone.id ? `/ ${zone.id}` : "";
  $("#revision-label").textContent = t("zone.desiredRevision", { revision });
  $("#updated-label").textContent = t("zone.lastChanged", { date: formatDate(zone.updatedAt || zone.updated_at) });
  renderRecords();
  renderFocusOptions();
  renderSync(statusPayload || zone.status || {});
  renderHistory(historyPayload);
}

function renderRecords() {
  const body = $("#record-rows");
  $("#records-empty").hidden = state.records.length > 0;
  $(".table-wrap").hidden = state.records.length === 0;
  body.innerHTML = state.records.map((record, index) => {
    const hasInternalOverride = state.records.some((candidate) => candidate.name === record.name
      && candidate.type === record.type && candidate.views.internal.content);
    const internal = record.views.internal.content || (hasInternalOverride ? "" : record.views.external.content);
    const external = record.views.external.content;
    return `<tr>
      <td><span class="record-identity"><b>${escapeHtml(displayName(record.name))}</b><small>${escapeHtml(record.type)}</small></span></td>
      <td data-label="${escapeHtml(t("record.internalAnswer"))}"><div class="record-answer ${record.views.internal.content ? "" : "inherited"}">${escapeHtml(internal || t(hasInternalOverride ? "record.overridden" : "record.noAnswer"))}</div></td>
      <td data-label="${escapeHtml(t("record.externalAnswer"))}"><div class="record-answer">${escapeHtml(external || t("record.noAnswer"))}${record.views.external.proxied ? `<span class="proxy-badge">${escapeHtml(t("record.proxied"))}</span>` : ""}</div></td>
      <td data-label="TTL"><span class="record-answer">${escapeHtml(formatLocalizedTtl(record.views.internal.ttl))} / ${escapeHtml(formatLocalizedTtl(record.views.external.ttl))}</span></td>
      <td><div class="row-actions"><button class="row-action" type="button" data-edit-record="${index}">${escapeHtml(t("record.edit"))}</button><button class="row-action danger" type="button" data-delete-record="${index}">${escapeHtml(t("record.delete"))}</button></div></td>
    </tr>`;
  }).join("");
}

function renderFocusOptions() {
  const focus = $("#focus-record");
  const previous = focus.value;
  focus.innerHTML = state.records.length ? state.records.map((record, index) => `<option value="${index}">${escapeHtml(displayName(record.name))} · ${escapeHtml(record.type)}</option>`).join("") : `<option value="">${escapeHtml(t("record.none"))}</option>`;
  if (previous && Number(previous) < state.records.length) focus.value = previous;
  renderLens();
}

function renderLens() {
  const record = state.records[Number($("#focus-record").value) || 0];
  const empty = !record;
  const hasInternalOverride = record && state.records.some((candidate) => candidate.name === record.name
    && candidate.type === record.type && candidate.views.internal.content);
  const internal = record?.views.internal.content || (hasInternalOverride ? t("record.overridden") : record?.views.external.content) || t("record.noAnswerDefined");
  const external = record?.views.external.content || t("record.noAnswerDefined");
  $("#internal-answer").textContent = empty ? t("record.noneYet") : internal;
  $("#external-answer").textContent = empty ? t("record.noneYet") : external;
  $("#internal-type").textContent = record?.type || "—";
  $("#external-type").textContent = record?.type || "—";
  $("#internal-ttl").textContent = t("ttl.label", { value: record ? formatLocalizedTtl(record.views.internal.ttl) : "—" });
  $("#external-ttl").textContent = t("ttl.label", { value: record ? formatLocalizedTtl(record.views.external.ttl) : "—" });
  $("#proxy-label").textContent = t(record?.views.external.proxied ? "record.proxiedLabel" : "record.dnsOnly");
}

function renderSync(payload) {
  const desired = payload.desiredRevision ?? state.activeZone.desiredRevision ?? state.activeZone.revision ?? 0;
  const rawStatuses = Array.isArray(payload.statuses) ? payload.statuses : [];
  const internal = normalizeTargetStatus(rawStatuses.find((status) => status.view === "internal") || payload.internal || payload.status?.internal, desired);
  const external = normalizeTargetStatus(rawStatuses.find((status) => status.view === "external") || payload.external || payload.cloudflare || payload.status?.cloudflare || payload.status?.external, desired);
  setTargetStatus("internal", internal);
  setTargetStatus("external", external);
  const statuses = [internal.status, external.status];
  const overall = statuses.includes("failed") ? "failed" : statuses.every((value) => value === "applied") ? "applied" : "pending";
  const chip = $("#sync-overall");
  chip.className = `status-chip ${overall}`;
  chip.textContent = t(`status.${overall}`);
  const applied = Math.min(internal.appliedRevision, external.appliedRevision);
  const percent = desired > 0 ? Math.min(100, Math.round((applied / desired) * 100)) : overall === "applied" ? 100 : 0;
  $("#revision-progress").style.width = `${percent}%`;
  $("#revision-caption").textContent = desired ? t("sync.progress", { applied, desired }) : t("sync.noneApplied");
}

function normalizeTargetStatus(value, desired) {
  if (typeof value === "string") return { status: value.toLowerCase(), appliedRevision: value.toLowerCase() === "applied" ? desired : 0, error: "" };
  return {
    status: String(value?.state || value?.status || "pending").toLowerCase(),
    appliedRevision: Number(value?.appliedRevision ?? value?.revision ?? 0),
    error: value?.error || value?.message || "",
  };
}

function setTargetStatus(prefix, target) {
  const label = $(`#${prefix}-sync`);
  label.className = `target-status ${target.status}`;
  label.textContent = t(`status.${target.status}`);
  $(`#${prefix}-sync-detail`).textContent = target.error ? localizeProviderError(target.error, t) : t("sync.appliedRevision", { revision: target.appliedRevision });
}

function renderHistory(payload) {
  const entries = Array.isArray(payload) ? payload : payload?.entries || payload?.history || payload?.items || [];
  $("#history-empty").hidden = entries.length > 0;
  $("#history-list").innerHTML = entries.slice(0, HISTORY_PAGE_SIZE).map((entry) => {
    const action = entry.summary || entry.action || entry.event;
    return `<li><b>${escapeHtml(action ? localizeAuditAction(action, t) : t("history.changed"))}</b><time>${escapeHtml(formatDate(entry.createdAt || entry.timestamp || entry.at))}</time><small>${escapeHtml(entry.actor?.name || entry.actor || t("history.system"))}${entry.revision ? ` · ${escapeHtml(t("history.revision", { revision: entry.revision }))}` : ""}</small></li>`;
  }).join("");
}

function openRecordDialog(index = null) {
  const form = $("#record-form");
  form.reset();
  form.elements.internalTtl.value = "300";
  form.elements.externalTtl.value = "300";
  form.elements.originalName.value = "";
  $("#record-form-error").hidden = true;
  if (index !== null) {
    const record = state.records[index];
    form.dataset.index = String(index);
    form.elements.originalName.value = record.name;
    form.elements.name.value = record.name;
    form.elements.type.value = record.type;
    form.elements.internalContent.value = record.views.internal.content;
    form.elements.externalContent.value = record.views.external.content;
    form.elements.proxied.checked = record.views.external.proxied;
    form.elements.acknowledgeNonGlobalIp.checked = record.views.external.acknowledgeNonGlobalIp;
    form.elements.internalTtl.value = record.views.internal.ttl;
    form.elements.externalTtl.value = record.views.external.ttl;
  } else {
    delete form.dataset.index;
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
  $("#record-dialog-mode").textContent = index === null ? t("record.desired") : displayName(state.records[index]?.name || form.elements.name.value);
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
  const proxied = form.elements.proxied.checked && !form.elements.proxied.disabled;
  if (proxied) {
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
  const type = form.elements.type.value;
  const address = form.elements.externalContent.value.trim();
  const show = (type === "A" || type === "AAAA") && address !== "" && isNonGlobalAddress(address);
  $("#non-global-warning").hidden = !show;
  form.elements.acknowledgeNonGlobalIp.required = show;
  if (!show) form.elements.acknowledgeNonGlobalIp.checked = false;
  updateLocalizedValidity(form.elements.acknowledgeNonGlobalIp);
}

async function saveRecord(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const data = new FormData(form);
  const record = normalizeRecord({
    id: form.dataset.index === undefined ? createUniqueRecordId(String(data.get("name")), String(data.get("type"))) : state.records[Number(form.dataset.index)].id,
    name: String(data.get("name")).trim(),
    type: String(data.get("type")),
    ttl: effectiveExternalTtl(form.elements.externalTtl.value, form.elements.proxied.checked),
    views: {
      internal: { content: String(data.get("internalContent")).trim(), ttl: Number(data.get("internalTtl")) },
      external: { content: String(data.get("externalContent")).trim(), ttl: effectiveExternalTtl(form.elements.externalTtl.value, data.get("proxied") === "on"), proxied: data.get("proxied") === "on", acknowledgeNonGlobalIp: data.get("acknowledgeNonGlobalIp") === "on" },
    },
  });
  const duplicate = state.records.findIndex((item, index) => item.name === record.name && item.type === record.type
    && index !== Number(form.dataset.index)
    && ((item.views.external.content && item.views.external.content === record.views.external.content)
      || (item.views.internal.content && item.views.internal.content === record.views.internal.content)));
  if (duplicate >= 0) {
    showFormError("record", "record.duplicate");
    return;
  }
  const cnameConflict = state.records.findIndex((item, index) => item.name === record.name
    && index !== Number(form.dataset.index) && (item.type === "CNAME" || record.type === "CNAME"));
  if (cnameConflict >= 0) {
    showFormError("record", "record.cnameConflict");
    return;
  }
  const index = form.dataset.index === undefined ? -1 : Number(form.dataset.index);
  if (index >= 0) state.records[index] = record;
  else state.records.push(record);
  state.dirty = true;
  state.previewRevision = null;
  state.planPayload = null;
  state.planError = "";
  renderRecords();
  renderFocusOptions();
  $("#record-dialog").close();
  toast("record.updatedLocal");
}

function deleteRecord(index) {
  const record = state.records[index];
  if (!confirm(t("record.removeConfirm", { name: displayName(record.name), type: record.type }))) return;
  state.records.splice(index, 1);
  state.dirty = true;
  state.previewRevision = null;
  state.planPayload = null;
  state.planError = "";
  renderRecords();
  renderFocusOptions();
  toast("record.removedLocal");
}

function desiredPayload() {
  const asDesiredRecord = (record, view) => ({
    id: record.views[view].id || record.id,
    name: record.name,
    type: record.type,
    content: view === "internal" ? (record.views.internal.content || record.views.external.content) : record.views.external.content,
    ttl: record.views[view].ttl,
    ...(view === "external" ? {
      ...(["A", "AAAA", "CNAME"].includes(record.type) ? { proxied: record.views.external.proxied } : {}),
      ...(record.views.external.acknowledgeNonGlobalIp ? { acknowledgeNonGlobalIp: true } : {}),
    } : {}),
  });
  return {
    views: [
      { name: "internal", records: state.records.filter((record) => record.views.internal.content).map((record) => asDesiredRecord(record, "internal")) },
      { name: "external", records: state.records.filter((record) => record.views.external.content).map((record) => asDesiredRecord(record, "external")) },
    ],
  };
}

async function previewPlan() {
  const dialog = $("#plan-dialog");
  dialog.showModal();
  $("#plan-summary").textContent = t("plan.comparing");
  $("#plan-content").innerHTML = '<div class="skeleton plan-skeleton"></div><div class="skeleton plan-skeleton"></div>';
  $("#apply-from-plan").disabled = true;
  state.previewRevision = null;
  state.planPayload = null;
  state.planError = "";
  try {
    const result = await api(`/zones/${encodeZone(state.activeZone)}/preview`, { method: "POST", body: JSON.stringify(desiredPayload()) });
    state.previewRevision = result.revision;
    state.planPayload = result;
    renderPlan(result);
  } catch (error) {
    state.planError = error.message;
    renderPlanError(error.message);
  }
}

function renderPlanError(error) {
  $("#plan-summary").textContent = t("plan.failed");
  $("#plan-content").innerHTML = `<div class="form-error">${escapeHtml(t("plan.failedHelp", { error }))}</div>`;
}

function renderPlan(payload) {
  const operations = Array.isArray(payload) ? payload : payload?.operations || payload?.changes || payload?.plan || Object.entries(payload?.views || {}).flatMap(([target, plan]) => (plan?.operations || []).map((operation) => ({ ...operation, target })));
  $("#plan-summary").textContent = operations.length ? t(pluralKey("plan.operations", operations.length), { count: operations.length }) : t("plan.noChanges");
  $("#plan-content").innerHTML = operations.length ? operations.map((operation) => {
    const kind = String(operation.kind || operation.action || "update").toLowerCase();
    const record = operation.record || operation.after || operation.desired || {};
    const rawTarget = operation.target || operation.provider || operation.view;
    const target = rawTarget ? localizeViewName(rawTarget, t) : t("plan.provider");
    return `<article class="plan-operation"><span class="operation-kind ${escapeHtml(kind)}">${escapeHtml(t(`operation.${kind}`))}</span><div><b>${escapeHtml(displayName(record.name || operation.name || t("plan.record")))} ${escapeHtml(record.type || operation.type || "")}</b><small>${escapeHtml(target)} · ${escapeHtml(record.content || operation.content || operation.description || t("plan.reconciled"))}</small></div></article>`;
  }).join("") : `<div class="mini-empty">${escapeHtml(t("plan.noDrift"))}</div>`;
  $("#apply-from-plan").disabled = !operations.length && !state.dirty;
}

async function applyChanges() {
  setActionBusy(true);
  try {
    let expectedApplyRevision = state.previewRevision;
    if (state.dirty) {
      const saved = await api(`/zones/${encodeZone(state.activeZone)}`, {
        method: "PUT",
        headers: activeRevisionHeaders(),
        body: JSON.stringify(desiredPayload()),
      });
      state.activeZone = { ...state.activeZone, ...saved };
      expectedApplyRevision = saved.revision;
    }
    const result = await api(`/zones/${encodeZone(state.activeZone)}/apply`, {
      method: "POST",
      headers: expectedApplyRevision ? { "If-Match": `"${expectedApplyRevision}"` } : {},
    });
    state.dirty = false;
    state.previewRevision = null;
    state.planPayload = null;
    state.planError = "";
    $("#plan-dialog").close();
    toast(result?.revision ? "apply.startedRevision" : "apply.started", result?.revision ? { revision: result.revision } : {});
    await selectZone(state.activeZone);
    await loadZones({ preserveSelection: true });
  } catch (error) {
    toast("apply.failed", { error: error.message }, "error");
  } finally {
    setActionBusy(false);
  }
}

function setActionBusy(busy) {
  for (const id of ["#apply-button", "#apply-from-plan", "#preview-button"]) $(id).disabled = busy;
  $("#apply-button").textContent = t(busy ? "zone.applying" : "zone.apply");
}

async function createZone(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const name = String(new FormData(form).get("name")).trim().toLowerCase().replace(/\.$/, "");
  const button = $("#create-zone-submit");
  button.disabled = true;
  button.textContent = t("zone.creating");
  try {
    const zone = await api("/zones", { method: "POST", body: JSON.stringify({ name, provider: "cloudflare", managementPolicy: "managed-only", views: { internal: { records: [] }, external: { provider: "cloudflare", records: [] } } }) });
    $("#zone-dialog").close();
    form.reset();
    await loadZones({ preserveSelection: true });
    const created = state.zones.find((item) => zoneName(item) === name) || zone || { name };
    await selectZone(created);
    toast("zone.created", { name });
  } catch (error) {
    showFormError("zone", "zone.createFailed", { error: error.message });
  } finally {
    button.disabled = false;
    button.textContent = t("zones.create");
  }
}

function showFormError(formName, key, values = {}) {
  const element = $(`#${formName}-form-error`);
  setLiveMessage(element, key, values);
  element.hidden = false;
}

function openCreateZone() {
  $("#zone-form-error").hidden = true;
  $("#zone-dialog").showModal();
  queueMicrotask(() => $("#zone-form").elements.name.focus());
}

async function openRevisions() {
  const dialog = $("#revisions-dialog");
  state.revisionsLoadError = "";
  dialog.showModal();
  $("#revisions-content").innerHTML = '<div class="skeleton plan-skeleton"></div><div class="skeleton plan-skeleton"></div>';
  try {
    const payload = await api(`/zones/${encodeZone(state.activeZone)}/revisions?limit=${REVISION_PAGE_SIZE}`);
    const revisions = payload?.revisions || [];
    state.revisions = revisions;
    state.revisionsLoadError = "";
    renderRevisionList(revisions);
  } catch (error) {
    state.revisions = [];
    state.revisionsLoadError = error.message;
    renderRevisionListError(error.message);
  }
}

function renderRevisionListError(error) {
  $("#revisions-content").innerHTML = `<div class="form-error">${escapeHtml(t("revisions.loadFailed", { error }))}</div>`;
}

function renderRevisionList(revisions) {
  $("#revisions-content").innerHTML = revisions.length ? [...revisions].reverse().map((revision) => {
      const recordCount = (revision.views || []).reduce((count, view) => count + (view.records || []).length, 0);
      const current = revision.revision === (state.activeZone.revision ?? state.activeZone.desiredRevision);
      const currentText = current ? t("revisions.current") : "";
      return `<article class="revision-item"><span><b>${escapeHtml(t("revisions.item", { revision: revision.revision, currentText }))}</b><small>${escapeHtml(formatDate(revision.updatedAt || revision.createdAt))} · ${escapeHtml(t(pluralKey("revisions.records", recordCount), { count: recordCount }))}</small></span>${current ? "" : `<button class="button compact" type="button" data-restore-revision="${escapeHtml(revision.revision)}">${escapeHtml(t("revisions.restore"))}</button>`}</article>`;
    }).join("") : `<div class="mini-empty">${escapeHtml(t("revisions.none"))}</div>`;
}

async function restoreRevision(revision) {
  if (!confirm(t("revisions.restoreConfirm", { revision }))) return;
  try {
    await api(`/zones/${encodeZone(state.activeZone)}/revisions/${encodeURIComponent(revision)}/restore`, {
      method: "POST",
      headers: activeRevisionHeaders(),
    });
    $("#revisions-dialog").close();
    toast("revisions.restored", { revision });
    await selectZone(state.activeZone);
  } catch (error) {
    toast("revisions.restoreFailed", { error: error.message }, "error");
  }
}

async function deleteActiveZone() {
  const name = zoneName(state.activeZone);
  if (!name || !confirm(t("zone.deleteConfirm", { name }))) return;
  try {
    const result = await api(`/zones/${encodeURIComponent(name)}`, { method: "DELETE", headers: activeRevisionHeaders() });
    state.activeZone = null;
    state.records = [];
    const withdrawn = result?.removedProviderRecords?.length ?? 0;
    if (withdrawn > 0) toast(pluralKey("zone.deletedRecords", withdrawn), { name, count: withdrawn });
    else toast("zone.deleted", { name });
    await loadZones();
  } catch (error) {
    toast("zone.deleteFailed", { error: error.message }, "error");
  }
}

function openAuthDialog() {
  const dialog = $("#auth-dialog");
  if (!dialog.open) dialog.showModal();
  queueMicrotask(() => $("#auth-form").elements.token.focus());
}

async function authenticatePortal(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const token = String(new FormData(form).get("token") || "").trim();
  if (!token) return;
  $("#auth-form-error").hidden = true;
  try {
    await api("/session", { method: "POST", body: JSON.stringify({ token }) });
    state.authenticated = true;
    syncSessionControls();
    $("#auth-dialog").close();
    form.reset();
    await loadZones();
  } catch (error) {
    state.authenticated = false;
    syncSessionControls();
    setLiveMessage($("#auth-form-error"), error.status === 403 ? "auth.forbidden" : "auth.rejected");
    $("#auth-form-error").hidden = false;
  }
}

async function signOut() {
  try {
    await api("/session", { method: "DELETE" });
  } catch {
    // The cookie is cleared either way; a failed sign-out still ends the session here.
  }
  state.authenticated = false;
  state.activeZone = null;
  state.zones = [];
  state.records = [];
  syncSessionControls();
  renderZoneList();
  showWelcome(true);
  openAuthDialog();
}

function syncSessionControls() {
  $("#sign-out-button").hidden = !state.authenticated;
}

async function openCredentialSettings() {
  const dialog = $("#credential-dialog");
  const form = $("#credential-form");
  form.reset();
  form.elements.zone.value = zoneName(state.activeZone);
  $("#credential-form-error").hidden = true;
  setCredentialEditorEnabled(false);
  $("#credential-list").innerHTML = '<div class="skeleton plan-skeleton"></div>';
  $("#credential-access-message").hidden = true;
  dialog.showModal();
  try {
    const payload = await api("/credentials/cloudflare");
    const credentials = payload?.credentials || [];
    renderCredentialList(credentials);
    const current = credentials.find((credential) => credential.zone === zoneName(state.activeZone));
    if (current) form.elements.zoneId.value = current.zoneId;
    setCredentialEditorEnabled(Boolean(zoneName(state.activeZone)));
    state.credentials = credentials;
    if (!state.activeZone) showCredentialAccess("credentials.selectZone");
  } catch (error) {
    state.credentials = [];
    renderCredentialList([]);
    if (error.status === 403) showCredentialAccess("credentials.adminView", {}, true);
    else if (error.status === 404) showCredentialAccess("credentials.disabled");
    else showCredentialAccess("credentials.loadFailed", { error: error.message }, true);
  }
}

function renderCredentialList(credentials) {
  $("#credential-list").innerHTML = credentials.length ? credentials.map((credential) => `<article class="credential-item"><b>${escapeHtml(credential.zone)}</b><small>${escapeHtml(t("credentials.zoneIdValue", { id: credential.zoneId }))}</small><small>${escapeHtml(t("credentials.updated", { date: formatDate(credential.updatedAt) }))}</small></article>`).join("") : `<div class="mini-empty">${escapeHtml(t("credentials.none"))}</div>`;
}

function setCredentialEditorEnabled(enabled) {
  const form = $("#credential-form");
  for (const name of ["zoneId", "token"]) form.elements[name].disabled = !enabled;
  for (const id of ["#delete-credential-button", "#test-credential-button", "#save-credential-button"]) $(id).disabled = !enabled;
}

function showCredentialAccess(key, values = {}, denied = false) {
  const element = $("#credential-access-message");
  setLiveMessage(element, key, values);
  element.className = `credential-access-message${denied ? " denied" : ""}`;
  element.hidden = false;
  setCredentialEditorEnabled(false);
}

async function saveCredential(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const zone = String(form.elements.zone.value);
  const zoneId = String(form.elements.zoneId.value).trim();
  const token = String(form.elements.token.value);
  if (!zoneId || !token.trim()) {
    showFormError("credential", "credentials.required");
    return;
  }
  $("#save-credential-button").disabled = true;
  try {
    await api(`/credentials/cloudflare/${encodeURIComponent(zone)}`, { method: "PUT", body: JSON.stringify({ zoneId, token }) });
    form.elements.token.value = "";
    $("#credential-form-error").hidden = true;
    toast("credentials.saved", { zone });
    await refreshCredentialSettings();
  } catch (error) {
    showFormError("credential", error.status === 403 ? "credentials.adminSave" : "credentials.saveFailed", error.status === 403 ? {} : { error: error.message });
  } finally {
    $("#save-credential-button").disabled = false;
  }
}

async function testCredential() {
  const form = $("#credential-form");
  const zone = String(form.elements.zone.value);
  const zoneId = String(form.elements.zoneId.value).trim();
  const token = String(form.elements.token.value);
  if (token.trim() && !zoneId) {
    showFormError("credential", "credentials.testNeedsZoneId");
    return;
  }
  $("#test-credential-button").disabled = true;
  try {
    await api(`/credentials/cloudflare/${encodeURIComponent(zone)}/test`, {
      method: "POST",
      ...(token.trim() ? { body: JSON.stringify({ zoneId, token }) } : {}),
    });
    form.elements.token.value = "";
    $("#credential-form-error").hidden = true;
    toast("credentials.accepted", { zone });
  } catch (error) {
    showFormError("credential", error.status === 403 ? "credentials.adminTest" : "credentials.testFailed", error.status === 403 ? {} : { error: error.message });
  } finally {
    $("#test-credential-button").disabled = false;
  }
}

async function deleteCredential() {
  const zone = String($("#credential-form").elements.zone.value);
  if (!confirm(t("credentials.deleteConfirm", { zone }))) return;
  $("#delete-credential-button").disabled = true;
  try {
    await api(`/credentials/cloudflare/${encodeURIComponent(zone)}`, { method: "DELETE" });
    $("#credential-form").elements.zoneId.value = "";
    $("#credential-form").elements.token.value = "";
    toast("credentials.deleted", { zone });
    await refreshCredentialSettings();
  } catch (error) {
    showFormError("credential", error.status === 403 ? "credentials.adminDelete" : "credentials.deleteFailed", error.status === 403 ? {} : { error: error.message });
  } finally {
    $("#delete-credential-button").disabled = false;
  }
}

async function refreshCredentialSettings() {
  const payload = await api("/credentials/cloudflare");
  const credentials = payload?.credentials || [];
  state.credentials = credentials;
  renderCredentialList(credentials);
  const current = credentials.find((credential) => credential.zone === zoneName(state.activeZone));
  $("#credential-form").elements.zoneId.value = current?.zoneId || "";
}

function setLiveMessage(element, key, values = {}) {
  const message = createSemanticMessage(key, values);
  liveMessages.set(element, message);
  element.textContent = renderSemanticMessage(message, t);
}

function toast(key, values = {}, type = "success") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  setLiveMessage(element, key, values);
  $("#toast-region").append(element);
  setTimeout(() => { liveMessages.delete(element); element.remove(); }, 5200);
}

function displayName(name) { return name === "@" ? zoneName(state.activeZone) : `${name}.${zoneName(state.activeZone)}`; }
function formatLocalizedTtl(value) { return Number(value) === 1 ? t("ttl.auto") : t("ttl.seconds", { seconds: Number(value) }); }
function formatDate(value) {
  if (!value) return t("date.unknown");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(state.locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function createRecordId(name, type) {
  const base = String(name || "record").toLowerCase().replace(/^@$/, "root").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "record";
  return `${base}-${String(type || "record").toLowerCase()}`.slice(0, 63);
}

function createUniqueRecordId(name, type) {
  const base = createRecordId(name, type);
  const used = new Set(state.records.flatMap((record) => [record.id, record.views.internal.id, record.views.external.id]));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 63 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 54)}-${Date.now().toString(36)}`;
}

function isNonGlobalAddress(value) {
  if (value.includes(":")) {
    const normalized = value.toLowerCase();
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fe8") || normalized.startsWith("fe9")
      || normalized.startsWith("fea") || normalized.startsWith("feb") || /^[fd]/.test(normalized)
      || normalized.startsWith("ff") || normalized.startsWith("2001:db8:") || normalized.startsWith("100:");
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

$("#zone-list").addEventListener("click", (event) => {
  const retry = event.target.closest('[data-action="retry-zones"]');
  if (retry) return loadZones();
  const button = event.target.closest("[data-zone]");
  if (button) selectZone(state.zones.find((zone) => zoneName(zone) === button.dataset.zone));
});
$("#zone-search").addEventListener("input", renderZoneList);
$("#locale-select").addEventListener("change", (event) => setLocale(event.currentTarget.value));
$("#add-zone-button").addEventListener("click", openCreateZone);
$("#zone-form").addEventListener("submit", createZone);
$("#auth-form").addEventListener("submit", authenticatePortal);
$("#sign-out-button").addEventListener("click", signOut);
$("#credential-settings-button").addEventListener("click", openCredentialSettings);
$("#credential-form").addEventListener("submit", saveCredential);
$("#test-credential-button").addEventListener("click", testCredential);
$("#delete-credential-button").addEventListener("click", deleteCredential);
$("#add-record-button").addEventListener("click", () => openRecordDialog());
$("#record-form").addEventListener("submit", saveRecord);
$("#record-form [name=type]").addEventListener("change", () => { syncProxyAvailability(); syncExternalTtl(); syncAddressSafetyWarning(); });
$("#record-form [name=proxied]").addEventListener("change", syncExternalTtl);
$("#record-form [name=externalTtl]").addEventListener("input", syncExternalTtl);
$("#record-form [name=externalContent]").addEventListener("input", syncAddressSafetyWarning);
for (const field of $$('[data-validation-label]')) {
  field.addEventListener("invalid", () => updateLocalizedValidity(field));
  field.addEventListener("input", () => updateLocalizedValidity(field));
  field.addEventListener("change", () => updateLocalizedValidity(field));
}
$("#record-rows").addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit-record]");
  const remove = event.target.closest("[data-delete-record]");
  if (edit) openRecordDialog(Number(edit.dataset.editRecord));
  if (remove) deleteRecord(Number(remove.dataset.deleteRecord));
});
document.addEventListener("click", (event) => {
  const closeButton = event.target.closest("[data-close-dialog]");
  if (closeButton) closeButton.closest("dialog")?.close();
  if (event.target.closest('[data-action="open-create"]')) openCreateZone();
  if (event.target.closest('[data-action="add-record"]')) openRecordDialog();
});
$("#focus-record").addEventListener("change", renderLens);
$("#refresh-button").addEventListener("click", () => selectZone(state.activeZone));
$("#delete-zone-button").addEventListener("click", deleteActiveZone);
$("#revisions-button").addEventListener("click", openRevisions);
$("#preview-button").addEventListener("click", previewPlan);
$("#apply-button").addEventListener("click", previewPlan);
$("#apply-from-plan").addEventListener("click", applyChanges);
$("#close-plan").addEventListener("click", () => $("#plan-dialog").close());
$("#cancel-plan").addEventListener("click", () => $("#plan-dialog").close());
$("#close-revisions").addEventListener("click", () => $("#revisions-dialog").close());
$("#revisions-content").addEventListener("click", (event) => {
  const button = event.target.closest("[data-restore-revision]");
  if (button) restoreRevision(button.dataset.restoreRevision);
});
window.addEventListener("beforeunload", (event) => { if (state.dirty) event.preventDefault(); });

setLocale(state.locale);
syncSessionControls();
showWelcome(true);
loadZones();
