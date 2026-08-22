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
/** Counting a second way, so the first way has to still be counting. */
function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe("every module the portal imports is served", () => {
  it("serves each relative import declared by a portal script", async () => {
    const scripts = (await readdir(PUBLIC)).filter((name) => name.endsWith(".js"));
    assert.ok(scripts.length > 0, "the portal has scripts to check");

    const missing: string[] = [];
    let matched = 0;
    let plain = 0;
    for (const script of scripts) {
      const source = await readFile(join(PUBLIC, script), "utf8");
      plain += occurrences(source, 'from "./');
      for (const match of source.matchAll(/(?:^|\s)(?:import|export)[^;]*?from\s+"(\.\/[^"]+)"/gu)) {
        matched += 1;
        const specifier = (match[1] as string).replace(/^\.\//u, "");
        if (!PORTAL_ASSETS.has(`/${specifier}`)) missing.push(`${script} imports ${specifier}`);
      }
    }
    // An empty `missing` is what a working scan gives and what a scan that read
    // nothing gives, and the assertion below cannot tell them apart. Measured:
    // stop the pattern matching and this file stayed green -- the guard that
    // exists because a live portal went blank would have been gone, silently.
    assert.ok(plain > 0, "the portal imports its own modules; finding none means this stopped looking");
    assert.equal(matched, plain, "the pattern and a plain count of `from \"./` disagree, so the pattern is missing imports");
    assert.deepEqual(missing, [], "a portal module imports something the server will not serve");
  });

  it("serves each script and stylesheet the pages themselves load", async () => {
    // Every page, not just the portal's. The reference page is a second document
    // with its own script and its own stylesheet, and naming `index.html` here
    // would have left it with exactly the gap this file exists to close.
    const pages = (await readdir(PUBLIC)).filter((name) => name.endsWith(".html"));
    assert.ok(pages.length > 1, "the server has more than one page to check");

    for (const page of pages) {
      const html = await readFile(join(PUBLIC, page), "utf8");
      const sources = [
        ...[...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/gu)].map((match) => match[1] as string),
        ...[...html.matchAll(/<link[^>]*\shref="([^"]+)"/gu)].map((match) => match[1] as string),
      ];
      // Same shape as above, one worse: an empty list makes the loop below run
      // zero times, so the test asserts nothing at all and still passes.
      // Counting the tags a different way is what makes the loop's silence mean
      // something.
      const carryingSrc = [...html.matchAll(/<script\b[^>]*>/gu)].filter((tag) => tag[0].includes("src=")).length
        + [...html.matchAll(/<link\b[^>]*>/gu)].filter((tag) => tag[0].includes("href=")).length;
      assert.ok(carryingSrc > 0, `${page} loads at least one script or stylesheet`);
      assert.equal(sources.length, carryingSrc, `${page} carries a src or href this did not read`);
      for (const source of sources) {
        if (/^https?:/u.test(source)) continue;
        assert.ok(PORTAL_ASSETS.has(source.startsWith("/") ? source : `/${source}`), `${page} loads ${source}`);
      }
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
