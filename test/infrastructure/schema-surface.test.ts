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

/** The paths the README tells a deployment to diff, taken from the README. */
async function documentedPaths(): Promise<string[]> {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  const command = /git diff --name-only [^\n]*? -- ([^\n]+)/u.exec(readme);
  assert.ok(command, "the README must document the schema-change check");
  return (command[1] as string).trim().split(/\s+/u);
}

describe("where the schema can be changed from", () => {
  it("keeps every DDL statement inside the paths the check watches", async () => {
    const watched = await documentedPaths();
    const files = await typescriptFiles(join(ROOT, "src"));
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
    const watched = await documentedPaths();
    const candidates = watched.filter((path) => path.endsWith(".ts"));
    assert.ok(candidates.length > 0, "the check must watch at least one source file");

    const holding: string[] = [];
    for (const path of candidates) {
      const source = await readFile(join(ROOT, path), "utf8");
      if (DDL.test(source)) holding.push(path);
    }
    assert.ok(holding.length > 0, `none of ${candidates.join(", ")} holds DDL; has it moved?`);
  });

  it("watches the directory the .sql files are in", async () => {
    const watched = await documentedPaths();
    const sql = (await readdir(join(ROOT, "migrations"))).filter((name) => name.endsWith(".sql"));
    assert.ok(sql.length > 0, "there are migrations to watch");
    assert.ok(watched.some((path) => path.replace(/\/$/u, "") === "migrations"),
      "the check must cover the migrations directory");
  });
});
