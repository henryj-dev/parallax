import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * `scripts/audit.sh` — 물어보지 못한 것을 권고 없음으로 읽지 않는다.
 *
 * 🔴 **이 파일은 사고에서 나왔다.** `check.yml` 의 `audit` 잡은 `pnpm run audit` 한
 * 줄이었고, `#29` 가 머지된 직후 main 을 빨갛게 만들었다. 실패는 권고 때문이 아니라
 * 레지스트리의 advisories 엔드포인트가 응답하지 않아서였다 — 재시도 3회 전부 타임아웃.
 * PR 에서는 두 번 다 통과했다(한 번은 6분 42초가 걸렸고, 그게 신호였다).
 *
 * 🔑 **두 결과가 같은 종료 코드로 온다.** `pnpm audit` 는 권고를 찾아도, 물어보지 못해도
 * 0 이 아닌 값을 낸다. 그래서 종료 코드만 보는 검사는 「이 커밋에 취약한 의존성이 있다」와
 * 「우리가 물어보지 못했다」를 같은 것으로 취급한다.
 *
 * 여기서 재는 것은 그 셋이 **서로 다른 결과로 갈라지는가**다. 진짜 레지스트리를 부르면
 * 잴 수 없는 것들이라 — 네트워크에 기대는 테스트는 이 사고를 만든 바로 그 의존이다 —
 * `PNPM` 이음매에 가짜를 물려 세 상황을 결정적으로 재현한다.
 *
 * ⚠️ **셋 중 마지막이 이 스위트의 존재 이유다.** 「물어보지 못했을 때 통과한다」는
 * 의도한 열림이고, 의도한 열림은 실수로 생긴 열림과 코드에서 구별되지 않는다. 여기
 * 적혀 있는 동안에만 그것이 결정으로 남는다.
 */
const SCRIPT = fileURLToPath(new URL("../../scripts/audit.sh", import.meta.url));

const workspaces: string[] = [];
after(async () => {
  await Promise.all(workspaces.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * `pnpm` 인 척하는 실행 파일 하나를 만들고, 그것을 물린 채 스크립트를 돌린다.
 *
 * `attempts` 는 재시도가 실제로 일어나는지 보기 위한 것이다 — 한 번만 부르고 포기하는
 * 스크립트도 「물어보지 못함」 경로를 통과하므로, 횟수를 세지 않으면 재시도가 사라진
 * 것을 알 수 없다.
 */
async function withFakePnpm(body: string): Promise<{ stdout: string; stderr: string; code: number; calls: number }> {
  const workspace = await mkdtemp(join(tmpdir(), "parallax-audit-"));
  workspaces.push(workspace);
  const fake = join(workspace, "pnpm");
  const tally = join(workspace, "calls");
  await writeFile(fake, `#!/usr/bin/env bash\necho x >> ${JSON.stringify(tally)}\n${body}\n`);
  await chmod(fake, 0o755);

  try {
    const { stdout, stderr } = await run("bash", [SCRIPT], {
      env: { PATH: process.env["PATH"] ?? "", PNPM: fake, AUDIT_SLEEP: "0" },
    });
    return { stdout, stderr, code: 0, calls: await countCalls(tally) };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: failure.code ?? -1,
      calls: await countCalls(tally),
    };
  }
}

async function countCalls(tally: string): Promise<number> {
  try {
    return (await readFile(tally, "utf8")).trimEnd().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe("the advisory check tells apart a finding from a failure to ask", () => {
  it("passes when the registry answers and there is nothing to report", async () => {
    const result = await withFakePnpm(`echo '{"advisories":{},"metadata":{"vulnerabilities":{}}}'\nexit 0`);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no advisories at or above moderate/u);
    assert.equal(result.calls, 1, "an answer on the first attempt must not be retried");
  });

  it("fails when the registry answers and names an advisory", async () => {
    // 이 방향이 잡의 존재 이유다. 여기가 통과하면 검사는 없는 것과 같다.
    const report = '{"advisories":{"1234":{"module_name":"pg","severity":"high"}}}';
    const result = await withFakePnpm(`echo '${report}'\nexit 1`);
    assert.equal(result.code, 1, "a real advisory must fail the job");
    assert.match(result.stdout, /::error::advisories at or above moderate/u);
    assert.match(result.stdout, /pg/u, "the report must reach the log, or the red says nothing");
    assert.equal(result.calls, 1, "an answer is an answer; do not retry a finding away");
  });

  it("passes with a warning when the registry never answers", async () => {
    // 의도한 열림. `dependency-review` 가 PR 이 새로 끌고 오는 것을 따로 막으므로,
    // 여기서 못 답한 하루가 배포를 위태롭게 하지는 않는다 -- 레지스트리가 죽은 동안
    // 머지를 못 하는 쪽이 더 위태롭다. 조용히 넘기지 않는 것이 조건이다.
    const result = await withFakePnpm(`echo 'TimeoutError: The operation was aborted due to timeout' >&2\nexit 1`);
    assert.equal(result.code, 0, "an unreachable registry is not a fact about this commit");
    assert.match(result.stdout, /::warning::the advisory database did not answer/u);
    assert.match(result.stdout, /not audited/u);
    assert.equal(result.calls, 3, "it must actually retry before giving up");
  });

  it("treats output that is not a report as a failure to ask, however plausible", async () => {
    // 레지스트리가 HTML 오류 페이지나 프록시의 안내문을 돌려주는 경우. 종료 코드는
    // 권고를 찾았을 때와 같으므로, 파싱되는지 말고는 가를 방법이 없다.
    const result = await withFakePnpm(`echo '<html><body>502 Bad Gateway</body></html>'\nexit 1`);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /::warning::/u);
    assert.equal(result.calls, 3);
  });

  it("does not read the timeout envelope as an advisory, though it is valid JSON", async () => {
    // 🔴 **이 케이스가 첫 고침을 무효로 만들 뻔했다.** 처음에는 「파싱되면 답이다」로
    // 갈랐는데, 타임아웃일 때 `pnpm audit --json` 이 내놓는 것은 깨진 출력이 아니라
    // 유효한 JSON 객체다 -- 아래가 이 저장소에서 실제로 받은 바이트다. 객체이고 종료
    // 코드가 0 이 아니므로 그 규칙은 이것을 권고로 읽고, 고치려던 사고를 그대로
    // 재현했을 것이다. 실제 출력을 재 보기 전까지 그럴듯해 보였다.
    const envelope = '{"error":{"code":23,"message":"The operation was aborted due to timeout"}}';
    const result = await withFakePnpm(`echo '${envelope}'\nexit 1`);
    assert.equal(result.code, 0, "a timeout envelope is not an advisory");
    assert.match(result.stdout, /::warning::the advisory database did not answer/u);
    assert.doesNotMatch(result.stdout, /::error::/u);
    assert.equal(result.calls, 3, "it is a failure to ask, so it must retry");
  });

  it("does not read a bare JSON array as a report", async () => {
    // `type == "object"` 인 이유. 배열도 JSON 이지만 이 보고서의 모양이 아니고,
    // 모양을 확인하지 않으면 「파싱된다」가 「답이다」로 새어 나간다.
    const result = await withFakePnpm(`echo '[]'\nexit 1`);
    assert.equal(result.code, 0, "an array is not the report shape; treat it as no answer");
    assert.match(result.stdout, /::warning::/u);
  });

  it("cannot outlive the job that runs it", async () => {
    // 🔴 **첫 판이 정확히 여기서 죽었다.** 시도당 120초, 대기 30·60초로 잡아 최악 450초
    // 였고, `pnpm install` 과 체크아웃이 붙자 `audit` 잡의 `timeout-minutes: 10` 을 넘겨
    // 10분 17초에 잘렸다(`rc=124`). 판정 로직은 옳았는데 **판정을 내리기 전에 죽었다** —
    // 고치려던 것과 같은 결과, 커밋과 무관한 이유로 빨간 필수 게이트.
    //
    // `test-deadlines.test.ts` 가 「테스트의 마감 < 러너의 마감」을 강제하는 것과 같은
    // 규칙이다. 여기서는 「스크립트의 최악 소요 < 잡의 상한」이고, 두 값을 각자의 파일에서
    // 읽어 온다 -- 어느 쪽을 올려도 다른 쪽이 따라오지 않으면 여기서 걸린다.
    const script = await readFile(SCRIPT, "utf8");
    const numberOf = (name: string): number => {
      const found = new RegExp(String.raw`\$\{${name}:-(\d+)\}`, "u").exec(script)?.[1];
      assert.ok(found, `${name} must have a default in the script`);
      return Number(found);
    };
    const attempts = numberOf("AUDIT_ATTEMPTS");
    const perAttempt = numberOf("ATTEMPT_TIMEOUT");
    const sleepUnit = numberOf("AUDIT_SLEEP");
    // 대기는 시도 번호에 비례한다: 1×unit, 2×unit, ... 마지막 시도 뒤에는 자지 않는다.
    const waiting = sleepUnit * ((attempts - 1) * attempts) / 2;
    const worstCase = attempts * perAttempt + waiting;

    const workflow = await readFile(new URL("../../.github/workflows/check.yml", import.meta.url), "utf8");
    const auditJob = /^ {2}audit:$([\s\S]*?)^ {2}\S/mu.exec(workflow)?.[1];
    assert.ok(auditJob, "check.yml must define an `audit` job");
    const limitMinutes = Number(/timeout-minutes:\s*(\d+)/u.exec(auditJob)?.[1]);
    assert.ok(Number.isFinite(limitMinutes), "the audit job must bound itself");

    // 절반을 남긴다. 나머지는 체크아웃 · setup-node · `pnpm install` 의 몫이고, 그 셋은
    // 이 스크립트가 통제하지 못한다.
    const budget = limitMinutes * 60 * 0.5;
    assert.ok(
      worstCase < budget,
      `the script's worst case is ${worstCase}s, which leaves too little of the job's ${limitMinutes}min for install and setup`,
    );
  });

  it("accepts a clean report whatever keys it carries", async () => {
    // 술어가 `.error` 의 **부재**로 가르고 보고서의 키를 요구하지 않는 이유.
    //
    // 이 고침을 쓰는 동안 레지스트리가 계속 죽어 있어서 **성공 출력을 한 번도 재지
    // 못했다.** `advisories`/`metadata` 를 요구하는 판을 먼저 썼다가 되돌린 것은 그것이
    // 재어 보지 않은 모양에 검사를 거는 일이기 때문이다 -- 키 이름이 다르면 성공이
    // 「답 아님」이 되어 조용히 경고만 남는다. 아는 것으로 배제하고, 모르는 것에는
    // 기대지 않는다. 이 테스트가 그 결정을 붙잡아 둔다.
    for (const shape of ['{"metadata":{"vulnerabilities":{}}}', '{"actions":[],"muted":[]}', "{}"]) {
      const result = await withFakePnpm(`echo '${shape}'\nexit 0`);
      assert.equal(result.code, 0, `${shape} answered cleanly and must pass`);
      assert.match(result.stdout, /no advisories at or above moderate/u, shape);
      assert.doesNotMatch(result.stdout, /::warning::/u, `${shape} was an answer, not a failure to ask`);
    }
  });
});
