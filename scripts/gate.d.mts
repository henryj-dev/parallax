/**
 * 게이트 장치의 타입 선언.
 *
 * 장치 자체는 `.mjs` 다 — `pnpm test` 가 돌기 전에도, `node_modules` 가 없어도 돌아야
 * 하기 때문이다(CI 의 `--assert-order` 가 그 자리에서 돈다). 그래서 타입은 여기 따로 둔다.
 */

export type How = "lines" | "grep" | "test" | "cmd" | "diff-empty" | "json";

export interface Check {
  readonly id: string;
  readonly what?: string;
  readonly how: How;
  /** `lines` · `json` */
  readonly file?: string;
  /** `grep` — 파일 경로 또는 글롭 */
  readonly in?: string;
  readonly pattern?: string;
  /** `grep` — 파일의 이 구간만 본다. `[시작 정규식, 끝 정규식]` */
  readonly between?: readonly [string, string];
  /** `grep` — 등장 줄 수 대신 파일 수를 센다 */
  readonly count?: "files" | "lines";
  /** `cmd` · `test` */
  readonly cmd?: string;
  /** `cmd` — 종료코드가 0 이 아니어야 통과 */
  readonly expect?: "nonzero";
  /** `cmd` — 표준출력에서 통과 수를 읽어 측정값으로 쓴다 */
  readonly capture?: string;
  /** `diff-empty` */
  readonly paths?: readonly string[];
  readonly since?: string;
  /** `diff-empty` — 경로 안에서 이 문자열을 담은 줄이 움직였는지만 본다 */
  readonly grep?: string;
  /** `json` */
  readonly path?: string;
  readonly op?: ">=" | "<=" | "==";
  /** 없으면 봉인 값 자체에 `min`·`limit`·`equals` 를 건다 — 「그때 이랬다」를 묻는 검사 */
  readonly measure?: Check;
  /** 판정 제약. 여럿이면 전부 만족해야 한다 */
  readonly equals?: number;
  readonly limit?: number;
  readonly min?: number;
  /** 음성 대조에서만 쓴다 — 봉인을 임시 디렉터리에서 읽게 한다 */
  readonly seals?: string;
}

export interface Phase {
  readonly needs: readonly string[];
  /** `--assert-order` 가 보는 경로 */
  readonly outputs: readonly string[];
  readonly checks: readonly Check[];
}

export interface Measurement {
  readonly measured: number;
  readonly limit?: number | string;
  readonly code?: number;
  readonly detail?: string;
  /** `json` 처럼 측정 자체가 판정을 담을 때 */
  readonly forced?: boolean;
}

export interface CheckResult {
  readonly id: string;
  readonly ok: boolean;
  readonly measured: number;
  readonly limit: number | string;
  readonly detail: string;
}

/** 검사표와 봉인 위치를 주입한다. 기본값은 이 저장소의 것 */
export interface Context {
  readonly gates?: Record<string, Phase>;
  readonly seals?: string;
  /**
   * 아무것도 쓰지 않는다. 음성 대조는 **실패하는 검사를 일부러** 돌리므로, 그 `✖` 가
   * 초록 실행에 섞이면 읽는 사람이 무엇이 진짜 실패인지 가릴 수 없다.
   */
  readonly quiet?: boolean;
}

export declare const GATES: Record<string, Phase>;

export declare function measure(check: Check): Measurement;
export declare function verdict(check: Check, result: Measurement): boolean;
/** `봉인` · `면제` · `무효` · `열림` */
export declare function sealState(phase: string, context?: Context): string;
export declare function blockedBy(phase: string, context?: Context): string[];
export declare function runPhase(
  phase: string,
  options?: Context & { explain?: boolean },
): { ok: boolean; results: CheckResult[]; blocked?: string[] };
export declare function seal(phase: string, waived?: string, context?: Context): number;
export declare function status(context?: Context): number;
export declare function assertOrder(context?: Context): number;
