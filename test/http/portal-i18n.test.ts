import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  createTranslator,
  DEFAULT_LOCALE,
  escapeHtml,
  localizeAuditAction,
  localizedValidationMessage,
  localizeProviderError,
  localizeViewName,
  messages,
  normalizeLocale,
  pluralKey,
  readPersistedLocale,
  renderSemanticMessage,
  resolveLocale,
  translateDocument,
  createSemanticMessage,
  writePersistedLocale,
} from "../../public/i18n.js";
import { createStore, type StoreNotice } from "../../public/store.js";
import { PROFILE_NAME_PATTERN } from "../../src/security/credential-store.ts";

describe("portal internationalization", () => {
  it("resolves a persisted choice before browser preferences", () => {
    assert.equal(resolveLocale({ persistedLocale: "ko", browserLocales: ["en-US"] }), "ko");
    assert.equal(resolveLocale({ persistedLocale: "invalid", browserLocales: ["fr-FR", "ko-KR"] }), "ko");
    assert.equal(resolveLocale({ persistedLocale: null, browserLocales: ["fr-FR"] }), DEFAULT_LOCALE);
    assert.equal(normalizeLocale("KO_kr"), "ko");
    assert.equal(normalizeLocale("ja"), null);
  });

  it("translates, interpolates, pluralizes, and safely falls back", () => {
    const ko = createTranslator("ko-KR");
    assert.equal(ko("zone.created", { name: "example.com" }), "example.com 존을 만들었습니다.");
    assert.equal(ko(pluralKey("plan.operations", 1), { count: 1 }), "이 존을 동기화할 작업이 1개 있습니다.");
    assert.equal(ko(pluralKey("plan.operations", 2), { count: 2 }), "이 존을 동기화할 작업이 2개 있습니다.");
    assert.equal(ko("missing.key"), "missing.key");
    assert.equal(createTranslator("unsupported")("zones.create"), "Create zone");
  });

  it("keeps the Korean catalog in parity with English", () => {
    assert.deepEqual(Object.keys(messages.ko).sort(), Object.keys(messages.en).sort());
  });

  it("updates text and accessible attributes through translation keys", () => {
    type FakeElement = {
      dataset: Record<string, string>;
      textContent: string;
      attributes: Record<string, string>;
      setAttribute(name: string, value: string): void;
    };
    const element = (dataset: Record<string, string>): FakeElement => ({
      dataset,
      textContent: "",
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
    });
    const elements: Record<string, FakeElement[]> = {
      "[data-i18n]": [element({ i18n: "zones.create" })],
      "[data-i18n-aria-label]": [element({ i18nAriaLabel: "language.label" })],
      "[data-i18n-title]": [] as FakeElement[],
      "[data-i18n-placeholder]": [element({ i18nPlaceholder: "zones.filterPlaceholder" })],
      "[data-i18n-content]": [element({ i18nContent: "meta.description" })],
    };
    const root = { querySelectorAll: (selector: string) => elements[selector] || [] };
    translateDocument(root, createTranslator("ko"));
    assert.equal(elements["[data-i18n]"]?.at(0)?.textContent, "존 만들기");
    assert.equal(elements["[data-i18n-aria-label]"]?.at(0)?.attributes["aria-label"], "언어");
    assert.equal(elements["[data-i18n-placeholder]"]?.at(0)?.attributes.placeholder, "도메인으로 필터…");
    assert.equal(elements["[data-i18n-content]"]?.at(0)?.attributes.content, "Parallax 분할 DNS 운영 포털");
  });

  it("localizes only known audit actions and provider errors", () => {
    const ko = createTranslator("ko");
    const actions = ["zone.created", "zone.deleted", "record.upserted", "record.deleted", "desired.replaced", "desired.restored"];
    assert.deepEqual(actions.map((action) => localizeAuditAction(action, ko)), ["존 생성", "존 삭제", "레코드 저장", "레코드 삭제", "목표 상태 교체", "목표 상태 복원"]);
    assert.equal(localizeAuditAction("custom.audit.event", ko), "custom.audit.event");
    assert.equal(localizeProviderError("provider operation failed", ko), "프로바이더 작업 실패");
    assert.equal(localizeProviderError("unmanaged provider records conflict with desired state", ko), "관리되지 않는 프로바이더 레코드가 목표 상태와 충돌합니다");
    assert.equal(localizeProviderError("upstream timeout", ko), "upstream timeout");
    assert.equal(localizeViewName("internal", ko), "내부 뷰");
    assert.equal(localizeViewName("external", ko), "외부 뷰");
    assert.equal(localizeViewName("cloudflare", ko), "cloudflare");
  });

  it("rerenders semantic messages without freezing the previous locale", () => {
    const message = createSemanticMessage("zone.createFailed", { error: "timeout" });
    assert.equal(renderSemanticMessage(message, createTranslator("en")), "Zone was not created: timeout");
    assert.equal(renderSemanticMessage(message, createTranslator("ko")), "존을 만들지 못했습니다: timeout");
  });

  it("fails safely when locale storage is unavailable", () => {
    const unavailable = {
      getItem(): string | null { throw new Error("blocked"); },
      setItem(): void { throw new Error("blocked"); },
    };
    assert.equal(readPersistedLocale(unavailable), null);
    assert.equal(writePersistedLocale(unavailable, "ko"), false);
    assert.equal(writePersistedLocale(null, "ko"), false);
  });

  it("builds localized required and numeric range messages", () => {
    const ko = createTranslator("ko");
    assert.equal(localizedValidationMessage({ validity: { valueMissing: true }, label: "도메인 이름" }, ko), "도메인 이름: 필수 입력 항목입니다.");
    assert.equal(localizedValidationMessage({ validity: { rangeUnderflow: true }, label: "내부 TTL(초)", min: 1 }, ko), "내부 TTL(초): 1 이상이어야 합니다.");
    assert.equal(localizedValidationMessage({ validity: { rangeOverflow: true }, label: "외부 TTL", max: 86400 }, ko), "외부 TTL: 86400 이하여야 합니다.");
    assert.equal(localizedValidationMessage({ validity: { stepMismatch: true }, label: "내부 TTL(초)", step: 1 }, ko), "내부 TTL(초): 1 단위로 입력하세요.");
  });

  it("keeps interpolation as text until the HTML rendering boundary", () => {
    const injected = '<img src=x onerror="alert(1)">';
    const translated = createTranslator("en")("zone.createFailed", { error: injected });
    assert.match(translated, /<img/);
    assert.equal(escapeHtml(translated), "Zone was not created: &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("wires an accessible persisted language selector and keeps the portal layered", async () => {
    const [html, app, store, client] = await Promise.all([
      readFile(new URL("../../public/index.html", import.meta.url), "utf8"),
      readFile(new URL("../../public/app.js", import.meta.url), "utf8"),
      readFile(new URL("../../public/store.js", import.meta.url), "utf8"),
      readFile(new URL("../../public/api-client.js", import.meta.url), "utf8"),
    ]);
    assert.match(html, /id="locale-select"[^>]+data-i18n-aria-label="language\.label"/);
    assert.match(html, /<option value="en"[^>]+data-i18n="language\.english"/);
    assert.match(html, /<option value="ko"[^>]+data-i18n="language\.korean"/);
    assert.match(app, /writePersistedLocale\(globalThis\.localStorage/);
    assert.match(app, /document\.documentElement\.lang = locale/);
    // Load failures are state the store owns; the view only draws them.
    assert.match(store, /state\.zonesError = /);
    assert.match(store, /state\.revisionsError = /);
    assert.match(app, /state\.zonesError/);
    assert.match(app, /state\.revisionsError/);

    // The layering has to survive: the view never calls the network, and
    // neither the store nor the client may reach for a document.
    assert.doesNotMatch(app, /\bfetch\(/);
    for (const module of [store, client]) {
      assert.doesNotMatch(module, /\bdocument\.|innerHTML|querySelector/);
    }

    // Every scope the store can record an error against has somewhere to be
    // drawn, checked against the store's own list rather than a copy of it.
    const scopes = /ERROR_SCOPES = \[([^\]]+)\]/.exec(store)?.[1] ?? "";
    assert.ok(scopes.length > 0, "the store must declare its error scopes");
    for (const scope of scopes.split(",").map((name) => name.trim().replaceAll('"', ""))) {
      assert.match(app, new RegExp(`^  ${scope}: "#`, "m"), scope);
    }

    // Which modules are served is checked in portal-assets.test.ts, against the
    // imports the portal actually declares. The list that used to sit here named
    // five files by hand, so it agreed with the server about those five and knew
    // nothing about a sixth -- which is how `panels.js` reached production
    // unserved under an assertion called "serves every portal module".
    assert.equal(createTranslator("ko")("meta.title"), "Parallax — DNS 관측소");
  });
});

/**
 * Every notice the store can raise, read out of its own source.
 *
 * A notice goes straight to `translate(key, values)` -- nothing pluralizes it
 * on the way -- so a key the catalog only holds as `.one`/`.other` misses the
 * lookup and the toast prints the key. `zone.deletedRecords` had been doing
 * exactly that: a zone deletion that withdrew records showed the literal string
 * `zone.deletedRecords` to whoever deleted it.
 *
 * Enumerating by hand would have missed it, since the key looks correct at the
 * call site and correct in the catalog -- it is only the pair that is wrong.
 * So the call sites are read from the file instead.
 */
describe("every notice the store raises resolves to a sentence", () => {
  it("finds no key that would print itself", async () => {
    const source = await readFile(new URL("../../public/store.js", import.meta.url), "utf8");
    const keys = [...source.matchAll(/notice\(\s*(?:pluralKey\(\s*)?"([^"]+)"/gu)].map((match) => match[1] as string);
    assert.ok(keys.length > 5, `expected to find the call sites, found ${keys.length}`);

    const pluralized = new Set([...source.matchAll(/notice\(\s*pluralKey\(\s*"([^"]+)"/gu)].map((match) => match[1] as string));
    for (const locale of Object.keys(messages)) {
      const catalog = messages[locale as keyof typeof messages] as Record<string, string>;
      for (const key of new Set(keys)) {
        const resolves = pluralized.has(key)
          ? Object.hasOwn(catalog, `${key}.one`) && Object.hasOwn(catalog, `${key}.other`)
          : Object.hasOwn(catalog, key);
        assert.ok(resolves, `${locale}: ${key} would render as its own key`);
      }
    }
  });
});

describe("portal store", () => {
  it("carries a settings warning to whoever made the change", async () => {
    const store = createStore({
      saveSettings: async () => ({
        settings: { publicOrigin: "" },
        warnings: ["publicOrigin is empty, so redirects assume 443"],
      }),
    });
    const notices: StoreNotice[] = [];
    store.onNotice((notice) => { notices.push(notice); });

    assert.equal(await store.saveSettings({ publicOrigin: "" }), true);
    // The success notice alone would report a change that quietly cost something.
    assert.deepEqual(notices.map((notice) => notice.key), ["settings.saved", "settings.warning"]);
    const warning = notices[1]!;
    assert.equal(warning.level, "warning");
    assert.equal(warning.values.message, "publicOrigin is empty, so redirects assume 443");

    // A key with no translation renders as the key itself, which is how this
    // reaches a user as `settings.warning` instead of a sentence.
    for (const locale of Object.keys(messages)) {
      const translated = createTranslator(locale)(warning.key, warning.values);
      assert.notEqual(translated, warning.key, locale);
      assert.match(translated, /publicOrigin is empty/, locale);
    }
  });

  /**
   * `apply` answers 200 with the failure inside `statuses`, which is the right
   * shape -- one view failing must not hide another view's result -- and it
   * means the caller has to read them. The portal did not, so every apply
   * reported success in green and the only correction was the status dot
   * redrawing a moment later.
   */
  it("reports an apply the provider refused as a failure, not a green notice", async () => {
    const store = createStore({
      apply: async () => ({
        zone: "example.com",
        revision: 4,
        statuses: [
          { zone: "example.com", view: "internal", desiredRevision: 4, appliedRevision: 4, state: "applied" },
          {
            zone: "example.com", view: "external", desiredRevision: 4, appliedRevision: 0, state: "failed",
            error: "provider operation failed", completedOperations: 3, plannedOperations: 7,
          },
        ],
      }),
      getZone: async () => ({ name: "example.com", revision: 4, views: [] }),
      zoneStatus: async () => ({ statuses: [] }),
      history: async () => ({ entries: [] }),
      listZones: async () => ({ zones: [] }),
      statusOverview: async () => ({ zones: [] }),
    });
    const notices: StoreNotice[] = [];
    store.onNotice((notice) => { notices.push(notice); });

    assert.equal(await store.apply(), false, "the flow reports it did not succeed");

    const reported = notices.find((notice) => notice.key.startsWith("apply."));
    assert.equal(reported?.level, "error");
    assert.equal(reported?.key, "apply.viewsFailedPartial");
    assert.equal(reported?.values.views, "external");
    // How far it got decides what to do next: the view is answering for part
    // of the change already.
    assert.equal(reported?.values.completed, "3");
    assert.equal(reported?.values.planned, "7");

    for (const locale of Object.keys(messages)) {
      const translated = createTranslator(locale)(reported!.key, reported!.values);
      assert.notEqual(translated, reported!.key, locale);
      assert.match(translated, /external/u, locale);
    }
  });

  it("still reports an apply every view accepted as a success", async () => {
    const store = createStore({
      apply: async () => ({
        zone: "example.com",
        revision: 4,
        statuses: [{ zone: "example.com", view: "internal", desiredRevision: 4, appliedRevision: 4, state: "applied" }],
      }),
      getZone: async () => ({ name: "example.com", revision: 4, views: [] }),
      zoneStatus: async () => ({ statuses: [] }),
      history: async () => ({ entries: [] }),
      listZones: async () => ({ zones: [] }),
      statusOverview: async () => ({ zones: [] }),
    });
    const notices: StoreNotice[] = [];
    store.onNotice((notice) => { notices.push(notice); });

    assert.equal(await store.apply(), true);
    const reported = notices.find((notice) => notice.key.startsWith("apply."));
    assert.equal(reported?.key, "apply.startedRevision");
    assert.notEqual(reported?.level, "error");
  });

  /**
   * The portal always sends `abandonProviderRecords`, and the confirm text says
   * so. What it did not say afterwards is which targets were abandoned -- the
   * server returns them precisely so the blast radius can be seen. A broken
   * token therefore left live records nobody tracks, under a notice reading
   * "deleted".
   */
  it("says which provider targets a deletion abandoned", async () => {
    const store = createStore({
      deleteZone: async () => ({
        zone: "example.com",
        removedProviderRecords: [],
        abandonedProviderTargets: [{ view: "external", target: "example.com/external" }],
      }),
      listZones: async () => ({ zones: [] }),
      statusOverview: async () => ({ zones: [] }),
    });
    const notices: StoreNotice[] = [];
    store.onNotice((notice) => { notices.push(notice); });
    await store.loadZones();
    await store.selectZone("example.com");
    notices.length = 0;

    await store.deleteActiveZone();

    const abandoned = notices.find((notice) => notice.key.startsWith("zone.deletedAbandoned"));
    assert.ok(abandoned, "the abandoned targets are reported at all");
    assert.equal(abandoned.level, "warning", "not a failure -- the deletion did happen");
    assert.equal(abandoned.values.targets, "example.com/external");

    for (const locale of Object.keys(messages)) {
      const translated = createTranslator(locale)(abandoned.key, abandoned.values);
      assert.notEqual(translated, abandoned.key, locale);
      // The value itself, not a pattern that looks like it: this is what the
      // notice is for, and asserting the actual value means a change to the
      // fixture cannot leave the check passing against a stale string.
      assert.ok(translated.includes(abandoned.values.targets as string),
        `${locale} does not name the abandoned target`);
    }
  });

  it("stays quiet about abandoned targets when there were none", async () => {
    const store = createStore({
      deleteZone: async () => ({ zone: "example.com", removedProviderRecords: [], abandonedProviderTargets: [] }),
      listZones: async () => ({ zones: [] }),
      statusOverview: async () => ({ zones: [] }),
    });
    const notices: StoreNotice[] = [];
    store.onNotice((notice) => { notices.push(notice); });
    await store.loadZones();
    await store.selectZone("example.com");
    notices.length = 0;

    await store.deleteActiveZone();

    assert.equal(notices.some((notice) => notice.key.startsWith("zone.deletedAbandoned")), false);
    assert.equal(notices.some((notice) => notice.key === "zone.deleted"), true);
  });

  it("carries what adopting could not read to whoever adopted", async () => {
    // The count cannot say this. A zone whose service lookups were refused
    // gains no `Worker` or `R2` label, and nothing else on the page explains
    // the absence -- so an operator reads "adopted 7 of 7" and concludes the
    // feature does not work. The CLI passed these through from the start; the
    // portal dropped them, which is the half an operator actually looks at.
    const store = createStore({
      adopt: async () => ({
        seen: 7,
        adopted: [],
        refreshed: [],
        warnings: ["which names Workers and R2 own could not be read: Cloudflare API request failed (HTTP 403)"],
      }),
      getZone: async () => ({ name: "example.com", revision: 2, views: [] }),
      listZones: async () => ({ zones: [{ name: "example.com", revision: 2 }] }),
      status: async () => ({ zone: "example.com", revision: 2, views: {} }),
      audit: async () => ({ entries: [] }),
    });
    const notices: StoreNotice[] = [];
    store.onNotice((notice) => { notices.push(notice); });

    await store.adopt();
    assert.deepEqual(notices.map((notice) => notice.key).slice(0, 2), ["zone.adopted", "zone.adoptWarning"]);
    const warning = notices[1]!;
    assert.equal(warning.level, "warning");
    for (const locale of Object.keys(messages)) {
      const translated = createTranslator(locale)(warning.key, warning.values);
      assert.notEqual(translated, warning.key, locale);
      assert.match(translated, /HTTP 403/, locale);
    }
  });

  it("stages a record answered only inside, and refuses one answered nowhere", async () => {
    // The dialog required an external answer, so the portal could not create a
    // name answered only inside -- which the desired state, the CLI and the
    // table have always handled. What is actually required is one answer or the
    // other: a row with neither is dropped from both views by `desiredState`, so
    // saving it would report success, change nothing, and lose the record with
    // no error ever shown.
    const store = createStore({});
    const notices: StoreNotice[] = [];
    store.onNotice((notice) => { notices.push(notice); });
    const row = (internal: string, external: string) => ({
      id: "inside", name: "only-inside", type: "A",
      views: {
        internal: { id: "inside", content: internal, ttl: 300 },
        external: { id: "inside", content: external, ttl: 300 },
      },
    });

    assert.equal(store.stageRecord(row("10.10.10.10", "")), true, "inside only is a record");
    assert.equal(store.stageRecord(row("", "203.0.113.9")), true, "outside only still is too");
    assert.equal(store.stageRecord(row("", "")), false, "neither is not");

    const errors = store.getState().errors as Record<string, { key: string } | null>;
    const refusal = errors.record;
    assert.equal(refusal?.key, "record.answerRequired");
    assert.ok(refusal);
    for (const locale of Object.keys(messages)) {
      const translated = createTranslator(locale)(refusal.key, {});
      assert.notEqual(translated, refusal.key, locale);
    }
  });

  it("says nothing extra when a change costs nothing", async () => {
    const store = createStore({
      saveSettings: async () => ({ settings: { publicOrigin: "https://dns.example.com" } }),
    });
    const keys: string[] = [];
    store.onNotice((notice) => { keys.push(notice.key); });
    await store.saveSettings({ publicOrigin: "https://dns.example.com" });
    assert.deepEqual(keys, ["settings.saved"]);
  });
});

describe("portal form validation", () => {

  it("keeps notices visible whether or not the top layer is available", async () => {
    const [html, css, app] = await Promise.all([
      readFile(new URL("../../public/index.html", import.meta.url), "utf8"),
      readFile(new URL("../../public/styles.css", import.meta.url), "utf8"),
      readFile(new URL("../../public/app.js", import.meta.url), "utf8"),
    ]);

    // A modal dialog is in the top layer, which no stacking order reaches past,
    // so a notice raised while one is open is painted under its backdrop. The
    // region joins the top layer as a popover to sit above it.
    assert.match(app, /setAttribute\("popover"/);
    assert.match(app, /showPopover/);

    // The attribute must not be in the markup. A popover is hidden until it is
    // shown, so declaring it where the API is missing would hide every notice --
    // worse than the backdrop dimming them.
    assert.doesNotMatch(html, /id="toast-region"[^>]*popover/);
    assert.match(app, /typeof toastRegion\.showPopover === "function"/);

    // And if showing ever fails, the region still lays out, so notices degrade
    // to dimmed rather than disappearing.
    assert.match(css, /\.toast-region:not\(:popover-open\)\s*\{[^}]*display:\s*grid/);
  });

  it("compiles every pattern the way a browser does, and agrees with the server", async () => {
    const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
    const patterns = [...html.matchAll(/pattern="([^"]*)"/g)].map((match) => match[1]!);
    assert.ok(patterns.length > 0, "no pattern attributes were found to check");

    for (const pattern of patterns) {
      // Browsers compile `pattern` with the `v` flag, where a literal `-` inside
      // a character class is a syntax error. `new RegExp(pattern)` accepts what
      // the browser rejects, so checking it the ordinary way proves nothing --
      // the attribute was invalid in production while every test passed, and an
      // invalid pattern means the field is not validated at all.
      assert.doesNotThrow(() => new RegExp(pattern, "v"), `pattern is invalid in a browser: ${pattern}`);
    }

    const profilePattern = patterns.find((pattern) => pattern.startsWith("[a-z0-9]"));
    assert.ok(profilePattern, "the profile name pattern was not found");
    const client = new RegExp(`^(?:${profilePattern})$`, "v");
    for (const [value, allowed] of [
      ["production-account", true], ["my_profile", true], ["a", true],
      ["a".repeat(63), true], ["a".repeat(64), false],
      ["-leading", false], ["Upper", false], ["has space", false],
    ] as const) {
      // The server is the authority; the attribute only spares a round trip.
      // Disagreeing in either direction is a defect: rejecting what the server
      // accepts is as wrong as accepting what it refuses.
      assert.equal(client.test(value), allowed, value);
      assert.equal(PROFILE_NAME_PATTERN.test(value), allowed, `server: ${value}`);
    }
  });
});
