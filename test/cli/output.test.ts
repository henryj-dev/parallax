import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Long enough for a cold start, and bounded.
 *
 * Without it a child that never exits makes the test wait forever: the run does
 * not fail, it stops saying anything, and a hang has to be read off a clock by
 * whoever notices. A killed child is a sentence.
 */
const CLI_TIMEOUT_MS = 60_000;
const ENTRY = join(import.meta.dirname, "../../cmd/parallax/main.ts");

/**
 * What the terminal actually prints.
 *
 * The command layer's own tests assert what a command returns, which is a
 * different thing from what a person sees. `preview` returned a complete plan
 * the whole time and the formatter printed only its scalars, so the command
 * whose entire purpose is to say what would change said `zone=… revision=2` and
 * nothing else -- indistinguishable from having nothing to do. No test noticed,
 * because none of them looked at the output.
 */
describe("command-line output", () => {
  let directory: string;
  let environment: NodeJS.ProcessEnv;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "parallax-cli-output-"));
    environment = {
      ...process.env,
      DATABASE_URL: "",
      PARALLAX_AUTH_TOKENS: "",
      PARALLAX_STATE_FILE: join(directory, "state.json"),
      PARALLAX_CONFIG_FILE: join(directory, "config.json"),
      PARALLAX_PROVIDER_STATE_FILE: join(directory, "provider.json"),
    };
    const cli = (...argv: string[]) => execFileAsync(process.execPath, [ENTRY, ...argv], { env: environment, timeout: CLI_TIMEOUT_MS });
    await cli("settings", "set", "--values", '{"allowLocalProvider":true}');
    await cli("zone", "create", "--zone", "demo.test");
    await cli("record", "set", "--zone", "demo.test", "--view", "external", "--id", "web",
      "--record", '{"name":"www","type":"A","content":"8.8.8.10","ttl":300}');
  });

  after(async () => { await rm(directory, { recursive: true, force: true }); });

  it("prints the plan a preview found, not only the zone it was asked about", async () => {
    const { stdout } = await execFileAsync(process.execPath, [ENTRY, "preview", "--zone", "demo.test"], { env: environment, timeout: CLI_TIMEOUT_MS });
    assert.match(stdout, /zone=demo\.test/u);
    assert.match(stdout, /kind=create/u, "the operation itself");
    assert.match(stdout, /name=www type=A content=8\.8\.8\.10/u, "and what it would write");
    assert.match(stdout, /create=1/u, "the counts");
    assert.match(stdout, /untouched=0/u, "including what it would leave alone");
  });

  it("says which view each part of the plan belongs to", async () => {
    // A plan without its view is a list of changes with no answer to "where".
    const { stdout } = await execFileAsync(process.execPath, [ENTRY, "preview", "--zone", "demo.test"], { env: environment, timeout: CLI_TIMEOUT_MS });
    assert.match(stdout, /external:/u);
    assert.match(stdout, /internal:/u);
  });

  it("still prints a plain result on one line", async () => {
    // The nested rendering must not turn every ordinary result into a tree.
    const { stdout } = await execFileAsync(process.execPath, [ENTRY, "zone", "get", "--zone", "demo.test"], { env: environment, timeout: CLI_TIMEOUT_MS });
    assert.match(stdout.split("\n")[0] ?? "", /name=demo\.test revision=\d+/u);
  });
});
