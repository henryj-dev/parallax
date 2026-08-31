import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Bounded, like every other place a child is awaited here.
 *
 * This file was missed when those bounds went in, because that sweep searched
 * for the name the other files gave the function rather than for the thing
 * itself -- and this one calls it `run`.
 */
/**
 * `tsc` 하나에 허용하는 시간. **러너의 마감보다 짧아야 한다.**
 *
 * `pnpm test` 는 `--test-timeout=120000` 으로 돈다. 이 값이 그것과 **같으면** 두 마감이
 * 경합하고, 먼저 시작한 러너가 대개 이긴다 — 그러면 결과는 「`tsc` 가 시간 안에 끝나지
 * 않았다」가 아니라 **취소된 테스트**이고, 취소된 테스트는 왜 취소됐는지 말하지 않는다.
 *
 * 90초로 두면 `tsc` 가 걸렸을 때 이 파일이 먼저 답한다. 실제 소요는 0.5초 안쪽이라
 * (측정 2026-08-31) 여유는 문제가 아니고, 문제는 **누가 먼저 말하느냐**였다.
 */
const TSC_TIMEOUT_MS = 90_000;

/** How a problem is picked out of `tsc` output, in one place so it can be tested. */
function problemsIn(output: string): string[] {
  return output.split("\n").filter((line) => line.startsWith("public/"));
}

/** One line of real `tsc` output -- the sample the parse has to recognise. */
const SAMPLE_PROBLEM = "public/app.js(12,3): error TS2339: Property 'nope' does not exist on type 'Store'.";

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
    // The control. No errors is what a clean check gives, what a check that
    // read no portal files gives, and -- before this -- what a `tsc` that never
    // started gave, because the rejection carried no stdout to parse and an
    // absent string parses into an empty list of problems.
    const listed = await run("node_modules/.bin/tsc",
      ["-p", "tsconfig.portal.json", "--listFilesOnly"], { cwd: root, timeout: TSC_TIMEOUT_MS });
    const read = listed.stdout.split("\n").filter((line) => line.includes("/public/"));
    assert.ok(read.length > 0, "tsc must be reading the portal, or a clean answer below is not about the portal");

    const checked = await run("node_modules/.bin/tsc", ["-p", "tsconfig.portal.json"], { cwd: root, timeout: TSC_TIMEOUT_MS })
      .then(() => ({ ran: true, output: "", code: undefined as unknown }),
        (error: { stdout?: string; code?: unknown }) => ({ ran: error.stdout !== undefined, output: error.stdout ?? "", code: error.code }));
    assert.ok(checked.ran, `tsc did not run (${String(checked.code)}); a check that never started is not a check that passed`);

    // And the last control: on a clean tree there are no errors to find, so a
    // parse that recognises nothing looks exactly like a portal with nothing
    // wrong. One line of real `tsc` output settles which it is.
    assert.deepEqual(problemsIn(SAMPLE_PROBLEM), [SAMPLE_PROBLEM],
      "the parse must recognise a tsc error, or finding none below is not evidence");

    const errors = problemsIn(checked.output);
    assert.deepEqual(errors, [], `the portal does not type-check:\n${errors.join("\n")}`);
  });
});
