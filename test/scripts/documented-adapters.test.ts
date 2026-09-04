import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * README 의 한계 절이 대는 주장과 코드의 사실을 짝지어 둔다.
 *
 * 세 주장 중 하나가 **거짓이었다.** 「실제 프로바이더 어댑터는 Cloudflare 하나뿐」인데
 * `src/adapters/rfc2136.ts` 가 있었고, 같은 README 가 361 줄 앞에서 그 변수를 정확히
 * 설명하고 있었다 — 한 문서 안의 모순이 양 언어에 나란히 있었다.
 *
 * 아무도 게을러서가 아니다. 어댑터를 추가한 커밋은 `docs/todo.md` 와
 * `docs/provider-adapters.md` 를 갱신했고 README 의 한계 절은 건드리지 않았다. **그
 * 문장이 그 커밋의 범위에 있다고 말해 주는 것이 없었다.** 그 경로를 막는 것이 이 파일이다.
 *
 * ⚠️ 세 검사는 **도착하는 날 이미 초록**이다. 그러니 초록은 아무것도 증명하지 않는다 —
 * 측정하지 않는 검사도 똑같이 초록이다. 각 짝마다 음성 대조를 붙여 둔 이유가 그것이고,
 * 이 파일의 값은 그 대조들에 있다.
 */

const ROOT = new URL("../../", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, ROOT), "utf8");

const temporary: string[] = [];
after(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); });
function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), "parallax-claims-"));
  temporary.push(path);
  return path;
}

/** `implements ProviderAdapter` 를 선언한 `src/**` 파일. 이것이 「있는 어댑터」의 정의다. */
async function implementations(): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of glob("src/**/*.ts")) {
    if (read(entry).includes("implements ProviderAdapter")) found.push(entry);
  }
  return found.sort();
}

/** 문서가 대지 않는 구현. 개수가 아니라 경로를 낸다 — 개수로는 고칠 수 없다. */
function unnamed(paths: readonly string[], document: string): string[] {
  return paths.filter((path) => !document.includes(path));
}

describe("문서가 대는 어댑터 집합이 구현 집합과 같다", () => {
  it("TC-P2.T1.a — 구현 파일 전부가 문서에 이름으로 있다", async () => {
    const paths = await implementations();
    const missing = unnamed(paths, read("docs/provider-adapters.md"));
    assert.deepEqual(
      missing,
      [],
      `docs/provider-adapters.md 가 이 구현을 대지 않는다: ${missing.join(" ")}`,
    );
  });

  it("TC-P2.T1.b — 대조가 무엇도 못 찾은 상태로 초록이 되지 않는다", async () => {
    // `implements ProviderAdapter` 표기가 바뀌면(타입 별칭, 인터페이스 분리) 수집이 0 이
    // 되고, 빈 집합은 위반도 0 이라 이 파일이 영구 초록이 된다. 초록이 「통과」가 아니라
    // 「아무것도 보지 않음」을 뜻하게 되는 것이 이 검사의 조용한 실패 양식이다.
    const paths = await implementations();
    assert.ok(paths.length >= 2, `구현을 ${paths.length}개 찾았다 — 표기가 바뀌었는지 확인할 것`);
    assert.ok(paths.includes("src/adapters/cloudflare.ts"), "Cloudflare 어댑터를 찾았다");
    assert.ok(paths.includes("src/adapters/rfc2136.ts"), "RFC 2136 어댑터를 찾았다 — README 가 없다고 했던 그것");
  });

  it("TC-P2.T1.c — 문서에서 이름이 빠지면 빨개진다", async () => {
    // 이 파일의 존재 이유. 사본에서 한 줄을 지워 위반이 잡히는지 본다.
    const paths = await implementations();
    const document = read("docs/provider-adapters.md");
    const target = paths[0] as string;
    const damaged = document.split("\n").filter((line) => !line.includes(target)).join("\n");
    assert.deepEqual(unnamed(paths, damaged), [target], "이름이 빠진 구현 하나를 정확히 집어낸다");
    assert.deepEqual(unnamed(paths, document), [], "원본은 여전히 초록이다");
  });
});

describe("한계 절의 나머지 두 주장이 코드와 맞다", () => {
  const LIMITS = [
    { file: "README.md", from: "## Status & limitations", to: "## License" },
    { file: "README.ko.md", from: "## 현재 상태와 한계", to: "## 라이선스" },
  ] as const;

  /** 한계 절만 잘라 낸다. 파일 전체를 보면 설정 표가 대신 답한다. */
  function limitation(file: string, from: string, to: string): string {
    const text = read(file);
    const start = text.indexOf(from);
    assert.notEqual(start, -1, `${file} 에 「${from}」 절이 있다`);
    const end = text.indexOf(to, start + from.length);
    return text.slice(start, end < 0 ? undefined : end);
  }

  /**
   * `authorize` 의 매개변수 목록. 서명을 찾지 못하면 `undefined` 다.
   *
   * 「존을 받지 않는다」와 「서명을 못 찾았다」를 같은 답으로 만들면 함수 이름이 바뀐 날
   * 이 짝이 조용히 초록이 된다 — 여기서 갈라 두고, 부르는 쪽이 둘을 따로 단언한다.
   */
  function authorizeParameters(source: string): string | undefined {
    return /export function authorize\(([^)]*)\)/u.exec(source)?.[1];
  }

  /**
   * 그 서명이 존을 받는가.
   *
   * ⚠️ **본 검사와 음성 대조가 이 함수 하나를 함께 지난다.** 대조 안에 정규식을 다시 적으면
   * 입력도 매처도 그 자리의 리터럴이라 언제나 참이고, 진짜 매처가 바뀌어 아무것도 못 잡게
   * 된 날에도 대조는 초록으로 남는다 — 대조가 지키기로 한 그것을 대조가 못 보게 된다.
   */
  function takesZone(source: string): boolean {
    const parameters = authorizeParameters(source);
    return parameters !== undefined && /zone/iu.test(parameters);
  }

  /** 거부 테스트가 그 스위트에 남아 있는가. 위와 같은 이유로 표기는 여기 한 곳에만 있다. */
  function keepsRefusal(source: string): boolean {
    return /it\("refuses to restore over the store it came from"/u.test(source);
  }

  it("TC-P2.T2.a — 라우트 단위 주장이 코드와 맞다", () => {
    // 존별 RBAC 을 구현하고 한계 절을 안 지우는 것이 §R1 의 거울상이다. **있는 기능을
    // 없다고 적은 문서는 없는 기능을 있다고 적은 것과 같은 크기의 거짓이다.**
    const claims = LIMITS.map(({ file, from, to }) =>
      /route-based,\s+not zone-based|존 단위가\s+아니라 라우트 단위/u.test(limitation(file, from, to)));
    assert.deepEqual(claims, [true, true], "두 README 가 같은 주장을 한다");

    const authorization = read("src/security/http-authorization.ts");
    const parameters = authorizeParameters(authorization);
    assert.ok(parameters !== undefined, "authorize 가 있다");
    assert.equal(
      takesZone(authorization),
      false,
      `주장은 「라우트 단위」인데 authorize 가 존을 받는다: ${parameters} — 어느 쪽이 움직였는지 확인할 것`,
    );
  });

  it("TC-P2.T2.b — restore 주장이 그 동작을 확인하는 테스트와 맞다", () => {
    const claims = LIMITS.map(({ file, from, to }) =>
      // ⚠️ `\s+` 는 장식이 아니다. 국문 원문이 「병합이」와 「아니며」 사이에서 줄바꿈되고,
      // 공백 하나로 붙여 찾으면 매치가 0 이다 — 그 0 은 「주장이 사라졌다」로 읽힌다.
      // `TC-P0.T2.b` 가 경고한 실패 양식이고, 이 파일을 쓰면서 실제로 걸렸다.
      /`restore` is not a merge|`restore`는 병합이\s+아니며/u.test(limitation(file, from, to)));
    assert.deepEqual(claims, [true, true], "두 README 가 같은 주장을 한다");

    // 거부를 없애면서 문서를 안 고치면 두 스토어를 합치는 사고가 조용히 가능해진다.
    assert.ok(
      keepsRefusal(read("test/cli/backup-restore.test.ts")),
      "주장을 지키는 테스트가 사라졌다 — 주장과 사실 중 어느 쪽이 움직였는지 확인할 것",
    );
  });

  it("TC-P2.T2.c — 세 대조가 각각 이빨을 가진다", () => {
    // 하나의 대조가 다른 것을 가리면 셋이 함께 초록/빨강이 되어 무엇이 움직였는지 모른다.
    // 셋을 하나씩 인위로 깨뜨려 그 짝만 실패하는지 본다.
    const scratchDir = scratch();

    // ① 어댑터 짝 — 문서에서 이름을 지우면 그 경로만 잡힌다 (TC-P2.T1.c 가 본체)
    const document = read("docs/provider-adapters.md");
    assert.deepEqual(unnamed(["src/adapters/rfc2136.ts"], document), [], "원본은 초록");
    assert.deepEqual(
      unnamed(["src/adapters/rfc2136.ts"], document.replace("src/adapters/rfc2136.ts", "지움")),
      ["src/adapters/rfc2136.ts"],
      "지우면 그 경로가 잡힌다",
    );

    // ② RBAC 짝 — 서명에 존이 붙으면 잡힌다. **TC-P2.T2.a 가 쓰는 그 `takesZone` 으로**
    //    잰다: 여기 정규식을 다시 적으면 진짜 매처가 무엇을 하든 이 줄은 참이다.
    const withZone = "export function authorize(principal: Principal, request: Request, zones: Set<string>): boolean {";
    const withoutZone = "export function authorize(principal: Principal, request: Request): boolean {";
    assert.equal(takesZone(withZone), true, "존을 받는 서명은 대조에 걸린다");
    assert.equal(takesZone(withoutZone), false, "받지 않는 서명은 걸리지 않는다 — 둘 다 참이면 대조가 아니다");

    // ③ restore 짝 — 테스트 이름이 사라지면 잡힌다. 같은 이유로 `keepsRefusal` 을 지난다.
    const withoutTest = join(scratchDir, "no-refusal.test.ts");
    writeFileSync(withoutTest, 'it("moves a store into an empty one", async () => {});\n');
    assert.equal(keepsRefusal(readFileSync(withoutTest, "utf8")), false, "거부 테스트가 없는 파일은 대조에 걸린다");
    assert.equal(
      keepsRefusal('it("refuses to restore over the store it came from", async () => {});\n'),
      true,
      "있는 파일은 걸리지 않는다 — 없음만 잡는 매처인지 여기서 본다",
    );
  });
});
