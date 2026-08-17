import { parseInvocation, usage, UsageError } from "../../src/cli/argv.ts";
import {
  CommandPermissionError,
  CommandUnavailableError,
  runCommand,
  UnknownCommandError,
} from "../../src/cli/commands.ts";
import { ConflictError, NotFoundError } from "../../src/application/control-plane.ts";
import { readConfig } from "../../src/config.ts";
import { checkConfig } from "../../src/cli/config-check.ts";
import { DomainValidationError } from "../../src/domain/dns.ts";
import {
  createMigrationRuntime,
  createRuntime,
  createSettingsRecoveryRuntime,
  RuntimeStartupError,
} from "../../src/runtime.ts";
import { MIGRATION_TARGETS, type MigrationTarget } from "../../src/infrastructure/migrations.ts";

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
  process.stdout.write(`${usage(argv.slice(1).join(" ") || undefined)}\n`);
  process.exit(0);
}

// Answered before anything is built, because that is the point: it reports
// what would stop the serving process from starting, without starting it and
// without opening the store. A deployment that only finds out at rollout finds
// out when the pod it replaced is already gone.
if (argv[0] === "config" && argv[1] === "check") {
  try {
    const checked = checkConfig();
    const wantsJsonHere = argv.includes("--json");
    process.stdout.write(wantsJsonHere
      ? `${JSON.stringify(checked, null, 2)}\n`
      : `${Object.entries(checked).map(([key, value]) => `${key}=${String(value)}`).join(" ")}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`parallax: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(78);
  }
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
  const config = readConfig();
  runtime = invocation.name === "migrate"
    ? createMigrationRuntime(config, migrationTarget(invocation.input))
    // A machine-specific stored setting can make the serving runtime fail
    // closed. Keep a deliberately narrow local-CLI path available to repair it.
    : invocation.name === "settings set"
      ? createSettingsRecoveryRuntime(config)
      : await createRuntime(config);
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

function migrationTarget(input: Record<string, unknown>): MigrationTarget {
  const target = input.target === undefined ? "parallax" : String(input.target);
  if (!MIGRATION_TARGETS.includes(target as MigrationTarget)) {
    throw new UsageError(`--target must be one of: ${MIGRATION_TARGETS.join(", ")}`);
  }
  return target as MigrationTarget;
}

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
  return render(record, "");
}

/**
 * Scalars on one line, then a labelled block for everything nested.
 *
 * Printing only the scalars is what this used to do, and for `preview` that
 * meant the entire plan -- every operation and every count -- was dropped, so
 * the command whose whole purpose is to say what would change said `zone=… 
 * revision=3` whether or not anything would. Nothing looked wrong; there was
 * simply nothing there to look at.
 */
function render(value: unknown, indent: string): string {
  if (value === null || typeof value !== "object") return `${indent}${String(value)}`;
  const record = value as Record<string, unknown>;
  const lines: string[] = [];
  const scalars = Object.entries(record)
    .filter(([, item]) => item === null || typeof item !== "object")
    .map(([key, item]) => `${key}=${String(item)}`);
  if (scalars.length > 0) lines.push(`${indent}${scalars.join(" ")}`);
  for (const [key, item] of Object.entries(record)) {
    if (item === null || typeof item !== "object") continue;
    if (Array.isArray(item)) {
      lines.push(`${indent}${key}: ${item.length === 0 ? "none" : ""}`.trimEnd());
      for (const entry of item) lines.push(render(entry, `${indent}  `));
    } else {
      lines.push(`${indent}${key}:`);
      lines.push(render(item, `${indent}  `));
    }
  }
  return lines.length === 0 ? `${indent}{}` : lines.join("\n");
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
