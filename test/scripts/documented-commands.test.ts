import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { parseInvocation } from "../../src/cli/argv.ts";
import { findCommand } from "../../src/cli/commands.ts";

/**
 * The command lines both READMEs print, run through the parser that would run
 * them.
 *
 * The quick start -- the first six commands anybody types -- did not work. It
 * spelled a record out as `--name app --type A --content 10.0.0.11 --ttl 300`,
 * and `record set` takes none of those: the body is one `--record` JSON value.
 * `unknown option --ttl`, on line two of the tutorial, in both languages.
 *
 * Nobody had removed those flags. Checked against `git log`, `record set` has
 * taken `--record` since the command layer existed, which means the quick start
 * was **never** run as written -- it was written from what the API accepts and
 * the two never had to agree. A test is the only thing that would have noticed,
 * because a reader who hits `unknown option` assumes they typed it wrong.
 *
 * This parses; it does not execute. Executing would need a store, a provider and
 * a temp directory per line, and the defect was never about behaviour -- it was
 * that the words did not name anything. Two things are checked per line: the
 * command resolves, and every option it passes is one that command declares.
 * Both read the same registry the CLI reads, so neither is a second copy of it.
 */
const DOCUMENTS = ["README.md", "README.ko.md"] as const;

/**
 * The `pnpm cli` lines inside fenced blocks, rejoined across `\` continuations.
 *
 * Deliberately not `parallax …`: those lines carry environment prefixes and shell
 * redirection (`> parallax-backup.json`, `< …`, `DATABASE_URL=…`) that belong to
 * a shell rather than to the parser. They are worth checking too, and checking
 * them means teaching this a shell's grammar -- which is how a control grows
 * until it is the thing being tested.
 */
function documentedInvocations(markdown: string): string[] {
  const joined = markdown.replaceAll(/\\\n\s*/gu, " ");
  return [...joined.matchAll(/^pnpm cli (.+)$/gmu)].map((match) => match[1] as string);
}

/** Splits a documented line into argv, honouring the single quotes around JSON. */
function toArgv(line: string): string[] {
  const argv: string[] = [];
  const pattern = /'([^']*)'|"([^"]*)"|(\S+)/gu;
  for (const match of line.matchAll(pattern)) {
    const token = match[1] ?? match[2] ?? match[3] as string;
    // A trailing `# comment` ends the command; the READMEs annotate these lines.
    if (match[3]?.startsWith("#")) break;
    argv.push(token);
  }
  return argv;
}

describe("the command lines the READMEs print", () => {
  it("finds command lines to check in both documents", async () => {
    // A regex that matches nothing passes every assertion below it.
    for (const name of DOCUMENTS) {
      const lines = documentedInvocations(await readFile(new URL(`../../${name}`, import.meta.url), "utf8"));
      assert.ok(lines.length >= 6, `${name} should document at least the quick start; found ${lines.length}`);
    }
  });

  it("names a real command and only options that command declares", async () => {
    for (const name of DOCUMENTS) {
      const markdown = await readFile(new URL(`../../${name}`, import.meta.url), "utf8");
      for (const line of documentedInvocations(markdown)) {
        const argv = toArgv(line);
        const parsed = parseInvocation(argv);
        const command = findCommand(parsed.name);
        assert.ok(command, `${name}: \`pnpm cli ${line}\` names no command`);
        const declared = new Set(command.options.map((option) => option.name));
        for (const option of Object.keys(parsed.input)) {
          assert.ok(
            declared.has(option),
            `${name}: \`pnpm cli ${line}\` passes --${option}, which \`${parsed.name}\` does not take`,
          );
        }
        for (const option of command.options) {
          if (!option.required) continue;
          assert.ok(
            option.name in parsed.input,
            `${name}: \`pnpm cli ${line}\` omits --${option.name}, which \`${parsed.name}\` requires`,
          );
        }
      }
    }
  });

  it("would notice the flags that were wrong", () => {
    // The exact line the quick start carried. If the check above ever stops
    // reaching option names, this is what it stops catching.
    const argv = toArgv("record set --zone example.com --view internal --id app --name app --type A --content 10.0.0.11 --ttl 300");
    const parsed = parseInvocation(argv);
    const declared = new Set(findCommand(parsed.name)?.options.map((option) => option.name));
    const rejected = Object.keys(parsed.input).filter((option) => !declared.has(option));
    assert.deepEqual(rejected.sort(), ["content", "name", "ttl", "type"]);
  });
});
