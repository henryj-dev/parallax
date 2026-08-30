#!/usr/bin/env node
/**
 * 단계 게이트 — 통과를 사람이 아니라 이 파일이 판정한다.
 *
 * 실행판(`docs/2026-08-29-unimplemented-review-todo.md`)의 §0 이 계약이고, 이 파일은
 * 그 계약의 구현이다. 계약이 요구하는 것 셋:
 *
 *   R1 순서   선행 단계의 봉인이 없으면 이 단계의 검사 실행 자체를 거부한다
 *   R2 최신성 봉인의 head 가 HEAD 의 조상이 아니면 그 봉인을 무효로 본다
 *   R3 재검   --seal 은 이전 결과를 읽지 않는다. 검사를 처음부터 다시 돌린다
 *
 * 검사 정의는 아래 `GATES` **데이터** 하나다. 검사를 더하는 일이 코드 분기를 더하는
 * 일이 되면 검사를 더하지 않게 되고, 그러면 게이트는 처음 쓴 사람의 관심사에서 굳는다.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

/**
 * 봉인 디렉터리와 검사표는 주입할 수 있다 — 기본값은 이 저장소의 것이다.
 *
 * 음성 대조 테스트가 R1·R2·R3 을 **실제로 깨뜨려 봐야** 하기 때문이다. 진짜 봉인을
 * 옮기거나 진짜 문서를 고쳐서 확인하면, 그 확인은 저장소를 망가뜨린 상태에서만 유효하고
 * 중단되면 망가진 상태가 남는다. 그래서 두 곳에 이음매를 둔다 — 이것 말고 다른 이음매는
 * 없고, 이 둘은 프로덕션 경로에서 기본값으로만 쓰인다.
 */
const DEFAULT_SEALS = join(ROOT, "gates");

/** 검사가 대는 경로. 저장소 상대가 기본이고, 절대 경로는 그대로 쓴다 — 음성 대조가 임시
 * 디렉터리를 대상으로 돌기 때문이고, 그 경우까지 상대로 붙이면 검사가 「파일이 없다」로
 * 실패해 이빨을 확인할 수 없다. */
const at = (path) => (isAbsolute(path) ? path : join(ROOT, path));

/**
 * 단계마다: 선행 · 산출 경로 · 검사 목록.
 *
 * `outputs` 는 `--assert-order` 가 쓴다 — 봉인되지 않은 단계의 산출이 본선에 들어가는
 * 것을 CI 에서 잡는다. 로컬에서만 지켜지는 순서는 지켜지지 않는 순서다.
 */
const GATES = {
  P0: {
    needs: [],
    outputs: ["scripts/gate.mjs", "gates/"],
    checks: [
      { id: "G-P0.0", what: "장치가 대답한다", how: "cmd", cmd: "node scripts/gate.mjs --status" },
      { id: "G-P0.1", what: "어댑터 구현 수", how: "grep", pattern: "implements ProviderAdapter", in: "src/**/*.ts", count: "files", min: 1 },
      { id: "G-P0.2", what: "커맨드 role 선언 수", how: "grep", pattern: 'role: "', in: "src/cli/commands.ts", min: 1 },
      { id: "G-P0.3", what: "영문 한계 문장 존재", how: "grep", pattern: "only real provider", in: "README.md", equals: 1 },
      { id: "G-P0.4", what: "국문 한계 문장 존재", how: "grep", pattern: "실제 프로바이더 어댑터는 Cloudflare 하나뿐", in: "README.ko.md", equals: 1 },
      { id: "G-P0.5", what: "낡은 CI 문장 존재", how: "grep", pattern: "`scripts` · `docker`", in: "docs/todo.md", equals: 1 },
      { id: "G-P0.6", what: "테스트 통과 수", how: "cmd", cmd: "pnpm test", capture: "pass" },
      { id: "G-P0.7", what: "봉인이 무시되지 않는다", how: "cmd", cmd: "git check-ignore gates/", expect: "nonzero" },
      { id: "G-P0.8", what: "장치 음성 대조", how: "test", cmd: "node --test test/scripts/gate-device.test.ts" },
    ],
  },
  P1: {
    needs: ["P0"],
    outputs: ["README.md", "README.ko.md", "docs/todo.md"],
    checks: [
      { id: "G-P1.1", what: "영문 단일 어댑터 주장", how: "grep", pattern: "only real provider", in: "README.md", limit: 0 },
      { id: "G-P1.2", what: "국문 단일 어댑터 주장", how: "grep", pattern: "실제 프로바이더 어댑터는 Cloudflare 하나뿐", in: "README.ko.md", limit: 0 },
      {
        id: "G-P1.3", what: "영문 한계 절이 RFC 2136 을 댄다", how: "grep", pattern: "RFC 2136", in: "README.md",
        between: ["^## Status & limitations", "^## License"], min: 1,
      },
      {
        id: "G-P1.4", what: "국문 한계 절이 RFC 2136 을 댄다", how: "grep", pattern: "RFC 2136", in: "README.ko.md",
        between: ["^## 현재 상태와 한계", "^## 라이선스"], min: 1,
      },
      { id: "G-P1.5", what: "낡은 CI 문장", how: "grep", pattern: "`scripts` · `docker`", in: "docs/todo.md", limit: 0 },
      { id: "G-P1.6", what: "요구 체크 이름", how: "grep", pattern: "gate", in: "docs/todo.md", min: 1 },
      { id: "G-P1.7", what: "소스 무변경", how: "diff-empty", paths: ["src/", "test/", "migrations/"], since: "seal:P0" },
      { id: "G-P1.8", what: "설정 표 무변경", how: "diff-empty", paths: ["README.md", "README.ko.md"], since: "seal:P0", grep: "| `PARALLAX_DNS_INTERNAL_UPDATE`" },
      { id: "G-P1.8b", what: "타입·빌드·테스트", how: "cmd", cmd: "pnpm check && pnpm run check:portal && pnpm build && pnpm test" },
      { id: "G-P1.9", what: "배포 게이트", how: "test", cmd: "node --test test/infrastructure/schema-surface.test.ts" },
      { id: "G-P1.10", what: "문서 수치 검사", how: "test", cmd: "node --test test/scripts/documented-counts.test.ts" },
      {
        // 기준선이 실제로 대상을 잡았다는 역사적 사실. P0 이 자기 봉인을 읽을 수는 없어서
        // — 봉인을 만드는 검사가 자기 출력을 읽으면 순환이다 — 그 문장을 지운 단계가 읽는다.
        id: "G-P1.12", what: "P0 기준선이 대상을 잡았다", how: "json", file: "gates/P0.json",
        path: "checks[id=G-P0.3].measured", min: 1,
      },
      {
        id: "G-P1.11", what: "테스트 비악화", how: "json", file: "gates/P0.json",
        path: "checks[id=G-P0.6].measured", op: ">=", measure: { how: "cmd", cmd: "pnpm test", capture: "pass" },
      },
    ],
  },
  P2: {
    needs: ["P1"],
    outputs: ["test/scripts/documented-adapters.test.ts"],
    checks: [
      { id: "G-P2.1", what: "어댑터 집합 대조", how: "test", cmd: "node --test test/scripts/documented-adapters.test.ts" },
      { id: "G-P2.2", what: "수집이 비어 있지 않다", how: "grep", pattern: "implements ProviderAdapter", in: "src/**/*.ts", count: "files", min: 1 },
      {
        id: "G-P2.7", what: "임시 표식 잔재", how: "grep", pattern: "GATE-TEMP", in: "**/*.{ts,mjs,md}", limit: 0,
        // 이 표식을 인용하는 세 파일 — 검사 정의, 실행판, 그리고 면제가 이름으로만 걸리는지
        // 확인하는 음성 대조(`TC-P0.T1.h`). 이름으로 면제하는 이유는 규칙으로 면제하면 다음
        // 면제가 조용히 늘고, 그러면 금지가 아니라 권고가 되기 때문이다.
        except: [
          "scripts/gate.mjs",
          "docs/2026-08-29-unimplemented-review-todo.md",
          "test/scripts/gate-device.test.ts",
        ],
      },
      {
        // `--assert-order` 를 여기서 **돌리지 않는다.** 그것은 봉인되지 않은 단계의 산출이
        // 바뀌었는지 묻는 검사인데, P2 를 봉인하려면 P2 가 통과해야 하고 P2 가 통과하려면
        // P2 가 봉인돼 있어야 한다 — 순환이다. 대신 그 명령에 이빨이 있는지를 본다.
        id: "G-P2.8", what: "순서 강제에 이빨이 있다", how: "test",
        cmd: "node --test test/scripts/gate-device.test.ts",
      },
      { id: "G-P2.9", what: "전체 게이트", how: "cmd", cmd: "pnpm check && pnpm run check:portal && pnpm build && pnpm test" },
      {
        id: "G-P2.6", what: "테스트 비악화", how: "json", file: "gates/P0.json",
        path: "checks[id=G-P0.6].measured", op: ">=", measure: { how: "cmd", cmd: "pnpm test", capture: "pass" },
      },
    ],
  },
};

// ---- 측정 ------------------------------------------------------------------

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** 종료코드만 필요할 때. 던지지 않는다. */
function run(command) {
  try {
    const stdout = execFileSync("bash", ["-c", command], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/**
 * `between` 이 주어지면 파일의 그 구간만 본다.
 *
 * 절 스코프가 필요한 이유는 한계 절이 무엇을 말하는지 묻는 검사가 여럿이기 때문이다 —
 * 파일 전체에서 `RFC 2136` 을 찾으면 설정 표가 대신 답해 버리고, 그 표는 처음부터 옳았다.
 */
function scoped(text, between) {
  if (!between) return text;
  const [from, to] = between.map((pattern) => new RegExp(pattern, "mu"));
  const start = text.search(from);
  if (start < 0) return "";
  const rest = text.slice(start);
  const end = rest.slice(1).search(to);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

function filesFor(pattern) {
  if (!pattern.includes("*")) return [pattern];
  return globSync(pattern, { cwd: ROOT }).filter((entry) => !entry.startsWith("node_modules"));
}

/** 검사 하나를 측정한다. `{ measured, detail }` 을 낸다. 판정은 하지 않는다. */
export function measure(check) {
  if (check.how === "lines") {
    const text = readFileSync(at(check.file), "utf8");
    return { measured: text.split("\n").length - (text.endsWith("\n") ? 1 : 0) };
  }
  if (check.how === "grep") {
    let hits = 0;
    const matched = [];
    for (const file of filesFor(check.in)) {
      // 금지 표식을 **정의하는** 파일은 그 표식을 담을 수밖에 없다. 이름으로 면제하고,
      // 면제된 파일에서 패턴이 여전히 잡히는지는 음성 대조가 따로 본다 — 규칙으로 면제하면
      // 다음 면제가 조용히 늘어난다.
      if (check.except?.some((exempt) => file === exempt)) continue;
      let text;
      try { text = readFileSync(at(file), "utf8"); } catch { continue; }
      const body = scoped(text, check.between);
      const lines = body.split("\n").filter((line) => line.includes(check.pattern));
      if (lines.length > 0) matched.push(file);
      hits += lines.length;
    }
    return { measured: check.count === "files" ? matched.length : hits, detail: matched.join(" ") };
  }
  if (check.how === "test" || check.how === "cmd") {
    const { code, stdout } = run(check.cmd);
    if (check.capture === "pass") {
      const found = /^ℹ pass (\d+)/mu.exec(stdout) ?? /# pass (\d+)/mu.exec(stdout);
      return { measured: found ? Number(found[1]) : -1, code, detail: found ? "" : "통과 수를 읽지 못했다" };
    }
    return { measured: code, code };
  }
  if (check.how === "diff-empty") {
    const since = resolveSince(check.since, check.seals);
    if (!since) return { measured: -1, detail: `기준 커밋을 찾지 못했다: ${check.since}` };
    const changed = git("diff", "--name-only", `${since}..HEAD`, "--", ...check.paths)
      .split("\n").filter((line) => line !== "");
    if (!check.grep) return { measured: changed.length, detail: changed.join(" ") };
    // 경로 안에서 특정 문자열을 담은 줄이 움직였는지만 본다.
    const touched = changed.filter((file) => {
      const patch = git("diff", `${since}..HEAD`, "--", file);
      return patch.split("\n").some((line) => /^[+-]/u.test(line) && !/^[+-]{3}/u.test(line) && line.includes(check.grep));
    });
    return { measured: touched.length, detail: touched.join(" ") };
  }
  if (check.how === "json") {
    const stored = readSealValue(check.file, check.path);
    if (stored === undefined) return { measured: -1, detail: `봉인에서 ${check.path} 를 읽지 못했다` };
    // `measure` 가 없으면 봉인 값 자체에 제약을 건다 — 「그때 이랬다」를 묻는 검사다.
    if (!check.measure) return { measured: stored, detail: `봉인 기록 ${stored}` };
    const current = measure(check.measure).measured;
    const ok = check.op === ">=" ? current >= stored : check.op === "<=" ? current <= stored : current === stored;
    return { measured: current, limit: stored, forced: ok, detail: `기준선 ${stored} ${check.op} 현재 ${current}` };
  }
  throw new Error(`알 수 없는 how: ${check.how}`);
}

function resolveSince(since, seals) {
  if (!since?.startsWith("seal:")) return since ?? null;
  const seal = readSeal(since.slice(5), seals);
  return seal?.head ?? null;
}

function readSealValue(file, path) {
  let document;
  try { document = JSON.parse(readFileSync(at(file), "utf8")); } catch { return undefined; }
  const found = /^checks\[id=([^\]]+)\]\.(\w+)$/u.exec(path);
  if (!found) return undefined;
  return document.checks?.find((check) => check.id === found[1])?.[found[2]];
}

/** 측정값을 통과/실패로 판정한다. 제약이 하나도 없으면 종료코드 0 을 요구한다. */
export function verdict(check, result) {
  if (result.forced !== undefined) return result.forced;
  // 변경 0 이 통과다. 기준 커밋을 찾지 못한 경우(-1)도 실패로 떨어진다 — 「변경 없음」과
  // 「비교하지 않음」이 같은 답이 되는 것이 이 검사의 최악이다.
  if (check.how === "diff-empty") return result.measured === 0;
  const constraints = [];
  if (check.equals !== undefined) constraints.push(result.measured === check.equals);
  if (check.limit !== undefined) constraints.push(result.measured <= check.limit);
  if (check.min !== undefined) constraints.push(result.measured >= check.min);
  if (constraints.length > 0) return constraints.every(Boolean);
  if (check.expect === "nonzero") return result.code !== 0;
  return result.code === 0;
}

function limitOf(check, result) {
  if (result.limit !== undefined) return result.limit;
  if (check.how === "diff-empty") return 0;
  if (check.equals !== undefined) return check.equals;
  if (check.limit !== undefined) return check.limit;
  if (check.min !== undefined) return `≥ ${check.min}`;
  return check.expect === "nonzero" ? "≠ 0" : 0;
}

// ---- 봉인 ------------------------------------------------------------------

function readSeal(phase, seals = DEFAULT_SEALS) {
  const path = join(seals, `${phase}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/**
 * R2 — 봉인의 head 가 지금 이력에 없으면 무효다.
 *
 * 되돌리면 자동으로 풀린다는 것이 요점이다. 손으로 봉인 파일을 지우게 만들면 그 자동성을
 * 아무도 믿지 않게 되고, 믿지 않는 자동성은 없는 것과 같다.
 */
export function sealState(phase, context = {}) {
  const seal = readSeal(phase, context.seals ?? DEFAULT_SEALS);
  if (!seal?.sealed) return "열림";
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", seal.head, "HEAD"], { cwd: ROOT, stdio: "ignore" });
  } catch {
    return "무효";
  }
  return seal.waived ? "면제" : "봉인";
}

function sealed(phase, context = {}) {
  const state = sealState(phase, context);
  return state === "봉인" || state === "면제";
}

export function blockedBy(phase, context = {}) {
  const gates = context.gates ?? GATES;
  return (gates[phase]?.needs ?? []).filter((need) => !sealed(need, context));
}

// ---- 명령 ------------------------------------------------------------------

export function runPhase(phase, { explain = false, quiet = false, ...context } = {}) {
  const gate = (context.gates ?? GATES)[phase];
  if (!gate) throw new Error(`알 수 없는 단계: ${phase}`);
  // R1 — 선행 봉인이 없으면 검사를 돌리지 않는다. 돌린 결과를 기록할 곳이 없다.
  const blocked = blockedBy(phase, context);
  if (blocked.length > 0) {
    if (!quiet) process.stderr.write(`🔒 ${phase} 는 잠겨 있다 — 선행 단계 ${blocked.join(" · ")} 가 봉인되지 않았다\n`);
    return { ok: false, results: [], blocked };
  }
  const results = [];
  for (const check of gate.checks) {
    let result;
    try { result = measure(check); } catch (error) { result = { measured: -1, detail: String(error.message) }; }
    const ok = verdict(check, result);
    results.push({ id: check.id, ok, measured: result.measured, limit: limitOf(check, result), detail: result.detail ?? "" });
  }
  const width = Math.max(...results.map((row) => row.id.length));
  for (const row of quiet ? [] : results) {
    const line = `${row.ok ? "✔" : "✖"} ${row.id.padEnd(width)}  측정 ${String(row.measured).padStart(5)}  기준 ${row.limit}`;
    process.stdout.write(`${line}${explain && row.detail ? `  ${row.detail}` : ""}\n`);
  }
  const failed = results.filter((row) => !row.ok);
  if (!quiet) process.stdout.write(`${failed.length === 0 ? "초록" : `빨강 — ${failed.map((row) => row.id).join(" · ")}`}\n`);
  return { ok: failed.length === 0, results };
}

export function seal(phase, waived, context = {}) {
  if (waived !== undefined && !waived) {
    if (!context.quiet) process.stderr.write("--waived 는 사유가 필요하다\n");
    return 2;
  }
  if (waived) {
    // 면제는 검사를 통과했다는 주장이 아니라 하지 않기로 했다는 기록이다.
    const blocked = blockedBy(phase, context);
    if (blocked.length > 0) {
      if (!context.quiet) process.stderr.write(`🔒 ${phase} 는 잠겨 있다 — ${blocked.join(" · ")}\n`);
      return 1;
    }
    write(phase, { sealed: true, waived: true, reason: waived, checks: [] }, context);
    if (!context.quiet) process.stdout.write(`🔏 ${phase} 면제 봉인 — ${waived}\n`);
    return 0;
  }
  // R3 — 이전 결과를 읽지 않는다. 지금 돌린다.
  const { ok, results } = runPhase(phase, context);
  if (!ok) {
    if (!context.quiet) process.stderr.write(`${phase} 는 봉인되지 않았다 — 빨간 검사가 있다\n`);
    return 1;
  }
  write(phase, { sealed: true, waived: false, reason: null, checks: results.map(({ id, ok: passed, measured, limit }) => ({ id, ok: passed, measured, limit })) }, context);
  if (!context.quiet) process.stdout.write(`🔏 ${phase} 봉인\n`);
  return 0;
}

function write(phase, body, context = {}) {
  const seals = context.seals ?? DEFAULT_SEALS;
  mkdirSync(seals, { recursive: true });
  const document = { phase, head: git("rev-parse", "HEAD"), at: new Date().toISOString(), ...body };
  writeFileSync(join(seals, `${phase}.json`), `${JSON.stringify(document, null, 2)}\n`);
}

export function status(context = {}) {
  const gates = context.gates ?? GATES;
  const width = Math.max(...Object.keys(gates).map((phase) => phase.length));
  for (const phase of Object.keys(gates)) {
    const state = blockedBy(phase, context).length > 0 && !sealed(phase, context) ? "잠김" : sealState(phase, context);
    process.stdout.write(`${phase.padEnd(width)}  ${state.padEnd(4)}  node scripts/gate.mjs ${phase}  gates/${phase}.json\n`);
  }
  return 0;
}

/**
 * CI 용 — 봉인되지 않은 단계의 산출이 본선에 들어갔는지 본다.
 *
 * `origin/main` 과의 차이를 보는 이유는 이것이 「이 브랜치가 무엇을 바꾸려 하는가」를
 * 묻는 검사이기 때문이다. 봉인 없이 산출이 바뀌었다면 순서가 지켜지지 않았다.
 */
export function assertOrder(context = {}) {
  let base;
  try { base = git("merge-base", "origin/main", "HEAD"); } catch { base = git("rev-parse", "HEAD"); }
  const changed = git("diff", "--name-only", `${base}..HEAD`).split("\n").filter((line) => line !== "");
  const problems = [];
  for (const [phase, gate] of Object.entries(context.gates ?? GATES)) {
    if (sealed(phase, context)) continue;
    const touched = changed.filter((file) => gate.outputs.some((output) => file === output || file.startsWith(output)));
    if (touched.length > 0) problems.push(`${phase}: ${touched.join(" ")}`);
  }
  if (problems.length > 0) {
    process.stderr.write(`봉인 없이 산출이 바뀐 단계가 있다\n  ${problems.join("\n  ")}\n`);
    return 1;
  }
  process.stdout.write("순서 이상 없음\n");
  return 0;
}

// ---- 진입 ------------------------------------------------------------------

export { GATES };

// CLI — 모듈로 불릴 때는 돌지 않는다.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(dirname(new URL(import.meta.url).pathname), "gate.mjs");
const argv = invokedDirectly ? process.argv.slice(2) : [];
if (invokedDirectly) {
if (argv.includes("--status")) process.exitCode = status();
else if (argv.includes("--assert-order")) process.exitCode = assertOrder();
else {
  const phase = argv.find((argument) => !argument.startsWith("--"));
  if (!phase) {
    process.stderr.write("사용법: gate.mjs <단계> [--seal [--waived \"사유\"]] [--explain] | --status | --assert-order\n");
    process.exitCode = 2;
  } else if (argv.includes("--seal")) {
    const at = argv.indexOf("--waived");
    process.exitCode = seal(phase, at < 0 ? undefined : (argv[at + 1] ?? ""));
  } else {
    process.exitCode = runPhase(phase, { explain: argv.includes("--explain") }).ok ? 0 : 1;
  }
}
}
