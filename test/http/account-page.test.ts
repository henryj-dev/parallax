import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ACCOUNT_MESSAGES, viewForPath } from "../../public/account.js";
import { ACCOUNT_ONLY_ASSETS, ACCOUNT_PAGE_PATHS, PORTAL_ASSETS } from "../../src/http/portal-assets.ts";

const PUBLIC = join(import.meta.dirname, "../../public");

describe("the member account page", () => {
  it("has every string in both languages", () => {
    assert.deepEqual(Object.keys(ACCOUNT_MESSAGES.ko).sort(), Object.keys(ACCOUNT_MESSAGES.en).sort());
    for (const [locale, table] of Object.entries(ACCOUNT_MESSAGES)) {
      for (const [key, text] of Object.entries(table)) assert.ok(String(text).trim().length > 0, `${locale} ${key} is empty`);
    }
  });

  it("translates every label the page names, and every error code the server answers with", async () => {
    const html = await readFile(join(PUBLIC, "account.html"), "utf8");
    const keys = [...html.matchAll(/data-t(?:-aria)?="([^"]+)"/gu)].map((match) => match[1] as string);
    assert.ok(keys.length > 40, `expected the page's labels, found ${keys.length}`);
    for (const key of keys) assert.ok(Object.hasOwn(ACCOUNT_MESSAGES.en, key), `account.html names ${key}, which has no translation`);
    for (const code of ["invalid-input", "denied", "conflict", "last-admin", "rate-limited", "unavailable", "mfa-required", "not-enabled", "csrf_rejected",
      "reauthentication_required", "unauthorized", "authentication_unavailable", "identity_authentication_failed", "invalid_path"]) {
      assert.ok(Object.hasOwn(ACCOUNT_MESSAGES.en, `error.${code}`), `no message for ${code}`);
    }
  });

  it("opens the view each mailed link and sign-in path names", () => {
    assert.deepEqual(ACCOUNT_PAGE_PATHS.map(viewForPath), ["account", "login", "invite", "reset", "email"]);
    assert.equal(viewForPath("/account/login/"), "login");
    for (const path of ACCOUNT_ONLY_ASSETS) assert.ok(PORTAL_ASSETS.has(path), path);
  });

  it("marks this browser's own session and confirms before ending it", async () => {
    const script = await readFile(join(PUBLIC, "account.js"), "utf8");
    for (const key of ["sessions.current", "sessions.revokeCurrent", "sessions.revokeCurrentConfirm"]) {
      assert.ok(ACCOUNT_MESSAGES.en[key] && ACCOUNT_MESSAGES.ko[key], key);
    }
    // This browser's own row signs out the way the header button does, after a confirmation.
    assert.match(script, /if \(entry\.current\) \{ if \(confirm\(t\("sessions\.revokeCurrentConfirm"\)\)\) await signOut\(\); return; \}/u);
    assert.match(script, /onClick\("#logout", signOut\);/u);
  });

  it("keeps secrets out of browser storage and out of the address bar", async () => {
    const script = await readFile(join(PUBLIC, "account.js"), "utf8");
    // The only thing stored is the language choice.
    const writes = [...script.matchAll(/localStorage\.setItem\(([^,]+),/gu)].map((match) => (match[1] as string).trim());
    assert.deepEqual(writes, ["LOCALE_STORAGE_KEY"]);
    assert.doesNotMatch(script, /sessionStorage|indexedDB|document\.cookie/u);
    assert.match(script, /history\.replaceState\(null, "", url\.pathname\)/u, "a mailed token must leave the address bar");
    assert.match(script, /addEventListener\("pagehide", forget\)/u);
    assert.doesNotMatch(script, /innerHTML/u, "member-supplied text is set as text, never parsed as markup");
  });
});
