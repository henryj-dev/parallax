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
    // The chain the script follows to narrow a whole-tree stage: the build
    // script names a tsconfig, the tsconfig names what it compiles.
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.build.json" } }));
    await writeFile(join(repo, "tsconfig.build.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
    await mkdir(join(repo, "public"), { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "public/app.js"), "one\n");
    await writeFile(join(repo, "src/index.ts"), "one\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "notes.md"), "docs\n");
    await git("add", "-A");
    await git("commit", "-qm", "docs only");
    await writeFile(join(repo, "src/index.ts"), "two\n");
    await git("commit", "-qam", "source only");
    await writeFile(join(repo, "public/app.js"), "two\n");
    await git("commit", "-qam", "portal too");
  });

  after(async () => { await rm(repo, { recursive: true, force: true }); });

  it("says `실리는 변경 없음` when nothing in the image changed", async () => {
    const out = await run("HEAD~3..HEAD~2");
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
    for (const range of ["HEAD~3..HEAD~2", "HEAD~2..HEAD~1", "HEAD~1..HEAD", "HEAD~2..HEAD"]) {
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
    assert.equal(await status("HEAD~3..HEAD~2"), 0, "clean range");
    assert.equal(await status("HEAD~1..HEAD"), 0, "shipping range");
  });

  it("follows a stage to what feeds it, narrowed by what the build compiles", async () => {
    // The final stage copies `dist` out of a builder, and the builder takes the
    // whole tree. Skipping the stage answered "nothing ships" for a release that
    // changed only sources -- silently, which is the direction that matters.
    // Following it without narrowing would call every file shipped, which is the
    // over-report that made skipping look right in the first place.
    const out = await run("HEAD~2..HEAD~1");
    assert.match(out, /^이미지에 실리는 경로\(Dockerfile 에서 읽음\): .*\bsrc\b/mu, "the build's inputs");
    assert.match(out, /^이미지에 실리는 경로\(Dockerfile 에서 읽음\): .*\bpublic\b/mu, "and the direct copy");
    assert.doesNotMatch(out, /^이미지에 실리는 경로[^\n]*(^| )\.( |$)/mu, "not the whole tree");
    // And the source-only commit is now on the shipping side of the answer.
    assert.match(out, /실립니다/u);
    assert.match(out, /src\/index\.ts/u);
  });
});

/**
 * The fallback, which is the half that had no fixture.
 *
 * When a stage takes the whole tree and the build cannot be read, the script
 * says everything ships. That is deliberately an over-report -- but the first
 * version of it matched nothing at all, so the safe answer it claimed to give
 * was silently no answer. Nothing here exercised that path, because the other
 * fixture's build chain always resolved.
 */
describe("a stage whose inputs cannot be narrowed", () => {
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

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "parallax-ships-wide-"));
    await git("init", "-q", "--initial-branch=main");
    await writeFile(join(repo, "Dockerfile"),
      "FROM node AS build\nCOPY . .\nRUN true\n\nFROM node\nCOPY --from=build /app/dist ./dist\nCOPY public ./public\n");
    // No build script to follow, so the whole tree is the honest answer.
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(repo, "public"), { recursive: true });
    await writeFile(join(repo, "public/app.js"), "one\n");
    await writeFile(join(repo, "notes.md"), "one\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "notes.md"), "two\n");
    await git("commit", "-qam", "docs only");
  });

  after(async () => { await rm(repo, { recursive: true, force: true }); });

  it("calls everything shipped rather than nothing", async () => {
    const { stdout, stderr } = await execFileAsync("bash", [SCRIPT, "HEAD~1..HEAD"], { cwd: repo, timeout: TIMEOUT_MS });
    assert.match(stderr, /빌드 입력을 못 읽었습니다/u, "and says why it widened");
    assert.match(stdout, /실립니다/u, "a file it cannot rule out is reported, not dropped");
    assert.match(stdout, /notes\.md/u);
    assert.doesNotMatch(stdout, /실리는 변경 없음/u);
  });
});

/**
 * A change to a file the answer was read out of.
 *
 * stardust noticed that `tsconfig.build.json` decides what compiles into the
 * image, and that the narrowing reads it -- so a range that moves it moves the
 * meaning of the classification, exactly as a range that moves the Dockerfile
 * does. The warning covered only the Dockerfile, because when it was written
 * that was the only file the answer came from. Adding the narrowing added two
 * more sources and left the warning behind.
 */
describe("when the list itself moved", () => {
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

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "parallax-ships-moved-"));
    await git("init", "-q", "--initial-branch=main");
    await writeFile(join(repo, "Dockerfile"),
      "FROM node AS build\nCOPY . .\nRUN true\n\nFROM node\nCOPY --from=build /app/dist ./dist\nCOPY public ./public\n");
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.build.json" } }));
    await writeFile(join(repo, "tsconfig.build.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "public"), { recursive: true });
    await writeFile(join(repo, "src/index.ts"), "one\n");
    await writeFile(join(repo, "public/app.js"), "one\n");
    await writeFile(join(repo, "notes.md"), "one\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "notes.md"), "two\n");
    await git("commit", "-qam", "docs only");
    await writeFile(join(repo, "tsconfig.build.json"), JSON.stringify({ include: ["src/**/*.ts", "cmd/**/*.ts"] }));
    await git("commit", "-qam", "what compiles changed");
  });

  after(async () => { await rm(repo, { recursive: true, force: true }); });

  it("says so when the file that decides what compiles moved", async () => {
    const out = await run("HEAD~1..HEAD");
    assert.match(out, /tsconfig\.build\.json.*바뀌었습니다/u, "names the file, not just 'something'");
    assert.match(out, /범위 내내 같지 않습니다/u);
  });

  it("stays quiet on a range that moved none of them", async () => {
    // The control: a warning on every range is a warning on none.
    const out = await run("HEAD~2..HEAD~1");
    assert.doesNotMatch(out, /범위 내내 같지 않습니다/u);
  });
});

/**
 * The file the config the build names is itself reading.
 *
 * Collecting the sources while the answer is read out of them kept the warning
 * from falling behind the files it opens -- but it only opened one link. This
 * repository's `tsconfig.build.json` extends `tsconfig.json`, so the options
 * that decide the shape of `dist` live in a file the tool never looked at: a
 * range that moved it was classified as harmless rather than reported, which is
 * the quiet direction and the one that matters. stardust found this by running
 * the fixed warning once per filename.
 */
describe("a config that reads another config", () => {
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

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "parallax-ships-extends-"));
    await git("init", "-q", "--initial-branch=main");
    await writeFile(join(repo, "Dockerfile"),
      "FROM node AS build\nCOPY . .\nRUN true\n\nFROM node\nCOPY --from=build /app/dist ./dist\nCOPY public ./public\n");
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.build.json" } }));
    // The shape this repository has: the build points at a config whose
    // compilerOptions are inherited from the one beside it.
    await writeFile(join(repo, "tsconfig.build.json"),
      JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { outDir: "dist" }, include: ["src/**/*.ts"] }));
    await writeFile(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2024" } }));
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "public"), { recursive: true });
    await writeFile(join(repo, "src/index.ts"), "one\n");
    await writeFile(join(repo, "public/app.js"), "one\n");
    await writeFile(join(repo, "notes.md"), "one\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "notes.md"), "two\n");
    await git("commit", "-qam", "docs only");
    // Nothing under a shipping path moved -- but every compiled file comes out
    // different, and the paths this tool lists cannot show that.
    await writeFile(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2015" } }));
    await git("commit", "-qam", "what the compiler emits changed");
  });

  after(async () => { await rm(repo, { recursive: true, force: true }); });

  it("says so when the config that the named one extends moved", async () => {
    const out = await run("HEAD~1..HEAD");
    assert.match(out, /tsconfig\.json.*바뀌었습니다/u, "the parent is a file the answer came from too");
    assert.match(out, /범위 내내 같지 않습니다/u);
  });

  it("stays quiet on a range that moved neither of them", async () => {
    // The control again, for the link that was just added: a chain that reports
    // every range would have replaced a blind spot with a blindfold.
    const out = await run("HEAD~2..HEAD~1");
    assert.doesNotMatch(out, /범위 내내 같지 않습니다/u);
  });
});

/**
 * The other half of following the chain: reading it, not just recording it.
 *
 * A child that leaves `include` to its parent used to stop the narrowing dead,
 * and the whole tree was reported instead -- safe, but it called every docs
 * commit a shipping one. Walking to the parent answers it properly, and the
 * same walk is what makes the warning above see that file at all.
 */
describe("an include that lives in the parent config", () => {
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

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "parallax-ships-inherit-"));
    await git("init", "-q", "--initial-branch=main");
    await writeFile(join(repo, "Dockerfile"),
      "FROM node AS build\nCOPY . .\nRUN true\n\nFROM node\nCOPY --from=build /app/dist ./dist\nCOPY public ./public\n");
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.build.json" } }));
    await writeFile(join(repo, "tsconfig.build.json"),
      JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { outDir: "dist" } }));
    await writeFile(join(repo, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "public"), { recursive: true });
    await writeFile(join(repo, "src/index.ts"), "one\n");
    await writeFile(join(repo, "public/app.js"), "one\n");
    await writeFile(join(repo, "notes.md"), "one\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "notes.md"), "two\n");
    await git("commit", "-qam", "docs only");
  });

  after(async () => { await rm(repo, { recursive: true, force: true }); });

  it("narrows by what the parent compiles instead of widening to everything", async () => {
    const { stdout, stderr } = await execFileAsync("bash", [SCRIPT, "HEAD~1..HEAD"], { cwd: repo, timeout: TIMEOUT_MS });
    assert.doesNotMatch(stderr, /빌드 입력을 못 읽었습니다/u, "the chain resolves, so nothing had to be widened");
    assert.match(stdout, /^이미지에 실리는 경로\(Dockerfile 에서 읽음\): .*\bsrc\b/mu, "the parent's inputs");
    assert.doesNotMatch(stdout, /^이미지에 실리는 경로[^\n]*(^| )\.( |$)/mu, "not the whole tree");
    assert.match(stdout, /실리는 변경 없음/u, "and a docs commit is not a release");
  });
});

/**
 * A link that cannot be followed.
 *
 * The chain is walked, not guessed at: a parent that is not there, or one named
 * by a package that is not installed, leaves the tool unable to say what
 * compiles. The rule that already governs the rest of this chain applies --
 * report everything rather than nothing, loudly.
 */
describe("a parent config that cannot be read", () => {
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

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "parallax-ships-broken-"));
    await git("init", "-q", "--initial-branch=main");
    await writeFile(join(repo, "Dockerfile"),
      "FROM node AS build\nCOPY . .\nRUN true\n\nFROM node\nCOPY --from=build /app/dist ./dist\nCOPY public ./public\n");
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.build.json" } }));
    // An include is right there, and it is still not the answer: what the
    // missing parent would have said cannot be known.
    await writeFile(join(repo, "tsconfig.build.json"),
      JSON.stringify({ extends: "@tsconfig/absent/tsconfig.json", include: ["src/**/*.ts"] }));
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "public"), { recursive: true });
    await writeFile(join(repo, "src/index.ts"), "one\n");
    await writeFile(join(repo, "public/app.js"), "one\n");
    await writeFile(join(repo, "notes.md"), "one\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    await writeFile(join(repo, "notes.md"), "two\n");
    await git("commit", "-qam", "docs only");
  });

  after(async () => { await rm(repo, { recursive: true, force: true }); });

  it("calls everything shipped rather than trusting the half it could read", async () => {
    const { stdout, stderr } = await execFileAsync("bash", [SCRIPT, "HEAD~1..HEAD"], { cwd: repo, timeout: TIMEOUT_MS });
    assert.match(stderr, /빌드 입력을 못 읽었습니다/u, "and says why it widened");
    assert.match(stdout, /실립니다/u);
    assert.match(stdout, /notes\.md/u);
    assert.doesNotMatch(stdout, /실리는 변경 없음/u);
  });
});
