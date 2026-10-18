import type { PgQueryable } from "./postgres.ts";

/**
 * 저장소에 기록된 인증 기능 표식 중 이 바이너리가 아는 것.
 *
 * 이 버전은 `member-accounts-v1`(회원 계정)을 안다. `parallax accounts enable` 이 계정
 * 상태와 같은 트랜잭션에서 남긴다. 더 새 버전이 남긴 모르는 표식이 있으면, 이 버전이
 * 그 데이터를 모른 채 관리 화면을 열지 않도록 관리 포트를 열기 전에 시작을 거절한다.
 *
 * 표식이 없는 저장소는 지금까지의 설치다. 그대로 legacy 로 받는다.
 *
 * 이 검사는 이 버전부터만 효과가 있다. 이 목록이 생기기 전 버전은 표식을 읽지
 * 않으므로, 표식이 있어도 그대로 시작한다. 그런 버전으로는 되돌리지 않는다.
 *
 * 저장 정책:
 * - PostgreSQL: `parallax_auth_features` 테이블의 `feature` 열, 기능 하나에 한 행.
 *   테이블은 그 기능을 들이는 마이그레이션이 만들고, 기능을 켜는 같은 트랜잭션
 *   안에서 행을 넣는다. 이 파일은 읽기만 하고 DDL 을 실행하지 않는다.
 *   스키마는 한정하지 않는다. 다른 Parallax 테이블처럼 연결의 search_path 로
 *   찾는다. 마이그레이션도 같은 search_path 로 만들기 때문이다. 시작할 때 한 번
 *   확인한다.
 * - 파일: 설정 파일 최상위의 `authFeatures` 문자열 배열. 파일을 읽을 때마다
 *   확인한다.
 *
 * 기능 이름은 `AUTH_FEATURE_NAME` 모양이어야 한다. 모양이 틀린 이름은 이 버전이
 * 읽을 수 없는 저장소로 보고 거절한다.
 */
export const RECOGNIZED_AUTH_FEATURES: readonly string[] = ["member-accounts-v1"];

export const AUTH_FEATURES_TABLE = "parallax_auth_features";

/** 소문자로 시작하는 ASCII 식별자, 64자 이하. */
export const AUTH_FEATURE_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;

/** 메시지에 이름을 몇 개까지 적을지. 나머지는 개수만 적는다. */
const LISTED_NAMES = 5;
/** 메시지에 적는 이름 하나의 최대 길이. 넘으면 자른다. */
const LISTED_NAME_LENGTH = 64;

/** 저장소가 이 버전이 모르는 기능을 켰다. 다른 버전으로 시작해야 한다. */
export class UnrecognizedAuthStorageError extends Error {
  override readonly name = "UnrecognizedAuthStorageError";
}

/** 표식을 확인하지 못했다(연결, 권한, 조회 실패). 없다고 보지 않는다. */
export class AuthStorageCheckError extends Error {
  override readonly name = "AuthStorageCheckError";
}

/**
 * 저장소에서 온 이름을 메시지에 적을 수 있게 만든다. 따옴표로 감싸고, 출력 가능한
 * ASCII 가 아닌 글자는 모두 `\uXXXX` 로 바꾼다. 줄바꿈이나 제어 문자가 로그와
 * 응답에 그대로 들어가지 않는다. 개수와 길이에도 상한을 둔다.
 */
export function describeStoredNames(names: readonly string[]): string {
  const shown = names.slice(0, LISTED_NAMES).map((name) => {
    const clipped = name.length > LISTED_NAME_LENGTH ? `${name.slice(0, LISTED_NAME_LENGTH)}...` : name;
    return JSON.stringify(clipped).replace(/[^\x20-\x7e]/gu, (character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
    });
  });
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** 모르는 표식이 하나라도 있으면 그 이름을 담아 던진다. 이름은 이미 검사된 것이다. */
export function assertRecognizedAuthFeatures(features: readonly string[], where: string): void {
  const unknown = [...new Set(features)].filter((feature) => !RECOGNIZED_AUTH_FEATURES.includes(feature)).sort();
  if (unknown.length === 0) return;
  throw new UnrecognizedAuthStorageError(
    `${where} records authentication features this version does not recognize: ${describeStoredNames(unknown)}. `
    + "A newer Parallax enabled them; run that version instead, or follow the documented rollback before starting this one",
  );
}

/**
 * PostgreSQL 에 기록된 표식을 읽는다. 테이블이 없으면 표식도 없다.
 *
 * 다른 스키마 변경은 보지 않는다. 롤링 업데이트 중에는 새 버전이 아직 쓰지 않는
 * 테이블이나 열이 먼저 생길 수 있고, 그것까지 거절하면 업데이트가 멈춘다.
 *
 * 찾는 범위는 search_path 다. `to_regclass` 는 USAGE 권한이 없는 스키마를 건너뛰므로,
 * 그런 스키마에 같은 이름의 테이블이 있으면 "없음"이 아니라 "확인하지 못함"으로
 * 거절한다. search_path 밖이면서 USAGE 가 있는 스키마의 테이블은 보지 않는다.
 * 모든 스키마를 본다고 주장하지 않는다.
 *
 * 읽지 못하면(권한, 연결) `AuthStorageCheckError`, 읽었는데 이 버전이 해석할 수
 * 없는 행이면 `UnrecognizedAuthStorageError` 다. 어느 쪽도 "없음"으로 읽지 않는다.
 */
export async function readPostgresAuthFeatures(pool: PgQueryable): Promise<string[]> {
  let flags: { present?: unknown; hidden?: unknown } | undefined;
  try {
    const result = await pool.query<{ present: unknown; hidden: unknown }>(
      "SELECT to_regclass($1) IS NOT NULL AS present, EXISTS ("
      + "SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
      + "WHERE c.relname::text = $1 AND NOT pg_catalog.has_schema_privilege(n.oid, 'USAGE')) AS hidden",
      [AUTH_FEATURES_TABLE],
    );
    flags = result.rows[0];
  } catch (error) {
    throw new AuthStorageCheckError(`the authentication feature table could not be looked up: ${message(error)}`);
  }
  if (typeof flags?.present !== "boolean" || typeof flags.hidden !== "boolean") {
    throw new AuthStorageCheckError("the authentication feature table could not be looked up");
  }
  if (!flags.present) {
    if (flags.hidden) {
      throw new AuthStorageCheckError(`${AUTH_FEATURES_TABLE} exists in a schema this role cannot use`);
    }
    return [];
  }
  let rows: readonly { feature: unknown }[];
  try {
    rows = (await pool.query<{ feature: unknown }>(`SELECT feature FROM ${AUTH_FEATURES_TABLE}`)).rows;
  } catch (error) {
    throw new AuthStorageCheckError(`${AUTH_FEATURES_TABLE} could not be read: ${message(error)}`);
  }
  return rows.map((row) => {
    if (typeof row.feature !== "string" || !AUTH_FEATURE_NAME.test(row.feature)) {
      throw new UnrecognizedAuthStorageError(`${AUTH_FEATURES_TABLE} holds a row this version cannot read`);
    }
    return row.feature;
  });
}

/** 시작 직전에 한 번 확인한다. 실패 사유는 종류를 지켜서 그대로 올린다. */
export async function assertPostgresAuthStorageIsRecognized(pool: PgQueryable): Promise<void> {
  assertRecognizedAuthFeatures(await readPostgresAuthFeatures(pool), `the database (${AUTH_FEATURES_TABLE})`);
}

/** 연결 오류 문구를 한 줄로 만든다. 줄바꿈과 제어 문자는 공백이 된다. */
function message(error: unknown): string {
  const text = error instanceof Error ? error.message : "unknown error";
  return text.replace(/[^\x20-\x7e]/gu, " ").slice(0, 200);
}
