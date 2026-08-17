import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "../../scripts/what-ships.sh");
const TIMEOUT_MS = 60_000;

/**
 * Two lines of this script's output are a machine interface.
 *
 * A deployment's gate runs it and greps stdout for `실립니다` and for
 * `실리는 변경 없음` -- the first decides whether a human has to approve the
 * release, the second is what "measured, nothing ships" looks like. Rewording
 * either does not make that gate wrong; it makes the answer *absent*, and the
 * verdict line simply stops being printed on their side.
 *
 * So the wording is pinned here rather than left to whoever next edits the
 * script. It is the same shape as the preflight's properties: their procedure
 * rests on something of ours, and until this existed nothing on this side held
 * it still.
 *
 * The fixture is its own repository. The script asks git for the root, so it
 * runs anywhere -- and building the case here rather than pointing at real
 * commits means the test does not depend on this repository's history.
 */
describe("what a deployment greps for", () => {
  let repo: string;

  async function git(...args: string[]): Promise<void> {
    await execFileAsync("git", ["-C", repo, ...args], {
      timeout: TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  }

  async function run(range: string): Promise<string> {
    const { stdout } = await execFileAsync("bash", [SCRIPT, range], { cwd: repo, timeout: TIMEOUT_MS });
    return stdout;
  }

  /** Runs it and reports the exit code instead of throwing on a non-zero one. */
  async function status(range: string): Promise<number> {
    try {
      await execFileAsync("bash", [SCRIPT, range], { cwd: repo, timeout: TIMEOUT_MS });
      return 0;
    } catch (error) {
      return (error as { code?: number }).code ?? -1;
    }
  }

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "parallax-ships-"));
    await git("init", "-q", "--initial-branch=main");
    // Two stages, so the test also covers the rule that only the last one
    // counts: the builder copies everything, the image copies `public`.
    await writeFile(join(repo, "Dockerfile"),
      "FROM node AS build\nCOPY . .\nRUN true\n\nFROM node\nCOPY --from=build /app/dist ./dist\nCOPY public ./public\n");
    await mkdir(join(repo, "public"), { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "public/app.js"), "one\n");
    await writeFile(join(repo, "src/index.ts"), "one\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "src/index.ts"), "two\n");
    await git("commit", "-qam", "source only");
    await writeFile(join(repo, "public/app.js"), "two\n");
    await git("commit", "-qam", "portal too");
  });

  after(async () => { await rm(repo, { recursive: true, force: true }); });

  it("says `실리는 변경 없음` when nothing in the image changed", async () => {
    const out = await run("HEAD~2..HEAD~1");
    assert.match(out, /실리는 변경 없음/u, "the gate reads this as measured-and-clean");
    assert.doesNotMatch(out, /🔴 실립니다/u, "and must not also say the opposite");
  });

  it("says `실립니다` when something in the image changed", async () => {
    const out = await run("HEAD~1..HEAD");
    assert.match(out, /실립니다/u, "the gate reads this as needing a human");
    assert.doesNotMatch(out, /실리는 변경 없음/u, "and must not also say the opposite");
  });

  it("keeps the two answers mutually exclusive", async () => {
    // The gate tests for `실립니다` first and falls through to the other, so a
    // range that produced both would be approved-by-human when it should have
    // been clean, or the reverse -- depending only on the order of its ifs.
    for (const range of ["HEAD~2..HEAD~1", "HEAD~1..HEAD", "HEAD~2..HEAD"]) {
      const out = await run(range);
      const ships = /실립니다/u.test(out);
      const clean = /실리는 변경 없음/u.test(out);
      assert.notEqual(ships, clean, `${range} answered both or neither`);
    }
  });


  it("exits 0 whether something ships or not, which is what its one consumer relies on", async () => {
    // "Something ships" is an observation, not a failure, so both answers are a
    // successful run and the wording carries the result. stardust measured that
    // and built their gate on the strings alone.
    //
    // ⚠️ There is exactly one known consumer: stardust's release gate, which
    // greps this output and treats a non-zero exit as "could not measure". If a
    // second consumer ever wants exit codes to carry the answer, splitting them
    // is a change to a published interface -- that gate has to be told, and the
    // wording has to keep working, or their ④ stops producing a verdict at all.
    //
    // They cannot see this coming: how many consumers exist is a fact only this
    // side holds. So the current contract is pinned here rather than left to a
    // promise to remember.
    assert.equal(await status("HEAD~2..HEAD~1"), 0, "clean range");
    assert.equal(await status("HEAD~1..HEAD"), 0, "shipping range");
  });

  it("counts only the last stage, so the builder's `COPY . .` does not ship everything", async () => {
    // Without that rule every file would match and the first test above would
    // fail -- but stated on its own, because it is the reason the answer is
    // usable at all.
    const out = await run("HEAD~2..HEAD~1");
    assert.match(out, /^이미지에 실리는 경로\(Dockerfile 에서 읽음\): public$/mu);
  });
});
