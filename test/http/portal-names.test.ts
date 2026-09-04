import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Bounded, like every other place a child is awaited here.
 *
 * This file was missed when those bounds went in, because that sweep searched
 * for the name the other files gave the function rather than for the thing
 * itself -- and this one called it `run`. It is `tsc` now, which is no more
 * greppable; what makes the bound findable is that there is one of it.
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

/** What a failed `tsc` leaves behind: its streams, and whether it ever finished. */
interface FailedRun extends NodeJS.ErrnoException {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly killed?: boolean;
  readonly signal?: NodeJS.Signals | null;
  /** Set by the deadline in `tsc()`, which is the only thing that can know. */
  readonly outOfTime?: boolean;
}

/**
 * Whether `tsc` reached its own exit rather than being stopped.
 *
 * `error.stdout !== undefined` used to stand for this and could not: the
 * rejection object **always** carries `stdout`, `""` for a child that produced
 * nothing, so the guard was true in exactly the cases it was written to catch.
 * A `tsc` that did not run hands back an empty string, an empty string parses
 * into an empty list of problems, and an empty list read as "the portal
 * type-checks". What separates the two is the exit: a number means `tsc`
 * finished and said no, while `outOfTime`/`killed`/`signal` mean it was
 * stopped and a string code (`ENOENT`) means it never started.
 */
function completed(error: FailedRun): boolean {
  return !error.outOfTime && !error.killed && !error.signal && typeof error.code === "number";
}

/**
 * One `tsc`, bounded by a deadline this file **owns**, and reachable afterwards.
 *
 * `execFile`'s own `timeout` cannot be used for this, and the reason is the
 * whole defect one layer down. It sends SIGTERM; `tsc` installs a handler and
 * exits **0**; `execFile` sees a zero exit and reports **success**, with empty
 * output. Measured here: `tsc -p tsconfig.portal.json` with `timeout: 100` on a
 * check that needs ~350ms calls back with `error === null` and no stdout. So a
 * `tsc` that was killed mid-compile never reached the rejection path at all --
 * every guard written there, old or new, was reasoning about a branch the
 * killed case does not take. A SIGKILL sent from here cannot be caught, and the
 * flag says which run it was, so a stopped check is a failure with a name.
 *
 * The kill is also the teardown this file lacked. `promisify(execFile)` handed
 * back a promise and dropped the child, so nothing here could end either
 * process; a run the test runner abandons first left a `tsc` behind.
 */
function tsc(t: TestContext, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  let child!: ChildProcess;
  let outOfTime = false;
  const finished = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child = execFile("node_modules/.bin/tsc", [...args], { cwd: root }, (error, stdout, stderr) => {
      if (outOfTime) {
        reject(Object.assign(new Error(`tsc exceeded ${TSC_TIMEOUT_MS}ms`), { outOfTime, stdout, stderr }));
      } else if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
  const deadline = setTimeout(() => { outOfTime = true; child.kill("SIGKILL"); }, TSC_TIMEOUT_MS);
  t.after(() => { clearTimeout(deadline); child.kill("SIGKILL"); });
  return finished;
}

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
  it("type-checks cleanly", async (t) => {
    // The control. No errors is what a clean check gives, what a check that
    // read no portal files gives, and -- before this -- what a `tsc` that never
    // started gave, because the rejection carried no stdout to parse and an
    // absent string parses into an empty list of problems.
    const listed = await tsc(t, ["-p", "tsconfig.portal.json", "--listFilesOnly"]);
    const read = listed.stdout.split("\n").filter((line) => line.includes("/public/"));
    assert.ok(read.length > 0, "tsc must be reading the portal, or a clean answer below is not about the portal");

    const checked = await tsc(t, ["-p", "tsconfig.portal.json"])
      .then(() => ({ failed: false, output: "", ran: true, why: "" }),
        (error: FailedRun) => ({
          failed: true,
          output: error.stdout ?? "",
          ran: completed(error),
          why: `code=${String(error.code)} signal=${String(error.signal)} killed=${String(error.killed)} `
            + `outOfTime=${String(error.outOfTime === true)}: ${error.message}`,
        }));
    assert.ok(checked.ran, `tsc did not run to completion (${checked.why}); a check that never started is not a check that passed`);

    // And the last control: on a clean tree there are no errors to find, so a
    // parse that recognises nothing looks exactly like a portal with nothing
    // wrong. One line of real `tsc` output settles which it is.
    assert.deepEqual(problemsIn(SAMPLE_PROBLEM), [SAMPLE_PROBLEM],
      "the parse must recognise a tsc error, or finding none below is not evidence");

    const errors = problemsIn(checked.output);
    // A `tsc` that exited non-zero and said nothing this parse recognises has
    // not reported a clean portal -- it has reported something in a form this
    // test cannot read, a `-p` that resolved nowhere or a config diagnostic
    // that never mentions a file. Reading that silence as "no problems" is the
    // same mistake one layer further in.
    assert.ok(!checked.failed || errors.length > 0,
      `tsc failed (${checked.why}) with output this parse does not recognise:\n${checked.output.trim() || "(none)"}`);
    assert.deepEqual(errors, [], `the portal does not type-check:\n${errors.join("\n")}`);
  });
});
