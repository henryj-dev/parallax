import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PORTAL_ASSETS } from "../../src/http/portal-assets.ts";

const PUBLIC = join(import.meta.dirname, "../../public");

/**
 * The portal declares what it needs and the server declares what it will serve,
 * and nothing made those two agree. Adding a module to the portal without adding
 * it here does not degrade: the browser's first import 404s, the module graph
 * fails, and the whole page is blank -- while the server is healthy, the API
 * answers, and every other test passes.
 *
 * That shipped. `panels.js` was added, the allowlist was not, and the live
 * portal was dead until somebody fetched the file by hand and read `Not found`.
 */
describe("every module the portal imports is served", () => {
  it("serves each relative import declared by a portal script", async () => {
    const scripts = (await readdir(PUBLIC)).filter((name) => name.endsWith(".js"));
    assert.ok(scripts.length > 0, "the portal has scripts to check");

    const missing: string[] = [];
    for (const script of scripts) {
      const source = await readFile(join(PUBLIC, script), "utf8");
      for (const match of source.matchAll(/(?:^|\s)(?:import|export)[^;]*?from\s+"(\.\/[^"]+)"/gu)) {
        const specifier = (match[1] as string).replace(/^\.\//u, "");
        if (!PORTAL_ASSETS.has(`/${specifier}`)) missing.push(`${script} imports ${specifier}`);
      }
    }
    assert.deepEqual(missing, [], "a portal module imports something the server will not serve");
  });

  it("serves each script the page itself loads", async () => {
    const html = await readFile(join(PUBLIC, "index.html"), "utf8");
    const sources = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/gu)].map((match) => match[1] as string);
    for (const source of sources) {
      if (/^https?:/u.test(source)) continue;
      assert.ok(PORTAL_ASSETS.has(source.startsWith("/") ? source : `/${source}`), `index.html loads ${source}`);
    }
  });

  it("has a file on disk behind every entry it offers", async () => {
    // The other direction: an entry naming a file that is not there answers 500
    // on a path the page is told to fetch.
    const present = new Set(await readdir(PUBLIC));
    for (const [route, asset] of PORTAL_ASSETS) {
      assert.ok(present.has(asset.file), `${route} points at ${asset.file}, which is not in public/`);
    }
  });
});
