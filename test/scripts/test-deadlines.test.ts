import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { describe, it } from "node:test";

/**
 * 테스트가 자기 안에 둔 마감은 **러너의 마감보다 짧아야 한다.**
 *
 * `pnpm test` 는 `--test-timeout` 을 걸고 돈다. 테스트 안의 하위 프로세스 마감이 그것과
 * 같거나 크면 두 마감이 경합하고, 먼저 시작한 러너가 대개 이긴다 — 그러면 결과는 그 테스트가
 * 쓰려던 진단(「`tsc` 가 시간 안에 끝나지 않았다」)이 아니라 **취소된 테스트**다. 취소된
 * 테스트는 왜 취소됐는지 말하지 않고, 읽는 사람에게는 원인 없는 빨강 하나만 남는다.
 *
 * `test/http/portal-names.test.ts` 가 정확히 러너와 같은 값을 들고 있었다(둘 다 120초).
 * 그 파일의 실제 소요는 0.5초라 발화한 적은 없지만, 발화하는 날 무엇이 이길지는 정해져
 * 있었다 — 그리고 지는 쪽이 이유를 아는 쪽이었다.
 *
 * 📌 이 검사는 「간헐 실패의 원인」이 아니다. 그것을 찾다가 나온 별개의 잠재 결함이고,
 * [`docs/test-flakes.md`](../../docs/test-flakes.md) 가 그 구분을 적고 있다.
 */
describe("테스트의 마감은 러너의 마감보다 짧다", () => {
  const runnerTimeout = async (): Promise<number> => {
    const scripts = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as
      { scripts: Record<string, string> };
    const found = /--test-timeout=(\d+)/u.exec(scripts.scripts.test ?? "");
    assert.ok(found, "`pnpm test` 가 --test-timeout 을 걸고 있어야 이 검사가 뜻이 있다");
    return Number(found[1]);
  };

  it("러너의 마감을 package.json 에서 읽는다", async () => {
    // 값을 여기 적지 않는다. 적으면 두 곳이 어긋나고, 어긋나면 이 검사가 옛 값을 지킨다.
    const limit = await runnerTimeout();
    assert.ok(limit > 0, `--test-timeout=${limit}`);
  });

  /**
   * 소스 한 덩이가 든, 러너보다 먼저 발화하지 못하는 마감. 이름과 값으로 낸다 — 개수로는
   * 고칠 수 없다.
   *
   * ⚠️ **이 함수 하나만 있는 것이 요점이다.** 아래 음성 대조들은 이것을 부르고, 정규식을
   * 자기 안에 다시 적지 않는다. 다시 적으면 대조는 입력도 매처도 그 자리의 리터럴이라
   * 언제나 참이고, 표기가 바뀌어 진짜 수집이 0 이 된 날에도 초록으로 남는다 — 대조가
   * 지키기로 한 바로 그 실패 양식을 대조가 못 보게 된다.
   */
  const offending = (source: string, limit: number): Array<{ name: string; value: number }> => {
    const found: Array<{ name: string; value: number }> = [];
    for (const [, name, raw] of source.matchAll(/const (\w*TIMEOUT_MS) = ([\d_]+)/gu)) {
      const value = Number((raw as string).replaceAll("_", ""));
      if (value >= limit) found.push({ name: name as string, value });
    }
    return found;
  };

  it("어떤 테스트도 러너와 같거나 긴 마감을 두지 않는다", async () => {
    const limit = await runnerTimeout();
    const offenders: string[] = [];
    let scanned = 0;
    for await (const entry of glob("test/**/*.test.ts")) {
      scanned += 1;
      const source = await readFile(entry, "utf8");
      for (const { name, value } of offending(source, limit)) {
        offenders.push(`${entry}: ${name} = ${value} (러너 ${limit})`);
      }
    }
    // `glob` 은 `process.cwd()` 에 대고 푼다. 러너를 저장소 루트가 아닌 곳에서 부르면 아무것도
    // 매치하지 않고, 읽은 파일이 0 이면 위반도 0 이라 이 검사는 영구 초록이 된다 — 「마감이
    // 다 짧다」와 「아무것도 보지 않았다」가 같은 답이 되는 것이다. 형제 검사들이 같은 자리에
    // 같은 바닥을 둔다(`documented-adapters`, `source-reviewability`).
    assert.ok(scanned >= 50, `테스트 파일을 ${scanned}개 읽었다 — 저장소 루트에서 돌고 있는지 확인할 것`);
    assert.deepEqual(
      offenders,
      [],
      `러너보다 먼저 발화하지 못하는 마감이 있다 — 발화하면 그 테스트의 진단 대신 취소가 남는다:\n  ${offenders.join("\n  ")}`,
    );
  });

  it("이 검사에 이빨이 있다", async () => {
    // 러너와 같은 값이 위반으로 잡히는지, 짧은 값은 안 잡히는지. **위 검사가 쓰는 그 함수로**
    // 잰다 — 검사가 정규식으로 소스를 읽으므로, 표기가 바뀌어 아무것도 못 잡게 되는 것이
    // 이것의 조용한 실패 양식이고, 그 표기는 한 곳에만 적혀 있어야 여기서 걸린다.
    const limit = await runnerTimeout();
    const sample = `const START_TIMEOUT_MS = ${limit};\nconst OTHER_TIMEOUT_MS = ${limit - 1};\n`;
    assert.deepEqual(
      offending(sample, limit),
      [{ name: "START_TIMEOUT_MS", value: limit }],
      "같은 값만 잡고, 1ms 짧은 값은 통과시킨다",
    );
  });

  it("밑줄이 들어간 표기도 읽는다", () => {
    // `60_000` 이 이 저장소의 표기다. 밑줄을 지우지 않으면 `Number("60_000")` 는 NaN 이고,
    // NaN >= limit 는 false 라 **모든 위반이 조용히 통과한다** — 그래서 빈 배열이 나오는
    // 것으로 그 회귀가 여기서 드러난다.
    assert.deepEqual(
      offending("const A_TIMEOUT_MS = 60_000;", 60_000),
      [{ name: "A_TIMEOUT_MS", value: 60_000 }],
      "밑줄을 지우지 않으면 NaN 이 되고 비교가 항상 거짓이 된다",
    );
  });
});
