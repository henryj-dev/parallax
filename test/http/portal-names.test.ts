import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The portal is plain JavaScript that nothing compiles, so a call to a function
 * that does not exist is a syntactically valid file that throws the moment the
 * code path runs -- and the tests that read these files as text cannot see it.
 *
 * This asks TypeScript for one class of answer only: names used but never
 * declared. The portal has other type errors, mostly parameters TypeScript
 * infers as `{}` for want of an annotation; those are worth fixing but they are
 * not defects, and gating on them would mean this check never gets turned on.
 */
describe("portal identifiers", () => {
  it("never calls a name that is not defined", async () => {
    const output = await run("node_modules/.bin/tsc", ["-p", "tsconfig.portal.json"], { cwd: root })
      .then(() => "", (error: { stdout?: string }) => error.stdout ?? "");
    const undefined_ = output.split("\n").filter((line) => line.includes("error TS2304"));
    assert.deepEqual(undefined_, [], `the portal uses names nothing defines:\n${undefined_.join("\n")}`);
  });
});
