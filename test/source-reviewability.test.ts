import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
/** Bounded like every other awaited child here; `ls-files` is fast or broken. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Keeps every file that ships or gets reviewed readable as text.
 *
 * A single control byte makes git classify a file as binary, and from then on
 * `git diff` reports `Bin 22073 -> 22074 bytes` and shows nothing. Nothing about
 * that looks like a problem: the tests pass, the file works, and the byte was a
 * deliberate choice -- a NUL is a fine map-key separator precisely because no
 * DNS name or service name can contain one.
 *
 * It cost a review. The deployment on the other end of this repository reads
 * `src/` changes by hand before shipping them, and the largest source change in
 * a release was invisible to that reading; it was only caught because somebody
 * noticed the file looked odd and reached for `--text`. The same byte sat in
 * `public/store.js` for longer, where it hid every change made to the portal's
 * store -- including the diff a reviewer would most want to see, since `\0`
 * renders as a space and the old line reads as though nothing moved.
 *
 * `\0`, `\x1f` and friends produce the same strings and leave the file text, so
 * there is nothing to trade away. This is a guard, not a preference.
 */
const ALLOWED = new Set([0x09, 0x0a]);

/**
 * The one exception, and it is a document rather than code: this audit quotes
 * an attack payload made of control characters, and the bytes are the subject.
 * Rewriting a dated report to make its own evidence more comfortable is the
 * wrong repair -- nobody reviews a release by diffing it, which is the harm
 * this guard exists to prevent.
 */
const EXEMPT = /^security-audits\//u;

async function trackedFiles(): Promise<string[]> {
  const { stdout } = await run("git", ["ls-files", "-z"], { cwd: ROOT, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split("\0").filter((name) => name !== "");
}

function controlBytesIn(contents: Buffer): number[] {
  const offsets: number[] = [];
  for (const [offset, byte] of contents.entries()) {
    if (byte < 0x20 && !ALLOWED.has(byte)) offsets.push(offset);
    else if (byte === 0x7f) offsets.push(offset);
  }
  return offsets;
}

describe("every file here stays readable as a diff", () => {
  it("finds no control byte in anything tracked", async () => {
    const names = (await trackedFiles()).filter((name) => !EXEMPT.test(name));
    // Not vacuous: a filter or a `cwd` that quietly matched nothing would make
    // this assertion pass over an empty list, which is the failure mode of every
    // scan in this repository that had to be fixed twice.
    assert.ok(names.length > 100, `expected to scan the tree, saw ${names.length} files`);
    assert.ok(names.includes("public/store.js"), "the file this was found in must be in scope");
    assert.ok(names.includes("src/adapters/cloudflare.ts"), "and so must the one that cost a review");

    const offenders: string[] = [];
    for (const name of names) {
      const contents = await readFile(join(ROOT, name));
      const offsets = controlBytesIn(contents);
      if (offsets.length === 0) continue;
      const line = contents.subarray(0, offsets[0]).toString("utf8").split("\n").length;
      offenders.push(`${name}:${line} holds ${offsets.length} control byte(s); write it as an escape (\\0, \\x1f) instead`);
    }
    assert.deepEqual(offenders, []);
  });

  it("would notice the byte it exists for", async () => {
    // The control. A scan that cannot see the thing it looks for reports a clean
    // tree for the same reason a clean tree does, and the two are indistinguishable.
    // Built from codepoints, not typed: a fixture written as a real byte would
    // make this file the next thing that stops diffing.
    assert.deepEqual(controlBytesIn(Buffer.from("a\0b")), [1]);
    assert.deepEqual(controlBytesIn(Buffer.from(`ok${String.fromCharCode(0x1f)}then`)), [2]);
    assert.deepEqual(controlBytesIn(Buffer.from(`del${String.fromCharCode(0x7f)}`)), [3]);
    assert.deepEqual(controlBytesIn(Buffer.from("tabs\tand\nnewlines are how source is written")), []);
  });

  it("exempts the audit that quotes control bytes, and nothing else", async () => {
    // Read off the tree rather than asserted from memory: if the audit is ever
    // cleaned up, this notices that the exemption now covers nothing and can go.
    const exempt = (await trackedFiles()).filter((name) => EXEMPT.test(name));
    const dirty: string[] = [];
    for (const name of exempt) {
      if (controlBytesIn(await readFile(join(ROOT, name))).length > 0) dirty.push(name);
    }
    assert.deepEqual(dirty, ["security-audits/2026-08-15-security-audit.md"],
      "the exemption is for this one report; anything else under it should be plain text");
  });
});
