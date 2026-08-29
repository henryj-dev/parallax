import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { join } from "node:path";
import { promisify } from "node:util";
import { parallaxEnvironment } from "../support/environment.ts";

const execFileAsync = promisify(execFile);

const CLI_TIMEOUT_MS = 60_000;
const ENTRY = join(import.meta.dirname, "../../cmd/parallax/main.ts");

/**
 * A pipe is the only place the bug lived, and every earlier test walked past it.
 *
 * `execFile` already gives the child a pipe rather than a terminal, so the
 * existing command-line tests were running through the affected path the whole
 * time. What none of them did was produce enough output to reach the pipe
 * buffer: `process.exit()` discards whatever has not flushed, and below 64 KiB
 * there is nothing left to discard. Measured before the fix, `openapi --json`
 * arrived as exactly 65536 bytes of a 219142-byte document, with exit code 0
 * -- a truncated answer reported as a successful one.
 *
 * So the assertion that matters is not "the output is right" but "the output is
 * whole", and the command chosen is simply the largest one there is. Anything
 * smaller would pass against the defect.
 */
describe("what the command line writes to a pipe", () => {
  /** No store is opened: the description is built from the command registry. */
  const environment: NodeJS.ProcessEnv = { ...parallaxEnvironment(), DATABASE_URL: "", PARALLAX_AUTH_TOKENS: "" };

  it("delivers a document larger than the pipe buffer without losing the end of it", async () => {
    const { stdout } = await execFileAsync(process.execPath, [ENTRY, "openapi", "--json"], {
      env: environment,
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });

    assert.ok(
      stdout.length > 65_536,
      `this only tests anything while the output exceeds the pipe buffer; it was ${stdout.length} bytes`,
    );
    // Parsing is the check. A truncation lands mid-token, so a document that
    // parses is a document that arrived whole.
    const document = JSON.parse(stdout) as { openapi?: unknown; paths?: Record<string, unknown> };
    assert.equal(typeof document.openapi, "string");
    assert.ok(Object.keys(document.paths ?? {}).length > 0, "the paths survived to the end");
  });

  it("still reports the exit code each outcome had before", async () => {
    // Returning a code rather than calling `process.exit()` must not change
    // what a caller reads, which is the other half of the same change.
    const run = async (argv: string[]): Promise<number> => {
      try {
        await execFileAsync(process.execPath, [ENTRY, ...argv], { env: environment, timeout: CLI_TIMEOUT_MS });
        return 0;
      } catch (error) {
        return (error as { code?: number }).code ?? -1;
      }
    };

    assert.equal(await run(["help"]), 0);
    assert.equal(await run(["config", "check"]), 0);
    assert.equal(await run(["definitely-not-a-command"]), 64, "UsageError");
  });

  it("exits on its own once the write drains", async () => {
    // The event loop has to empty for the code above to work at all. If
    // anything here kept it alive the process would hang instead of
    // truncating, which is a worse failure and a silent one under a timeout.
    const started = Date.now();
    await execFileAsync(process.execPath, [ENTRY, "openapi", "--json"], {
      env: environment,
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.ok(Date.now() - started < 30_000, "the process left without being killed");
  });
});
