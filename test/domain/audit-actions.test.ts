import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { AUDIT_ACTIONS, canBeProxied, RECORD_TYPES } from "../../src/domain/dns.ts";

const root = new URL("../../", import.meta.url);

/**
 * Two copies of the action list live where they cannot import it: a CHECK
 * constraint the database enforces, and a label map the portal renders. A
 * control plane that writes an action its own database refuses is not caught by
 * anything else -- the in-memory store used by the rest of the suite accepts
 * every string, so the mismatch only appears against real PostgreSQL.
 */
describe("audit actions", () => {
  it("are all permitted by the constraint the database enforces", async () => {
    const sql = await readFile(fileURLToPath(new URL("migrations/003_audit_actions.sql", root)), "utf8");
    const list = sql.slice(sql.indexOf("CHECK (action IN ("));
    const allowed = new Set([...list.matchAll(/'([a-z.]+)'/gu)].map((match) => match[1]));
    assert.deepEqual([...allowed].sort(), [...AUDIT_ACTIONS].sort(),
      "the migration must permit exactly the actions the control plane writes");
  });

  it("all have a label the portal can render", async () => {
    const source = await readFile(fileURLToPath(new URL("public/i18n.js", root)), "utf8");
    const map = source.slice(source.indexOf("AUDIT_MESSAGE_KEYS"));
    const keys = new Map([...map.slice(0, map.indexOf("});")).matchAll(/"([a-z.]+)":\s*"([\w.]+)"/gu)]
      .map((match) => [match[1], match[2]] as const));
    assert.deepEqual([...keys.keys()].sort(), [...AUDIT_ACTIONS].sort());

    // Every label needs a string in each locale, not just in whichever one was
    // edited: a missing translation renders the key itself to that reader.
    const locales = { en: source.slice(source.indexOf("\n  en: {"), source.indexOf("\n  ko: {")),
      ko: source.slice(source.indexOf("\n  ko: {")) };
    for (const key of keys.values()) {
      for (const [locale, block] of Object.entries(locales)) {
        assert.ok(block.includes(`"${key}":`), `${key} has no ${locale} translation`);
      }
    }
  });
});

/**
 * The portal's type list is a third copy of RECORD_TYPES, in HTML that nothing
 * compiles. A type added to the domain and not here is one an operator can
 * reach through the API and the command line but not the portal, which reads as
 * the type not being supported.
 */
describe("record types", () => {
  it("are all offered by the portal", async () => {
    const html = await readFile(fileURLToPath(new URL("public/index.html", root)), "utf8");
    const select = html.slice(html.indexOf('<select name="type">'));
    const offered = [...select.slice(0, select.indexOf("</select>")).matchAll(/<option>([A-Z]+)<\/option>/gu)]
      .map((match) => match[1]);
    assert.deepEqual([...offered].sort(), [...RECORD_TYPES].sort());
  });

  it("lets the portal offer the proxy on exactly the types that can carry it", async () => {
    // The portal disables the checkbox for types a proxy cannot stand in front
    // of. Its list is a copy of the domain's rule, and a copy that drifts here
    // offers an option the server then refuses.
    const app = await readFile(fileURLToPath(new URL("public/app.js", root)), "utf8");
    const line = app.slice(app.indexOf("function syncProxyAvailability"));
    const listed = [...line.slice(0, line.indexOf("}")).matchAll(/"([A-Z]+)"/gu)].map((match) => match[1] as string);
    assert.deepEqual(listed.sort(), RECORD_TYPES.filter(canBeProxied).sort());
  });
});
