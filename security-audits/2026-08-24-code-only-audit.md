# 코드 기반 기능·보안 전수 점검 보고서

## 점검 개요

- 점검일: 2026-08-24
- 대상: production TypeScript, 포털 JavaScript, 실행 스크립트, 설정 코드, 테스트 코드
- 제외: README, `docs/`, 주석에 적힌 설계 주장과 운영 문서
- 코드 변경: 없음

점검 범위는 기능 오류, 인증·인가·세션·CSRF, OIDC/provider 연동, DNS wire/parser/forwarding/transfer, 파일·PostgreSQL 저장소와 동시성, 포털 XSS, 미구현·더미 데이터, 테스트 상태다.

## 종합 결론

치명적(Critical) 또는 고위험(High) 보안 취약점은 확인되지 않았다.

Production 코드에서 명백한 `TODO`, `FIXME`, `not implemented`, 테스트 skip/only 기반의 미구현 기능도 확인되지 않았다. `fake`, `mock`, `stub` 구현은 테스트 코드에 한정되어 있었다.

## 확인된 방어 상태

### HTTP/API

- 일반 요청 본문은 1 MiB, zone import 문서는 8 MiB로 제한된다.
- credentials/settings/tokens는 관리자 전용이며 역할별 권한이 분리된다.
- cookie 기반 unsafe request에는 same-origin 검사가 적용된다.
- 요청 ID는 허용 문자만 로그와 응답 헤더에 반영된다.
- forwarded header는 명시적으로 신뢰하도록 설정한 경우에만 사용된다.

관련 코드: `src/http/api.ts:24`, `src/http/api.ts:182`, `src/security/http-authorization.ts:149`, `src/security/http-authorization.ts:249`

### 인증·OIDC

- access token은 digest로 저장되고 bootstrap token은 32 random bytes 형식만 허용된다.
- OIDC authorization code 흐름에 state와 PKCE가 적용된다.
- callback state, verifier, duplicate cookie, return path를 검증한다.
- 세션 cookie는 HttpOnly, SameSite, Secure 조건을 적용한다.
- 세션은 HMAC 서명과 만료 검사를 통과해야 한다.

관련 코드: `src/security/http-authorization.ts:487`, `src/security/session-token.ts:42`, `src/security/oidc.ts:177`, `src/http/identity-routes.ts:83`, `src/http/identity-routes.ts:137`

### DNS

- DNS 응답은 query ID, QR, opcode, question count, 이름, 타입, class를 검증한다.
- forwarding에는 timeout과 동시성 제한이 있다.
- UDP source 검증을 위해 connected UDP socket을 사용한다.
- TCP incomplete frame과 전체 frame 크기가 제한된다.
- AXFR/IXFR은 allowlist와 TSIG 정책을 따른다.
- TSIG reply는 요청 MAC과 chain을 검증한다.
- wildcard, CNAME, DNAME, provider placeholder 처리에 대한 테스트가 존재한다.

관련 코드: `src/dns/wire.ts:163`, `src/dns/server.ts:1261`, `src/dns/server.ts:1350`, `src/dns/server.ts:1400`, `src/dns/tsig.ts`

### 저장소·동시성

- 파일 저장은 temporary file, fsync, rename 순서의 atomic write를 사용한다.
- 파일 backend는 프로세스 간 lock과 stale lock 회수를 지원한다.
- zone apply는 zone 단위 lock으로 provider 작업과 상태 commit을 직렬화한다.
- PostgreSQL은 transaction과 advisory lock을 사용한다.
- SQL 값은 parameterized query로 전달된다.

관련 코드: `src/infrastructure/atomic-file.ts:68`, `src/infrastructure/file-state.ts:597`, `src/infrastructure/postgres.ts:380`, `src/infrastructure/postgres.ts:430`

### 포털 XSS

동적 HTML의 zone, record, provider, audit, token subject 등 외부·저장 데이터는 주요 출력 위치에서 `escapeHtml`을 거친다. 서버는 CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`도 적용한다.

관련 코드: `public/app.js:193`, `public/app.js:253`, `public/app.js:379`, `public/app.js:418`, `public/app.js:493`, `public/app.js:774`

## 개선 권고

### 1. OIDC ID token 검증 추가

현재 구현은 authorization code를 token endpoint에서 교환한 뒤 userinfo 응답을 사용한다. 방어 심도를 높이려면 ID token의 `iss`, `aud`, `exp`, `nonce`를 직접 검증하는 것이 좋다.

관련 코드: `src/security/oidc.ts:199`

이는 현재 확인된 취약점이라기보다 OIDC hardening 권고다.

### 2. HTTP 인증 실패 제한의 분산화

실패 횟수와 lockout 상태가 process memory의 `Map`에만 저장된다. 여러 replica가 endpoint를 제공하면 요청을 replica별로 분산해 제한을 우회할 수 있다.

관련 코드: `src/security/http-authorization.ts:392`

Redis/PostgreSQL 기반 공용 rate limit 또는 reverse proxy/WAF 레벨 제한을 권고한다.

### 3. OIDC 세션 즉시 폐기 기능

현재 OIDC session은 self-contained signed cookie이므로 만료 전 개별 폐기가 불가능하다. session version, revocation timestamp, 또는 서버 측 revoke 목록을 추가할 수 있다.

관련 코드: `src/security/session-token.ts:11`

### 4. DNS forwarding 관측성 강화

전체 테스트 실행에서 forwarding 검증 테스트 1건이 간헐적으로 timeout/SERVFAIL 결과를 보였으나, 동일 테스트 단독 실행은 통과했다. Production 버그로 확정할 근거는 부족하다.

upstream별 DNS resolution 실패, connect/send 실패, correlation 불일치, timeout, 유효 응답을 별도로 기록하면 운영 진단성이 좋아진다.

관련 코드: `src/dns/server.ts:1350`

## 미구현·더미 데이터 점검

Production 코드에서 다음 패턴은 발견되지 않았다.

- `TODO`, `FIXME`, `HACK`, `not implemented`
- `test.skip`, `describe.skip`, `.only()`
- 기능 경로의 고정 dummy response
- 미완성 branch 또는 placeholder return

발견된 placeholder는 provider가 실제 사용하는 DNS placeholder 주소 또는 포털 입력 placeholder text였다. 테스트의 fake/mock/stub provider는 테스트 격리용 구현이었다.

## 검증 결과

- `pnpm check`: 통과
- sandbox 제한 환경의 `pnpm test`: localhost socket bind가 `EPERM`으로 차단되어 DNS/HTTP 통합 테스트 다수 실패
- 권한 승인 후 `pnpm test`: 대부분 통과, forwarding 테스트 1건 간헐 실패
- 해당 forwarding 테스트 단독 실행: 96개 테스트 통과
- `pnpm audit`: npm registry DNS/network 차단으로 실행 불가

sandbox의 `EPERM`은 코드 실패가 아니라 테스트 프로세스가 `127.0.0.1`, `::1`에 bind하지 못한 실행 환경 문제다.

## 최종 평가

현재 코드에서 즉시 수정이 필요한 Critical/High 수준의 기능 또는 보안 결함은 확인되지 않았다.

후속 우선순위는 다음과 같다.

1. OIDC ID token claim 검증 보강
2. multi-replica 환경의 인증 실패 rate limit 공유
3. OIDC 세션 즉시 폐기 수단 추가
4. DNS forwarding의 간헐 테스트 실패 원인 및 upstream별 관측성 보강
