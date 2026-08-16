import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "../..");

/**
 * Keeps the schema-change check honest about where schema lives.
 *
 * A deployment that replaces pods one at a time runs two versions at once for a
 * few seconds, so it needs to know whether a release changes the schema. The
 * README answers that with a `git diff` over two paths, and those two paths were
 * complete when they were written -- which is a fact about the tree that day,
 * not a property anything enforces.
 *
 * That is the dangerous direction. Move the `CREATE TABLE` into another file and
 * the command keeps returning nothing, and nothing means "safe to overlap". The
 * check would not break; it would start lying, on the one release where it
 * mattered.
 *
 * So the paths are read out of the documented command rather than repeated here.
 * A third copy of the same fact is what this whole class of failure is made of.
 */
const DDL = /\b(?:create\s+(?:unique\s+)?(?:table|index)|alter\s+table|drop\s+(?:table|index))\b/iu;

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await typescriptFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

/**
 * Every way a module can be reached, in one place so it can be tested.
 *
 * A scan that finds nothing and a scan that is broken give the same answer --
 * an empty list -- and an assertion that the list holds no packages cannot tell
 * those apart. Inline, it could not be run over anything but the file itself,
 * so there was no way to show it still worked. Measured: breaking the static
 * pattern left all four assertions green while the guard was dead.
 */
function specifiersIn(source: string): string[] {
  return [
    ...source.matchAll(/^import[^"']*["']([^"']+)["']/gmu),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/gu),
    ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/gu),
  ].map((match) => match[1] as string);
}

/**
 * One sample holding all three forms -- the control.
 *
 * Builtins only, deliberately: this file scans its own source, so a sample
 * naming a package would be found there and reported as the very thing the
 * scan exists to forbid.
 */
const EVERY_FORM = [
  'import { readFile } from "node:fs"',
  'await import("node:os")',
  'require("node:url")',
].join("\n");

/** Every document that states the check, and the paths each one states. */
const DOCUMENTS = ["README.md", "README.ko.md"] as const;

async function documentedPaths(file: string): Promise<string[]> {
  const readme = await readFile(join(ROOT, file), "utf8");
  const command = /git diff --name-only [^\n]*? -- ([^\n]+)/u.exec(readme);
  assert.ok(command, `${file} must document the schema-change check`);
  return (command[1] as string).trim().split(/\s+/u);
}

/**
 * The paths, once, after checking that every document agrees on them.
 *
 * Reading one document was the same mistake one translation down. The command a
 * deployment actually ran came out of the Korean README, and dropping a path
 * from that copy alone left every assertion here passing -- a third copy avoided
 * and then walked back in through the translation.
 */
async function agreedPaths(): Promise<string[]> {
  const stated = await Promise.all(DOCUMENTS.map(async (file) => [file, await documentedPaths(file)] as const));
  const [first, ...rest] = stated;
  assert.ok(first, "there is at least one document to read");
  for (const [file, paths] of rest) {
    assert.deepEqual(paths, first[1], `${file} states different paths from ${first[0]}; a stale translation is a stale check`);
  }
  return first[1];
}

describe("where the schema can be changed from", () => {
  it("keeps every DDL statement inside the paths the check watches", async () => {
    const watched = await agreedPaths();
    // `cmd/` is thin and is not where schema would live, but it is compiled and
    // copied into the image, so a statement there would ship and the check would
    // not see it. Scanning it costs nothing and stops the name from promising
    // more than the body does.
    const files = (await Promise.all(["src", "cmd"].map((directory) => typescriptFiles(join(ROOT, directory))))).flat();
    assert.ok(files.length > 0, "there is source to scan");

    const stray: string[] = [];
    for (const file of files) {
      const relative = file.slice(ROOT.length + 1);
      if (watched.some((path) => relative === path || relative.startsWith(path.replace(/\/?$/u, "/")))) continue;
      const source = await readFile(file, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        if (DDL.test(line)) stray.push(`${relative}:${index + 1}`);
      }
    }
    assert.deepEqual(stray, [], "DDL outside the watched paths would make the check answer 'no schema change' wrongly");
  });

  it("watches a path that actually holds DDL, so the check is not vacuous", async () => {
    // If the DDL moved and the README moved with it, the test above still
    // passes and proves nothing. This asserts the watched set is where the
    // schema really is: at least one watched path contains a statement.
    const watched = await agreedPaths();
    const candidates = watched.filter((path) => path.endsWith(".ts"));
    assert.ok(candidates.length > 0, "the check must watch at least one source file");

    const holding: string[] = [];
    for (const path of candidates) {
      const source = await readFile(join(ROOT, path), "utf8");
      if (DDL.test(source)) holding.push(path);
    }
    assert.ok(holding.length > 0, `none of ${candidates.join(", ")} holds DDL; has it moved?`);
  });

  it("runs without anything installed, because a deployment gate depends on that", async () => {
    // stardust runs this file straight from a checkout, with no `pnpm install`,
    // as the first half of its push gate: pass this, then trust the `git diff`.
    // A single import of a package would make that gate stop running without
    // announcing it -- the failure would be silence at the moment of a deploy.
    //
    // Every way in, not only the one at the top of the file. A static `import`
    // is what a reader looks for; `await import(…)` and `require(…)` reach the
    // same package and were invisible to an earlier version of this assertion.
    // On a machine with the packages installed -- which is where this is
    // written -- that version passed while the gate it protects would have died.
    // The control comes first: silence from the scan means nothing until the
    // scan is shown to speak.
    assert.deepEqual([...specifiersIn(EVERY_FORM)].sort(), ["node:fs", "node:os", "node:url"],
      "the scan must find all three ways in, or its empty answer below is not evidence");

    const source = await readFile(join(ROOT, "test/infrastructure/schema-surface.test.ts"), "utf8");
    const external = specifiersIn(source).filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith("."));
    assert.deepEqual(external, [], "this file may reach node builtins and relative paths only, by any means");
  });

  it("watches the directory the .sql files are in", async () => {
    const watched = await agreedPaths();
    const sql = (await readdir(join(ROOT, "migrations"))).filter((name) => name.endsWith(".sql"));
    assert.ok(sql.length > 0, "there are migrations to watch");
    assert.ok(watched.some((path) => path.replace(/\/$/u, "") === "migrations"),
      "the check must cover the migrations directory");
  });
});
