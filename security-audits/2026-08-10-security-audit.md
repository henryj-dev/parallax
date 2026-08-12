# Parallax 보안 감사 및 구현 검수 리포트

> **§1–7 은 2026-08-10 의 감사 그 자체이고 그대로 둡니다.** 커밋 `3a1f16c` 를 대상으로 한
> 시점 기록이라 나중에 고치면 그때 무엇이 보였는지가 사라집니다.
>
> **§8 이후는 그 뒤에 붙인 것이고 날짜가 따로 붙습니다.** 발견 사항은 전 항목 수정했으며
> ([8. 조치 결과](#8-조치-결과)), 조치 과정에서 드러난 후속 항목은
> [9. 후속 조치](#9-후속-조치)에 회차별로 있습니다.
>
> | 절 | 시점 | 내용 |
> | --- | --- | --- |
> | §1–7 | 2026-08-10 · `3a1f16c` | 감사 원본 |
> | §8, §9.1–9.6 | 2026-08-10 | 조치와 1차 후속 |
> | §9.7 | 2026-08-11 | 리버스 프록시·자체 TLS 검증 |
> | §9.8 | 2026-08-12 · `ef61201` | Cloudflare 실계정 검증 — **결함 셋을 찾음** |
>
> ⚠️ 각 검증의 통과는 **그 커밋에 대한 것**이지 이후 커밋에 대한 주장이 아닙니다.


- **대상**: `mack-erel/parallax` — split-horizon DNS 컨트롤 플레인 (커밋 `3a1f16c`)
- **일자**: 2026-08-10
- **범위**: `src/`, `public/`, `migrations/`, `test/`, 설정 및 배포 문서 전체 (읽기 전용 분석 + 로컬 실행 검증)
- **기준선**: `pnpm check` 통과, `pnpm test` 144/144 통과
- **방법**: 전체 소스 정독 → 가설 수립 → 로컬 서버 기동 후 실제 HTTP·파일 시스템으로 재현 검증.
  문서·주석의 보안 주장은 증거로 인정하지 않고 코드 경로를 끝까지 추적해 확인함.

---

## 1. 정찰 요약

**시스템**: 단일 프로세스 Node.js 24 HTTP 서비스. 의존성은 `pg` 하나뿐이며 프레임워크를 쓰지 않는다.
하나의 "목표 상태(desired state)"를 존별로 보관하고, 이를 내부(CoreDNS 존 파일)와 외부(Cloudflare API)
두 프로바이더에 각각 reconcile 한다. 브라우저 포털(`public/`)이 같은 프로세스에서 정적 파일로 서빙된다.

**진입점**: `src/index.ts`의 단일 `createServer`. 세 갈래로 분기한다 — (1) `/health/live`, `/health/ready`
(**인증 없음**), (2) `/api/*` → `createNodeHandler` → RBAC → 라우터, (3) 고정 allowlist 정적 파일
(**인증 없음**, 포털 로그인 화면 제공에 필요). 외부 입력은 HTTP 요청 본문·경로·헤더, 환경변수,
디스크의 상태/자격증명 파일, 그리고 Cloudflare API 응답과 기존 CoreDNS 존 파일 내용이다.

**신뢰 경계**: ①미인증 네트워크 ↔ 서버 (토큰 인증), ②viewer/editor ↔ admin (RBAC), ③서버 ↔ 프로바이더
(Cloudflare 응답과 손으로 관리되던 존 파일은 신뢰하지 않는 입력으로 취급해야 함), ④서버 ↔ 디스크
(상태 파일·암호화된 자격증명 파일). **권한 경계**: root 권한으로 도는 컴포넌트는 없다. 다만 CoreDNS
존 파일 디렉터리에 대한 쓰기 권한과 Cloudflare API 토큰을 보유하므로, 프로세스 장악 = **조직의 공개
DNS 장악**이다. **민감 자산**: Cloudflare API 토큰(암호화 저장), ownership HMAC 시크릿, RBAC 토큰,
credential 마스터 키, 그리고 DNS 레코드 자체(트래픽 리디렉션·인증서 발급 탈취로 직결).

---

## 2. 심각도별 요약

| 심각도 | 보안 | 정확성/기능 | 합계 |
| --- | --- | --- | --- |
| High | 1 | 2 | 3 |
| Medium | 4 | 2 | 6 |
| Low | 5 | 5 | 10 |
| Info | 1 | 1 | 2 |

---

## 3. 보안 발견 사항

### S-1. [High / 확인됨] CoreDNS 존 파일 파서가 `$TTL` 기본값 레코드를 인식하지 못해 RRset을 오염시킨다

- **위치**: `src/adapters/coredns-file.ts:74`
- **원인**: 레코드 인식 정규식이 `^(\S+)\s+(\d+)\s+(?:IN\s+)?(A|AAAA|CNAME|TXT)\s+(.+?)\s*$`로,
  **명시적 숫자 TTL이 있는 줄만** 매칭한다. RFC 1035에서 가장 흔한 형태인 `$TTL` 상속 레코드
  (`legacy IN A 10.9.9.9`)는 조용히 건너뛴다.
- **공격/사고 시나리오** (실제 재현함):

  ```
  # 기존 손관리 존 파일
  $ORIGIN example.com.
  $TTL 3600
  legacy       IN A     10.9.9.9      <- 파서가 못 봄
  withttl 3600 IN A     10.9.9.11     <- 파서가 봄

  # adapter.list() 결과: withttl 하나뿐
  # desired: legacy A 10.1.1.1 → plan = {create:1, conflict:0}
  # 적용 후:
  legacy       IN A     10.9.9.9              <- 살아있음
  legacy 300 IN A 10.1.1.1 ; parallax-managed  <- 추가됨
  ```

  운영자는 `legacy`의 응답을 **교체**하려 했지만 결과는 두 값의 라운드로빈이며, 구 IP가 계속 응답된다.
  드리프트/충돌 탐지가 제품의 핵심 가치인데, 브라운필드 존 파일에 대해서는 그 탐지가 동작하지 않는다.
- **문서-구현 불일치**: README는 "Existing non-Parallax records and authority data are retained;
  Parallax only updates records carrying its signed ownership marker"라고 주장한다. 문자 그대로는
  참이지만, **대부분의 기존 레코드를 애초에 보지 못한다**는 사실을 감춘다. "managed-only라 안전하다"는
  안전성 서사가 실제로는 "충돌을 조용히 만들어낸다"로 퇴화한다.
- **수정 제안**: `$TTL` 디렉티브를 추적해 TTL 생략 레코드를 파싱하고, 소유자 이름 생략(공백 시작
  연속 레코드)과 괄호 다중 행도 처리한다. 최소한 파싱하지 못한 비어있지 않은 레코드 줄이 있으면
  `conflict`를 발생시켜 **fail-closed** 하도록 바꾼다. 지금은 "못 읽은 줄 = 없는 레코드"로
  fail-open 하고 있다.

### S-2. [Medium / 확인됨] 인증 토큰에 최소 강도 요건이 없고 레이트 리밋·잠금도 없다

- **위치**: `src/config.ts:101-106`, `src/security/http-authorization.ts:119`
- **검증**: `PARALLAX_AUTH_TOKENS='[{"token":"a","role":"admin","subject":"o"}]'`로 설정하고
  `Authorization: Bearer a` 요청 → **HTTP 200, admin 권한 획득**. 길이·엔트로피 검사는
  `TOKEN_PATTERN` 형식 검사와 `length === 0` 거부뿐이다.
- **대조**: 같은 코드베이스가 `PARALLAX_OWNERSHIP_SECRET`은 32바이트를, credential 마스터 키는
  정확히 32바이트를 강제한다. 정작 **API 전체를 여는 자격증명**만 검사가 없다.
- **증폭 요인**: 실패한 인증에 대한 레이트 리밋, 지연, 잠금, 로깅이 전혀 없다. 온라인 브루트포스가
  자유롭다.
- **수정 제안**: 최소 32바이트(base64 기준 43자) 강제 + 인증 실패 카운터 기반 지연/차단 추가.

### S-3. [Medium / 확인됨] TLS 종료 프록시 뒤에서 쿠키 인증 변경 요청이 전부 403이 된다

- **위치**: `src/http/api.ts:24`, `src/security/http-authorization.ts:103-111`
- **원인**: `createNodeHandler`가 origin을 `` `http://${request.headers.host}` ``로 **스킴 하드코딩**해
  재구성한다. `hasSameOrigin()`은 브라우저가 보낸 `Origin: https://...`와 이 `http://...`를 비교하므로
  스킴 불일치로 항상 실패한다. `X-Forwarded-Proto` 처리나 신뢰 프록시 설정이 없다.
- **검증**: 동일 호스트에 `Origin: https://127.0.0.1:39118`로 쿠키 인증 POST → **403**,
  `Origin: http://...`이면 201.
- **영향**: 그 자체는 fail-closed(취약점 아님)지만, HTTPS 배포 시 쿠키 인증 경로가 완전히 죽는다.
  운영자가 이를 "버그"로 인식하고 CSRF 게이트를 우회·비활성화하도록 압박하는 구조다. 덧붙여
  서버는 쿠키를 **발급하지 않으므로**(포털은 Bearer만 사용) `Secure`/`SameSite`/`HttpOnly` 속성이
  정의된 곳이 없다. 쿠키 인증은 절반만 명세된 상태다.
- **참고**: `docs/handoff.md:92`가 "reverse proxy/TLS 환경의 Secure cookie, Origin 확인"을 남은
  검증 항목으로 명시하고 있다 — 즉 **미검증임을 코덱스도 인지하고 있었다**.
- **수정 제안**: 신뢰 프록시 목록 기반 `X-Forwarded-Proto`/`Forwarded` 처리, 또는 기대 origin을
  환경변수(`PARALLAX_PUBLIC_ORIGIN`)로 명시받기.

### S-4. [Medium / 확인됨] 루프백 바인딩에서 인증이 기본적으로 완전히 꺼지고, 감사 actor가 위조 가능해진다

- **위치**: `src/config.ts:19-23`, `src/security/http-authorization.ts:41`, `src/http/api.ts:59`
- **동작**: `HOST` 기본값이 `127.0.0.1`이고 `PARALLAX_AUTH_TOKENS`가 없으면
  `security.enabled = false` → `authenticate()`가 무조건 `{role:"admin"}`을 반환한다. 이때
  `createAuthorizedHandler`도 건너뛰므로 `x-parallax-actor` 헤더가 **호출자 통제**로 남아
  감사 로그의 행위자를 임의로 위조할 수 있다. (인증이 켜져 있을 때는 `principal.subject`로
  덮어써지는 것을 실제로 확인함 — 이 방어는 정상 동작한다.)
- **영향**: 비루프백 바인딩은 토큰을 강제하므로 직접 노출은 막힌다. 그러나 **로컬 리버스 프록시 뒤에
  두는 것이 표준 프로덕션 패턴**이며, 이 경우 프록시에 도달한 누구나 무인증 admin이 된다. 같은
  호스트의 다른 프로세스/컨테이너 사이드카도 마찬가지다.
- **수정 제안**: 인증 비활성화를 `PARALLAX_ALLOW_UNAUTHENTICATED=true` 같은 **명시적 옵트인**으로
  바꾸고, 기동 시 경고를 출력한다.

### S-5. [Medium / 확인됨] `PARALLAX_ALLOW_LOCAL_PROVIDER`가 루프백에서 기본 활성이라 DNS 게시 실패를 성공으로 보고한다

- **위치**: `src/config.ts:29`, `src/adapters/router.ts:50`
- **동작**: 루프백 바인딩이면 기본값이 `true`가 되어 `FileProviderAdapter`가 라우터의 **fallback**으로
  등록된다. Cloudflare 자격증명이 없는 존도 apply가 로컬 JSON 파일에 기록되고 상태는 `applied`가 된다.
- **영향**: 리버스 프록시 뒤 루프백 배포에서 운영자가 "적용 완료"를 보고도 실제 공개 DNS에는 아무것도
  반영되지 않는다. 장애 대응 중 잘못된 확신을 주는 유형의 결함이다.
- **수정 제안**: 기본값을 `false`로 바꾸고, fallback 사용 시 apply 응답과 `/health/ready`에
  `providerMode: "local-fallback"` 경고를 명시적으로 노출한다 (readiness에는 이미 있음).

### S-6. [Low / 확인됨] 미인증 `/health/ready`가 백엔드 구성을 노출한다

- **위치**: `src/index.ts:85` — `{"status":"ready","storage":"file","providerMode":"local-fallback"}`
- **수정 제안**: 상세 필드는 인증된 요청에만 반환하고, 미인증에는 `{"status":"ready"}`만 반환.

### S-7. [Low / 확인됨] 감사 로그·리비전 조회에 페이지네이션이 없다

- **위치**: `src/http/api.ts:91-94`, `src/application/control-plane.ts:290`,
  `src/infrastructure/postgres.ts:242`, `src/infrastructure/file-state.ts:151`
- **동작**: `GET /audit`는 존의 전체 히스토리를, `GET /revisions`는 모든 스냅샷 전문을 무제한 반환한다.
  파일 백엔드는 변경 1건마다 전체 상태 파일을 다시 직렬화해 쓴다. 리텐션·프루닝 경로가 없다.
- **영향**: 인증된 저권한(viewer) 사용자가 반복 호출로 메모리/CPU를 소모시킬 수 있고, 정상 운영만으로도
  성능이 선형 열화된다.

### S-8. [Low / 확인됨] viewer 권한으로 외부 프로바이더 API 호출을 유발할 수 있다

- **위치**: `src/security/http-authorization.ts:56` (GET은 무조건 허용) → `control-plane.ts:206`
  → Cloudflare `list()`
- **영향**: 최저 권한 역할이 `GET /preview` 반복만으로 Cloudflare API 레이트 리밋을 소진시켜
  실제 apply를 방해할 수 있다.

### S-9. [Low] HSTS 헤더 부재 및 서버 타임아웃 미조정

- **위치**: `src/index.ts:110-115`
- CSP/`X-Frame-Options`/`nosniff`/`Referrer-Policy`는 설정되어 있으나 `Strict-Transport-Security`가 없고,
  `server.requestTimeout`/`headersTimeout`은 Node 기본값에 의존한다(slowloris 완화 미흡).

### S-10. [Info] CoreDNS 존 파일이 0600으로 기록된다

- **위치**: `src/adapters/node-coredns-files.ts:91`
- 별도 사용자로 실행되는 CoreDNS가 파일을 읽지 못한다. 보안상으로는 보수적이지만 배포 시 반드시
  그룹 권한 또는 동일 사용자 구성이 필요하며, 문서화되어 있지 않다.

---

## 4. 검토했으나 문제 없음 (코드로 추적 완료)

| 영역 | 결과 | 근거 |
| --- | --- | --- |
| SQL 인젝션 | 문제 없음 | `src/infrastructure/postgres.ts` 전 쿼리가 `$n` 파라미터 바인딩. 상수 `STATUS_COLUMNS` 외 문자열 결합 없음 |
| 커맨드 인젝션 | 문제 없음 | `child_process`/`exec`/`spawn`/`eval`/`new Function`/`vm` 사용처 0건 |
| 경로 순회 | 문제 없음 | 정적 파일은 고정 Map allowlist. CoreDNS 경로는 `#safePath` + `realpath` 부모 검사 + 심볼릭 링크 거부 |
| SSRF | 문제 없음 | 외부 fetch는 `cloudflare.ts:117` 한 곳뿐, base URL 하드코딩. 사용자 입력은 `encodeURIComponent`된 경로 세그먼트로만 유입. `apiBaseUrl`은 설정으로 노출되지 않음 |
| 역직렬화 | 문제 없음 | JSON only. 읽기 시 `readZone`/`parseState`/`parseDocument`가 스키마 재검증 |
| XSS | 문제 없음 | `public/app.js`의 모든 `innerHTML` 보간이 `escapeHtml()` 경유(`& < > ' "` 이스케이프, 속성 컨텍스트 안전). 인라인 스크립트·핸들러 0건, CSP `script-src 'self'` |
| 프로토타입 오염 | 문제 없음 | 객체 키로 쓰이는 zone/view 이름이 `__proto__`를 만들 수 없는 문자 집합으로 검증됨 |
| 비밀 유출 | 문제 없음 (실측) | CF 토큰 저장 후 `list`/`get` 응답·서버 로그·상태 파일에 평문 0건. 디스크에는 AES-256-GCM 암호문(AAD 포함, nonce 매 저장 재생성), 파일 모드 0600. 오류 메시지는 일반화(`Cloudflare credential test failed`) |
| 타이밍 공격 | 문제 없음 | SHA-256 다이제스트 + `timingSafeEqual`, 매칭 후에도 전체 레코드 순회 |
| ownership 마커 위조 | 문제 없음 | `HMAC-SHA256(secret, target \0 recordId)`, 길이 검사 후 `timingSafeEqual`. 시크릿 32바이트 강제 |
| CSRF | 문제 없음 (실측) | 쿠키 인증 변경 요청은 same-origin 증명 필수. Origin 없음 → 403, `https://evil.example` → 403, 일치 → 201. Bearer 경로는 설계상 면제(정상) |
| RBAC | 문제 없음 (실측) | viewer 생성 403, editor 존 삭제 403, editor credentials 403, credentials는 읽기까지 admin 전용 |
| 낙관적 동시성 | 문제 없음 (실측) | `If-Match: "1"`로 stale 요청 → 409 |
| 요청 본문 크기 제한 | 문제 없음 (실측) | 1.1MB 본문 → 413 |
| PostgreSQL 교착 | 문제 없음 | `AsyncLocalStorage` 기반 `ContextualPgPool`이 apply 잠금 커넥션을 재사용해 풀 고갈 회피. 회귀 테스트 존재 |
| 언매니지드 레코드 삭제 방지 | 문제 없음 | 세 어댑터 모두 `managed === false`면 삭제 거부. 단 S-1 참조(CoreDNS는 "보이는" 레코드에 한함) |

---

## 5. 정확성·기능 결함 (보안 외)

### C-1. [High / 확인됨] 언더스코어로 시작하는 레코드 이름을 거부한다 → DMARC/DKIM/ACME 불가

- **위치**: `src/domain/dns.ts:58` (`DNS_LABEL`), `src/domain/dns.ts:206` (`isValidRecordName`)
- **검증**: `_dmarc`, `_acme-challenge`, `_sip._tcp` 모두
  `name must be @ or a valid relative DNS name`으로 거부. CNAME 대상에 언더스코어가 있어도 거부.
- **영향**: DMARC 정책 레코드, DKIM 셀렉터(`sel._domainkey`), Let's Encrypt DNS-01 챌린지를
  이 컨트롤 플레인으로는 **만들 수 없다**. TXT 지원을 표방하는 DNS 제품에서 치명적인 공백이다
  (RFC 8552 underscored names).
- **수정 제안**: 레코드 소유자 이름과 CNAME 대상에 한해 선행 언더스코어 라벨을 허용한다
  (존 이름에는 계속 금지).

### C-2. [High / 확인됨] `internal`/`external` 이외의 뷰 이름이 저장되면 해당 존의 preview가 영구 500이 된다

- **위치**: `src/domain/dns.ts:70` (`validateViewName`은 임의 식별자 허용) ↔
  `src/adapters/router.ts:56` (`parseTarget`은 internal/external만 허용)
- **검증**:
  ```
  PUT /api/v1/zones/example.com/views/staging/records/www-a  → 200, revision 2로 저장됨
  GET /api/v1/zones/example.com/preview                      → 500 {"error":"internal_error"}
  POST /api/v1/zones/example.com/apply                       → staging: state=failed, "provider operation failed"
  ```
- **영향**: 쓰기는 성공하는데 그 존의 preview가 통째로 죽는다(포털의 Preview/Apply 버튼 전면 마비).
  복구하려면 API로 뷰를 제거해야 하는데, 포털에는 그 경로가 없다. 오류 메시지도 원인을 전혀
  알려주지 않는다.
- **수정 제안**: `validateViewName`을 `internal`/`external`로 제한하거나, 라우팅 불가 뷰를
  쓰기 시점에 400으로 거부한다. 최소한 preview의 라우팅 실패는 500이 아니라 4xx로 매핑한다.

### C-3. [Medium / 확인됨] 모든 `TypeError`가 HTTP 400 "invalid provider credential"로 매핑된다

- **위치**: `src/http/api.ts:165`
- **영향**: 요청 처리 경로 어디서든 발생한 실제 프로그래밍 버그(`undefined` 프로퍼티 접근 등)가
  클라이언트에는 검증 오류로 보고되고 500으로 드러나지 않는다. 운영 중 버그가 은폐된다.
- **수정 제안**: credential 검증 실패는 전용 에러 클래스로 던지고, `TypeError`는 500으로 되돌린다.

### C-4. [Medium / 확인됨] 경로의 잘못된 퍼센트 인코딩이 500을 유발한다

- **위치**: `src/http/api.ts:53` — `segments.map(decodeURIComponent)`가 `URIError`를 던지고
  `errorResponse`가 이를 잡지 못해 `internal_error`로 떨어진다.
- **검증**: `GET /api/v1/zones/%zz` → 500 (기대: 400 또는 404)

### C-5. [Low / 확인됨] proxied 레코드는 잘못된 TTL을 조용히 받아들인다

- **위치**: `src/domain/dns.ts:107-114`
- `{proxied:true, ttl:-5}` 및 `{proxied:true, ttl:3.7}` → 검증 통과, `ttl:1`로 강제 변환.
  결과는 안전하나 잘못된 입력이 오류 없이 통과한다.

### C-6. [Low / 확인됨] 유효한 API 경로에 대한 `HEAD` 요청이 404를 반환한다

- **위치**: `src/http/api.ts:61` 이하 — 라우터가 `GET`만 매칭. `authorize()`는 HEAD를 허용하므로
  인가 계층과 라우팅 계층의 의미가 어긋난다.

### C-7. [Low] 죽은 코드: `ControlPlane.#findView`

- **위치**: `src/application/control-plane.ts:344-348` — 모듈 레벨 `findView`(541행)가 사용되며
  이 private 메서드는 호출되지 않는다.

### C-8. [Low] `FileStateRepository`는 rename 전에 `fsync`를 하지 않는다

- **위치**: `src/infrastructure/file-state.ts:208-219`
- 같은 리포의 `file-provider.ts`와 `credential-store.ts`는 `handle.sync()`를 호출한다.
  README의 "atomic writes"는 rename 원자성 측면에서는 참이지만 전원 손실 내구성은 보장하지 않는다.
  세 구현의 내구성 수준이 불일치한다.

### C-9. [Low] 로컬 파일 프로바이더는 언매니지드 레코드를 표현할 수 없다

- **위치**: `src/infrastructure/file-provider.ts:108` — `parseProviderRecord`가 `managed !== true`를 거부
- 개발 환경에서 충돌(conflict)·채택(adoption) 경로를 아예 테스트할 수 없어, 로컬 검증이 실제
  프로바이더 대비 낙관적으로 편향된다.

### C-10. [Info] 존 삭제 시 프로바이더의 관리 레코드가 고아로 남는다

- **위치**: `src/application/control-plane.ts:74-99` — 존/리비전/상태만 제거하고 프로바이더는 건드리지 않음
- 포털 문구에 "관리 중인 프로바이더 레코드는 자동 삭제되지 않습니다"로 고지되어 의도된 동작이었지만,
  삭제 후 그 레코드들은 컨트롤 플레인이 더 이상 추적하지 않는 상태로 남는다. 목록·드리프트 비교·상태
  화면 어디에도 나타나지 않으면서 Cloudflare/CoreDNS에서는 계속 응답한다.
- **정정**: 최초 리포트에 "정리 경로가 전혀 없다"고 적었으나 정확하지 않다. 같은 이름으로 존을 다시
  만들고 빈 `external`/`internal` 뷰를 명시 선언한 뒤 apply하면 회수된다(실측 확인). 다만 이 절차는
  문서화되어 있지 않았고 포털 UI로는 불가능했다.
- **조치**: 삭제가 기본적으로 관리 레코드를 회수하도록 변경했다. 8절 참고.

---

## 6. 문서 주장 vs 실제 구현 대조표

| 주장 (출처) | 판정 | 근거 |
| --- | --- | --- |
| "API tokens are write-only: list and metadata responses contain only zone, zone ID, and update time" (README) | **확인됨** | 실제 저장 후 `list`/`get` 응답·로그·상태 파일 어디에도 평문 토큰 없음 |
| "Encrypted ... credential management" (README) | **확인됨** | AES-256-GCM + AAD + 저장마다 새 nonce, 파일 모드 0600 |
| "preview never mutates a provider" (README) | **확인됨** | `preview`는 `provider.list`만 호출 |
| "Desired state is stored before provider changes" (README) | **확인됨** | `apply`가 저장된 존을 다시 읽어 계획 수립 |
| "Deterministic managed-only reconciliation that leaves foreign records alone" (README) | **부분적 — S-1 참조** | 삭제 방어는 실재하나, CoreDNS에서 대다수 기존 레코드를 인식하지 못해 중복 RRset을 생성 |
| "Existing non-Parallax records and authority data are retained" (README) | **부분적 — S-1 참조** | 보존은 되지만 충돌 탐지가 우회됨 |
| "Durable single-node JSON state ... with atomic writes" (README) | **부분적 — C-8 참조** | rename은 원자적이나 상태 파일은 fsync 없음 |
| "admin/editor/viewer RBAC, Bearer/cookie 인증, CSRF·본문 크기·보안 헤더 방어" (handoff.md:25) | **확인됨** | RBAC·CSRF·413·보안 헤더 모두 실측 통과. 단 쿠키 경로는 S-3 |
| "reverse proxy/TLS 환경의 Secure cookie, Origin ... 확인" 필요 (handoff.md:92) | **미검증 항목이 실제 결함으로 확인됨** | S-3 |

---

## 7. 우선 조치 권고

1. **S-1 / C-1 / C-2** — DNS 정확성에 직접 영향. 릴리스 전 필수.
2. **S-2** — 토큰 최소 강도 + 인증 레이트 리밋.
3. **S-4 / S-5** — 기본값을 안전한 쪽으로 뒤집고(인증 옵트아웃 명시화, 로컬 프로바이더 기본 off),
   리버스 프록시 배포 가이드를 문서화.
4. **S-3** — `X-Forwarded-Proto` 또는 `PARALLAX_PUBLIC_ORIGIN` 도입 후 HTTPS 환경 재검증.
5. **C-3 / C-4** — 오류 매핑 정리(버그 은폐 제거).

## 8. 조치 결과

기준선: `pnpm check` 통과, `pnpm test` **157/157** 통과(감사 전 144건 + 신규 회귀 테스트 13건),
`pnpm build` 통과. 각 항목은 로컬 서버를 기동해 실제 HTTP/파일 시스템으로 재검증했습니다.

| 항목 | 조치 | 주요 변경 |
| --- | --- | --- |
| S-1 | 수정 | `$TTL` 상속·소유자 상속·선택적 class·괄호 다중 행을 파싱하고, **읽을 수 없는 레코드 줄은 오류로 fail-closed**. 재현 시나리오가 중복 추가 대신 `conflict`로 바뀜 |
| S-2 | 수정 | 토큰 최소 32바이트 강제(기동 시 검증) + 실패 전용 카운터 기반 `429`/`Retry-After`. 유효 토큰은 절대 지연·차단되지 않음 |
| S-3 | 수정 | `PARALLAX_PUBLIC_ORIGIN` / `PARALLAX_TRUST_FORWARDED_HEADERS` 도입. `https` Origin 쿠키 변경 요청 201, 악성 Origin 403 확인 |
| S-4 | 수정 | actor를 항상 보안 계층이 소유(인증 비활성 시 `authentication-disabled`). 인증 비활성 상태에서 프록시 전달 헤더가 붙은 API 요청은 401. 기동 시 경고 출력 |
| S-5 | 수정 | 프로바이더가 하나라도 설정되면 로컬 폴백 기본값이 `false`. 폴백 활성 시 기동 경고 |
| S-6 | 수정 | `/health/ready`의 storage/providerMode는 인증된 호출자에게만 반환 |
| S-7 | 수정 | history/revisions에 `limit`(최대 500, 기본 50)/`offset` 페이징과 `hasMore`. 감사 로그는 최신순으로 변경(포털 "최근 변경"이 실제로 최신을 표시) |
| S-8 | 수정 | preview는 프로바이더를 조회하므로 editor 이상 필요. viewer preview 403, viewer status 200 확인 |
| S-9 | 수정 | HSTS 헤더 추가, `headersTimeout`/`requestTimeout`/`keepAliveTimeout` 설정 |
| S-10 | 수정 | CoreDNS 존 파일 모드를 `0644`로 변경(존 데이터는 공개 정보) |
| C-1 | 수정 | RFC 8552 언더스코어 라벨 허용. `_dmarc`, `_acme-challenge`, `sel._domainkey` 생성 가능 |
| C-2 | 수정 | `validateViewName`을 `internal`/`external`로 제한(쓰기 시 400). 기존 스냅샷은 계속 읽히되 프로바이더로 전달되지 않음. 라우팅 실패는 `ProviderNotConfiguredError` → 409 |
| C-3 | 수정 | 전역 `TypeError` → 400 매핑 제거. 전용 `CredentialValidationError`만 400 |
| C-4 | 수정 | 경로 퍼센트 디코딩 실패를 400으로 매핑 |
| C-5 | 수정 | proxied 레코드도 TTL을 먼저 검증한 뒤 Auto로 정규화 |
| C-6 | 수정 | HEAD를 GET과 동일하게 라우팅하고 본문 없이 `content-length`만 응답 |
| C-7 | 수정 | 죽은 `ControlPlane#findView` 제거 |
| C-8 | 수정 | 상태 파일도 `fsync` + 디렉터리 `fsync` 후 rename |
| C-9 | 수정 | 파일 프로바이더가 언매니지드 레코드를 표현 가능. 언매니지드 수정도 거부 |
| C-10 | 수정 | 존 삭제가 게시된 관리 레코드를 프로바이더에서 회수한 뒤 상태를 제거합니다. 회수를 **먼저** 수행하므로 프로바이더 실패 시 존이 남아 재시도 가능하고, 소유권 마커가 없는 레코드는 건드리지 않습니다. 응답에 `removedProviderRecords`를 반환하며, `?abandonProviderRecords=true`로 명시적 옵트아웃 가능. apply와 동일한 존 잠금을 사용 |

부수적으로 정적 파일 경로가 `process.cwd()` 대신 모듈 위치 기준으로 해석되도록 바꿔,
임의의 작업 디렉터리에서 실행해도 포털이 서빙됩니다.

### 동작이 바뀌는 항목

기존 배포가 있다면 롤아웃 전에 확인이 필요합니다.

- 32바이트 미만 토큰과 빈 `PARALLAX_AUTH_TOKENS` 배열은 기동 실패
- 감사 로그 정렬이 최신순으로 반전
- viewer는 preview 불가(editor 이상 필요)
- 프로바이더를 설정하면 로컬 폴백이 자동으로 비활성
- `internal`/`external` 외의 뷰 이름은 쓰기 거부
- proxied 레코드도 TTL을 먼저 검증(`ttl: 0` 같은 값은 이제 400)
- `DELETE /zones/:zone`이 204 대신 200 + `removedProviderRecords` 본문을 반환하고,
  프로바이더의 관리 레코드를 실제로 삭제

### 문서 갱신

`README.md`, `README.ko.md`, `.env.example`에 리버스 프록시/TLS 배포 절차, 토큰 강도 요건,
페이징 계약, 뷰 제한, CoreDNS 파싱 범위와 파일 모드를 반영했습니다.

## 9. 후속 조치

감사 항목을 닫은 뒤 남아 있던 다섯 가지를 처리했다. 기준선은 `pnpm check` 통과,
`pnpm test` **170/170** 통과, `pnpm build` 통과이며, 아래 통합 검증은 실제 컨테이너를
상대로 실행한 결과다.

### 9.1 쿠키 인증의 발급 경로 (S-3 잔여분)

검증 경로만 있고 발급 주체가 없어 `Secure`/`HttpOnly`/`SameSite`를 정하는 곳이 없었다.
`POST /api/v1/session`이 토큰을 받아 `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`
쿠키를 발급하고(HTTPS 요청이면 `Secure` 추가), `DELETE /api/v1/session`이 지운다. 두
경로 모두 same-origin 증명을 요구한다. 포털은 토큰을 메모리에 두지 않고 이 쿠키를
쓰므로 XSS가 자격 증명을 읽을 수 없게 됐고, 로그아웃 버튼이 생겼다. same-origin 증명은
`Origin` 외에 `Sec-Fetch-Site: same-origin`도 인정한다.

실측: 로그인 200 + 쿠키 발급 → 쿠키로 GET 200 → Origin 있는 POST 201 →
`Sec-Fetch-Site` POST 201 → 교차 출처 POST 403 → 로그아웃 204 + `Max-Age=0` →
이후 GET 401 → 위조 쿠키 401.

### 9.2 감사·리비전 리텐션 (S-7 잔여분)

페이징은 응답만 제한했고 저장은 무한히 증가했다. `PARALLAX_REVISION_RETENTION`(기본
100)과 `PARALLAX_AUDIT_RETENTION_DAYS`(기본 365)를 도입해, 변경을 기록하는 것과 **같은
원자적 커밋 안에서** 존 단위로 정리한다. `0`은 무제한이다. 파일·인메모리·PostgreSQL
세 저장소 모두 구현했다. 보관 범위를 벗어난 리비전 복원은 404가 되므로, 필요한 롤백
범위에 맞춰 값을 정해야 한다.

실측: 리비전 상한 3으로 6회 변경 후 보관된 리비전 `[4, 5, 6]`, 현재 리비전은 항상 유지.
실제 PostgreSQL에서도 `parallax_zone_revisions` 행이 3으로 고정됨을 확인했다.

### 9.3 PostgreSQL TLS

`pg` 8.22가 연결 문자열의 `sslmode`를 파싱하는 것을 확인했으므로 코드 결함은 아니었다.
다만 기본값이 평문이고 문서화가 없었다. `usesPlaintextPostgres()`를 추가해 TLS를 요구하지
않는 `DATABASE_URL`이면 기동 시 경고를 출력하고, README와 `.env.example`에
`?sslmode=verify-full`을 권장값으로 명시했다(`sslmode=require`는 향후 libpq 호환으로
의미가 바뀐다는 `pg`의 경고 때문에 피한다).

### 9.4 실제 환경 통합 검증

`scripts/`에 재실행 가능한 검증 스크립트를 추가하고 실제로 실행했다.

| 대상 | 스크립트 | 결과 |
| --- | --- | --- |
| PostgreSQL 17 (Docker) | `pnpm verify:postgres` | **통과** — fresh migration, 멱등 재적용, 트랜잭션 커밋(zone/revision/audit = 1/3/3), 재시작 후 상태 복원 및 무드리프트, 동시 apply 6건 직렬화(교착 없음), 리텐션 pruning, 존 삭제 시 FK cascade(0/0/0)와 삭제 감사 보존 |
| CoreDNS 1.12 (Docker + `dig`) | `pnpm verify:coredns` | **통과** — 손으로 관리하던 `$TTL`·소유자 상속 RRset 응답, 그와 충돌하는 목표 레코드가 중복 대신 conflict 1건으로 보고(S-1 실환경 재확인), 적용 레코드와 언더스코어 TXT DNS 응답(C-1 확인), SOA serial 7→9 증가를 reload로 관측, 외부 레코드·권한 데이터 보존, 파일 모드 644(S-10 확인), 철회 시 응답 소멸 |
| Cloudflare | `pnpm verify:cloudflare` | **통과 (`ef61201`, 2026-08-12, 실계정 `tinytools.work`)** — 라이브 존 read, 소유하지 않은 3건 앞에서 삭제 제안 0건, 발행, 드리프트 0(자기 쓰기 왕복), proxied TTL Auto 정규화, 존 삭제 시 회수. 자격 증명이 없으면 건너뛴다. **이 실행이 결함 셋을 찾았다 — 9.8 참조** |

CoreDNS 검증 중 Docker Desktop의 UDP 포워딩이 동작하지 않아 질의는 TCP로 수행한다.
검사 대상 존 데이터는 전송 방식과 무관하므로 검증 가치는 동일하다.

### 9.5 의존성 스캔

`pnpm audit`을 `package.json` 스크립트로 고정했다. 현재 **알려진 취약점 없음**이며 런타임
의존성은 `pg` 하나뿐이다.

### 9.6 여전히 남은 것

- 없다. 마지막 항목이던 Cloudflare 실계정 검증은 9.8에서 통과했다.

~~실제 TLS 종단 프록시 뒤에서의 검증~~ → 9.7에서 실제 nginx로 검증 완료.

### 9.7 리버스 프록시 검증 (`pnpm verify:proxy`)

S-3(프록시 뒤 Origin 재구성 결함)은 회귀 테스트로 고정했지만, 그 결함이 나타나는
조건 자체 — 서버는 루프백에서 평문 HTTP를 보는데 브라우저는 HTTPS를 본다 — 는 단위
테스트로 만들 수 없다. Docker nginx를 TLS 종단으로 세워 실제 구성에서 확인했다.

검사는 **잘못된 상태를 먼저 재현**한다. `publicOrigin`도 `trustForwardedHeaders`도
없을 때 브라우저의 `https` Origin이 403으로 거부되는 것을 확인한 뒤에야 나머지 검사로
넘어간다. 이 단계가 없으면 이후 통과가 공허할 수 있다.

| 확인 | 결과 |
| --- | --- |
| 설정 없이 https Origin → 거부 (결함 재현) | 403 |
| `trustForwardedHeaders=true` 후 로그인·변경 | 200 / 201 |
| 세션 쿠키 속성 | `Secure`, `HttpOnly`, `SameSite=Strict` |
| HSTS | `max-age=` 전송 확인 |
| 미인증 readiness | 상세 정보 없음, 인증 시에만 노출 |
| `publicOrigin`만 설정 (헤더 불신) | 200 / 201 |
| 교차 사이트 Origin + 유효 세션 쿠키 | 403 |

### 9.8 Cloudflare 실계정 검증 (`pnpm verify:cloudflare`, 2026-08-12)

토큰을 쥔 운영자가 실계정(`tinytools.work`)에서 실행했다. **네 번 돌렸고 결함 셋이 나왔다.**

| 회차 | 커밋 | 결과 |
| --- | --- | --- |
| 1 | `849fd2a` | 스크립트 결함 2건 — 자격 증명이 앱에 닿지 않음(죽은 env 변수), 뷰가 없는 존에 `preview?view=` 는 404 |
| 2 | 재구성본 | **소유권 마커 104자 > Cloudflare 주석 상한 100자** → 발행이 전부 HTTP 400 |
| 3 | `6c90779` | **존 삭제가 409** — 파생된 `internal` 뷰의 없는 프로바이더를 조회. 게다가 비원자적 |
| 4 | `ef61201` | **전 단계 통과** |

**앞의 결함이 뒤의 결함을 가리고 있었다.** 1회차가 두 번째 단계에서 죽어 마커까지 가지
못했고, 마커를 고친 뒤에야 존 삭제가 드러났다. 한 번 돌려 통과한 것과 결함이 없는 것은
다르다.

세 결함 모두 **모형으로는 볼 수 없는 것**이었다. 100자 제한은 Cloudflare 쪽 규칙이고
스텁 fetch 는 무엇을 보내든 받는다. 이 검증이 존재하는 이유가 그것이고, 그 근거가 실측으로
확인됐다.

⚠️ 이 항목의 **통과는 `ef61201` 에 대한 것**이다. 이후 커밋에 대한 주장이 아니다 —
이 리포트가 한동안 `verify:coredns` 의 옛 통과를 현재의 주장으로 재사용하고 있었고,
그 사이 그 스크립트는 설정 이관(`3f5f183`)으로 깨져 있었다.

## 10. 범위 밖

- CI/CD 파이프라인, 컨테이너 이미지, 배포 매니페스트: 리포지토리에 존재하지 않음.
- ~~실제 Cloudflare 계정·CoreDNS 프로세스·PostgreSQL 서버를 사용한 운영 환경 통합 검증~~
  → PostgreSQL·CoreDNS·리버스 프록시는 실제 컨테이너로, Cloudflare는 실계정으로 검증 완료(9.8).
- ~~의존성 취약점 스캔~~ → 9.5에서 실시, 알려진 취약점 없음.
