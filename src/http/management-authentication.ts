import type { IncomingHttpHeaders } from "node:http";
import {
  assertAccountSessionsNeedAuthentication,
  authenticateRequest,
  type Authentication,
  type SecurityConfig,
} from "../security/http-authorization.ts";

/**
 * API 처리기 바깥에서 관리 정보를 내주는 경로(`/metrics`, `/health/ready` 의
 * 상세, 포털 진입 판단)가 호출자를 확인하는 한 가지 방법.
 *
 * 결과는 세 가지다. 저장소가 답하지 못한 경우(`unavailable`)는 인증 실패와 다르게
 * 다뤄야 하므로 따로 돌려준다. 그렇지 않으면 회원 세션 저장소 장애가 "로그인 안 됨"
 * 으로 보이고, 그 답을 받은 포털이 로그인 화면으로 사람을 돌려보낸다.
 *
 * 인증이 꺼진 배포에서는 `unauthenticated` 다. 예전 동기 판(`isAuthenticated`)이
 * false 를 돌려주던 것과 같다. 익명 루프백 배포는 상세 없이 판정만 받는다.
 *
 * 꺼진 인증과 회원 세션 확인 장치가 같이 온 설정은 API 처리기와 같은 검사로
 * 거절한다(TypeError). 조용히 `unauthenticated` 로 답하지 않는다.
 */
export async function authenticateManagementRequest(
  headers: IncomingHttpHeaders,
  security: SecurityConfig,
  origin: string,
): Promise<Authentication["status"]> {
  assertAccountSessionsNeedAuthentication(security);
  if (!security.enabled) return "unauthenticated";
  // 자격 증명에 쓰이는 두 헤더만 옮긴다. 이 요청은 판단에만 쓰이고 다른 곳으로
  // 넘어가지 않는다.
  const copied = new Headers();
  for (const name of ["authorization", "cookie"]) {
    const value = headers[name];
    if (typeof value === "string") copied.set(name, value);
  }
  const authentication = await authenticateRequest(new Request(new URL("/health/ready", origin), { headers: copied }), security);
  return authentication.status;
}
