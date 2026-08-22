# Parallax 감사 수정 계획 — 2026-08-22

> **근거**: [`2026-08-22-implementation-and-security-audit.md`](2026-08-22-implementation-and-security-audit.md)
> — 대상 커밋 `95e85e6`, 발견 High 2 · Medium 5 · Low 8 · Info 1.
>
> **이 문서는 계획이지 기록이 아니다.** 여기 적힌 것은 아직 하나도 하지 않았다.
> 항목을 끝내면 그 사실을 증명하는 것은 이 문서가 아니라 커밋과 테스트이며,
> 완료를 적을 때는 **커밋 sha를 함께** 적는다. 이 저장소는 이미 한 번,
> 문서에 적힌 커밋 번호가 한 커밋 만에 틀린 채로 남은 적이 있다.
>
> 계획은 `95e85e6` 기준이다. 그 사이 `main`이 움직이면 착수 전에 해당 파일의
> 줄 번호와 전제를 다시 확인할 것 — 감사 자체도 진행 중에 트리가 바뀌었다.

---

## 0. 이 계획의 규칙

1. **한 항목 = 한 커밋 = 한 회귀 테스트.** 테스트 없는 수정은 완료가 아니다.
2. **회귀 테스트는 고친 줄이 아니라 비어 있던 조합을 겨눈다.** §1이 그 근거다.
3. **각 단계는 독립적으로 배포 가능해야 한다.** 이 저장소에서 `origin/main` push는
   곧 배포이므로, 단계를 반쯤 올려두는 상태가 존재하면 안 된다.
4. **리포트의 확신도 구분을 계승한다.** "코드 추적으로 확인"에 머문 항목
   (M3·M4·M5·L1~L8)은 **고치기 전에 먼저 재현**한다. 재현되지 않으면 그 항목은
   수정 대상이 아니라 리포트의 정정 대상이다.
5. 게이트는 매 커밋 `pnpm check` + `pnpm test` 전건 통과.

---

## 1. 왜 667개 테스트가 High 둘을 놓쳤는가 (수정보다 먼저 볼 것)

수정 계획을 세우기 전에 이것부터 확인했다. 같은 구멍이 남아 있으면 같은 종류의
결함이 또 지나간다.

**H1 — "OIDC가 있고 액세스 토큰이 0개"라는 조합의 커버리지가 0이다.**
실제 서버를 띄워 OIDC를 시험하는 테스트는 `test/http/portal-sign-in.test.ts`
하나뿐인데, 그 `start()` 헬퍼는 **항상** `PARALLAX_AUTH_TOKENS`에 admin 토큰
하나를 함께 넣는다(`test/http/portal-sign-in.test.ts:64`). 그래서
`accessTokens.security().enabled`가 언제나 `true`이고, H1의 조건이 성립하는
경로에 테스트가 한 번도 들어가지 않는다.

```
$ grep -rn 'PARALLAX_OIDC_ISSUER' test
test/config.test.ts:42            ← readConfig 단위 테스트 (서버를 띄우지 않음)
test/cli/config-check.test.ts:17  ← 프리플라이트 (서버를 띄우지 않음)
test/http/portal-sign-in.test.ts:21 ← 유일한 실서버, 그러나 항상 토큰 동봉
```

**H2 — `encodeRdata`가 성공한 뒤 `writeRecord`가 실패하는 구간을 아무도 지나가지
않는다.** `onUnservable` 경로에는 테스트가 있지만, 전부 `encodeRdata`가 던지는
경우다. 인코딩은 성공하고 그 결과 길이가 uint16을 넘는 조합은 테스트가 없다.

→ **따라서 아래 각 단계의 회귀 테스트는 "고친 줄이 도는지"가 아니라 "비어 있던
조합이 이제 덮이는지"를 확인하도록 쓴다.**

---

## 2. 단계 요약

| 단계 | 항목 | 변경 규모 | 배포 가능 |
| --- | --- | --- | --- |
| 1 | H1 | `src/index.ts` 3줄 + 테스트 1파일 | 예 |
| 2 | H2 | `src/dns/rdata.ts` 1곳 + `src/dns/server.ts` 백스톱 + 테스트 | 예 |
| 3 | M1 · M2(노브) · M5 | 3파일 + 각 테스트 | 예 |
| 4 | M4 · M3 | 2파일 + 각 테스트 | 예 |
| 5 | L1~L4 · L8 | 5파일, 각각 독립 | 예 |
| 6 | 결정 필요 — I1 · EDNS Cookie · L5 · L6 · 존별 RBAC | 착수 전 사람의 판단 | — |

L7은 **수정하지 않는다**(§4).

---

## 3. 단계별 계획

### 1단계 — H1: 인증 활성 판정 소스를 하나로 통일

**변경.** `src/index.ts`의 세 곳이 `accessTokens.security().enabled`를 읽는다.
셋 다 `securityConfig().enabled`로 바꾼다.

| 줄 | 지금 | 무엇이 잘못되는가 |
| --- | --- | --- |
| `:205` | 프록시 가드 | OIDC 세션이 유효해도 `/api/*` 전면 401 |
| `:220` | `/health/live`의 `authentication` | 포털이 인증 필요 배포를 열린 배포로 그림 |
| `:424` | 기동 경고 | "every caller is an administrator"가 거짓 |

같은 파일 `:77`의 non-loopback 거부 검사는 **이미 `securityConfig()`를 쓴다** —
고칠 곳이 아니라 참조할 곳이다.

**의미 확인(고치기 전에 답할 것).** 프록시 가드의 목적은 주석대로 "토큰이 없으면
모든 호출자가 관리자가 되므로, 프록시를 거쳐 온 요청은 신뢰하지 않고 거절"이다.
OIDC가 켜진 배포에서 호출자는 기본적으로 관리자가 **아니다** — 세션을 제시해야
한다. 따라서 `securityConfig().enabled`가 이 가드가 물었어야 할 질문이 맞다.
이 문단이 참이 아니면 수정 방향 자체가 틀린 것이므로, 코드를 건드리기 전에
이 판단부터 검토할 것.

**함정.** `securityConfig()`는 호출될 때마다 `accessTokens.security()`를 부르고
OIDC일 때 객체를 새로 만든다(`index.ts:72-75`). `createAuthorizedHandler`는
**객체 동일성**으로 준비된 다이제스트를 캐시하므로(`http-authorization.ts`의
`preparedFor`), 요청 경로에서 매번 새 객체를 만들면 캐시가 매번 무효화된다.
지금 `handleApi`는 `securityConfig`를 **함수로** 넘기고 있어 이미 그 성질을 갖는다
— 즉 이 수정은 새 문제를 만들지 않지만, 캐시 무효화가 이미 존재하는지는
1단계에서 같이 측정해 두는 편이 좋다(측정만; 최적화는 이 계획 밖).

**완료 정의.**
- 세 줄이 `securityConfig().enabled`를 읽는다.
- OIDC 구성 + 토큰 0개 + 프록시 헤더에서 유효 세션의 `/api/v1/zones` GET이 200.
- 같은 배포의 `/health/live`가 `authentication: "required"`.

**회귀 테스트(새 파일 `test/http/identity-only-deployment.test.ts`).**
`portal-sign-in.test.ts`의 `start()` 헬퍼를 재사용하되 **`PARALLAX_AUTH_TOKENS`를
주지 않는** 변형을 만든다. 이것이 §1에서 확인한 비어 있던 조합이다.
1. `x-forwarded-proto: https`를 붙인 `/api/v1/zones` GET이 세션 쿠키로 200.
2. 같은 요청에 쿠키가 없으면 401 (가드가 사라진 것이 아님을 확인).
3. `/health/live`가 `authentication: "required"`, `identityProvider: "available"`.

⚠️ 3번이 이 단계에서 가장 중요하다. 1·2번은 고친 줄을 도는 테스트이고,
3번은 **포털이 읽는 값**이 맞는지를 보는 테스트다.

---

### 2단계 — H2: RDATA 길이 상한을 쓰기에서 막고, 읽기는 살려두고, 침묵을 없앤다

#### 먼저 — 처음에 세운 계획은 틀렸다. 확인해서 버렸다.

첫 초안은 "`encodeRdata`가 길이를 검사해 던지게 하면 세 호출자가 한꺼번에 고쳐진다"
였다. `encodeRdata`(`src/dns/rdata.ts:71-74`)를 부르는 곳이 전부 try/catch 안이라는
관찰 자체는 맞다. **그런데 그 호출자 목록이 틀렸다.**

```
$ grep -n 'createDesiredRecord' src/infrastructure/postgres.ts src/infrastructure/file-state.ts
src/infrastructure/postgres.ts:670    return createDesiredRecord(id, object);
src/infrastructure/file-state.ts:370  return createDesiredRecord(id, record);
```

**저장된 존을 읽을 때마다 모든 레코드가 `createDesiredRecord`를 다시 통과한다.**
두 백엔드 모두 그렇다(`postgres.ts:665-671`, `file-state.ts:370`). 즉 `encodeRdata`가
길이로 던지기 시작하면, 이미 저장되어 있는 초과 레코드 하나가:

```
readZone 실패 → zones.get()/list() 실패 → controlPlane.listZones() 실패
             → readiness 갱신 실패 + DNS 스냅샷 정지 + 포털에서 존 전체가 안 보임
```

**H2보다 나쁘다.** 지금은 이름 하나가 조용해지는 것이고, 그 "수정"은 존 전체를
— 그리고 `listZones`에 의존하는 readiness와 DNS 스냅샷까지 — 읽을 수 없게 만든다.

이 저장소는 같은 문제를 이미 한 번 풀어 두었고 이유까지 적어 두었다:

> `readPersistedViewName` — *"Snapshots written before views were restricted may
> still carry other identifiers; they stay readable so an operator can remove
> them instead of losing access to the whole zone."* (`domain/dns.ts:154-157`)

**같은 판단을 따른다: 쓰기에서 막고, 읽기는 통과시켜 운영자가 지울 수 있게 한다.**

#### 실제 계획

호출자는 쓰기와 읽기로 깨끗하게 갈린다. 확인했다.

| 경로 | 호출 지점 | 새 동작 |
| --- | --- | --- |
| 쓰기 | `control-plane.ts:407` (`upsertRecord`) | 초과 시 400 |
| 쓰기 | `control-plane.ts:1563` (`parseDesiredViews`) | 초과 시 400 |
| 쓰기 | `control-plane.ts:1366` (`describeAdopted`) | 초과 시 adopt 실패 + 어느 레코드인지 |
| 쓰기 | `domain/zone-file.ts:55` (import) | 초과 시 400 |
| **읽기** | `postgres.ts:670` | **통과** — 지울 수 있어야 한다 |
| **읽기** | `file-state.ts:370` | **통과** — 지울 수 있어야 한다 |

1. **`createDesiredRecord`에 재수화(rehydrate) 모드를 둔다.** 기본은 엄격(쓰기),
   두 영속 리더만 관대 모드로 부른다. `readPersistedViewName`이 영속 리더에서만
   쓰이는 것과 같은 배치다.
2. **`encodeRdata`는 건드리지 않는다.** 읽기 경로가 공유하는 함수이므로.
3. **serve 경로는 `answerFromZone` 안에서 직접 잰다.** `encodeRdata`가 돌려준
   버퍼의 `.length`를 기존 try 블록 안에서 검사해, 초과면 지금 있는
   `onUnservable` + SERVFAIL 경로로 보낸다(`dns/server.ts:487-499`, AXFR은 `:454`).
   여기서 재는 것이 중요한 이유는 아래 함정에 있다.
4. **`respond()`에서 `writeReply`를 감싼다.** 이름 길이 초과 등 다른 경로를 위한
   2차 방어. 무응답은 어떤 경우에도 남기지 않는다.

**함정 — 백스톱만으로는 안 되는 이유.** `writeReply`를 감싸면 침묵은 없어지지만
그 지점은 **어느 레코드가 문제인지 모른다**. `onUnservable`은
`{zone, name, type, reason}`을 요구하는데 `writeReply`는 조립된 버퍼만 본다.
"이 존의 무언가가 답해지지 않는다"만 말하는 로그는 H2가 만든 상황과 크게 다르지
않다. 그래서 1차 방어는 레코드를 손에 쥐고 있는 3번이어야 한다.

**함정 — `assertZoneFileSafeContent` 같은 이름의 함수를 새로 만들지 말 것.**
`domain/dns.ts:220`에 이미 "어댑터가 `createDesiredRecord` 없이 불릴 때를 위한
방어" 주석이 달린 함수가 있다. 길이 검사도 그 옆에 두는 것이 자연스러운지,
아니면 별개인지는 구현에서 판단하되 **두 벌이 되지 않게** 한다 — M5가 정확히
같은 함수가 두 벌 존재해서 생긴 결함이다.

**완료 정의.**
- 70,000바이트로 인코딩되는 `OPENPGPKEY`를 **저장하려 하면 400**과 함께 왜인지가
  담긴 메시지를 받는다.
- 그런 레코드가 **이미 저장되어 있으면 존은 그대로 읽히고**, 포털에서 보이고,
  지울 수 있다.
- 그 이름에 질의하면 **rcode 2(SERVFAIL)** 가 돌아오고 `onUnservable`이
  **정확히 한 번** 호출된다.

**회귀 테스트.**
- `test/domain/record-types.test.ts` — 65535를 넘는 `OPENPGPKEY`/`DNSKEY`/`CERT`
  base64와 `DS`/`TLSA`/`SSHFP` hex가 쓰기에서 전부 거절되고, 65535 이하는 통과.
- **`test/infrastructure/postgres.test.ts` + `file-state.test.ts` — 초과 레코드를
  담은 스냅샷이 여전히 읽힌다.** 이 테스트가 위 §의 실패한 첫 초안을 고정한다.
  이것 없이는 같은 실수가 다시 들어온다.
- `test/dns/server.test.ts` — 감사에서 쓴 재현을 그대로.
  ⚠️ `ServedZone`을 **직접 구성**해야 한다. `createDesiredRecord`를 거치면 쓰기
  검증에 걸려 serve 경로의 방어를 영원히 시험하지 못한다.
- `test/dns/wire.test.ts` — `writeReply` 백스톱: 조립이 실패하는 입력에서
  무응답이 아니라 SERVFAIL이 나온다.

---

### 3단계 — M1 · M2(노브) · M5

세 항목은 서로 독립이므로 커밋도 셋으로 나눈다.

#### 3-1. M1 — QCLASS / OPCODE 판정

**함정 1 — `readQuery`에서 던지면 안 된다.** `respond()`는 `WireFormatError`를
잡아 `undefined`를 반환하고, 그것은 **무응답**을 뜻한다(`dns/server.ts:121-127`).
REFUSED와 NOTIMP는 응답이어야 하므로 판정은 `respond()` 안에서, 파싱이 끝난 뒤에.

**함정 2 — 클래스 검사를 포워딩 앞에 두면 리졸버 투명성이 깨진다.** 이 프로세스는
포워더이기도 하다. `version.bind` CHAOS TXT처럼 정상적인 non-IN 질의를 클라이언트가
업스트림에 물을 수 있는데, 존 매칭 앞에서 REFUSED를 내면 그 경로가 죽는다.
→ **opcode 검사는 맨 앞**(어떤 opcode든 릴레이 대상이 아니다), **클래스 검사는
존이 매칭된 뒤**(우리가 권위 있게 답할 때만).

```
respond():
  readQuery
  opcode !== 0            → NOTIMP        ← 맨 앞
  AXFR 검사 (기존)
  matchZone
    없음 → 기존 포워딩 경로 (클래스 무관, 그대로 릴레이)
    있음 → class !== IN && class !== ANY → REFUSED   ← 여기
         → 기존 answerFromZone
```

**EDNS version / BADVERS는 이 단계에서 하지 않는다.** BADVERS는 확장 rcode 16이라
OPT 레코드의 TTL 상위 바이트를 써야 하는데, 지금 `writeOpt`는 TTL을 0으로 고정
한다(`dns/wire.ts`). 확장 rcode 지원은 그 자체로 별건이므로 6단계로 넘긴다.

**회귀 테스트(`test/dns/server.test.ts`).** CH 클래스 질의가 (a)관리 존 이름이면
REFUSED, (b)관리 밖 이름이면 **여전히 포워딩된다**. opcode 5 질의는 NOTIMP.

#### 3-2. M2 — 이미 있는 노브를 환경에 노출 (EDNS Cookie는 제외)

`DnsServerOptions`에 정의만 되고 배선되지 않은 값들(`server.ts:29-46`)을
`config.ts`의 `DnsListenerSettings`로 끌어올려 `index.ts:398-409`에서 넘긴다.

| 환경변수 | 대상 옵션 | 기본 |
| --- | --- | --- |
| `PARALLAX_DNS_RATE_LIMIT_PER_SECOND` | `rateLimitPerSecond` | 100 |
| `PARALLAX_DNS_RATE_LIMIT_BURST` | `rateLimitBurst` | 200 |
| `PARALLAX_DNS_FORWARD_TIMEOUT_MS` | `forwardTimeoutMs` | 4000 |
| `PARALLAX_DNS_MAX_TCP_CONNECTIONS` | `maxTcpConnections` | 1024 |
| `PARALLAX_DNS_MAX_CONCURRENT_FORWARDS` | `maxConcurrentForwards` | 256 |

기본값은 지금 코드의 기본값과 **정확히 같아야 한다.** 이 커밋은 동작을 바꾸지 않고
조절 가능성만 추가하는 커밋이며, 그래야 배포에서 되돌릴 필요가 없다.

**왜 환경변수이고 설정 저장소가 아닌가.** `config.ts`의 `DnsListenerSettings`
주석이 이미 그 이유를 적어 두었다 — 업스트림과 허용 CIDR은 "포털 세션이 바꿀 수
있어서는 안 되는 값"이다. 레이트리밋도 같은 부류다. 새 규칙을 만드는 것이 아니라
이미 선언된 규칙을 따르는 것이다.

**회귀 테스트(`test/config.test.ts`).** 각 변수의 파싱과 경계(0·음수·비정수 거절),
그리고 미설정 시 기본값이 유지되는지.

#### 3-3. M5 — 쿠키 중복 처리 통일

**함정 — 그냥 합치면 로그인 후 복귀가 깨진다. 확인된 사실이다.**
`http-authorization.ts:439`의 엄격한 판본은 값이 `TOKEN_PATTERN`
(`/^[A-Za-z0-9._~+\/-]+=*$/u`, `:82`)에 맞지 않으면 `undefined`를 준다.
그런데 `parallax_oidc_return`은 **경로**를 담고, 포털은 그 값을
`${location.pathname}${location.search}${location.hash}`로 만든다
(`public/app.js:674`). `?`는 `TOKEN_PATTERN`에 없다. 즉 엄격한 판본을 그대로
가져다 쓰면 질의 문자열이 붙은 페이지에서 로그인한 사람은 **조용히 루트로
떨어진다** — 에러도, 로그도 없이.

**따라서 나누는 축은 "중복 거부"와 "값 모양 검증"이다.**
- 공유할 것: 같은 이름이 두 번 나오면 `undefined`를 반환하는 **중복 거부**.
- 호출자에게 남길 것: 값이 어떤 모양이어야 하는지. 토큰 쿠키는 `TOKEN_PATTERN`,
  핸드셰이크 쿠키는 각자의 규칙(`safeReturnPath`가 이미 복귀 경로를 검증한다).

구현은 `readCookie(header, name, validate?)` 하나를 공용 모듈에 두고 두 곳이
쓰게 하는 형태. 두 벌이 존재하는 것 자체가 M5의 원인이므로, 한 벌로 만드는 것이
수정의 본체다.

**추가로.** 핸드셰이크 쿠키 셋(`STATE`/`VERIFIER`/`RETURN`)에 `__Host-` 접두사를
붙인다. 이것이 섀도잉 자체를 브라우저 층에서 막는다. `Path=/` + `Secure` +
Domain 없음이 `__Host-`의 조건이고 셋 다 이미 만족하지만, **`Secure`는 https일
때만 붙는다**(`identity-routes.ts`의 `cookie()`). 평문 루프백 개발 환경에서
`__Host-`는 성립하지 않으므로 접두사도 조건부여야 한다.

**회귀 테스트.**
- `test/security/oidc-session.test.ts` — 같은 이름의 쿠키가 두 번 오면 핸드셰이크가
  실패한다(= 섀도잉된 state로 콜백이 완료되지 않는다).
- **복귀 경로 회귀** — `next=/zones?view=internal#rec` 로 로그인하면 그 경로로
  돌아온다. 이 테스트가 함정을 고정한다.

---

### 4단계 — M4 · M3

#### 4-1. M4 — 종료 데드라인

`shutdownProcess`의 `http`/`redirect` 타입에 `closeIdleConnections?()`를 선택
필드로 추가하고(`src/shutdown.ts:7-8`), 서버를 닫기 전에 호출한 뒤 전체에 상한을
건다. 선택 필드여야 `test/dns/server.test.ts:411`의 기존 호출이 그대로 컴파일된다.

순서: DNS 닫기 → `closeIdleConnections()` → `close()` → 상한(예: 10초) 초과 시
남은 소켓 destroy → runtime 닫기. 상한은 인자로 받아 테스트가 짧게 줄일 수 있게.

**회귀 테스트(`test/http/` 신규).** keep-alive 커넥션을 하나 열어둔 채
`shutdownProcess`를 부르면 상한 안에 resolve 된다. 지금 코드로는 실패해야 한다 —
실패를 먼저 확인하고 고칠 것.

#### 4-2. M3 — zone file 괄호 이어짐

⚠️ **착수 전에 재현부터.** M3는 "코드 추적으로 확인"에 머물러 있다. 실제 BIND
덤프(`dig axfr` 출력 또는 `named-compilezone` 결과)를 `POST .../import`에 넣어
실패를 눈으로 본 뒤에 파서를 건드린다.

변경은 `parseZoneFile`에 괄호 이어짐 상태를 두고, 이어붙인 **뒤의** content에만
`zoneFileContentIssue`를 적용하는 것. `$INCLUDE`는 **계속 지원하지 않는다**(§4).

**회귀 테스트(`test/domain/zone-file.test.ts`).** 괄호로 여러 줄에 걸친 DNSKEY와
긴 TXT가 import 되고, 이어붙인 결과가 한 줄로 쓴 것과 같은 레코드를 만든다.

---

### 5단계 — Low 묶음 (각각 독립 커밋)

| 항목 | 변경 | 비고 |
| --- | --- | --- |
| L1 | 잠금 중이면 검증 **전에** 429 | 또는 동작을 두고 주석을 실제에 맞춘다 — **둘 중 하나를 고르는 것이 이 항목의 내용**이다 |
| L2 | `maxClients` 노출 | 3-2와 같은 방식. EDNS Cookie(6단계)가 오면 근본 해결 |
| L3 | `server.maxConnections` 설정 | 인증 후 본문 읽기로 바꾸는 것은 범위 밖 |
| L4 | `ssl=true`를 검증된 TLS로 취급하지 않음 | 기존 배포의 `DATABASE_URL`이 이 형태면 **기동이 막힌다** — 배포 확인 후 |
| L8 | `applyPending` 커서 페이징 | 지금은 무해, 잠재 결함 고정 |

⚠️ L4는 이 묶음에서 유일하게 **기동을 막을 수 있는** 변경이다. 실제 배포의
`DATABASE_URL` 형태를 확인하기 전에는 올리지 않는다. `PARALLAX_ALLOW_PLAINTEXT_POSTGRES`
탈출구가 이미 있으므로 막히더라도 복구는 가능하지만, 배포 중에 알게 될 일은 아니다.

---

### 6단계 — 사람이 정해야 하는 것

아래는 **내가 정할 수 없는 항목**이다. 코드가 아니라 제품·운영의 결정이 앞선다.

| 항목 | 물어야 할 것 |
| --- | --- |
| **I1 · NS1** | 배선할 것인가 지울 것인가. 배선은 자격증명 저장소를 Cloudflare 모양 밖으로 일반화하는 큰 변경이고, 삭제는 224줄 + 테스트를 버리는 결정이다. **어느 쪽이든 지금 상태 — 지원되는 것처럼 보이는 죽은 코드 — 보다는 낫다.** 사라진 CoreDNS/PowerDNS 어댑터를 가리키는 주석 4곳 정리는 어느 쪽을 고르든 함께 한다 |
| **M2 · EDNS Cookie** | RFC 7873 구현은 별건의 기능이다. 3-2의 노브 노출로 완화한 뒤, 이 리스너가 실제로 신뢰 경계 밖에 노출되는지를 보고 결정 |
| **L5 · OIDC discovery** | 지금 배포가 쓰는 프로바이더 하나만 상대하면 되는가, 아니면 상호운용이 요구사항인가 |
| **L6 · 세션 폐기** | 서버측 세션 인덱스는 상태를 늘린다(파일 백엔드에서 특히). "전체 로그아웃 epoch"라는 값싼 절충이 충분한지 |
| **존별 RBAC** | 리포트 §9-11. 지금 editor는 모든 존을 편집한다. 팀이 여럿인가 |
| **EDNS 확장 rcode / BADVERS** | 3-1에서 미룬 것. `writeOpt`의 TTL 상위 바이트를 쓰는 별건 |

---

## 4. 하지 않기로 한 것

- **L7 (`servedByProvider`가 `forwardAllow` 바깥)** — 리포트가 "수정 불필요"로
  결론냈다. 주석의 논리가 옳고, 그 경로를 게이트하면 존재 이유가 사라진다.
  좁은 동시성 상한은 있으면 좋지만 필수가 아니다.
- **zone file `$INCLUDE` 지원** — 미지원이 파일 읽기 표면을 막아준다. M3를
  고치면서 **실수로 지원하게 되지 않도록** 회귀 테스트를 남긴다.
- **인증 이전 본문 읽기 제거(L3의 근본 해결)** — Fetch `Request` 조립 구조를
  바꾸는 큰 수술이고, `maxConnections`로 얻는 완화에 비해 이득이 작다.

---

## 5. 검증 게이트

매 커밋:
```
pnpm check          # tsc --noEmit -p tsconfig.test.json
pnpm test           # 667건 + 이 계획이 추가하는 건들, 전건 통과
```

단계별로 추가:
- 1단계 — `pnpm verify:proxy` (프록시 뒤 동작을 바꾸는 유일한 단계)
- 3-1·3-2 — `pnpm verify:dns`
- 5단계 L4 — `pnpm verify:postgres`

⚠️ `verify:*`는 실제 자원을 건드린다. 이 감사에서는 안전 제약으로 돌리지 않았고,
`docs/handoff.md`가 그중 일부가 과거에 **깨진 채로** 통과 기록만 남아 있었던 적을
기록해 두었다. 돌릴 때는 **어느 커밋에서 돌렸는지**를 함께 적을 것.

---

## 6. 위험

1. **배포가 곧 push다.** 각 단계가 독립 배포 가능해야 한다는 §0-3의 규칙이 여기서
   나온다. 특히 1단계는 인증 판정을 바꾸므로, 되돌릴 수 있는 단일 커밋으로 유지한다.
2. **1단계는 인증을 느슨하게 만들지 않는다 — 확인할 것.** `securityConfig().enabled`는
   `accessTokens.security().enabled`보다 **더 자주 참**이다(OIDC가 켜지면 항상 참).
   가드가 `!enabled`일 때 거절하므로, 바꾼 뒤에는 거절이 **줄어든다**. 줄어드는
   방향이 맞는지는 §3-1단계의 "의미 확인"이 답해야 하고, 회귀 테스트 2번
   (쿠키 없으면 401)이 그것을 고정한다.
3. **2단계가 기존 데이터를 읽지 못하게 만들 수 있다 — 이미 한 번 그렇게 계획했다가
   되돌렸다.** 자세한 것은 §3-2단계 첫머리에 있다. 요약: 저장된 존은 읽을 때마다
   모든 레코드가 `createDesiredRecord`를 다시 통과하므로(`postgres.ts:670`,
   `file-state.ts:370`), 검증을 공유 경로에 넣으면 초과 레코드 하나가 존 전체와
   `listZones`를 못 읽게 만든다. **쓰기에서만 막고 읽기는 통과시킨다.**
   회귀 테스트 중 "초과 레코드를 담은 스냅샷이 여전히 읽힌다"가 이 위험을 고정한다.
4. **M3·M5·L1~L8은 아직 재현되지 않았다.** §0-4에 따라 재현이 먼저다.
