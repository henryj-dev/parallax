# Parallax 구현 검수 및 보안 감사 리포트 — 2026-08-22

> ## ⚠️ 이 문서는 두 시점이 섞여 있다
>
> **§0–11은 `95e85e6`에 대한 읽기 전용 감사다.** 그 시점에 코드는 건드리지 않았고,
> `pnpm verify:*`도 돌리지 않았으며, 동적 확인은 전부 폐기 가능한 스크래치패드
> 스크립트(인메모리 저장소·루프백 포트)로만 했다. 실제 `.env`는 열지 않았다.
>
> **그 뒤 같은 날 수정 작업이 이어졌고, 그 결과가 발견 항목 안에 덧붙었다.**
> 2026-08-10 리포트가 경고한 그대로 — 원문을 고치면 그때 무엇이 보였는지가 사라진다
> — 원래 주장은 지우지 않고 남긴 채 측정 결과를 붙였다. 어디가 언제 손댄 것인지는
> 아래 표가 든다. 수정 계획과 그 실행 기록은
> [`2026-08-22-remediation-plan.md`](2026-08-22-remediation-plan.md)에 있다.
>
> | 절 | 시점 | 무엇이 바뀌었나 |
> | --- | --- | --- |
> | §0–11 본문 | 2026-08-22 · `95e85e6` | 감사 원본 |
> | M3 · M4 | 수정 중 | 재현 결과가 서술을 바꿈. **M4는 원인의 절반이 틀렸다** |
> | M5 | 수정 중 | 재현되어 "확인됨"으로 올라감 |
> | L4 | 수정 중 | **발견 자체가 철회됐다.** 측정해 보니 기존 코드가 맞았다 |
> | I1 | 수정 중 | 조치 기록(삭제) |
> | §2 · §8 | 수정 중 | 위 둘을 반영한 개수와 도달성 |
>
> ⚠️ **인용한 `파일:줄`은 전부 `95e85e6` 기준이고, 그 뒤 수정으로 대부분 움직였다.**
> 지금 트리에서 그 줄을 열면 다른 것이 나온다. 무엇이 보였는지의 기록으로 읽을 것.
>
> **의뢰 범위가 이전 두 리포트와 다르다.** 보안뿐 아니라 "무엇이 구현되어 있는가 ·
> 어디가 오작동하겠는가 · 무엇을 더하면 좋은가"를 함께 요구받았으므로, 발견 사항을
> 보안/기능으로 나누지 않고 **하나의 심각도 축**에 올리고 각 항목에 `성격`을 붙였다.
>
> **방법상의 제약이 하나 걸려 있었다.** 의뢰가 "문서나 메모리를 보지 말고 코드만으로"
> 였으므로, 감사 자체는 `README*.md`·`AGENTS.md`·기존 감사 리포트를 **읽지 않고**
> 수행했다. 기존 리포트는 이 파일을 쓰는 시점에 형식을 맞추기 위해서만 열었다.
> 따라서 §7의 이전 감사 대조는 사후 확인이지 감사 중의 판단이 아니다.

---

## 0. 대상 스냅샷 (감사 중 작업 트리가 한 번 바뀜 — 반드시 확인)

세션 시작 시점의 스냅샷은 다음이었다.

```
시작 시각   2026-08-22 13:44 (Asia/Seoul)
브랜치      main
HEAD        b8039d9  docs(hooks): 최신 공유 훅 집합을 다시 측정
작업 트리    깨끗
```

그런데 소스를 읽기 시작한 뒤 확인한 HEAD는 달랐다.

```
확인 시각   2026-08-22 14:04 (Asia/Seoul)
HEAD        95e85e6  ci(runners): ARC Scale Set으로 검사 실행 전환
```

세션 시작 훅의 자동 fast-forward가 두 커밋을 끌어왔다.

| 커밋 | 내용 | 감사에 미치는 영향 |
| --- | --- | --- |
| `71c3700` | fix(reliability): DNS TCP와 apply 복구 경로 보강 | `src/dns/server.ts` +96/-21, `control-plane.ts`, `cli/commands.ts`, `http/api.ts` |
| `95e85e6` | ci(runners): ARC Scale Set으로 검사 실행 전환 | `.github/workflows/check.yml` 만 |

`src/dns/server.ts`는 이 감사 발견 사항 여러 건의 근거 파일이므로, **어느 판본을
읽었는지**를 추정하지 않고 확인했다.

```
$ git show b8039d9:src/dns/server.ts | grep -c 'armIncompleteFrameTimer'
0
$ grep -c 'armIncompleteFrameTimer' src/dns/server.ts
3
```

`armIncompleteFrameTimer`·`MAX_TCP_INCOMPLETE_FRAME_BYTES`·`handleMessage`는 모두
`71c3700`이 추가한 식별자이고, 감사 중 읽은 본문에 전부 들어 있었다. `apply pending`의
`retryFailed` 옵션(같은 커밋)도 읽은 본문에 있었다. **따라서 이 리포트 전체의 대상은
`95e85e6`이며, 인용한 줄 번호도 전부 `95e85e6` 기준이다.**

- **대상**: `mack-erel/parallax` — split-horizon DNS 컨트롤 플레인 (커밋 `95e85e6`)
- **일자**: 2026-08-22
- **범위**: `src/`, `cmd/`, `public/`, `migrations/`, `scripts/`, `Dockerfile`, `package.json`
- **기준선**: `pnpm check` 통과, `pnpm test` **667/667 통과** (99 suites, 13.3s)
- **규모**: `src/` + `cmd/` TypeScript 13,765줄 / 44파일, `public/` JavaScript 3,005줄
- **방법**: 전체 소스 정독 → 가설 수립 → 스크래치패드 스크립트로 실행 재현.
  주석의 보안·동작 주장은 증거로 인정하지 않고 코드 경로를 끝까지 추적해 확인함.
- **수정 계획**: [`2026-08-22-remediation-plan.md`](2026-08-22-remediation-plan.md).
  이 리포트는 무엇이 잘못되었는지까지만 말하고, 어떤 순서로 고칠지와 각 수정이
  어디서 깨질 수 있는지는 그쪽에 있다.

---

## 1. 정찰 요약

**시스템.** 단일 프로세스 Node.js 24 서비스. 런타임 의존성은 `pg` 하나뿐이고
프레임워크가 없다. 하나의 목표 상태(desired state)를 존별로 보관하고, `external`(공개)과
`internal`(사설) 두 뷰로 갈라 각각의 프로바이더에 reconcile 한다. **`internal` 뷰는
저장되는 값이 아니라 `external`에서 파생된다** — `materializeProviderViews`
(`control-plane.ts:1430`)가 상속 가능한 external 레코드를 복사한 뒤 override를 name+type
단위로 덮어쓴다. apex NS만 상속에서 제외된다(`isInheritable`, `:1474`).

**진입점.** `src/index.ts`의 단일 `createServer`(TLS 설정 시 `createTlsServer`). 분기는
다섯 갈래다 — (1) `/health/live`·`/health/ready`(**인증 없음**, ready의 상세는 인증 시에만),
(2) `/auth/*` OIDC 핸드셰이크(**인증 없음** — 인증을 얻는 경로이므로), (3) `/api/*` →
`createNodeHandler` → RBAC → 라우터, (4) 고정 allowlist 정적 파일(`PORTAL_ASSETS`,
9개 경로만), (5) 선택적 DNS 리스너(UDP+TCP)와 HTTP→HTTPS 리다이렉터.

**외부 입력.** HTTP 요청 본문·경로·헤더·쿠키, 환경변수, 디스크의 상태/설정/자격증명 파일,
Cloudflare API 응답, OIDC 프로바이더 응답, **그리고 DNS 포트로 들어오는 임의의 UDP/TCP
패킷** — 이 마지막이 이전 감사 대비 표면이 가장 크게 늘어난 곳이다.

**신뢰 경계.** ①미인증 네트워크 ↔ HTTP 서버(토큰/세션), ②viewer/editor ↔ admin(RBAC),
③서버 ↔ 프로바이더(HMAC 소유권 마커), ④**미인증 네트워크 ↔ DNS 리스너(CIDR 허용목록 +
레이트리밋)**, ⑤프로세스 ↔ 디스크(0600 + 0700 디렉터리 검증), ⑥HTTP 관리자 ↔ 데이터베이스
DDL(런타임에서 `migrate` 능력을 의도적으로 제외, `runtime.ts:146-149`).

### 구현되어 있는 기능

| 영역 | 내용 |
| --- | --- |
| 도메인 | 23개 레코드 타입, presentation format RDATA 검증 + **저장 시점 와이어 인코딩 가능성 검사**(`dns.ts:598`), 비전역 주소 external 게시 시 명시적 승인 요구, Cloudflare Auto TTL 규칙 |
| 변경 관리 | 리비전, 낙관적 동시성(`If-Match`/`expectedRevision`), 리비전 스냅샷·복원, 10종 감사 액션, 스냅샷 diff에서 유도한 added/removed/changed |
| 조정 | create/update/delete/conflict + `untouched` 카운트, HMAC 소유권 마커(v3, v2 읽기 호환), 입양(adopt)의 "인지하되 인수하지 않음" 의미론, 프로바이더 소유 레코드 재입양 갱신 |
| 프로바이더 | Cloudflare DNS(존 스코프, 페이지네이션 상한, Workers/R2 커스텀 도메인 소유권 조회), Cloudflare Zero Trust fallback domains, 로컬 파일 프로바이더, quarantine 있는 라우팅 어댑터 |
| DNS 서버 | UDP+TCP, 와일드카드 확장, DNAME 합성(RFC 6672), CNAME, NXDOMAIN/NODATA 구분 + SOA 동봉, SOA 합성, AXFR(TCP + CIDR), serial 상승 시 NOTIFY, 허용목록 포워딩(connected UDP + 상관관계 검증), 토큰버킷 레이트리밋, slow-drip 방어 TCP 프레이밍 |
| 인터페이스 | HTTP API v1, 의존성 0의 바닐라 JS 포털(i18n 포함), **동일 커맨드 레지스트리를 공유하는** CLI(35개 명령), `config check` 프리플라이트 |
| 보안 | 3단 역할, 토큰 다이제스트 저장, bearer↔HttpOnly 세션 쿠키 교환, OIDC(PKCE+state, entitlements→role), Origin/Sec-Fetch-Site CSRF, 실패 스로틀, AES-256-GCM 자격증명 저장소(revision을 AAD에 포함), CSP/HSTS, TLS 종단 + 인증서 핫리로드 |
| 저장소 | PostgreSQL(advisory lock, 원자적 커밋, 체크섬 검증 마이그레이션) 또는 파일(0600, atomic rename + fsync, 크로스프로세스 lockfile) |

---

## 2. 도달 가능 vs dormant 구분

이번 감사는 "지원 설정에서 실제로 도달 가능한가"를 발견 사항마다 명시했다. 판정 기준은
`Dockerfile`이 기본으로 켜는 형태와 `config.ts`가 허용하는 조합이다.

| 설정 | 도달성 | 근거 |
| --- | --- | --- |
| 토큰 인증 + 리버스 프록시 | 기본 | `Dockerfile`이 `HOST=0.0.0.0` → 토큰 필수 |
| **OIDC 전용(토큰 0개) + 리버스 프록시** | **지원 설정** | `config.ts:205` `readOidc`가 독립적으로 활성화, `index.ts:77`은 OIDC만으로 non-loopback 기동 허용 |
| DNS 리스너 활성 | 선택 (`PARALLAX_DNS_PORT`) | 설정 시 컨테이너에서는 `0.0.0.0` 바인드 |
| 파일 백엔드 | 기본 (`DATABASE_URL` 미설정 시) | `runtime.ts:68` |
| NS1 프로바이더 | **도달 불가** (감사 후 삭제됨 — I1) | 아래 I1 |
| CoreDNS/PowerDNS 프로바이더 | **부재** | 아래 I1 |

---

## 3. 발견 사항 — 심각도 High

### H1. OIDC 전용 배포가 리버스 프록시 뒤에서 API 전면 401이 되고, `/health/live`가 "인증 비활성"이라고 잘못 보고한다

- **성격:** 기능 결함(전면 장애) + 틀린 보안 보고
- **심각도:** High
- **위치:** `src/index.ts:205`(프록시 가드), `:220`(`/health/live`), `:424`(기동 경고).
  올바른 소스는 `src/index.ts:72` `securityConfig()`
- **도달성:** 지원 설정 — OIDC 구성 + 액세스 토큰 0개 + 프록시(= 대부분의 Kubernetes/Ingress 배포)
- **증상:** 유효한 OIDC 세션 쿠키를 가진 브라우저의 모든 `/api/*` 요청이 401.
  포털은 존 목록조차 못 읽는다.
- **데이터 흐름:** `index.ts:205`가 프록시 가드의 조건으로 `accessTokens.security().enabled`를
  읽는다. 그런데 OIDC 활성 여부는 그 값이 아니라 `securityConfig()`
  (`= config.oidc ? withIdentityProvider(tokens, secret) : tokens`, `:72`)에 들어 있다.
  `withIdentityProvider`는 `enabled: true`를 강제하지만(`http-authorization.ts:101`),
  `AccessTokenService`의 `enabled`는 `#authenticationRequired`이고 이 값은
  `bootstrap.length > 0`으로 시작해 저장된 토큰을 관측해야만 켜진다
  (`access-tokens.ts:84`, `:290`). 토큰이 0개면 영원히 `false`다.
- **증거(스크래치패드 실행):**
  ```
  accessTokens.security().enabled     = false
  securityConfig().enabled (oidc on)  = true
  ```
  `isProxiedRequest`는 `x-forwarded-for|proto|host|forwarded` 중 **하나만 있어도** 참이므로
  (`index.ts:331`), 실질적으로 모든 프록시 배포가 걸린다.
- **같은 근본원인의 파생 두 건:**
  1. `:220` — `/health/live`가 `authentication: "disabled"`를 응답한다. 포털은 이를
     `authRequired = false`로 읽고(`public/store.js:134` → `api-client.js:106`) **인증이
     필요한 배포를 열린 배포로 그린다.** 미인증 요청이 이미 드러내는 사실이라 비밀은
     아니지만, 값 자체가 틀렸다.
  2. `:424` — 기동 로그가 `no access token exists; every caller that reaches this port is
     an administrator`를 경고한다. OIDC가 그 진술을 거짓으로 만든다.
- **기존 통제와 불충분 이유:** 기동 시 non-loopback 거부 검사(`:77`)는 **올바르게**
  `securityConfig()`를 쓴다. 즉 같은 파일 안에서 두 소스가 혼용되고 있고, 올바른 쪽이
  기동을 통과시킨 배포를 잘못된 쪽이 런타임에 막는다.
- **확신도:** 확인됨(코드 추적 + 실행 재현).
- **수정 제안:** 세 지점 모두 `securityConfig().enabled`로 통일한다. 회귀 테스트:
  OIDC 구성 + 토큰 0개 + `x-forwarded-proto: https` 헤더로 `/api/v1/zones` GET이 세션
  쿠키로 통과하는지, `/health/live`가 `authentication: "required"`를 답하는지.

---

### H2. RDATA 64 KiB를 넘는 레코드가 저장을 통과하고, 그 이름의 DNS 질의가 **응답도 로그도 없이** 사라진다

- **성격:** 가용성 + 관측 실패
- **심각도:** High (해당 이름의 내부 해석이 침묵으로 중단, 원인 추적 단서 0)
- **위치:** 게이트 `src/domain/dns.ts:293-294`(`OPENPGPKEY`), 같은 파일의 `DS`/`DNSKEY`/
  `TLSA`/`SMIMEA`/`SSHFP`/`CERT` 분기. 폭발 지점 `src/dns/wire.ts:265`
  (`writeRecord`의 `fixed.writeUInt16BE(record.data.length, 8)`)
- **도달성:** DNS 리스너 활성 배포. 최소 쓰기 역할인 **editor** 하나면 충분
- **공격자·전제:** editor 토큰/세션 하나. 프로바이더 접근 불필요. 악의 없는 대용량
  PGP 키 붙여넣기로도 발생한다.
- **데이터 흐름:** `validateRecordContent`는 TXT에만 길이 상한(1–4096자)을 둔다
  (`dns.ts:240`). `OPENPGPKEY`는 `isBase64(content)`만 보고 길이를 보지 않으며,
  `DS`/`TLSA`/`SMIMEA`/`SSHFP`의 hex와 `DNSKEY`/`CERT`의 base64도 마찬가지다.
  `createDesiredRecord`가 저장 전 `encodeRdata`를 호출해 인코딩 가능성을 확인하지만
  (`dns.ts:598`), `encodeRdata`는 **길이를 검사하지 않으므로 성공한다.**
  질의가 오면 `answerFromZone`이 `encodeRdata`를 try/catch로 감싸고
  (`server.ts:487-499`), 실패 시 SERVFAIL + `onUnservable` 통지를 낸다 — 그런데 이번
  실패는 거기서 나지 않는다. 인코딩은 성공하고, 그 뒤 `writeReply` → `assemble` →
  `writeRecord`(`wire.ts:265`)에서 rdlength를 uint16에 쓰다 `RangeError`가 난다.
  이 지점은 **`answerFromZone`의 try/catch 바깥**이다. 예외는 `respond()`를 거쳐
  UDP에서는 `attachUdp`의 `.catch(() => undefined)`(`server.ts:203`)가 삼키고,
  TCP에서는 `.catch(() => socket.destroy())`(`server.ts:233`)가 연결을 끊는다.
- **증거(스크래치패드 실행, 루프백 UDP 15353):**
  ```
  OPENPGPKEY accepted, rdata bytes = 67500
  oversized OPENPGPKEY query -> NO REPLY (timeout)
  ```
  `onUnservable` 콜백은 **한 번도 호출되지 않았다.** `index.ts:404-408`이 그 콜백에
  걸어 둔 `console.error` 한 줄이 이 사건의 유일한 단서였는데, 그 줄이 나오지 않는다.
- **기존·보완 통제와 불충분 이유:** `server.ts:491-494`의 주석은 이 실패 모드를 정확히
  기술한다 — *"Half an RRset is the dangerous answer… SERVFAIL is loud, and it is not
  cached as an answer."* 방어의 의도는 옳고 위치가 한 프레임 짧다. `encodeRdata` 실패만
  덮고 `writeRecord` 실패를 덮지 않는다.
- **확신도:** 확인됨(코드 추적 + 실행 재현).
- **수정 제안:** 두 겹으로 닫는다.
  1. `validateRecordContent`에 타입 무관 RDATA 바이트 예산을 추가한다(인코딩 결과
     `> 65535` 거부). `createDesiredRecord`가 이미 `encodeRdata`를 부르므로 그 결과의
     `.length`를 검사하면 추가 비용이 없다.
  2. `respond()`에서 `writeReply` 호출을 try/catch로 감싸 어떤 인코딩 실패도 **침묵이
     아니라** SERVFAIL + `onUnservable`이 되게 한다. 방어를 프레임 하나 바깥으로 옮기는 것.

  회귀 테스트: 70,000바이트 OPENPGPKEY를 가진 존에 질의했을 때 rcode 2(SERVFAIL)가
  돌아오고 `onUnservable`이 정확히 한 번 호출되는지.

---

## 4. 발견 사항 — 심각도 Medium

### M1. DNS 리스너가 QCLASS와 OPCODE를 검사하지 않는다
- **성격:** 프로토콜 정합성
- **위치:** `src/dns/wire.ts:71`(flags), `:79`(`klass`를 읽고 검사하지 않음), `:73-74`
  (질문 개수만 검사)
- **도달성:** DNS 리스너 활성 배포, 미인증
- **증거(스크래치패드 실행):**
  ```
  class CHAOS parsed ok, class = 3
  opcode UPDATE parsed ok, flags = 2800
  ```
- **영향:** ①CH/HS 클래스 질의가 IN 존에서 답변되고 `writeRecord`는 항상 `CLASS_IN`을
  쓴다(`wire.ts:263`) — 클라이언트가 묻지 않은 클래스의 답을 받는다. ②opcode 5(UPDATE)·
  4(NOTIFY)·2(STATUS)가 표준 질의로 파싱되어 답변되고, `assemble`이 opcode를 그대로
  에코한다(`wire.ts:240`, `query.flags & 0x7900`). 업데이트가 적용되지는 않으므로
  무결성 문제는 아니지만, UPDATE 메시지의 zone 섹션을 question으로 읽어 답을 만든다.
  ③EDNS 버전을 검사하지 않아 version > 0에 BADVERS를 반환하지 않는다(`findOpt`,
  `wire.ts:125`은 payload size만 읽음).
- **확신도:** 확인됨(실행 재현).
- **수정 제안:** `readQuery`에서 `klass !== CLASS_IN && klass !== 255` → REFUSED,
  `(flags >> 11) & 0xf !== 0` → NOTIMP, OPT의 version 바이트 ≠ 0 → BADVERS.

### M2. 약 90배 UDP 증폭이 가능하고, EDNS Cookie도 RRL도 없으며, 레이트리밋 노브가 환경에 노출되어 있지 않다
- **성격:** 보안(가용성 / 제3자 피해)
- **심각도:** Medium
- **위치:** `src/dns/server.ts:845`(`createRateLimiter`), 배선 `src/index.ts:398-409`
- **도달성:** DNS 리스너 활성 배포, 미인증
- **증거(스크래치패드 실행, 루프백 UDP):**
  ```
  query 44 bytes -> reply 3944 bytes (amplification x89.6)
  ```
  (TXT 17개를 가진 이름에 대한 44바이트 EDNS ANY 질의. 40개로 늘리면 4096 상한을
  넘겨 TC 비트가 서고 44바이트로 잘린다 — **절단 처리 자체는 올바르다.**)
- **분석:** 권위 응답이 `forwardAllow` 뒤에 있지 **않은 것은 정상**이다. 권위 서버는
  누구에게나 자기 존을 답해야 한다. 문제는 남은 방어가 토큰버킷 하나뿐이라는 점이다.
  - EDNS0 Cookie(RFC 7873) 미지원 — 출발지 위조를 값싸게 걸러내는 표준 수단이 없다.
  - Response Rate Limiting 없음, minimal-responses 없음.
  - `DnsServerOptions`에 `rateLimitPerSecond`·`rateLimitBurst`·`forwardTimeoutMs`·
    `maxTcpConnections`·`maxConcurrentForwards`·`negativeTtl`이 **전부 정의되어 있는데**
    (`server.ts:29-46`), `index.ts:398-409`는 zones/forwardTo/forwardAllow/transferAllow/
    notifyTo/onUnservable만 넘긴다. **운영자가 코드 수정 없이 어느 값도 낮출 수 없다.**

  기본값(100 qps, burst 200)에서 위조 출발지 1개당 피해자에게 약 3.2 Mbit/s가 향한다.
- **확신도:** 확인됨(측정).
- **수정 제안:** 우선 `config.ts`에 `PARALLAX_DNS_RATE_LIMIT_PER_SECOND` 등으로 기존
  옵션을 노출한다(코드는 이미 있다 — 배선만 없다). 그다음 EDNS0 Cookie를 붙인다.

### M3. zone file import가 실제 BIND 존 파일을 읽지 못한다
- **성격:** 기능 결함
- **위치:** `src/domain/zone-file.ts:9`(`parseZoneFile`), `:81`(`tokenize`),
  게이트 `src/domain/dns.ts:212`
- **도달성:** `POST /api/v1/zones/{z}/import`, editor
- **영향:** ①괄호 다중행 레코드(`( ... )`) 처리가 없다. `tokenize`는 한 줄 단위로만
  돌고 이어짐 상태가 없다. ②`zoneFileContentIssue`가 TXT가 아닌 타입에서 `(`/`)`를
  거부한다(`dns.ts:212`). 즉 SOA·DNSKEY·긴 TXT를 여러 줄로 쓰는 **BIND의 통상 표기가
  전부 실패**한다. ③`$INCLUDE`·`$GENERATE` 미지원(단 `$INCLUDE` 미지원은 파일 읽기
  표면을 막아주므로 **의도적으로 유지할 것**).
- **확신도:** 확인됨(2026-08-22 재현).
- **수정 제안:** 파서에 괄호 이어짐 상태를 추가하고, 이어붙인 뒤의 content에 대해서만
  구조 문자 검사를 적용한다. `import --dry-run`(뷰 교체 전 diff 미리보기)도 함께 권고.
- ⚠️ **재현 중에 같은 경로에서 결함 둘이 더 나왔다.** 괄호를 고치고 나니 다음 줄에서
  걸렸다 — `uniqueId`(`domain/zone-file.ts`)가 만드는 레코드 id가
  `validateRecordId`의 두 규칙을 모두 어긴다. ①`_dmarc`·`_acme-challenge` 같은
  underscored owner는 `_`로 시작하는 id를 만드는데 id는 letter/digit로 시작해야 한다.
  ②길이를 60자로 자르는데 상한은 36자다. 둘 다 zone file import 전용이고 괄호와
  무관하게 원래 있었으며, 증상은 "record id must be 1 to 36..."이라는 **파일과
  무관해 보이는 메시지**였다.

### M4. 종료에 데드라인이 없어 SIGTERM이 grace period를 넘길 수 있다
- **성격:** 신뢰성(운영)
- **위치:** `src/shutdown.ts:23`, 타임아웃 설정 `src/index.ts:350-351`
- **영향:** `shutdownProcess`가 `server.close()`를 await 한다. 이는 열린 커넥션이 전부
  끝나야 콜백이 온다. **응답하지 않는 in-flight 요청**은 `requestTimeout`(60s)까지
  버티고, 강제 종료 타이머가 없다. 종료가 60초를 넘기면 Kubernetes가 SIGKILL을 보내고,
  **그 시점이 apply 도중이면** 프로바이더에는 일부만 적용된 상태가 남는다.
- **확신도:** 확인됨(2026-08-22 재현). 측정: 멈춘 요청 하나가 `shutdownProcess`를
  120초 넘게 붙잡았다.

  ⚠️ **이 항목의 최초 서술은 절반이 틀렸다.** 원래 "keep-alive 유휴 커넥션이
  `keepAliveTimeout`(10s)까지 버틴다"고 적었는데, 재현해 보니 그렇지 않다 —
  Node 19+ 의 `server.close()` 는 유휴 keep-alive 커넥션을 **스스로 닫는다.**
  유휴 커넥션을 열어둔 채 측정한 종료는 데드라인 없이도 밀리초 단위로 끝났다.
  남는 노출은 in-flight 요청 하나뿐이고, 그것은 실재한다. 코드 추적만으로
  적은 항목을 고치기 전에 재현하기로 한 규칙이 잡아낸 첫 번째 오류다.
- **수정 제안:** `server.closeIdleConnections()`를 먼저 부르고, 전체에 `Promise.race`로
  상한(예: 10초)을 건 뒤 남은 소켓을 destroy 한다.

### M5. OIDC 핸드셰이크 쿠키 파서가 중복에 취약해 로그인 CSRF가 성립한다
- **성격:** 보안(인증)
- **심각도:** Medium (관련 도메인 공격자 전제)
- **위치:** `src/http/identity-routes.ts:172`(`readCookie`) —
  대조군 `src/security/http-authorization.ts:439`
- **도달성:** OIDC 구성 배포
- **공격자·전제:** 포털 오리진의 **부모 도메인에 쿠키를 심을 수 있는 서브도메인** 제어.
- **확신도:** 확인됨(2026-08-22 재현 — 공격자와 피해자가 각각 로그인을 시작하고
  콜백이 공격자의 code·state 를 들고 오면, first-wins 판본에서 교환이 완료되고
  피해자의 브라우저에 공격자 계정의 세션이 남는다).
- **분석:** 같은 저장소 안에 두 개의 `readCookie`가 있고 **동작이 다르다.**
  `http-authorization.ts:439`는 같은 이름이 두 번 나오면 `undefined`를 반환해 섀도잉을
  거부한다. `identity-routes.ts:172`는 **첫 매치를 그대로 반환**한다. 공격자가 부모
  도메인에 `parallax_oidc_state`/`parallax_oidc_verifier`를 심어 앞순위를 차지하면,
  피해자의 브라우저가 공격자의 authorization code로 콜백을 완료하고 **피해자 세션이
  공격자 계정이 된다**(classic login CSRF). 이후 피해자가 만드는 변경은 공격자 계정의
  감사 기록으로 남는다.
- **기존 통제와 불충분 이유:** state·PKCE·HttpOnly는 모두 올바르게 구현되어 있다.
  결함은 그 값을 **읽는** 함수의 중복 처리에만 있다. 쿠키는 host-only로 설정되지만
  (Domain 속성 없음), 브라우저는 부모 도메인이 설정한 쿠키를 같은 `Cookie` 헤더에
  실어 보내므로 host-only는 섀도잉을 막지 못한다.
- **재현 범위:** 서버 측 판정은 재현했다. 브라우저가 실제로 부모 도메인 쿠키를
  어느 순서로 보내는지는 재현하지 않았고, 그것은 이 결함의 전제이지 결함 자체가 아니다.
- **수정 제안:** ①`identity-routes.ts`의 `readCookie`를 `http-authorization.ts`의
  중복 거부 판본으로 통일(둘을 한 모듈로 합치는 편이 낫다 — 두 벌이 존재하는 것 자체가
  결함의 원인이다). ②핸드셰이크 쿠키에 `__Host-` 접두사를 붙인다.

---

## 5. 발견 사항 — 심각도 Low

### L1. 실패 스로틀이 실제로는 추측을 늦추지 않는다
- **위치:** `src/security/http-authorization.ts:195-199`, `:258`, `FailureThrottle` `:319`
- **분석:** `recordFailure`는 인증을 **평가한 뒤에만** 호출된다. 잠긴 클라이언트도 모든
  후보가 그대로 검증되고, 성공(200)과 잠금(429)을 구별할 수 있다. 즉 429는 신호일 뿐
  게이트가 아니다. 모든 토큰 경로가 32바이트를 강제하므로(`MIN_TOKEN_BYTES`, `:41`;
  `isStrongBootstrapToken`, `access-tokens.ts:316`) 실제 악용은 불가능하다. 다만
  주석이 *"Bounds online guessing"*이라고 주장하는 일을 하지는 않는다.
- **수정 제안:** 잠금 중이면 검증 **전에** 429로 끊는다. "유효한 토큰은 노이즈와 무관하게
  즉시 통과"라는 설계 의도를 유지하려면 현재 동작을 두고 주석을 실제에 맞춘다.

### L2. DNS 레이트리미터 테이블을 위조 출발지로 채워 신규 클라이언트를 차단할 수 있다
- **위치:** `src/dns/server.ts:867`
- **분석:** 10,000키에서 포화되고, 포화 상태에서 **테이블에 없는 신규 클라이언트를 전부
  거부**한다(`if (clients.size >= maxClients) return false`). sweep은 초당 1회로 제한된다.
  라이브 버킷을 축출하지 않는 설계는 옳지만(주석이 그 이유를 정확히 설명한다),
  결과적으로 위조 출발지 홍수가 정상 신규 클라이언트를 버킷 만료까지 차단한다.
- **수정 제안:** M2의 EDNS Cookie가 이 항목도 함께 닫는다. 그 전에는 `maxClients`를
  노출해 배포 규모에 맞게 올릴 수 있게 한다.

### L3. 인증 이전에 요청 본문을 최대 1 MiB 버퍼링하고, HTTP 커넥션 상한이 없다
- **위치:** `src/http/api.ts:65`(`readBody`가 `createAuthorizedHandler`보다 앞)
- **분석:** GET/HEAD가 아닌 모든 요청이 인증 전에 최대 1 MiB를 메모리에 올린다.
  `server.maxConnections`는 어디에서도 설정되지 않는다(확인함). 노출량은
  미인증 동시 커넥션 수 × 1 MiB.
- **수정 제안:** `server.maxConnections` 설정. 인증 후 본문 읽기로 바꾸는 것은 Fetch
  `Request` 조립 구조상 큰 수술이므로 비용 대비 효과를 따져볼 것.

### ~~L4. `usesPlaintextPostgres`의 판정이 비일관적이다~~ — **철회. 이 발견은 틀렸다**
- **위치:** `src/config.ts:350-353`
- **원래 주장:** `?ssl=true`는 "평문 아님"으로 통과시키면서 `sslmode=require`는 거부하는데,
  `ssl=true`가 더 강한 검증을 보장하지 않으므로 방향이 반대다.
- **측정 결과 — 양방향으로 틀렸다.** `pg` 8.22.0 / `pg-connection-string` 2.14.0에서:

  ```
  ?ssl=true            -> true          (boolean)
  ?sslmode=require     -> {}
  ?sslmode=verify-full -> {}
  ```

  `ssl=true`가 만드는 boolean `true`는 `tls.connect`에 **옵션 객체 전체로** 넘어가고,
  Node의 그 자리 기본값은 `rejectUnauthorized: true`다 — 체인과 호스트명이 **둘 다**
  검증된다. verify-full을 다른 철자로 쓴 것이다. 반대로 config가 **거절하는**
  `sslmode=require`는 같은 라이브러리가 지금 `prefer`·`require`·`verify-ca`를
  verify-full의 별칭으로 취급하고 있고(라이브러리 자신이 pg v9에서 libpq의 약한
  의미로 바뀐다고 경고한다), 그러니 오늘 거절하는 것은 그 라이브러리에 필요한 것보다
  엄격하고 바뀌는 날에는 정확히 옳다.

  **즉 기존 코드가 맞다.** 이름만 보고 추론한 것이 원인이다.
- ⚠️ **더 나쁜 것은, 이 틀린 판단으로 거짓 경고를 한 번 배포했다는 점이다.** 커밋
  `fd4d3a3`이 `ssl=true`를 두고 *"encrypts the session without checking who is on the
  other end"* 라고 기동 로그에 찍었다. 사실이 아니다. 측정 후 되돌렸다.
  `config.ts`에 측정 결과를 주석으로 박고 회귀 테스트로 고정했다 — 다음 사람이
  다시 이름만 보고 뒤집지 않도록.

### L5. OIDC 엔드포인트가 하드코딩이고 ID 토큰을 검증하지 않는다
- **위치:** `src/security/oidc.ts:52`, `:61`, `:102`, `:147`
- **분석:** `${issuer}/oidc/authorize|token|userinfo|end-session` — discovery
  (`/.well-known/openid-configuration`) 없음, JWKS 없음, `nonce` 없음, 콜백 `iss` 검사 없음.
  신원을 백채널 `userinfo`에서 읽으므로 **설계 자체는 방어 가능하다**(id_token을 신뢰하지
  않으니 서명 검증이 필수가 아니다). 다만 저 경로 구조를 쓰는 프로바이더에서만 동작하고
  Google/Okta/Keycloak/Entra와는 **조용히** 상호운용되지 않는다 — 실패가 로그인 시점의
  404/HTML 파싱 오류로 나타나 원인이 즉시 드러나지 않는다.
- **수정 제안:** discovery 문서를 한 번 읽어 엔드포인트를 채우고 캐시한다.

### L6. 세션 쿠키가 bearer 토큰 원문을 담고, OIDC 세션은 만료 전 폐기할 수 없다
- **위치:** `src/security/http-authorization.ts:267`(`sessionCookieValue(name, candidate, …)`)
- **분석:** HttpOnly + SameSite=Strict + (https일 때) Secure이므로 브라우저 안에서는
  타당하다. 다만 쿠키를 캡처하는 로그/프록시는 **살아 있는 API 크리덴셜**을 캡처하는
  셈이다. OIDC 세션은 자기완결 서명값이라 만료 전 폐기가 불가능하고
  (`session-token.ts:12-16`이 그렇게 문서화한다), 폐기 대상으로 삼을 서버측 세션 인덱스가
  없다.
- **수정 제안:** 세션 쿠키에 토큰 대신 별도의 랜덤 세션 id를 담고 서버가 매핑을 갖는다.
  최소한 settings에 "전체 로그아웃" epoch를 두어 그보다 오래된 세션을 거부한다.

### L7. `servedByProvider` 릴레이 경로가 `forwardAllow` 바깥이다
- **위치:** `src/dns/server.ts:157-169`
- **분석:** 주석의 논리는 타당하다 — 허용 범위 밖 클라이언트가 **우리 존의** placeholder
  이름을 물었을 때 공개 답을 돌려주기 위한 경로이고, 오픈 리졸버로 쓸 수는 없다.
  결과만 적어 두면: 도달 가능한 모든 클라이언트가 이 프로세스로 하여금 업스트림으로
  아웃바운드 UDP 소켓을 열게 만들 수 있는 **유일한 미인가 경로**다.
  `maxConcurrentForwards`(256)와 레이트리미터로 한정되므로 잔여 위험은 낮다.
- **수정 제안:** 수정 불필요. 이 경로에 별도의 좁은 동시성 상한을 두면 더 좋다.

### L8. `applyPending`이 이동하는 오프셋으로 페이징한다
- **위치:** `src/application/control-plane.ts:756`
- **분석:** `offset += page.zones.length`로 `statusOverview`를 페이징하는데 루프 도중 행의
  상태가 바뀐다. 현재는 행이 목록에서 사라지지 않고 상태만 바뀌므로 안정적이다.
  overview에 상태 필터가 생기는 순간 존을 건너뛴다 — 잠재 결함.
- **수정 제안:** 존 이름 커서로 바꾸거나, 목록을 먼저 전부 수집한 뒤 적용한다.

---

## 6. 발견 사항 — 심각도 Info (도달 불가능한 코드 · 문서-구현 불일치)

### I1. `src/adapters/ns1.ts`는 어디에서도 import되지 않는다. 주석이 언급하는 CoreDNS/PowerDNS 어댑터는 이 트리에 없다
- **위치:** `src/adapters/ns1.ts`(224줄) + `test/adapters/ns1.test.ts`
- **확인:**
  ```
  $ grep -rn "ns1" src cmd --include="*.ts" | grep -v "^src/adapters/ns1.ts"
  (출력 없음)
  ```
  자격증명 저장소는 Cloudflare 형태(profile = accountId + token, binding = zone + zoneId)만
  모델링하므로(`credential-store.ts:34-57`) NS1을 설정할 경로 자체가 없다.
- **더해서:** `index.ts:390`, `dns/snapshot.ts:14`, `http/readiness.ts:145` 의 주석이
  *"the CoreDNS and PowerDNS adapters"*를 반복 언급하지만 `src/adapters/`에는
  `cloudflare.ts`·`cloudflare-fallback.ts`·`ns1.ts`·`ownership.ts`·`router.ts` 다섯 개뿐이다.
  `runtime.ts:215-219`에는 *"Confines the administrator-owned CoreDNS directory setting…"*
  이라는 **고아 JSDoc**이 `createMigrationRuntime` 위에 붙어 있다 — 설명 대상 함수가 없다.
  `ParallaxSettings`에 `coreDnsDirectory` 같은 키도 없다(`settings.ts:11-31`).
- **왜 Info가 아니라 신경 쓸 일인가:** 2026-08-15 리포트의 H1이 **CoreDNS 어댑터를
  대상으로 한 발견**이었다. 그 어댑터가 사라졌다면 해당 발견은 "수정됨"이 아니라
  "대상 소멸"이고, 두 가지는 회귀 검증에서 전혀 다르게 다뤄야 한다. 주석만 남아 있으면
  다음 감사자가 없는 파일을 찾게 된다.
- **조치(2026-08-22):** 삭제했다. 처음에는 "배선인가 삭제인가는 사람의 결정" 으로
  뒀는데, 그 판단의 근거였던 *"남의 동작하는 코드"* 라는 전제를 확인해 보니 틀렸다.
  NS1은 이 감사 문서 **바깥 어디에도 없다** — README(양쪽), `docs/`, `migrations/`,
  `package.json`, 스크립트 전부. 광고된 적 없고, 설정 경로가 없고, 추가된 커밋
  이래 한 번도 도달 가능한 적이 없다. 지우는 것은 제품 변경이 아니라 정리이고,
  배선하는 쪽은 아무도 요청하지 않은 기능을 만드는 것이라 범위 밖이다.
  코드는 `4cb844a`에 남아 있으므로 되살리려면 그 커밋에서 두 파일을 꺼내면 된다.
  ②사라진 어댑터를 가리키는 주석 네 곳은 `656a149`에서 정리했다.

---

## 7. 검토했으나 문제 없음 (코드 경로 확인)

아래는 **찾아봤고 없었다**는 기록이다. 다음 감사자가 같은 곳을 다시 파지 않도록 남긴다.

| 항목 | 확인 내용 |
| --- | --- |
| SQL 인젝션 | `postgres.ts` 전 구문이 `$n` 파라미터화. 문자열 보간이 들어가는 유일한 자리는 `STATUS_COLUMNS`/`AUDIT_COLUMNS` 상수와 `forUpdate ? " FOR UPDATE" : ""`로, 둘 다 코드 상수다. settings 키는 `isDangerousObjectKey`로 프로토타입 오염 차단(`:428`, `:437`) |
| XSS | 포털의 모든 HTML 싱크(`app.js` 20여 곳)가 보간 **후** `escapeHtml`로 감싸임. `t()` 보간 결과도 전체가 한 번 escape 된다. `index.html`에 인라인 핸들러 0개·`style=` 속성 0개 → CSP `script-src 'self'; style-src 'self'`가 `unsafe-inline` 없이 성립. `signin_error` 쿼리도 `store.reportSignInFailure` → `escapeHtml` 경로 |
| 감사 actor 위조 | `withActor`가 `headers.set("x-parallax-actor", …)`로 **항상 덮어쓴다**(`http-authorization.ts:308`). 인증 비활성 모드에도 `"authentication-disabled"`로 덮는다. `next()`로 가는 모든 경로가 이를 통과 |
| 자격증명 저장소 | AES-256-GCM, revision을 AAD에 포함(`aadForRevision`, `credential-store.ts:457`), 단조 revision 검사로 롤백 탐지(`#acceptRevision`), 32바이트 키 강제, 토큰이 HTTP로 직렬화되는 경로 없음(`CloudflareProfileMetadata`에 token 필드 부재) |
| 토큰 저장·비교 | 다이제스트만 저장. `matchToken`이 **모든** 레코드를 순회해 일치 위치를 관측 불가로 만든다(`:427-437`). bootstrap 토큰은 정규 32바이트 base64url만 허용 |
| CSRF | 쿠키 인증 + unsafe method는 Origin/Sec-Fetch-Site 증명 필수(`:200`), 세션 발급/삭제 라우트도 동일(`:241`). `authorization` 헤더가 있으면 면제되는데, 이는 교차 출처에서 헤더를 붙일 수 없으므로 타당 |
| 소유권 마커 | target 바인딩 HMAC이라 다른 존으로 복사하면 검증 실패. `assertSecret`이 32바이트 미만을 거부하므로 `ownershipSecret ?? ""`(`runtime.ts:95`) 기본값으로 위조 가능한 마커가 만들어지지 않고 **생성자에서 즉시 실패**한다(`cloudflare.ts:63`이 생성자에서 `ownershipComment`를 한 번 호출해 검증) |
| 마커 디코이 (2026-08-15 H2) | `readVersion3`·`readVersion2` 모두 `matchAll`로 **전 후보를 순회**한다(`ownership.ts:68`, `:86`). 회귀 없음 |
| DNS 포워딩 응답 위조 (2026-08-15 H5) | connected UDP + `isResponseToQuery`가 id·QR·opcode/RD·qdcount·qname·qtype·qclass를 전부 대조(`wire.ts:99-115`). TCP도 프레임마다 검증하고 위조 프레임을 소비한 뒤 계속 기다린다. 회귀 없음 |
| 파일 백엔드 토큰 폐기 (2026-08-15 H3) | `AccessTokenService`가 5초 폴링 + `#repositoryMutationGeneration`으로 stale 스냅샷을 거부하고, 60초 초과 시 저장 다이제스트를 **버려서 fail-closed** 한다(`#buildSecurity`, `access-tokens.ts:279`). 회귀 없음 |
| SSRF | `apiBaseUrl`은 생성자 옵션일 뿐 운영자 설정 경로가 없다. `ParallaxSettings`는 고정 키 6개 허용목록이고 `readPatch`가 미지 키를 거부(`settings.ts:234`) |
| 이름 압축 루프 | `readName`의 포인터는 **엄격히 뒤로만** 이동해야 한다(`wire.ts:164`, `target >= limit` 거부). 자기참조·상호참조 루프 불가 |
| 파일 권한 | 상태·설정·프로바이더 파일 모두 0600, atomic rename + `fsync` + 디렉터리 `fsync`(`file-state.ts:208-227`). private 디렉터리는 chmod가 아니라 **0700 검증**(`atomic-file.ts:21-43`) — 공유 부모의 권한을 바꾸지 않고 fail-closed |
| 마이그레이션 | 고정 manifest 대조 → 세션 advisory lock → 파일별 SHA-256 체크섬 기록. 변경된 마이그레이션은 거부. `BEGIN/COMMIT` 래퍼를 정확히 하나만 벗겨 스키마 변경과 원장 행을 원자화 |
| DDL 권한 분리 | `migrate`는 `createMigrationRuntime`에만 존재하고 `createRuntime`의 반환 객체에 없다(`runtime.ts:146-149`). `POST /api/v1/cli`로 admin이 되어도 DB DDL 역할에 도달할 수 없다 |
| `/api/v1/cli` 표면 | `authorize()`가 이 경로만 전 역할에 POST를 허용하고(`:119`), 실제 권한은 각 명령의 `role`이 강제한다(`runCommand`, `commands.ts:79`). 명령 35개의 role 선언을 전수 확인 — 관리 표면(credentials/settings/tokens/fallback)은 전부 `admin`, 쓰기는 `editor`, 읽기는 `viewer`. `zone delete`만 쓰기 중 유일하게 `admin` |
| 응답 오류 누출 | 프로바이더 오류는 `publicProviderError`가 알려진 세 종류 외에는 `"provider operation failed"`로 접는다(`control-plane.ts:1184`). Cloudflare 전송 오류는 `redact(msg, token)`을 통과 |
| 컨테이너 | 숫자 UID 10001 non-root, `/app/dist`·`/app/public`·`/app/migrations` 쓰기 금지, `VOLUME` 미사용(이유까지 주석에 있음), `.env`는 git·docker 양쪽에서 제외 확인 |
| 절단(TC) 처리 | 응답이 클라이언트 광고 크기를 넘으면 헤더+질문+OPT만 남기고 TC 비트를 세운다(`wire.ts:225-234`). 40개 TXT 실측에서 44바이트로 정확히 잘렸다 |

---

## 8. 심각도별 개수

| 심각도 | 개수 | 항목 |
| --- | --- | --- |
| High | 2 | H1(OIDC+프록시 전면 401 / 틀린 인증 보고), H2(64 KiB 초과 RDATA 침묵) |
| Medium | 5 | M1(QCLASS/OPCODE), M2(90배 증폭·노브 미노출), M3(BIND import), M4(종료 데드라인), M5(로그인 CSRF) |
| Low | **7** | L1~L8 중 **L4는 철회** — 측정해 보니 기존 코드가 맞았다 |
| Info | 1 | I1(NS1 죽은 코드 · 사라진 어댑터 주석) |

**성격별로 다시 세면** 보안 6건(M2, M5, L2, L3, L5, L6 — H1·H2는 가용성과 잘못된
보안 보고 쪽), 기능 결함 5건(H1, H2, M1, M3, I1), 신뢰성 2건(M4, L8), 잔여 위험 1건(L7).
**L4는 어느 쪽에도 세지 않는다 — 철회된 발견이다.**

---

## 9. 신규로 추가하면 좋을 기능

발견 사항의 수정과 별개로, **코드를 읽으며 "여기까지 왔으면 다음은 이것"이라고 판단한**
항목들이다. 우선순위 순.

> **수정 작업에서 1·2·3·6·9·12번은 했다** — EDNS0 Cookie와 리미터 노브 노출,
> QCLASS/OPCODE/EDNS-version, SOA 값 설정, NS1 정리, 관측성(`/metrics`),
> 종료 데드라인. RRL은 하지 않았다.
>
> 9번(관측성)을 한 이유는 우선순위 판단이 바뀌어서다. **H2가 살던 공백이
> 이것이다** — 고쳐서 SERVFAIL과 stderr 한 줄이 되었지만, stderr 한 줄에는
> 임계값을 걸 수 없다. 3번(SOA)도 다시 보니 제안이라기보다 잠재 결함이었다:
> MNAME은 세컨더리가 갱신을 물으러 가는 곳이고, 거기 적히던 `ns.<zone>`은
> 존재가 확인된 적 없는 이름이다.
>
> 나머지는 그대로 제안이며, 어느 것도 이 감사가 든 결함이 아니다.

### DNS — 실제 리졸버로서의 격차가 가장 크다
1. **EDNS0 Cookie(RFC 7873) + RRL**, 그리고 `DnsServerOptions`에 이미 존재하는 리미터·
   타임아웃 옵션을 `config.ts`에 노출. M2의 표준 해법이고 배선은 이미 절반이 되어 있다.
2. **QCLASS/OPCODE/EDNS-version 처리**(M1).
3. **SOA 값 설정 가능화.** `soaRecord`(`server.ts:556-563`)가 primary를 `ns.<zone>`,
   mailbox를 `hostmaster.<zone>`으로 하드코딩하고 refresh/retry/expire가
   3600/600/604800 고정이다(`rdata.ts:76-84`). 여기서 AXFR을 받는 세컨더리는 **존재하지
   않을 수도 있는 NS 이름**을 받는다.
4. **AXFR/NOTIFY에 TSIG.** 지금은 IP 허용목록만이고, 그것이 유일한 전송 통제다.
5. **DoT/DoH.** 사설망 클라이언트가 대상인 제품이므로 자연스러운 다음 단계.

### 컨트롤 플레인
6. **두 번째 실 프로바이더.** I1의 정리와 같은 작업이다. NS1을 살리거나 지운다.
7. **주기적 드리프트 탐지 + 알림.** 조정 엔진이 이미 `conflict`/`untouched`를 계산하는데
   (`reconciliation.ts:14-33`) 이를 주기적으로 폴링하는 주체가 없다. 지금 드리프트는
   사람이 `preview`를 눌러야만 보인다.
8. **`apply pending`의 dry-run**과 존별 동시성 상한. 현재 전 존을 순차 적용한다.
9. **관측성.** `/metrics`도 구조화 로깅도 없다 — 확인 결과 로깅은 전부
   `src/index.ts`의 `console.*` 22회와 `control-plane.ts` 1회가 전부다.
   **실패가 눈에 잘 띄지 않는 컴포넌트치고 알림을 걸 표면이 없다.** H2가 정확히
   이 공백에서 사는 결함이다.
10. **OIDC 세션 서버측 폐기**(L6)와 **OIDC discovery**(L5).
11. **존 단위 RBAC.** 역할이 전역이라 editor는 모든 존을 편집한다. 멀티팀 DNS 컨트롤
    플레인에서 가장 먼저 요구되는 항목.

### 운영
12. **종료 데드라인 + `closeIdleConnections()`**(M4).
13. **`config check`의 확장.** 지금은 환경변수만 읽는다(그 자체는 옳은 설계 —
    주석이 이유를 정확히 설명한다). 저장소 연결·자격증명 복호화 가능성·바인딩된 각
    존의 프로바이더 도달성을 **선택적으로** 프로브하는 별도 명령이 있으면, 지금은
    기동 시점이나 apply 시점에만 드러나는 실패를 앞당겨 볼 수 있다.

---

## 10. 우선 조치 권고 (요약)

> **여섯 건 전부 처리됐다** — 순서대로 `ad0247e`, `a4ede3a`, `369858d`+`4aa24d4`,
> `7569c80`, `69a2b63`, `5dc4d08`. 아래는 감사 시점의 우선순위 판단 그대로 남긴다.

| 순위 | 항목 | 이유 |
| --- | --- | --- |
| 1 | **H1** | 배포 형태 하나(OIDC 전용 + 프록시)가 통째로 동작하지 않고, 포털에 틀린 보안 상태를 보고한다. 수정은 세 줄 |
| 2 | **H2** | 이름 하나가 침묵으로 사라지고 로그가 남지 않는다. 이 프로젝트가 존재 이유로 내건 실패 모드 그 자체 |
| 3 | **M2** | 노브 노출만으로 즉시 완화 가능(코드는 이미 있다). EDNS Cookie는 그다음 |
| 4 | **M1** | 작고, 프로토콜 정합성 문제이며, 회귀 테스트가 쉽다 |
| 5 | **M5** | 두 벌의 `readCookie` 중 하나로 통일 — 중복 자체를 없애는 편이 낫다 |
| 6 | **I1** | 다음 감사자가 없는 파일을 찾지 않도록. 2026-08-15의 CoreDNS 발견이 "수정됨"인지 "대상 소멸"인지도 여기서 갈린다 |

---

## 11. 범위와 미검토

- **미검토:** `README.md`/`README.ko.md`(약 100 KB), `docs/`, `.github/workflows/`,
  `scripts/claude-hooks/**`·`scripts/git-hooks/**`(다른 저장소의 스냅샷),
  `test/**`의 개별 단언 내용(통과 여부만 확인), `pnpm-lock.yaml` 의존성 감사.
- **안전 제약으로 수행하지 않은 동적 검증:** 실 Cloudflare 계정 대상 apply/adopt/
  fallback sync, 실 OIDC 프로바이더 대상 로그인, `pnpm verify:*` 전체,
  실제 `.env` 열람, 리버스 프록시 뒤 배포에서의 H1 end-to-end 재현
  (코드 추적 + 단위 재현으로 확인했고 통합 재현은 미수행).

  **2026-08-22 갱신 — 이 줄의 절반은 뒤이은 수정 작업에서 해소됐다.** 스크립트를
  열어보니 `verify:*` 넷 중 셋은 로컬이었다(`dns`는 Docker도 네트워크도 안 쓰고,
  `proxy`·`postgres`는 일회용 로컬 컨테이너). 셋 다 돌렸고 통과했으며, H1의
  end-to-end 재현은 `verify:proxy`가 실제 nginx와 세션 쿠키로 해줬다. **남은 것은
  `verify:cloudflare` 하나** — 운영자가 쓰기를 허용할 존과 실계정 토큰을 직접 줘야
  하는 opt-in이라 돌리지 않았다. "실 자원을 건드린다"며 넷을 통째로 넘긴 것이
  이 감사의 판단 착오였다.
- **확신도 표기:** "확인됨"은 코드 추적 **및** 실행 재현을 모두 마친 것,
  "코드 추적으로 확인"은 실행 재현 없이 경로만 끝까지 따라간 것이다.
  최초 작성 시점에 M3·M4·M5·L1~L8이 후자였다.

  **2026-08-22 갱신:** 수정 작업에서 M4와 M5를 재현했고, 결과가 서술을 바꿨다 —
  M4는 원인의 절반이 틀렸고(위 참조), M5는 재현되어 확인됨으로 올라갔다.
  나머지(M3·L1~L8)는 여전히 코드 추적 단계다.
