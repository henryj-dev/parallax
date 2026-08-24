# 코드 기반 기능·보안 전수 점검 보고서

> ⚠️ **이 보고서는 같은 날 재검증을 받았고, 본문 주장 여섯 개가 정정됐다.**
> 무엇이 틀렸는지는 **§정정**, 본문이 아예 다루지 않은 것은 **§추가** 에 있다.
>
> **§점검 개요 ~ §최종 평가 는 원래 스냅샷 그대로 두고 손대지 않는다** — 지금
> 고치면 그때 무엇이 보였는지가 사라진다. 대신 정정 대상 문장 자리마다 ⚠️ 를
> 달아 두었으니 **인용하기 전에 따라갈 것.**
>
> 🔑 **결론(Critical/High 없음)은 유지된다.** 코드를 다시 읽어 그 판정을 뒤집을
> 것은 나오지 않았다. 흔들린 것은 결론이 아니라 **근거의 정확도 · 커버리지 주장 ·
> 권고의 우선순위** 셋이다.

## 점검 개요

- 점검일: 2026-08-24
- 대상: production TypeScript, 포털 JavaScript, 실행 스크립트, 설정 코드, 테스트 코드
- 제외: README, `docs/`, 주석에 적힌 설계 주장과 운영 문서
- 코드 변경: 없음

점검 범위는 기능 오류, 인증·인가·세션·CSRF, OIDC/provider 연동, DNS wire/parser/forwarding/transfer, 파일·PostgreSQL 저장소와 동시성, 포털 XSS, 미구현·더미 데이터, 테스트 상태다.

## 종합 결론

치명적(Critical) 또는 고위험(High) 보안 취약점은 확인되지 않았다.

Production 코드에서 명백한 `TODO`, `FIXME`, `not implemented`, 테스트 skip/only 기반의 미구현 기능도 확인되지 않았다. `fake`, `mock`, `stub` 구현은 테스트 코드에 한정되어 있었다.

⚠️ **skip 에 대한 이 문장은 틀렸다 — 스킵은 3건 있다. §정정 1.**

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

⚠️ **`nonce` 는 애초에 발행되지 않으므로 검증 대상이 아니고, `iss`·`aud`·`exp` 의
이득도 이 흐름에서는 보고서가 말하는 만큼이 아니다. §정정 2.**

### 2. HTTP 인증 실패 제한의 분산화

실패 횟수와 lockout 상태가 process memory의 `Map`에만 저장된다. 여러 replica가 endpoint를 제공하면 요청을 replica별로 분산해 제한을 우회할 수 있다.

관련 코드: `src/security/http-authorization.ts:392`

Redis/PostgreSQL 기반 공용 rate limit 또는 reverse proxy/WAF 레벨 제한을 권고한다.

⚠️ **우회해도 얻는 것이 없고, `Map` 은 이미 유계다. §정정 3.**

### 3. OIDC 세션 즉시 폐기 기능

현재 OIDC session은 self-contained signed cookie이므로 만료 전 개별 폐기가 불가능하다. session version, revocation timestamp, 또는 서버 측 revoke 목록을 추가할 수 있다.

관련 코드: `src/security/session-token.ts:11`

⚠️ **새 발견이 아니라 이미 보류 결정이 난 항목이고, 같은 발견의 더 무거운 절반이
빠졌다. §정정 4 · §추가 1.**

### 4. DNS forwarding 관측성 강화

전체 테스트 실행에서 forwarding 검증 테스트 1건이 간헐적으로 timeout/SERVFAIL 결과를 보였으나, 동일 테스트 단독 실행은 통과했다. Production 버그로 확정할 근거는 부족하다.

⚠️ **이 현상이 같은 커밋의 전체 실행에서 재현되지 않는다. §정정 5.**

upstream별 DNS resolution 실패, connect/send 실패, correlation 불일치, timeout, 유효 응답을 별도로 기록하면 운영 진단성이 좋아진다.

관련 코드: `src/dns/server.ts:1350`

## 미구현·더미 데이터 점검

Production 코드에서 다음 패턴은 발견되지 않았다.

- `TODO`, `FIXME`, `HACK`, `not implemented`
- `test.skip`, `describe.skip`, `.only()`
- 기능 경로의 고정 dummy response
- 미완성 branch 또는 placeholder return

발견된 placeholder는 provider가 실제 사용하는 DNS placeholder 주소 또는 포털 입력 placeholder text였다. 테스트의 fake/mock/stub provider는 테스트 격리용 구현이었다.

⚠️ **`test.skip` 줄은 틀렸다. §정정 1 — 탐지 방법이 node:test 의 옵션 형태와
`context.skip()` 형태를 못 본다.**

## 검증 결과

- `pnpm check`: 통과
- sandbox 제한 환경의 `pnpm test`: localhost socket bind가 `EPERM`으로 차단되어 DNS/HTTP 통합 테스트 다수 실패
- 권한 승인 후 `pnpm test`: 대부분 통과, forwarding 테스트 1건 간헐 실패 ⚠️ **§정정 1 · §정정 5** — 「대부분」이 스킵 3건을 덮었고, 간헐 실패는 재현되지 않는다
- 해당 forwarding 테스트 단독 실행: 96개 테스트 통과
- `pnpm audit`: npm registry DNS/network 차단으로 실행 불가 ⚠️ **§정정 6**

sandbox의 `EPERM`은 코드 실패가 아니라 테스트 프로세스가 `127.0.0.1`, `::1`에 bind하지 못한 실행 환경 문제다.

## 최종 평가

현재 코드에서 즉시 수정이 필요한 Critical/High 수준의 기능 또는 보안 결함은 확인되지 않았다.

후속 우선순위는 다음과 같다.

1. OIDC ID token claim 검증 보강
2. multi-replica 환경의 인증 실패 rate limit 공유
3. OIDC 세션 즉시 폐기 수단 추가
4. DNS forwarding의 간헐 테스트 실패 원인 및 upstream별 관측성 보강

⚠️ **이 순서는 재검증 뒤 바뀐다. §다시 매긴 우선순위 를 볼 것.**

---

# 정정 — 2026-08-24 재검증

이 절은 위 본문에 대한 **반박**이다. 근거는 전부 이 저장소의 코드와 이 저장소에서
직접 돌린 실행 결과이며, 파일·줄 번호는 `f25cabd` 기준이다.

## 정정 1 · skip/only 가 없다는 것은 사실이 아니다

§종합 결론과 §미구현·더미 데이터 점검이 `test.skip` · `describe.skip` · `.only()` 가
발견되지 않았다고 적었다. **같은 보고서가 돌렸다는 `pnpm test` 의 요약이 직접
반박한다:**

```
ℹ tests 1024   ℹ suites 176   ℹ pass 1021   ℹ fail 0   ℹ skipped 3   ℹ duration_ms 92829
```

스킵 셋의 자리:

| 위치 | 형태 | 무엇 |
| --- | --- | --- |
| `test/infrastructure/atomic-file.test.ts:103` | `{ skip: linuxOnly() }` | 죽은 락 회수 — 프로세스 시작 시각을 리눅스만 공개한다 |
| `test/infrastructure/atomic-file.test.ts:122` | `{ skip: linuxOnly() }` | 위와 짝 |
| `test/adapters/provider-contract.test.ts:75` | `context.skip(excuse)` | in-memory 프로바이더의 계약 면제 1건 |

**셋 다 정당하다.** 앞의 둘은 플랫폼 게이트이고 CI(리눅스)에서는 실제로 돈다. 셋째는
사유가 붙은 면제이며(`test/adapters/provider-contract.test.ts:307`), 그 자리 주석은
*예전에 여기 있던 소유권 검사 면제를 이 스위트가 물어서 지웠다*는 기록까지 남긴다.

🔑 **그러니 틀린 것은 결론이 아니라 방법이다.** `test.skip`/`describe.skip`/`.only()`
문자열을 찾는 방식은 node:test 의 **옵션 형태**(`{ skip: … }`)와 **컨텍스트 형태**
(`context.skip()`)를 구조적으로 못 본다. 그리고 보고서는 `pnpm test` 를 직접 돌렸다고
적었으므로 **`skipped 3` 은 grep 없이도 보였어야 했다.** 「없다」로 닫은 축은 다음
검수에서 다시 열린다.

## 정정 2 · `nonce` 는 보내지 않으므로 검증할 수 없다

권고 1 이 ID token 의 `iss` · `aud` · `exp` · **`nonce`** 를 검증하라고 적었다.
`beginAuthorization` (`src/security/oidc.ts:184`)이 만드는 인가 요청 파라미터는
`response_type` · `client_id` · `redirect_uri` · `scope` · `state` ·
`code_challenge` · `code_challenge_method` 뿐이다. `grep -n nonce src/security/oidc.ts`
는 **0건**이다. 보내지 않은 nonce 는 검증 대상이 아니라 **발행부터 해야 하는 선행
작업**이고, 권고는 그렇게 적혀야 한다.

나머지 절반도 이 흐름에서는 이득이 보고서가 말하는 만큼이 아니다:

- OIDC Core §3.1.3.7 은 **code flow 에서 token endpoint 와 직접 TLS 로 받은 ID token
  은 서명 검증을 TLS 서버 검증으로 갈음할 수 있다**고 명시한다. `exchangeCode`
  (`src/security/oidc.ts:201`)가 정확히 그 경우다.
- 그 endpoint 는 아무 데서나 오지 않는다. discovery 문서가 **자기가 그 issuer 라고
  주장하는지**를 검사(`src/security/oidc.ts:96`)한 뒤에 쓰는 값이고, 실패하면
  구성된 issuer 자신의 오리진으로 되돌아간다.

📌 **그래서 실제로 남는 규범적 이득은 하나다:** userinfo 응답의 `sub` 가 ID token 의
`sub` 와 같은지 대조하는 것(OIDC Core §5.3.2, **MUST**). `readIdentity`
(`src/security/oidc.ts:244`)는 userinfo 의 `sub` 만 읽고 대조하지 않는다. 권고 문장은
「ID token 을 전면 검증하라」가 아니라 **「nonce 를 발행하고, `sub` 를 대조하라」**로
바뀌어야 한다.

## 정정 3 · 실패 제한 우회는 얻는 것이 없다

권고 2 는 replica 별 분산으로 제한을 **우회할 수 있다**고 적었다. 우회는 되지만
**우회로 얻는 것이 없다** — 코드 자신이 그렇게 적어 놨다
(`src/security/http-authorization.ts:385`):

> this does **not** slow an attacker down. Every guess is still evaluated, and the
> answer still distinguishes a right token from a wrong one — 429 rather than 401
> is the only difference once the budget is spent.

자격증명 검사는 스로틀 **앞**에서 끝나고, 실패만 사후에 센다. 그렇게 설계한 이유도
같은 자리에 있다: 클라이언트 키가 주소라서, 검사를 앞으로 옮기면 프록시나 NAT 뒤의
정상 클라이언트가 한 공격자 때문에 함께 막힌다. 실제 방어는 `MIN_TOKEN_BYTES = 32`
와 `isStrongBootstrapToken` 이다.

그리고 근거로 든 「process memory 의 `Map`」도 정확하지 않다 — 그 `Map` 은 **10,000개
상한과 LRU 축출로 이미 유계**다(`src/security/http-authorization.ts:418`), 게다가
축출이 현재 시도 중인 클라이언트를 고르지 않도록 삽입 순서를 갱신한다.

**이 항목은 취약점이 아니라 운영 일관성·관측성 항목으로 격하돼야 한다.** 공용 rate
limit 이 사는 것은 「우회 차단」이 아니라 「replica 를 넘나드는 잡음을 한자리에서
보는 것」이다.

## 정정 4 · 권고 3 은 새 발견이 아니다

OIDC 세션의 즉시 폐기 불가는 **2026-08-22 리포트 L6 의 절반**이고, 이 저장소는 이미
판단해서 보류했다 — `docs/todo.md` 「하지 않기로 한 것」:

> 이전 리포트 **L6** — 세션 쿠키가 bearer 토큰 원문을 담음. 보류 결정이 유효하다

재제기 자체는 문제가 아니다. 문제는 **기존 결정을 뒤집을 새 근거 없이 신규 권고처럼
3순위에 올린 것**이고, 더 큰 문제는 **같은 L6 의 나머지 절반을 빼놓은 것**이다 —
§추가 1 을 볼 것. 그쪽이 더 무겁다.

## 정정 5 · 간헐 실패가 재현되지 않는다

권고 4 는 forwarding 검증 테스트 1건의 간헐 timeout/SERVFAIL 을 근거로 삼는다. 같은
커밋에서 전체 스위트를 다시 돌린 결과:

```
ℹ tests 1024   ℹ pass 1021   ℹ fail 0   ℹ cancelled 0   ℹ skipped 3   ℹ duration_ms 92829
```

**재현되지 않았다.** upstream 별 실패 사유(DNS resolution · connect/send · correlation
불일치 · timeout · 유효 응답)를 나눠 기록하자는 권고 **자체는 여전히 타당하다** —
`forward()` (`src/dns/server.ts:1261`)의 세 갈래 `continue` 는 지금 전부 같은 침묵으로
떨어진다. 다만 **근거를 「간헐 실패」에 두지 말고 「관측 불가」에 두어야 한다.**
재현 조건을 적을 수 없으면 그 문장은 빼는 쪽이 맞다.

## 정정 6 · 「Critical/High 없음」이 의존성까지 덮는 것처럼 읽힌다

`pnpm audit` 미실행이 §검증 결과 안쪽에만 적혀 있다. §종합 결론과 §최종 평가에는
한정이 없어서, **점검되지 않은 축이 점검된 것처럼 읽힌다.** 한정 문구는 결론 옆에
있어야 한다.

---

# 추가 — 본문이 다루지 않은 것

## 추가 1 · 🔴 세션 쿠키가 bearer 토큰 **원문**을 담는다

`handleSession()` 은 제시된 토큰 **그 자체**를 쿠키 값으로 넣는다
(`src/security/http-authorization.ts:321`):

```ts
"set-cookie": sessionCookieValue(prepared.cookieName, candidate as string, request, maxAgeSeconds),
```

`candidate` 는 요청 본문에서 온 토큰이고, `sessionCookieValue`
(`src/security/http-authorization.ts:327`)는 그것을 그대로 `parallax_session=` 에
넣는다. 따라서:

- **쿠키 유출 = 장기 API 자격증명 유출이다.** 세션 값이 아니라 토큰이므로
  `Authorization: Bearer` 로 그대로 재사용된다.
- `DELETE` 세션은 쿠키만 지우고(`:296`) **토큰을 폐기하지 않는다.** 로그아웃이
  자격증명을 회수하지 않는다.

⚠️ **본문 §인증·OIDC 의 첫 줄 — "access token 은 digest 로 저장된다" — 과 나란히
놓이면 오해를 부른다.** 저장은 digest 가 맞다. 하지만 **브라우저가 들고 다니는 것은
평문 토큰**이고, 두 문장 중 방어를 설명하는 쪽만 실렸다.

`HttpOnly` · `SameSite=Strict` · (https 일 때) `Secure` 가 붙으므로 스크립트로는
읽히지 않는다 — 그래서 High 가 아니라 이 자리에 있다. 이것은 2026-08-22 L6 의
나머지 절반이며 `docs/todo.md` 「여전히 남은 것」에 **열린 채로** 있다.

## 추가 2 · 세션 쿠키에 `__Host-` 접두사가 없다

핸드셰이크 쿠키에는 붙인다 — `handshakeName()` (`src/http/identity-routes.ts:169`)
이 https 일 때 `__Host-` 를 붙이고, 그 자리 주석은 이렇게 적어 놨다:

> The prefix is what stops the shadowing in the first place … Refusing a
> duplicate when reading is the other half, but **this is the half that prevents
> it.**

**세션 쿠키에는 그 절반이 적용되지 않았다.** `sessionCookie(IDENTITY_COOKIE, …)`
(`src/http/identity-routes.ts:115`)와 `sessionCookieValue`
(`src/security/http-authorization.ts:327`)는 `handshakeName` 을 거치지 않고
`parallax_identity` · `parallax_session` 을 접두사 없이 내보낸다.

**결과.** 형제 서브도메인을 쥔 공격자(related-domain attacker)가 `Domain=.example.com`
으로 같은 이름의 쿠키를 심으면, 브라우저가 둘 다 보내고 `readCookie` 의 중복 거부
규칙(`src/security/cookies.ts:37`)이 **양쪽을 다 버린다.** 세션 고정은 막히지만 —
그게 그 규칙의 목적이다 — **피해자는 자기가 지울 수 없는 쿠키 때문에 영구 로그아웃**
된다. 가용성 쪽으로 넘어간 것이지 사라진 것이 아니다.

**고치는 값은 싸다:** `handshakeName` 과 똑같은 조건부(https 일 때만)를 두 세션
쿠키에도 적용하면, 브라우저가 애초에 그 쿠키를 받지 않는다.

## 추가 3 · 존별(zone-level) RBAC 이 없다

`authorize()` (`src/security/http-authorization.ts:149`)는 역할과 **경로의 모양**만
본다. `editor` 하나면 **모든 존**의 레코드를 수정하고, apply·import·restore 까지
할 수 있다. 존 이름은 인가 판단에 전혀 들어가지 않는다.

본문 §HTTP/API 의 "역할별 권한이 분리된다"는 맞지만, **분리의 축이 존이 아니라
라우트라는 사실**을 감춘다. 다중 팀·다중 존 배포에서는 이것이 실질적 인가 결함이다.
저장소는 이미 알고 사람에게 넘겼고(`docs/todo.md` 「하지 않기로 한 것」), 결론을
바꿀 필요는 없다 — 다만 **명시되지 않으면 없는 것처럼 읽힌다.**

## 추가 4 · `servedByProvider` 릴레이가 `forwardAllow` 를 의도적으로 우회한다

`src/dns/server.ts:412-419`. 존에 속하고 placeholder 를 든 이름이면, **허용 CIDR
밖 클라이언트의 질의도 upstream 으로 중계된다.** 코드에 근거가 적혀 있고 이전
리포트 L7 로 유지 결정이 난 항목이다.

그래도 §DNS 가 "forwarding 에는 timeout 과 동시성 제한이 있다"만 적고 이 경로를
안 적으면 그 절은 불완전하다. **완화가 있다는 사실도 함께 빠져 있다:**
`rateLimiter.allow()` 가 UDP·TCP 양쪽 입구에 있고(`:543` · `:572`),
`maxConcurrentForwards`(기본 256)를 넘으면 SERVFAIL 로 떨어진다(`:356`).

## 추가 5 · 저장소의 열린 대장을 참조하지 않았다

`docs/todo.md` 「여전히 남은 것」이 **미검증 둘**을 명시한다:

| 항목 | 이 보고서에 미치는 영향 |
| --- | --- |
| `verify:cloudflare` 미실행 (실제 자격증명 필요) | Cloudflare 어댑터는 정적 읽기로만 판정됐다 |
| `public/**` 는 정적 읽기와 `tsc --checkJs` 뿐 — **브라우저 실조작 없음** | §포털 XSS 의 결론 등급이 다르다 |

**§포털 XSS 결론 자체는 유지된다** — 다시 읽어 확인했다. `public/app.js` 의 모든
`innerHTML` 대입에서 외부 값이 `escapeHtml`(`public/i18n.js:455`)을 거치고,
`section()`/`list()` 같은 헬퍼도 라벨을 이스케이프한다. 서버가 리다이렉트 쿼리로
넘기는 `signin_error`(`src/http/identity-routes.ts:146`, 값은 IdP 가 준 문자열)조차
`setLiveMessage`(`public/app.js:64`)의 **`textContent`** 로 들어가므로 sink 가 아니다.
바뀌는 것은 결론이 아니라 **그 결론이 정적 읽기로 내려졌다는 표시**다.

## 추가 6 · 본문이 저평가한 방어들

정정의 반대 방향이다. 아래는 실재하는데 §확인된 방어 상태에서 빠졌다.

| 어디 | 무엇 | 왜 빠지면 안 되나 |
| --- | --- | --- |
| `src/dns/server.ts:162` | `forwardAllow` 기본값이 **loopback 전용** (`127.0.0.0/8` · `::1/128`) | 오픈 리졸버 방지의 본체 |
| `src/dns/server.ts:202` · `:543` · `:572` | 클라이언트별 **토큰버킷 rate limiter** (기본 100/s, burst 200) | 증폭·플러딩 방어의 1차선 |
| `src/dns/wire.ts:266` | 압축 포인터가 **엄격히 뒤로만** 이동하도록 강제 | 낯선 사람이 보낸 이름 하나로 무한 루프가 나는 고전적 자리 |
| `src/index.ts:408` | **HSTS** `max-age=31536000; includeSubDomains` | §포털 XSS 가 헤더 넷만 세고 이건 뺐다 |
| `src/http/api.ts:745` | 본문 상한이 `content-length` **와** 스트리밍 누적 양쪽에서 강제 | 선언 길이만 믿는 구현과 다르다 |

## 추가 7 · 점검 축 자체가 빠진 것

§점검 개요는 대상에 "실행 스크립트, 설정 코드"를 넣었다. 본문에서 다음 넷의 언급
횟수는 **0회**다:

- `migrations/` — 5개 `.sql`, `004_security_invariants.sql` 포함
- `Dockerfile` — 이미지 빌드와 uid·권한 (CI `docker` 잡이 여기에 답한다)
- `.github/workflows/**` — `check` · `scripts` · `docker` · `codeql` ·
  `dependency-review` 다섯
- `scripts/claude-hooks/**` · `scripts/git-hooks/**` — **CI(`scripts.yml`)에서 실제로
  도는** 파이썬 훅 스위트와 shellcheck

📌 **네 축을 안 봤다면 개요에서 빼야 하고, 봤다면 결과가 본문에 있어야 한다.** 지금은
포함한다고 읽히면서 결과가 없어서, 「전수」라는 낱말이 실제 범위보다 넓게 읽힌다.

---

# 다시 매긴 우선순위

정정과 추가를 반영하면 §최종 평가의 넷은 이렇게 바뀐다.

| # | 항목 | 원 보고서에서의 자리 | 왜 옮겼나 |
| --- | --- | --- | --- |
| 1 | **세션 쿠키의 평문 bearer 토큰** (§추가 1) | 없음 | 쿠키 유출이 곧 자격증명 유출이고, 로그아웃이 회수하지 않는다 |
| 2 | **세션 쿠키 `__Host-` 접두사** (§추가 2) | 없음 | 값이 싸고, 코드가 이미 다른 쿠키에 그 논거를 적어 놨다 |
| 3 | OIDC **nonce 발행 + `sub` 대조** | 1위 (「ID token 전면 검증」) | 검증 항목이 틀렸다. §정정 2 |
| 4 | DNS forwarding **upstream 별 관측성** | 4위 | 근거만 「간헐 실패」에서 「관측 불가」로 교체 |
| 5 | 존별 RBAC — **사람의 결정 대기** (§추가 3) | 없음 | 결함이 아니라 미결 설계. 열린 채로 둔다 |
| — | OIDC 세션 즉시 폐기 | 3위 | 보류 결정이 유효하다. §정정 4 |
| — | 인증 실패 제한 분산화 | 2위 | 보안 항목이 아니라 관측성 항목. §정정 3 |

그리고 **결론에 한정이 붙어야 한다:** 여기서 말하는 「Critical/High 없음」은
`src/` · `public/` · `test/` 를 **정적으로 읽은 범위**에 대한 것이고, 의존성
(`pnpm audit` 미실행) · 포털 실조작 · Cloudflare 실경로 · §추가 7 의 네 축은
**점검되지 않았다.**
