#!/usr/bin/env bash
# 설치된 트리에 대해 공표된 권고를 묻는다 — 그리고 **묻지 못한 것을 권고 없음으로 읽지
# 않는다.**
#
# 🔴 이 파일은 사고에서 나왔다. `check.yml` 의 `audit` 잡은 `pnpm run audit` 한 줄이었고,
# 그 한 줄이 머지 직후 main 을 빨갛게 만들었다. 실패 이유는 권고가 아니라
# `registry.npmjs.org` 의 bulk advisories 엔드포인트가 응답하지 않은 것이었다.
#
# 🔑 **두 결과가 같은 종료 코드로 온다.** `pnpm audit` 는 권고를 찾아도, 물어보지
# 못해도 0 이 아닌 값을 낸다. 종료 코드만 보면 「이 커밋에 취약한 의존성이 있다」와
# 「우리가 물어보지 못했다」를 구별할 수 없고, 구별하지 못하는 검사를 필수 게이트에
# 두면 **남의 서비스 가용성이 이 저장소의 머지를 막는다.** 그런 게이트는 곧 무시되거나
# 우회된다.
#
# 그래서 답이 **보고서의 모양인지**로 가른다:
#
#   보고서다 + 종료 0     권고 없음                        → 0
#   보고서다 + 종료 ≠ 0   권고 있음 — 이 커밋의 사실이다    → 1
#   보고서가 아니다        물어보지 못했다 — 커밋의 사실이   → 0, 단 경고를 남긴다
#                          아니다
#
# ⚠️ **「파싱되는가」로 가르면 안 된다. 이 고침의 첫 판이 그렇게 썼고, 그건 고침이
# 아니었다.** 타임아웃일 때 `pnpm audit --json` 이 내놓는 것은 깨진 출력이 아니라
# **유효한 JSON** 이다:
#
#     {"error": {"code": 23, "message": "The operation was aborted due to timeout"}}
#
# 객체이고 종료 코드가 0 이 아니므로, 「파싱되면 답이다」 규칙은 이것을 권고로 읽고
# 똑같이 빨개진다 — 고치려던 그 사고를 그대로 재현한다. 실제 출력을 재 보기 전까지
# 그럴듯해 보였다. 그래서 `.error` 를 명시적으로 배제하고 보고서의 키를 요구한다.
#
# ⚠️ 마지막 줄의 열림은 **의도한 것**이고 좁다. PR 이 새로 끌고 들어오는 취약 의존성은
# `policy` 의 `dependency-review` 가 따로 막는다. 여기가 답하는 것은 「이미 설치된 것에
# 나중에 붙은 권고」 하나이고, 그 질문은 하루 미뤄져도 배포를 위태롭게 하지 않는다.
# 레지스트리가 죽은 동안 머지를 못 하는 쪽이 더 위태롭다. 그리고 조용히 넘기지는 않는다 —
# `::warning::` 이 실행에 남으므로 이것이 계속되면 보이는 상태로 계속된다.
#
# 이음매 둘은 테스트를 위한 것이다(`test/scripts/audit-script.test.ts`):
#   PNPM        호출할 명령. 기본 `pnpm`.
#   AUDIT_SLEEP 재시도 사이 대기의 배수(초). 기본 30, 테스트는 0.
set -uo pipefail

PNPM="${PNPM:-pnpm}"
ATTEMPT_TIMEOUT="${ATTEMPT_TIMEOUT:-120}"
AUDIT_SLEEP="${AUDIT_SLEEP:-30}"
ATTEMPTS="${AUDIT_ATTEMPTS:-3}"

# `timeout` 이 없는 환경(맥의 기본 셸 도구 모음)에서는 그냥 직접 부른다. 상한은 CI 를
# 위한 것이고, 없다고 검사를 못 돌릴 이유는 없다.
run_audit() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$ATTEMPT_TIMEOUT" "$PNPM" audit --audit-level moderate --json 2>&1
  else
    "$PNPM" audit --audit-level moderate --json 2>&1
  fi
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  out="$(run_audit)"
  rc=$?

  # 보고서의 모양이어야 진짜 답이다 — 권고가 있든 없든. `.error` 를 든 객체는
  # 「물어보지 못했다」이지 「권고가 있다」가 아니다(위 ⚠️ 참조).
  #
  # 요구하는 것은 「객체이고 `.error` 가 없을 것」까지다. `advisories`/`metadata` 키를
  # 함께 요구하는 판도 써 봤지만 그건 **성공 출력의 모양을 안다고 가정**한다 — 이 고침을
  # 쓰는 동안 레지스트리가 죽어 있어서 성공 출력을 한 번도 재지 못했고, 재지 못한 모양에
  # 검사를 걸면 성공을 「답 아님」으로 읽어 조용히 경고만 남길 수 있다. 아는 것(오류
  # 봉투의 모양)으로 배제하고, 모르는 것(성공 보고서의 정확한 키)에는 기대지 않는다.
  if printf '%s' "$out" | jq -e 'type == "object" and (has("error") | not)' >/dev/null 2>&1; then
    if [ "$rc" -ne 0 ]; then
      echo "::error::advisories at or above moderate against the installed tree"
      printf '%s' "$out" | head -c 4000
      echo
      exit 1
    fi
    echo "no advisories at or above moderate"
    exit 0
  fi

  echo "attempt ${attempt}/${ATTEMPTS}: the advisory database did not answer (rc=${rc})"
  printf '%s\n' "$out" | tail -5
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep $((attempt * AUDIT_SLEEP))
  fi
done

echo "::warning::the advisory database did not answer in ${ATTEMPTS} attempts, so this commit was not audited. dependency-review still gates what a pull request adds; what is unmeasured here is advisories published against already-installed versions."
exit 0
