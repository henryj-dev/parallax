import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The portal is plain JavaScript that nothing compiles, so a call to a name
 * that does not exist, or a store command that was renamed, is a valid file
 * that throws the moment that code path runs. The other tests over these files
 * read them as text and cannot see it.
 *
 * `store.d.ts` is what makes the answer useful: it declares the commands and
 * the parts of the state the view reads by name, so a mismatch between the view
 * and the store is a compile error rather than a blank panel.
 */
describe("portal types", () => {
  it("type-checks cleanly", async () => {
    const output = await run("node_modules/.bin/tsc", ["-p", "tsconfig.portal.json"], { cwd: root })
      .then(() => "", (error: { stdout?: string }) => error.stdout ?? "");
    const errors = output.split("\n").filter((line) => line.startsWith("public/"));
    assert.deepEqual(errors, [], `the portal does not type-check:\n${errors.join("\n")}`);
  });
});
