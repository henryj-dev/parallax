import { DomainValidationError } from "../domain/dns.ts";
import { findCommand, listCommands, type CommandInput } from "./commands.ts";

export interface ParsedInvocation {
  readonly name: string;
  readonly input: CommandInput;
}

export class UsageError extends Error {}

/**
 * Turns `["record", "set", "--zone", "example.com", ...]` into a command name
 * and its input. The command path is matched greedily against the registry so
 * `credential profile set` wins over any shorter prefix.
 */
export function parseInvocation(argv: readonly string[]): ParsedInvocation {
  const words: string[] = [];
  let index = 0;
  while (index < argv.length && !argv[index]?.startsWith("-")) {
    words.push(argv[index] as string);
    index += 1;
  }
  if (words.length === 0) throw new UsageError("no command given");

  let name: string | undefined;
  let consumed = 0;
  for (let length = words.length; length > 0; length -= 1) {
    const candidate = words.slice(0, length).join(" ");
    if (findCommand(candidate)) {
      name = candidate;
      consumed = length;
      break;
    }
  }
  if (!name) throw new UsageError(`unknown command: ${words.join(" ")}`);
  if (consumed < words.length) {
    throw new UsageError(`unexpected argument: ${words[consumed]}`);
  }

  return { name, input: parseOptions(argv.slice(index)) };
}

function parseOptions(tokens: readonly string[]): CommandInput {
  const input: CommandInput = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!token.startsWith("--")) throw new UsageError(`expected an option, found: ${token}`);
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      input[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    // `--no-thing` sets a boolean false; a bare flag before another option or
    // the end of the line sets it true.
    if (body.startsWith("no-")) {
      input[body.slice(3)] = false;
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith("--")) {
      input[body] = true;
      continue;
    }
    input[body] = next;
    index += 1;
  }
  return input;
}

/** Human-readable listing used by `parallax help` and an unusable invocation. */
export function usage(commandName?: string): string {
  if (commandName) {
    const command = findCommand(commandName);
    if (!command) throw new DomainValidationError([`unknown command: ${commandName}`]);
    const options = command.options.length === 0
      ? "  (no options)"
      : command.options
        .map((option) => `  --${option.name}${option.required ? " (required)" : ""}  ${option.summary}`)
        .join("\n");
    return [
      `parallax ${command.name} -- ${command.summary}`,
      `role: ${command.role}`,
      "",
      "options:",
      options,
    ].join("\n");
  }

  const width = Math.max(...listCommands().map((command) => command.name.length));
  return [
    "parallax <command> [--option value]",
    "",
    "commands:",
    ...listCommands().map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    "",
    "Run `parallax help <command>` for its options.",
    "Add --json to print machine-readable output.",
  ].join("\n");
}
