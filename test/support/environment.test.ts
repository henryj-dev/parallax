import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { describe, it } from "node:test";
import { parallaxEnvironment } from "./environment.ts";

/**
 * The suite has to answer the same way on a developer's machine as it does in
 * CI, and for a while it did not.
 *
 * Every test that spawns a Parallax process states the configuration it is
 * about. Nine of them then spread `process.env` underneath that to keep `PATH`,
 * which also kept whatever the developer's `.env` had exported -- and this
 * repository tells them to have one. A test asserting that a deployment with no
 * identity provider refuses to start was handed one, and failed. CI never saw
 * it, because CI runs from a bare checkout.
 *
 * That is the worst shape a failure can have: red only where somebody is
 * working. It does not get fixed, it gets learned around, and the lesson is that
 * a red result is noise.
 */
describe("a test's environment does not depend on the shell that started it", () => {
  it("keeps the machine and drops everything that configures Parallax", () => {
    const before = { ...process.env };
    try {
      process.env.PARALLAX_OIDC_ISSUER = "https://idp.invalid";
      process.env.DATABASE_URL = "postgres://nobody@nowhere/db";
      process.env.HOST = "0.0.0.0";
      process.env.PARALLAX_STATE_FILE = "/tmp/should-not-leak.json";

      const environment = parallaxEnvironment();
      assert.equal(environment.PARALLAX_OIDC_ISSUER, undefined);
      assert.equal(environment.DATABASE_URL, undefined);
      assert.equal(environment.HOST, undefined);
      assert.equal(environment.PARALLAX_STATE_FILE, undefined);
      assert.equal(environment.PATH, process.env.PATH, "the machine survives");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  it("lets a test name what it wants, including an explicit empty string", () => {
    // `""` is how several of these tests say "configured, and configured to
    // nothing" -- distinct from absent, and it has to survive a helper whose job
    // is removing things.
    const environment = parallaxEnvironment({ PARALLAX_PORTAL_SIGN_IN: "idp", DATABASE_URL: "" });
    assert.equal(environment.PARALLAX_PORTAL_SIGN_IN, "idp");
    assert.equal(environment.DATABASE_URL, "");
  });

  /**
   * This file quotes the pattern it forbids, in the case below that proves the
   * search still works. Named rather than skipped by a rule, so adding a second
   * exemption is a decision somebody writes down.
   */
  const QUOTES_THE_PATTERN = "test/support/environment.test.ts";

  /**
   * A test that starts a Node process is a test that starts Parallax; nothing
   * else here spawns one. Matched on `process.execPath` rather than on an entry
   * path, because `what-ships` writes the string `src/index.ts` into a fixture
   * repository and spawns `git` and `bash` -- it inherits the shell on purpose
   * and none of this applies to it.
   */
  it("finds no test spawning Parallax with the shell's environment", async () => {
    // The control. Nine call sites were fixed; a tenth added later would be the
    // same defect, and it would be invisible for the same reason -- green in CI.
    const offenders: string[] = [];
    let scanned = 0;
    for await (const entry of glob("test/**/*.test.ts")) {
      scanned += 1;
      if (entry === QUOTES_THE_PATTERN) continue;
      const source = await readFile(entry, "utf8");
      if (source.includes("process.execPath") && source.includes("...process.env")) offenders.push(entry);
    }
    // `glob` resolves against `process.cwd()`. Run the suite from anywhere but the
    // repository root and it matches nothing; nothing scanned is no offenders, and
    // this file is green forever while measuring an empty set. The test below
    // proves the two search strings still match, which is a different question --
    // it reads one file by path and would keep passing with the glob dark.
    assert.ok(scanned >= 50, `scanned ${scanned} test files -- check that the suite is running from the repository root`);
    assert.deepEqual(
      offenders,
      [],
      "these spawn Parallax with the shell's environment; use parallaxEnvironment() from test/support/environment.ts",
    );
  });

  it("would notice the pattern it exists for", async () => {
    // The check above reads two fixed strings. If either ever stops matching the
    // way these tests are written, it passes by finding nothing -- so prove it
    // can find something, and that the exemption is the only thing hiding this
    // file rather than the search failing to match it.
    const source = await readFile(QUOTES_THE_PATTERN, "utf8");
    assert.ok(source.includes("process.execPath"), "the spawn marker must still be present here");
    assert.ok(source.includes("...process.env"), "and so must the pattern");
  });
});
