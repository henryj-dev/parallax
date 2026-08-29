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
    // stops gating, which is loud. The READMEs describe the same set in prose,
    // and that copy is read by people deciding whether a red result matters.
    const workflow = await readFile(new URL("../../.github/workflows/check.yml", import.meta.url), "utf8");
    const needs = /needs:\s*\[([^\]]+)\]/u.exec(workflow)?.[1];
    assert.ok(needs, "the gate job must declare what it collects");
    const jobs = needs.split(",").map((job) => job.trim()).filter((job) => job !== "");
    assert.ok(jobs.length > 1, "a gate over one job is not a gate");
    for (const name of DOCUMENTS) {
      const text = await read(name);
      for (const job of jobs) {
        assert.ok(text.includes(`\`${job}\``), `${name} does not name the \`${job}\` job the gate requires`);
      }
    }
  });
});
