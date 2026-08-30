import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { GATES, assertOrder, blockedBy, measure, runPhase, seal, sealState, verdict } from "../../scripts/gate.mjs";
import type { Check, Phase } from "../../scripts/gate.mjs";

/**
 * 게이트 장치가 스스로 틀렸을 때 빨개지는지.
 *
 * 실행판의 다른 모든 통과가 이 장치의 정직함에 얹혀 있다. 그런데 장치가 아무것도 측정하지
 * 않아도 위반은 0 이므로 검사는 초록이다 — 초록이 「통과」가 아니라 「측정하지 않음」을
 * 뜻하게 되는 것이 이 장치의 유일한 조용한 실패 양식이다. 그래서 여기서는 통과를 인위로
 * 깨뜨렸을 때 실패하는지만 본다.
 *
 * 진짜 봉인이나 진짜 문서를 건드려 확인하지 않는다. 그렇게 하면 확인이 저장소를 망가뜨린
 * 상태에서만 유효하고, 중단되면 망가진 상태가 남는다. 장치가 봉인 위치와 검사표를 받도록
 * 열어 둔 이유가 그것이다.
 */

const temporary: string[] = [];
function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), "parallax-gate-"));
  temporary.push(path);
  return path;
}
after(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); });

const ROOT = new URL("../../", import.meta.url).pathname;
const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();

/** 통과하는 검사 하나와 실패하는 검사 하나만 가진 최소 검사표. */
function fixture(passing: boolean): Record<string, Phase> {
  return {
    F0: { needs: [], outputs: [], checks: [{ id: "G-F0.1", how: "cmd", cmd: passing ? "true" : "false" }] },
    F1: { needs: ["F0"], outputs: [], checks: [{ id: "G-F1.1", how: "cmd", cmd: "true" }] },
  };
}

function writeSeal(seals: string, phase: string, body: Record<string, unknown>): void {
  writeFileSync(join(seals, `${phase}.json`), JSON.stringify({ phase, sealed: true, waived: false, checks: [], ...body }));
}

describe("게이트 장치가 자기 규칙을 지킨다", () => {
  it("TC-P0.T1.a — 선행이 봉인되지 않으면 실행을 거부한다", () => {
    const seals = scratch();
    const gates = fixture(true);
    assert.deepEqual(blockedBy("F1", { gates, seals }), ["F0"], "F0 이 봉인되지 않았다고 말한다");
    const attempt = runPhase("F1", { gates, seals, quiet: true });
    assert.equal(attempt.ok, false, "잠긴 단계는 통과할 수 없다");
    assert.deepEqual(attempt.results, [], "검사를 돌리지도 않는다 — 거부는 실패가 아니다");

    // 실제 CLI 경로도 같은 답을 하는지. 이 저장소의 P1 은 P0 봉인을 요구한다.
    const cli = (): number => {
      try {
        execFileSync(process.execPath, ["scripts/gate.mjs", "P1"], { cwd: ROOT, stdio: "ignore" });
        return 0;
      } catch (error) { return (error as { status?: number }).status ?? 1; }
    };
    if (sealState("P0") !== "봉인" && sealState("P0") !== "면제") {
      assert.notEqual(cli(), 0, "P0 이 봉인되지 않은 동안 CLI 도 P1 을 거부한다");
    }
  });

  it("TC-P0.T1.b — 봉인 후 그 단계를 되돌리면 봉인이 무효가 된다", () => {
    const seals = scratch();
    writeSeal(seals, "F0", { head: head() });
    assert.equal(sealState("F0", { seals }), "봉인", "지금 이력에 있는 커밋의 봉인은 유효하다");

    // 이력에 없는 커밋 — 되돌려서 사라진 봉인이 이 모양이다.
    writeSeal(seals, "F0", { head: "0".repeat(40) });
    assert.equal(sealState("F0", { seals }), "무효");
    assert.deepEqual(blockedBy("F1", { gates: fixture(true), seals }), ["F0"], "무효인 봉인은 다음 단계를 열지 않는다");
  });

  it("TC-P0.T1.c — --seal 은 검사를 다시 돌린다", () => {
    const seals = scratch();
    // 초록이던 시점의 결과를 봉인 파일로 심어 둔다.
    writeSeal(seals, "F0", { head: head(), checks: [{ id: "G-F0.1", ok: true, measured: 0, limit: 0 }] });
    // 그리고 검사를 깨뜨린 상태로 다시 봉인을 시도한다.
    const code = seal("F0", undefined, { gates: fixture(false), seals, quiet: true });
    assert.notEqual(code, 0, "빨간 검사가 있으면 봉인하지 않는다");
    const stored = JSON.parse(readFileSync(join(seals, "F0.json"), "utf8")) as { checks: unknown[] };
    assert.deepEqual(stored.checks, [{ id: "G-F0.1", ok: true, measured: 0, limit: 0 }], "옛 봉인이 덮여 쓰이지도 않는다");
  });

  it("TC-P0.T1.d — 검사마다 이빨이 있다", () => {
    const scratchDir = scratch();
    const file = join(scratchDir, "sample.txt");
    writeFileSync(file, "alpha\nbravo\ncharlie\n");

    const teeth: Array<[string, Check, Check]> = [
      ["lines", { id: "t.1", how: "lines", file, limit: 3 }, { id: "t.2", how: "lines", file, limit: 2 }],
      ["grep", { id: "t.3", how: "grep", pattern: "alpha", in: file, min: 1 }, { id: "t.4", how: "grep", pattern: "alpha", in: file, limit: 0 }],
      ["cmd", { id: "t.5", how: "cmd", cmd: "true" }, { id: "t.6", how: "cmd", cmd: "false" }],
      ["test", { id: "t.7", how: "test", cmd: "true" }, { id: "t.8", how: "test", cmd: "false" }],
    ];
    for (const [name, ok, broken] of teeth) {
      assert.equal(verdict(ok, measure(ok)), true, `${name}: 만족하는 상태는 통과한다`);
      assert.equal(verdict(broken, measure(broken)), false, `${name}: 위반하는 상태는 실패한다`);
    }

    // diff-empty — 기준 커밋을 찾지 못하면 통과하지 않는다. 조용히 초록이 되는 것이
    // 이 검사의 최악이다: 「변경 없음」과 「비교하지 않음」이 같은 답이 된다.
    const missing: Check = { id: "t.9", how: "diff-empty", paths: ["src/"], since: "seal:없는단계", seals: scratchDir };
    assert.equal(verdict(missing, measure(missing)), false, "diff-empty: 기준이 없으면 실패한다");
    const real: Check = { id: "t.10", how: "diff-empty", paths: ["migrations/"], since: `${head()}` };
    assert.equal(verdict(real, measure(real)), true, "diff-empty: 변경이 없으면 통과한다");

    // json — 봉인에서 값을 못 읽으면 실패한다.
    writeSeal(scratchDir, "B", { head: head(), checks: [{ id: "G-B.1", ok: true, measured: 10, limit: 10 }] });
    const relative = join(scratchDir, "B.json");
    const readable: Check = { id: "t.11", how: "json", file: relative, path: "checks[id=G-B.1].measured", op: "<=", measure: { id: "t.11m", how: "cmd", cmd: "true" } };
    const unreadable: Check = { id: "t.12", how: "json", file: relative, path: "checks[id=없음].measured", op: ">=", measure: { id: "t.12m", how: "cmd", cmd: "true" } };
    assert.equal(verdict(unreadable, measure(unreadable)), false, "json: 기준값을 못 읽으면 실패한다");
    assert.equal(verdict(readable, measure(readable)), true, "json: 기준선 10 이상이면 통과한다 (측정 0 <= 10)");
  });

  it("TC-P0.T1.e — 봉인이 커밋되는 위치에 있다", () => {
    // `git check-ignore` 는 무시되는 경로에 0 을 준다. 봉인은 증거이고, 무시되는 증거는
    // 다른 체크아웃에서 존재하지 않는다 — CI 는 모든 단계를 잠긴 것으로 본다.
    let ignored = false;
    try {
      execFileSync("git", ["check-ignore", "gates/"], { cwd: ROOT, stdio: "ignore" });
      ignored = true;
    } catch { ignored = false; }
    assert.equal(ignored, false, "gates/ 가 .gitignore 에 걸려 있다");
  });

  it("TC-P0.T1.f — 면제는 사유 없이는 봉인되지 않는다", () => {
    // 계약이 요구하는 다섯 번째 하위명령. 사유 없는 면제는 「하지 않기로 했다」가 아니라
    // 「하지 않았다」이고, 그 둘이 같은 기록이 되면 면제는 게이트를 끄는 스위치가 된다.
    const seals = scratch();
    assert.notEqual(seal("F0", "", { gates: fixture(false), seals, quiet: true }), 0, "빈 사유는 거부한다");
    assert.equal(seal("F0", "이번 사이클에서는 하지 않는다", { gates: fixture(false), seals, quiet: true }), 0);
    assert.equal(sealState("F0", { seals }), "면제", "검사가 빨간 상태에서도 면제는 기록된다");
    assert.deepEqual(blockedBy("F1", { gates: fixture(false), seals }), [], "면제된 선행은 다음 단계를 연다");
  });

  it("TC-P0.T1.g — --assert-order 는 봉인 없이 바뀐 산출을 잡는다", () => {
    // 봉인되지 않은 단계의 산출이 이 브랜치에서 바뀌었으면 실패해야 한다. 이 브랜치는
    // README 를 바꿨으므로, 그것을 산출로 대는 가짜 단계는 봉인 없이 걸린다.
    const seals = scratch();
    const gates: Record<string, Phase> = { P9: { needs: [], outputs: ["README.md"], checks: [] } };
    // ⚠️ 기준을 **명시로** 넘긴다. 넘기지 않으면 `merge-base(origin/main, HEAD)` 를 쓰는데,
    // CI 의 얕은 체크아웃에는 `origin/main` 이 없다 — 이 단언이 CI 에서만 빨개져서 그
    // 사실을 알려 줬고, 그때 함수는 조용히 0 을 내고 있었다.
    const base = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: ROOT, encoding: "utf8" }).trim();
    const touched = execFileSync("git", ["diff", "--name-only", `${base}..HEAD`], { cwd: ROOT, encoding: "utf8" });
    const output = touched.split("\n").find((line) => line !== "") ?? "README.md";
    const naming: Record<string, Phase> = { P9: { needs: [], outputs: [output], checks: [] } };
    assert.notEqual(assertOrder({ gates: naming, seals, base }), 0, "봉인 없이 산출이 바뀌면 실패한다");

    // 같은 단계를 봉인하면 통과한다 — 순서를 지킨 경우다.
    writeSeal(seals, "P9", { head: head() });
    assert.equal(assertOrder({ gates: naming, seals, base }), 0, "봉인된 단계의 산출 변경은 문제가 아니다");

    // 아무 산출도 대지 않는 단계는 무엇이 바뀌어도 걸리지 않는다 — 이 검사가 「무엇을
    // 보는지」가 `outputs` 뿐임을 못 박는다.
    const blind: Record<string, Phase> = { P9: { needs: [], outputs: [], checks: [] } };
    assert.equal(assertOrder({ gates: blind, seals: scratch(), base }), 0);

    // 기준을 못 찾으면 실패한다 — 「비교하지 않았다」가 「문제가 없다」로 읽히면 안 된다.
    assert.notEqual(assertOrder({ gates, seals: scratch(), base: "" }), 0, "기준 없이는 통과하지 않는다");
    void gates;
  });

  it("TC-P0.T1.h — 금지 표식 면제는 이름으로만 걸린다", () => {
    // 금지 표식을 정의하는 파일은 그 표식을 담을 수밖에 없다. 면제가 규칙(예: 「검사 파일은
    // 모두 면제」)이 되면 다음 면제가 조용히 늘고, 그러면 금지가 아니라 권고가 된다.
    const scratchDir = scratch();
    const guilty = join(scratchDir, "guilty.md");
    const quoting = join(scratchDir, "quoting.md");
    writeFileSync(guilty, "여기에 GATE-TEMP 가 남아 있다\n");
    writeFileSync(quoting, "이 파일은 GATE-TEMP 를 정의한다\n");
    const both: Check = { id: "t.20", how: "grep", pattern: "GATE-TEMP", in: join(scratchDir, "*.md"), limit: 0 };
    assert.equal(verdict(both, measure(both)), false, "면제가 없으면 둘 다 걸린다");
    const exempted: Check = { ...both, id: "t.21", except: [quoting] };
    assert.equal(measure(exempted).measured, 1, "면제한 파일만 빠진다 — 나머지는 그대로 걸린다");
    const all: Check = { ...both, id: "t.22", except: [quoting, guilty] };
    assert.equal(measure(all).measured, 0, "둘 다 면제하면 0 이다 — 그래서 면제는 이름으로만 쓴다");
  });
});

describe("기준선 패턴이 대상을 잡는 방식", () => {
  const find = (id: string) => GATES.P0!.checks.find((check) => check.id === id);

  it("TC-P0.T2.b — 줄바꿈이 패턴을 가르지 않는다", () => {
    // README 가 「provider」와 「adapter」 사이에서 줄바꿈된다. 두 단어를 붙여 찾으면
    // 등장 수가 0 이고, 그 0 은 「이미 고쳐졌다」로 읽힌다.
    //
    // 픽스처에 대고 재는 이유는 살아 있는 README 가 P1 뒤에 두 패턴 모두 0 이 되어
    // 「붙여 찾으면 0」이 아무것도 증명하지 않게 되기 때문이다. 이 TC 는 문서의 지금
    // 상태가 아니라 패턴의 성질을 묻는다.
    assert.equal(find("G-P0.3")?.pattern, "only real provider", "패턴에 adapter 가 붙어 있지 않다");
    const wrapped = join(scratch(), "wrapped.md");
    writeFileSync(wrapped, "Cloudflare is the only real provider\nadapter; the local file provider …\n");
    const joined: Check = { id: "t.13", how: "grep", pattern: "only real provider adapter", in: wrapped };
    const split: Check = { id: "t.14", how: "grep", pattern: "only real provider", in: wrapped };
    assert.equal(measure(joined).measured, 0, "붙여 찾으면 0 이다 — 그래서 붙이지 않는다");
    assert.equal(measure(split).measured, 1, "끊어 찾으면 잡힌다");
  });

  it("TC-P0.T2.c — 기준선 검사가 셋 다 검사표에 있고 제약을 가진다", () => {
    // P0 시점의 측정값 자체는 봉인이 들고 있고, 그 봉인을 읽는 것은 `G-P1.12` 다 —
    // 봉인을 만드는 검사가 자기 출력을 읽을 수는 없다. 여기서 확인하는 것은 셋이 검사표에
    // 있고 제약이 붙어 있다는 것뿐이다: 제약 없는 검사는 측정만 하고 판정하지 않는다.
    for (const id of ["G-P0.3", "G-P0.4", "G-P0.5"]) {
      const check = find(id);
      assert.ok(check, `${id} 가 검사표에 있다`);
      assert.equal(check.equals, 1, `${id}: 「정확히 1」을 요구한다 — 0 도 2 도 통과하지 않는다`);
    }
  });
});
