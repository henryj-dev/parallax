import { parseInvocation, usage, UsageError } from "../../src/cli/argv.ts";
import {
  CommandPermissionError,
  CommandUnavailableError,
  runCommand,
  UnknownCommandError,
} from "../../src/cli/commands.ts";
import { ConflictError, NotFoundError } from "../../src/application/control-plane.ts";
import { readConfig } from "../../src/config.ts";
import { DomainValidationError } from "../../src/domain/dns.ts";
import { createMigrationRuntime, createRuntime, RuntimeStartupError } from "../../src/runtime.ts";

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
  process.stdout.write(`${usage(argv.slice(1).join(" ") || undefined)}\n`);
  process.exit(0);
}

// `--json` is a presentation choice, not a command option, so it is removed
// before the invocation is parsed.
const wantsJson = argv.includes("--json");
const invocationArgv = argv.filter((token) => token !== "--json");

let exitCode = 0;
let runtime;
try {
  const invocation = parseInvocation(invocationArgv);
  // Migrating is the one command that runs against a store it cannot read yet,
  // so it gets a connection and nothing that would read through it.
  runtime = invocation.name === "migrate"
    ? createMigrationRuntime(readConfig())
    : await createRuntime(readConfig());
  // The command line reaches the store directly, so it acts with full rights;
  // HTTP callers are restricted by the role their token carries.
  const result = await runCommand({ runtime, actor: actorName(), role: "admin" }, invocation.name, invocation.input);
  // Warnings go to stderr and the result to stdout, so a caveat is visible even
  // when the output is being piped somewhere -- and, more to the point, so it is
  // not a line buried in the middle of the data it is a caveat about.
  for (const warning of warningsOf(result)) process.stderr.write(`parallax: warning: ${warning}\n`);
  process.stdout.write(wantsJson ? `${JSON.stringify(result, null, 2)}\n` : `${format(result)}\n`);
} catch (error) {
  exitCode = exitCodeFor(error);
  process.stderr.write(`${describe(error)}\n`);
  if (error instanceof UsageError || error instanceof UnknownCommandError) {
    process.stderr.write(`\n${usage()}\n`);
  }
} finally {
  await runtime?.close();
}

process.exit(exitCode);

/** Records who ran the command so the audit trail is not just "system". */
function actorName(): string {
  const user = process.env.SUDO_USER || process.env.USER || process.env.USERNAME;
  return user ? `cli:${user}` : "cli";
}

function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError || error instanceof UnknownCommandError) return 64;
  if (error instanceof DomainValidationError) return 65;
  if (error instanceof CommandPermissionError) return 77;
  if (error instanceof NotFoundError) return 69;
  if (error instanceof ConflictError) return 70;
  if (error instanceof CommandUnavailableError || error instanceof RuntimeStartupError) return 78;
  return 1;
}

function describe(error: unknown): string {
  if (error instanceof DomainValidationError) return `parallax: ${error.issues.join("\n           ")}`;
  return `parallax: ${error instanceof Error ? error.message : String(error)}`;
}

function warningsOf(result: unknown): string[] {
  if (result === null || typeof result !== "object") return [];
  const warnings = (result as { warnings?: unknown }).warnings;
  return Array.isArray(warnings) ? warnings.filter((item) => typeof item === "string") : [];
}

/** A compact rendering for a terminal; `--json` gives the untouched result. */
function format(result: unknown): string {
  if (result === undefined || result === null) return "ok";
  if (typeof result !== "object") return String(result);
  const { warnings: _reported, ...record } = result as Record<string, unknown>;
  // When a result carries exactly one array, that array is what the caller
  // asked about; any scalars beside it are context and are printed first.
  const arrays = Object.entries(record).filter(([, value]) => Array.isArray(value));
  if (arrays.length === 1) {
    const [key, rows] = arrays[0] as [string, unknown[]];
    const context = summarize(Object.fromEntries(
      Object.entries(record).filter(([name]) => name !== key),
    ));
    const body = rows.length === 0 ? `no ${key}` : rows.map((row) => summarize(row)).join("\n");
    return context === "{}" ? body : `${context}\n${body}`;
  }
  return summarize(result);
}

function summarize(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  const scalars = Object.entries(record)
    .filter(([, item]) => item === null || typeof item !== "object")
    .map(([key, item]) => `${key}=${String(item)}`);
  if (scalars.length > 0) return scalars.join(" ");
  return Object.keys(record).length === 0 ? "{}" : JSON.stringify(record, null, 2);
}
