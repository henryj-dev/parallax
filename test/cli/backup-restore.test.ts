import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 60_000;
const ENTRY = join(import.meta.dirname, "../../cmd/parallax/main.ts");

/**
 * The move an operator actually makes, made by the actual command line.
 *
 * The unit tests prove the document carries everything; this proves the two
 * halves meet -- that `backup --json` writes something `restore` will read,
 * that stdin is wired, and that a second store built only from that document
 * answers the same questions. The two stores here are two directories rather
 * than a file and a database, because what changes between backends is which
 * classes implement the ports, and the document only ever speaks to the ports.
 */
describe("backup and restore across two stores", () => {
  let source: string;
  let target: string;

  const environmentFor = (directory: string): NodeJS.ProcessEnv => ({
    ...process.env,
    DATABASE_URL: "",
    PARALLAX_AUTH_TOKENS: "",
    PARALLAX_STATE_FILE: join(directory, "state.json"),
    PARALLAX_CONFIG_FILE: join(directory, "config.json"),
    PARALLAX_PROVIDER_STATE_FILE: join(directory, "provider.json"),
  });

  const run = (directory: string, argv: string[], stdin?: string): Promise<{ stdout: string }> => {
    const child = execFileAsync(process.execPath, [ENTRY, ...argv], {
      env: environmentFor(directory),
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    // `restore` reads its document from stdin, so the pipe has to be closed
    // even when there is nothing to send -- otherwise it waits for a document
    // that is never coming.
    child.child.stdin?.end(stdin ?? "");
    return child;
  };

  before(async () => {
    source = await mkdtemp(join(tmpdir(), "parallax-backup-source-"));
    target = await mkdtemp(join(tmpdir(), "parallax-backup-target-"));
    await run(source, ["settings", "set", "--values", '{"allowLocalProvider":true,"revisionRetention":40}']);
    await run(source, ["zone", "create", "--zone", "demo.test"]);
    await run(source, ["record", "set", "--zone", "demo.test", "--view", "external", "--id", "web",
      "--record", '{"name":"www","type":"A","content":"8.8.8.10","ttl":300}']);
    await run(source, ["record", "set", "--zone", "demo.test", "--view", "external", "--id", "web",
      "--record", '{"name":"www","type":"A","content":"8.8.8.11","ttl":300}']);
  });

  after(async () => {
    await Promise.all([source, target].map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("moves a store into an empty one and answers the same questions there", async () => {
    const { stdout: document } = await run(source, ["backup", "--json"]);
    const parsed = JSON.parse(document) as { zones: unknown[]; audit: unknown[] };
    assert.ok(parsed.zones.length >= 1, "the backup found no zones");
    assert.ok(parsed.audit.length >= 1, "the backup found no history");

    const { stdout: restored } = await run(target, ["restore", "--json"], document);
    const summary = JSON.parse(restored) as { zones: number; revisions: number; auditRenumbered: boolean };
    assert.equal(summary.zones, parsed.zones.length);
    assert.ok(summary.revisions >= 3, `expected the history to come too, got ${summary.revisions}`);
    assert.equal(summary.auditRenumbered, true);

    // The questions, asked of the store that was built only from the document.
    const [here, there] = await Promise.all([
      run(source, ["zone", "get", "--zone", "demo.test", "--json"]),
      run(target, ["zone", "get", "--zone", "demo.test", "--json"]),
    ]);
    assert.deepEqual(JSON.parse(there.stdout), JSON.parse(here.stdout));

    const [revisionsHere, revisionsThere] = await Promise.all([
      run(source, ["revision", "list", "--zone", "demo.test", "--json"]),
      run(target, ["revision", "list", "--zone", "demo.test", "--json"]),
    ]);
    assert.deepEqual(JSON.parse(revisionsThere.stdout), JSON.parse(revisionsHere.stdout));

    // The audit trail too, minus the ids the store assigns.
    const withoutIds = (raw: string): unknown =>
      (JSON.parse(raw) as { entries: Record<string, unknown>[] }).entries.map(({ id: _renumbered, ...rest }) => rest);
    const [auditHere, auditThere] = await Promise.all([
      run(source, ["history", "--zone", "demo.test", "--json"]),
      run(target, ["history", "--zone", "demo.test", "--json"]),
    ]);
    assert.deepEqual(withoutIds(auditThere.stdout), withoutIds(auditHere.stdout));
  });

  it("refuses to restore over the store it came from", async () => {
    const { stdout: document } = await run(source, ["backup", "--json"]);
    await assert.rejects(
      () => run(source, ["restore", "--json"], document),
      (error: Error & { stderr?: string }) => {
        assert.match(error.stderr ?? "", /already holds demo.test/u);
        return true;
      },
    );
  });
});
