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

  it("wires an accessible persisted language selector and serves every portal module", async () => {
    const [html, app, store, client, server] = await Promise.all([
      readFile(new URL("../../public/index.html", import.meta.url), "utf8"),
      readFile(new URL("../../public/app.js", import.meta.url), "utf8"),
      readFile(new URL("../../public/store.js", import.meta.url), "utf8"),
      readFile(new URL("../../public/api-client.js", import.meta.url), "utf8"),
      readFile(new URL("../../src/index.ts", import.meta.url), "utf8"),
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

    for (const file of ["i18n.js", "app.js", "store.js", "api-client.js", "ttl.js"]) {
      assert.ok(server.includes(`file: "${file}"`), file);
    }
    assert.equal(createTranslator("ko")("meta.title"), "Parallax — DNS 관측소");
  });
});
