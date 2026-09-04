import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { usage } from "../../src/cli/argv.ts";
import { buildOpenApiDocument } from "../../src/http/openapi.ts";
import { RECORD_TYPES } from "../../src/domain/dns.ts";

/**
 * The counts both READMEs state about this control plane, re-derived rather than
 * re-read.
 *
 * Three of them were measured against the code and one was wrong: the command
 * count said 47 and the table held 49, in four places across two languages. The
 * paths count beside it was right, and so were the route and record-type counts
 * -- the difference is that `schema-surface.test.ts` re-derives the paths and
 * nothing re-derived the rest.
 *
 * That is the whole finding, and it is the same one this repository keeps making
 * about itself: an enforced fact survives and an unenforced one rots quietly, in
 * whichever document nobody had a reason to reopen. So these are enforced. A
 * count that changes fails here first, in the place that knows the new number,
 * instead of in a reader's head six months later.
 *
 * Deliberately not asserted: the prose around each number. A test that pinned
 * sentences would fail on every edit and be deleted within a month.
 */
const DOCUMENTS = ["README.md", "README.ko.md"] as const;

/**
 * The documents that describe the CI layout in prose, which is a **wider set**
 * than the two READMEs above.
 *
 * Measured 2026-09-04, and this is why the set grew. `CONTRIBUTING.md` still
 * said "Five workflows" and listed `scripts`, `docker` and `dependency-review`
 * as separate files -- a layout `#9` dissolved into jobs. It also promised
 * "None of them need secrets, so they all run on a pull request from a fork",
 * which `check.yml` has contradicted since the policy layer moved out. That is
 * the document an outside contributor reads first, and it had been wrong for
 * days. `AGENTS.md` said seven jobs when there were eight.
 *
 * Both were outside `DOCUMENTS` and so outside every check. The READMEs, which
 * were inside it, were correct. That is the whole argument: the mechanism
 * worked exactly as far as it was pointed, and no further.
 *
 * Deliberately *not* added to `DOCUMENTS` itself: those two do not restate the
 * command, path or record-type counts, so asserting those here would fail on a
 * document that never made the claim.
 */
const CI_DOCUMENTS = [...DOCUMENTS, "CONTRIBUTING.md", "AGENTS.md"] as const;

async function read(name: string): Promise<string> {
  return readFile(new URL(`../../${name}`, import.meta.url), "utf8");
}

/** Every distinct integer that appears in the document, as strings. */
function numbersIn(text: string): Set<string> {
  return new Set([...text.matchAll(/\d+/gu)].map((match) => match[0]));
}

describe("what the READMEs count", () => {
  it("states the number of commands `parallax help` actually lists", async () => {
    // The one that was wrong. Both languages say it twice -- once in the
    // architecture diagram, once above the command tables -- so all four have to
    // move together, which is why counting them here is worth more than fixing
    // them once.
    //
    // Counted from `usage()` rather than from the command table, because the two
    // differ by one and the documented number is the one a reader can check:
    // `config check` is answered before a runtime exists, so it is not in the
    // table, and `usage()` appends it because a listing that leaves it out is a
    // listing somebody trusts.
    const listing = usage().split("\n");
    const start = listing.indexOf("commands:");
    assert.notEqual(start, -1, "`usage()` must list its commands under a heading");
    const commands = listing.slice(start + 1).filter((line) => /^ {2}\S/u.test(line)).length;
    assert.ok(commands > 0, "the listing must not be empty");
    for (const name of DOCUMENTS) {
      const text = await read(name);
      const claims = [...text.matchAll(/(\d+)(?: commands|개 명령)/gu)].map((match) => match[1]);
      assert.equal(claims.length, 2, `${name} states the command count twice`);
      for (const claim of claims) {
        assert.equal(claim, String(commands), `${name} states ${claim} commands; \`help\` lists ${commands}`);
      }
    }
  });

  it("states the number of paths the generated document actually describes", async () => {
    const paths = Object.keys(buildOpenApiDocument().paths ?? {}).length;
    assert.ok(paths > 0);
    for (const name of DOCUMENTS) {
      const text = await read(name);
      const claims = [...text.matchAll(/\*\*(\d+) ?(?:paths|개 경로)/gu)].map((match) => match[1]);
      assert.equal(claims.length, 1, `${name} states the path count once`);
      assert.equal(claims[0], String(paths), `${name} states ${claims[0]} paths; the document describes ${paths}`);
    }
  });

  it("states the number of record types the validator actually accepts", async () => {
    // Matched loosely, because the two languages phrase it differently -- "23
    // types" and "23종". What matters is that the number is present at all,
    // which a wrong one would not be.
    for (const name of DOCUMENTS) {
      const text = await read(name);
      assert.ok(
        numbersIn(text).has(String(RECORD_TYPES.length)),
        `${name} does not mention ${RECORD_TYPES.length}, the number of record types`,
      );
    }
  });

  it("states how many workflow files there are, and names every one of them", async () => {
    // This is the count that rotted the other way: the prose said five, and by
    // then three of the five had been folded into `check.yml` as jobs. Naming
    // them as well as counting them means a rename cannot pass either.
    const workflows = (await readdir(new URL("../../.github/workflows", import.meta.url)))
      .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
      .map((entry) => entry.replace(/\.ya?ml$/u, ""))
      .sort();
    assert.ok(workflows.length > 0, "there must be workflows to count");
    const written: Record<number, readonly string[]> = { 3: ["Three", "세"] };
    const words = written[workflows.length];
    assert.ok(words, `no spelled-out form is recorded for ${workflows.length} workflows -- add one with the count`);
    for (const [index, name] of DOCUMENTS.entries()) {
      const text = await read(name);
      const word = words[index] as string;
      assert.ok(
        text.includes(`${word} workflows run in CI`) || text.includes(`CI에서 ${word} 워크플로가 돕니다`),
        `${name} does not say there are ${workflows.length} workflows`,
      );
      for (const workflow of workflows) {
        assert.ok(text.includes(`\`${workflow}\``), `${name} does not name the \`${workflow}\` workflow`);
      }
    }
  });

  it("names every job the required check collects", async () => {
    // `gate`'s `needs:` is the list that cannot rot -- a job removed from it
    // stops gating, which is loud. The prose copies describe the same set, and
    // that copy is read by people deciding whether a red result matters.
    const jobs = await gateNeeds();
    assert.ok(jobs.length > 1, "a gate over one job is not a gate");
    for (const name of CI_DOCUMENTS) {
      const text = await read(name);
      for (const job of jobs) {
        assert.ok(text.includes(`\`${job}\``), `${name} does not name the \`${job}\` job the gate requires`);
      }
    }
  });

  it("counts the jobs `check.yml` actually defines", async () => {
    // `AGENTS.md` said seven when there were eight, because `#27` added
    // `flake-watch` and nothing re-counted. The paragraph two lines below that
    // number warned, in that same file, that nothing kept it current. It was
    // right, and it stayed wrong for two days.
    //
    // Counted from the job keys rather than from `gate`'s `needs:`, because
    // `gate` cannot appear in its own `needs:` -- the two numbers differ by one
    // and this is the one a reader checks with `ls`/`grep`.
    // Scanned from inside the `jobs:` block only. Taking two-space keys from the
    // whole file also collects `push:` and `schedule:` under `on:`, which is how
    // the first draft of this test counted eleven.
    const workflow = await checkWorkflow();
    const start = workflow.indexOf("\njobs:\n");
    assert.notEqual(start, -1, "check.yml must have a `jobs:` block");
    const jobs = [...workflow.slice(start).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gmu)].map((match) => match[1] as string);
    assert.ok(jobs.includes("gate"), "the job scan must find `gate`; the shape of check.yml changed");
    const written: Record<number, readonly [string, string]> = { 9: ["nine", "아홉"] };
    const words = written[jobs.length];
    assert.ok(words, `no spelled-out form is recorded for ${jobs.length} jobs -- add one with the count`);
    // Matched loosely enough that a rewrite of the sentence does not fail, and
    // tightly enough that the number has to sit next to the thing it counts.
    // A bare digit somewhere in the file would not do -- that is the mistake the
    // record-type assertion above still makes, and it is worth not repeating.
    // Emphasis stripped for the same reason as the required-check assertion
    // below: where the `**` falls is formatting, not a claim. The Korean form
    // allows a gap because `AGENTS.md` lists all nine names between "잡은" and
    // the count, which is the more useful sentence to write.
    const [english, korean] = words;
    const claim = new RegExp(
      `${english} jobs|any of ${english} reasons|잡(?:은|이)?.{0,160}${korean} ?개|${korean} 개의 잡`,
      "u",
    );
    for (const name of CI_DOCUMENTS) {
      assert.match(await prose(name), claim, `${name} does not say \`check.yml\` has ${jobs.length} jobs`);
    }
  });

  it("states the required check names the ruleset actually enforces", async () => {
    // Measured against the API on 2026-09-04: the ruleset requires `gate` **and**
    // `codeql`. Before that day three places each claimed to name "the one"
    // required check -- `README.md`, `README.ko.md` and the comment in
    // `codeql.yml` -- and no place said there were two. Each was half true and
    // each contradicted the other.
    //
    // The list is spelled out here rather than fetched, because a test that
    // needs the network is a test that fails on an aeroplane. What this pins is
    // that the documents agree with *each other* and with the workflows that
    // define those two job names; the API reading is recorded in the comment
    // above and re-checked by hand when the ruleset is edited.
    const required = ["gate", "codeql"] as const;
    const codeql = await readFile(new URL("../../.github/workflows/codeql.yml", import.meta.url), "utf8");
    assert.match(codeql, /^ {2}codeql:$/mu, "codeql.yml must define the `codeql` job the ruleset names");
    assert.match(await checkWorkflow(), /^ {2}gate:$/mu, "check.yml must define the `gate` job the ruleset names");
    for (const name of CI_DOCUMENTS) {
      const text = await read(name);
      for (const context of required) {
        assert.ok(text.includes(`\`${context}\``), `${name} does not name the required check \`${context}\``);
      }
      assert.match(
        await prose(name),
        /requires two check names|체크 이름은.{0,40}둘|필수 체크.{0,40}둘/u,
        `${name} does not say the ruleset requires two check names`,
      );
    }
  });

  it("names the one job allowed to skip, and nothing else", async () => {
    // `gate` used to read every `skipped` as a pass. It now accepts `success`
    // only and names its exceptions in `ALLOWED_SKIP`. A second name added
    // there is a decision, and a decision belongs in the prose too -- otherwise
    // the gate quietly stops covering a job while the documents still say it does.
    const workflow = await checkWorkflow();
    const allowed = /ALLOWED_SKIP:\s*'(\[[^']*\])'/u.exec(workflow)?.[1];
    assert.ok(allowed, "the gate job must declare which jobs may skip");
    const names = JSON.parse(allowed) as string[];
    assert.deepEqual(names, ["flake-watch"], "a change here needs the same change in the prose below");
    const jobs = await gateNeeds();
    for (const skippable of names) {
      assert.ok(jobs.includes(skippable), `\`${skippable}\` may skip but is not collected by the gate`);
    }
  });
});

/**
 * A document as a single line of prose, for the assertions that match a claim
 * rather than a token.
 *
 * Two normalisations, each for a reason a matcher should not care about.
 * Emphasis is stripped because where a writer puts the `**` is formatting -- a
 * check that failed when someone moved an asterisk would be deleted within the
 * month. Line breaks are collapsed because a sentence wraps: `AGENTS.md` names
 * all nine jobs between "잡은" and the count, so the claim genuinely spans lines.
 */
async function prose(name: string): Promise<string> {
  return (await read(name)).replaceAll("**", "").replace(/\s+/gu, " ");
}

/** `.github/workflows/check.yml`, verbatim. */
async function checkWorkflow(): Promise<string> {
  return readFile(new URL("../../.github/workflows/check.yml", import.meta.url), "utf8");
}

/**
 * The jobs `gate` collects.
 *
 * Anchored to the `gate:` job rather than taking the first `needs:` in the file,
 * which is what this used to do. That worked only because `gate` happened to be
 * the sole job with a `needs:` -- a second one added above it would have
 * silently moved what this test enforces, without failing.
 */
async function gateNeeds(): Promise<readonly string[]> {
  const workflow = await checkWorkflow();
  const gate = /^ {2}gate:$([\s\S]*?)^ {2}\S|^ {2}gate:$([\s\S]*)$/mu.exec(workflow);
  const body = gate?.[1] ?? gate?.[2];
  assert.ok(body, "check.yml must define a `gate` job");
  const needs = /needs:\s*\[([^\]]+)\]/u.exec(body)?.[1];
  assert.ok(needs, "the gate job must declare what it collects");
  return needs.split(",").map((job) => job.trim()).filter((job) => job !== "");
}
