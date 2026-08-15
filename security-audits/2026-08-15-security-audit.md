# Parallax 보안 감사 리포트 — 2026-08-15

> 읽기 전용 감사. 코드·설정은 수정하지 않았고, 이 보고서 파일만 생성했다.
> 실제 `.env`는 열지 않았으며, `pnpm verify:*` 등 실 자원 변경 스크립트는 실행하지 않았다.
> 동적 확인은 폐기 가능한 스크래치패드 스크립트(인메모리 저장소·테스트 더블)로만 수행했다.

---

## 0. 대상 스냅샷 (감사 중 작업 트리가 두 번 바뀜 — 반드시 확인)

감사는 다음 스냅샷에서 시작했다.

```
시작 시각   2026-08-15 14:39 (Asia/Seoul)
브랜치      main
HEAD        92fe76e  docs: say that the internal view is not a resolver
작업 트리    깨끗, 단 미추적: src/dns/, test/dns/
```

**감사 도중 작업 트리와 브랜치가 바뀌었다.** 재확인 로그:

1. 14:40경 — `src/index.ts`, `src/config.ts`, `test/config.test.ts`가 수정되어 `src/dns/**`의 raw DNS 리스너가 런타임(`src/index.ts`)에 배선됨. 정찰 힌트가 말한 "dormant" 상태가 아니게 됨.
2. 이후 — 브랜치가 `main` → `dns-listener`로 전환되고, DNS 관련 변경이 커밋됨.

최종 검토 스냅샷(이 보고서의 기준):

```
종료 시각   2026-08-15 14:47 이후
브랜치      dns-listener
HEAD        1608288  feat(dns): answer the internal view from this process, not only publish it
작업 트리    docs/handoff.md 만 수정됨(문서), 그 외 깨끗
관련 브랜치   backup/pre-rebase-security-audit (리베이스 백업), main(92fe76e)
```

**중대한 함의:** raw DNS 리스너(`src/dns/**`)는 이제 **dormant가 아니라 이 브랜치에 정식 커밋된 기능**이며, 환경변수 `PARALLAX_DNS_PORT`로 옵트인되는 "지원 설정"이다. 따라서 이 코드의 결함을 dormant로 격리하지 않고, `PARALLAX_DNS_PORT`가 설정된 배포에 대한 **운영 도달 취약점**으로 집계한다. `main`(`92fe76e`)만 배포하는 곳에서는 이 표면이 아직 존재하지 않는다는 점을 함께 명시한다.

---

## 1. 정찰 요약

Parallax는 "split-horizon DNS 컨트롤 플레인"이다. 하나의 Node.js 프로세스가 (a) HTTP/HTTPS API + 브라우저 포털, (b) 저장소에 직접 접근하는 관리자 CLI(`cmd/parallax/main.ts`), 그리고 이제 (c) `PARALLAX_DNS_PORT` 설정 시 내부 뷰를 직접 응답하는 raw UDP/TCP DNS 리스너를 제공한다. 모든 조작은 **명령(command) 계층(`src/cli/commands.ts`)에서 단 한 번** 정의되고, HTTP 라우트와 CLI가 같은 디스패처를 호출한다(`src/http/api.ts`, `cmd/parallax/main.ts`). 존의 desired state는 파일(JSON) 또는 PostgreSQL에 저장되며, 실제 게시는 프로바이더 어댑터(Cloudflare API / CoreDNS 존 파일 / PowerDNS DB / 로컬 파일 fallback)를 통해 이뤄진다. 관리 레코드는 HMAC 소유권 마커(`src/adapters/ownership.ts`)로 표시된다.

인증은 네 모드다: (1) 토큰 없음 = 루프백 전용 개방 모드(비루프백 바인딩은 시작 시 거부), (2) Bearer 액세스 토큰(저장은 SHA-256 다이제스트만), (3) 토큰을 교환해 얻는 세션 쿠키(`SameSite=Strict`), (4) 직접 구현된 OIDC 세션(HMAC 서명 self-contained 쿠키, `SameSite=Lax`). 역할은 viewer/editor/admin이고, HTTP 게이트(`authorize()`)와 명령 게이트(`runCommand`의 `satisfiesRole`)가 이중으로 검사한다. `POST /api/v1/cli`는 게이트에서 모든 역할에 열려 있으나 각 명령이 자체 최소 역할을 재검사한다 — 이 재검사를 코드로 추적해 통과함을 확인했다.

정찰 시 문서·주석·테스트 이름의 보안 주장("안전", "원자적", "fail-closed", "5초 내 폐기", "never read at runtime", "not writable")을 모두 검증 대상 클레임으로 다뤘고, 다수가 실제 구현과 어긋남을 확인했다(특히 파일 백엔드 토큰 폐기, CoreDNS 존 파일 파서, Dockerfile의 마이그레이션 디렉터리 주장). 의존성은 런타임 `pg@8.22.0` 하나(전이 트리 포함)와 devDependency(typescript, @types/node)뿐으로 공급망 표면이 매우 작다.

---

## 2. 신뢰 경계와 민감 자산

**신뢰 경계**

- 네트워크 ↔ HTTP API/포털: 토큰/세션/OIDC로 게이트. 인증 비활성(루프백) 모드에서는 프록시 헤더가 있는 `/api/*` 요청을 시작 시가 아니라 요청 시점에 거부.
- 네트워크 ↔ DNS 리스너(`PARALLAX_DNS_PORT`): **인증 없음**. 소스 ACL·레이트리밋 없음. 신뢰 경계가 사실상 "포트에 도달 가능한 누구나".
- HTTP admin ↔ OS/파일시스템: admin API 주체는 셸 권한이 없어야 정상이지만, `coreDnsDirectory` 설정과 `migrate` 명령이 이 경계를 넘는다(§H/M 참조).
- CLI(프로세스 uid 10001) ↔ 실행 중 서버: 같은 저장소 파일을 공유하지만 파일 백엔드는 프로세스 간 락이 없다.
- 신뢰 프록시 ↔ 클라이언트: `trustForwardedHeaders`/`publicOrigin`으로 origin 재구성.

**민감 자산**

액세스 토큰(다이제스트), OIDC 클라이언트 시크릿·세션 시크릿, Cloudflare API 토큰(AES-256-GCM 봉인), credential master key, ownership HMAC secret, TLS 개인키, DB 자격증명, DNS desired state와 감사 기록, 그리고 DNS 리스너가 관장하는 내부 뷰 응답 자체.

---

## 3. 배포/설정 매트릭스

| 인증 | TLS/프록시 | 저장소 | DNS 프로바이더 | DNS 리스너 | 공격자 위치 | 상태 | 주요 노출 표면 |
|---|---|---|---|---|---|---|---|
| 토큰 없음 | 직접 HTTP | 파일 | 로컬 fallback | off | 루프백 로컬 | 개발 기본 | 로컬 프로세스만 |
| Bearer/세션 | 직접 TLS | 파일 | CoreDNS | off | 네트워크 | 지원 | H1·H2·H3·H4, CoreDNS 어댑터 결함군 |
| Bearer/OIDC | 리버스 프록시 TLS | PostgreSQL | Cloudflare+PowerDNS | off | 네트워크(+다중 replica) | 지원(운영형) | H3·H4·M3·M4·M14·M16 |
| Bearer/OIDC | 직접/프록시 TLS | 파일 또는 PG | CoreDNS/PowerDNS | **on(`PARALLAX_DNS_PORT`)** | 네트워크 | 지원(dns-listener 브랜치) | **H5·M1·M2** + 위 전부 |
| Docker 기본 | 0.0.0.0:3000, uid 10001 | 환경 의존 | 환경 의존 | off(기본) | 네트워크 | 이미지 기본 | 비루프백+토큰 필수(시작 시 강제) |

- Docker 이미지는 `0.0.0.0:3000`에 바인딩하고 uid/gid 10001로 실행함을 `Dockerfile`에서 코드로 재확인. 비루프백+토큰 없음은 `src/index.ts` 시작 시 거부됨(코드 확인).
- `allowLocalProvider`는 기본 **off**(`settings.ts` 기본값), `dns` 리스너는 `PARALLAX_DNS_PORT` 없으면 미바인드, DNS forwardTo 기본 빈 배열(빈 배열은 REFUSED).

---

## 4. 도달 가능 vs dormant 구분

- **운영 도달**: 기본 배포 또는 명시적으로 지원되는 설정(비밀·프록시·프로바이더·DNS 포트 등을 켠 상태)에서 공격자 통제 입력이 싱크에 도달함. §5.
- **통합 전/조건부 잠재 위험(dormant)**: 익스플로잇에 선행 쓰기 권한(저장소 DB row 직접 쓰기, CoreDNS 디렉터리 로컬 쓰기, 프로바이더 측 쓰기)이나 기본 off 옵트인이 필요해 현재 배포에서 스스로 성립하지 않음. §6.
- DNS 리스너 코드는 **더 이상 dormant가 아니다**(§0). `PARALLAX_DNS_PORT` 옵트인 시 운영 도달로 집계.

---

## 5. 운영 도달 발견 사항

### 심각도 High

---

#### H1. CoreDNS 존 파일에 `record.content`가 escape 없이 기록되어 editor가 임의 레코드를 주입한다
- **심각도:** High (CoreDNS `$INCLUDE`가 처리되면 Critical 가능 — 아래 Suspected)
- **위치:** `src/adapters/coredns-file.ts:284-289`(`formatRecord`), 게이트 `src/domain/dns.ts:181-236`(`validateRecordContent`)
- **도달성:** 지원 설정(CoreDNS 내부 퍼블리셔 = `coreDnsDirectory` 설정 + ownership secret)
- **공격자·전제:** 최소 쓰기 역할인 **editor** 토큰/세션 하나. 프로바이더 접근·레이스 불필요.
- **데이터 흐름:** `POST /api/v1/zones/{z}/views/{v}/records` 본문 `content` → `createDesiredRecord`(`dns.ts:263`) → `validateRecordContent` → 저장 → `apply` → `CoreDnsFileAdapter.apply` → `formatRecord`가 `content`를 존 파일 한 줄에 **그대로** 보간(`${name} ${ttl} IN ${type} ${content} ; ${marker}`). `content.split(/\s+/u)`에서 `\n`은 공백으로 취급되고, SVCB/HTTPS/NAPTR/URI/CAA/HINFO는 앞쪽 필드/따옴표 개수만 검사(예: HTTPS `fields.length>=2`)하므로 개행 포함 값이 검증을 통과한다. TXT만 `quoteDnsText`로 escape된다.
- **기존·보완 통제와 불충분 이유:** `validateRecordContent`가 유일 게이트인데 위 6개 타입의 tail을 제약하지 않고 제어문자/개행을 거르지 않는다. `formatRecord`는 TXT 외 escape가 없다. Cloudflare는 서버가 거부, PowerDNS는 컬럼값으로 저장하므로 **CoreDNS 전용** 결함이다.
- **증거(안전 재현, 스크래치패드):** 두 개 에이전트와 감사자가 독립 재현. 입력 `{name:"svc", type:"HTTPS", content:"1 . alpn=h2\n@ 60 IN A 6.6.6.6", ttl:300}` → 존 파일에
  ```
  svc 300 IN HTTPS 1 . alpn=h2
  @ 60 IN A 6.6.6.6 ; parallax-managed:v3:<id>:<sig>
  ```
  즉 운영자가 선언한 적 없는 **apex A 레코드**가 게시됨. 주입된 줄이 뒤따르는 소유권 마커까지 상속해 `managed`로, 원본은 `unmanaged`로 재분류됨(→ H2와 결합해 영구 conflict).
- **확신도:** 확인됨(코드 추적 + 실행 재현).
- **Suspected 확대:** `content:"1 .\n$INCLUDE /etc/passwd"`도 HTTPS 검증을 통과하며, 줄 선두 `$INCLUDE`는 Parallax 파서는 무시하지만(`coredns-file.ts:83-87`) miekg/dns 기반 CoreDNS `file` 플러그인은 처리할 수 있어 임의 파일 포함/정보노출/DoS로 확대될 수 있다. 실 CoreDNS 대상 검증은 안전 제약으로 미수행 → **Suspected**.
- **수정 제안:** `formatRecord`에서 `\r\n;"()` 포함 content를 거부/escape하고, `validateRecordContent`에 모든 타입 공통으로 `if (/[ -;]/u.test(content)) return "…"`를 추가. 회귀 테스트: 개행/세미콜론/`$INCLUDE`/`$ORIGIN` 포함 SVCB·HTTPS·CAA·NAPTR·URI·HINFO가 거부되는지.

---

#### H2. 소유권 마커를 디코이로 무력화해 관리 레코드를 disown시키고 존 내부 뷰를 영구 브릭한다
- **심각도:** High
- **위치:** `src/adapters/ownership.ts:67-71`(`readVersion3`, `.exec` 첫 매치만 검사), 동일 형태 `:79-90`(`readVersion2`)
- **도달성:** CoreDNS에서는 H1을 통해 editor로 기본 도달; Cloudflare에서는 레코드 comment 편집 권한 필요(지원 설정)
- **공격자·전제:** CoreDNS는 editor 하나(H1). 코멘트에 `parallax-managed:v3:<임의id>:<잘못된서명>`을 먼저 넣고 실제 마커가 뒤에 오게 만들면 됨.
- **데이터 흐름:** `readOwnershipComment` → `readVersion3`가 `new RegExp(...).exec(comment)`로 **첫 번째** 마커 형태 토큰만 뽑고, 그 서명이 불일치하면 뒤의 유효 마커를 보지 않고 `undefined` 반환 → 레코드가 `managed:false`로 분류 → `buildReconcilePlan`이 `conflict` 반환 → `ControlPlane.#apply`(`control-plane.ts:471`)가 해당 뷰에 대해 **매 apply마다 `ConflictError`**를 던지고, `coredns-file.ts:53`은 unmanaged 삭제를 거부하므로 레코드를 제거할 수도 없다. 단일 API 호출로 존 내부 뷰가 영구 정지.
- **기존·보완 통제와 불충분 이유:** HMAC 자체는 건전(`timingSafeEqual`, target 바인딩). 결함은 "첫 후보가 나쁘면 마커 없음으로 처리"하는 파싱 로직.
- **증거:** 실행 재현 — 디코이+유효 마커 문자열이 `undefined`를 반환하고, 후속 apply/preview/status가 모두 실패.
- **확신도:** 확인됨(코드 추적 + 재현).
- **수정 제안:** `matchAll(/g)`로 모든 매치를 순회해 **하나라도** 검증되면 수용. V2도 동일 적용. 회귀: 디코이 접두 + 유효 마커가 여전히 관리 레코드로 인식되는지.

---

#### H3. 파일 백엔드(기본)에서 토큰 폐기가 실제로 폐기되지 않는다 — 설정 문서가 프로세스 수명 내내 캐시됨
- **심각도:** High (폐기 후 인증 우회)
- **위치:** `src/infrastructure/file-settings.ts:73-85`(`#load`: `if (this.#document) return this.#document;`), `:55`(`accessTokens.list`); 갱신 루프 `src/application/access-tokens.ts:71-78`; 배선 `src/index.ts:32-34`, `src/runtime.ts:57`
- **도달성:** 기본(파일 백엔드 = `DATABASE_URL` 미설정)
- **공격자·전제:** 운영자가 대역 외로 폐기한 토큰의 보유자. `kubectl exec`/컨테이너 내 CLI로 폐기하는 것은 이미지가 명시적으로 지원하는 워크플로(`Dockerfile:1-4`).
- **데이터 흐름:** `AccessTokenService.startRefreshing`이 5초마다 `repository.list()` 호출 → 파일 백엔드는 `(await this.#load()).accessTokens` → `#load()`가 캐시된 `#document`를 즉시 반환하고 **파일을 다시 읽지 않음**. `#document`는 `#mutate`(같은 프로세스 내 쓰기)만 갱신하므로, **다른 프로세스**(CLI, 다른 replica)의 폐기/발급이 디스크에 기록되어도 실행 중 서버는 영원히 못 본다. 프로세스당 인스턴스는 1개(`runtime.ts:57`)라 캐시는 프로세스 수명. 즉 폐기된 토큰이 재시작 전까지 계속 통용되고, 새 토큰은 절대 인식되지 않는다.
- **부수 효과(같은 근본원인):** 서버의 다음 설정 쓰기는 stale 캐시로 파일을 재작성(`file-settings.ts:89 structuredClone(await this.#load())`)하므로, CLI로 한 폐기가 디스크에서 되살아나고 CLI로 발급한 토큰이 삭제된다.
- **기존·보완 통제와 불충분 이유:** `access-tokens.ts:56-70`이 바로 이 위협("a revocation that does not revoke")을 설명하고 5초 폴링을 대책으로 문서화하지만, 파일 리포지토리가 영속 인메모리 캐시라 대책이 무효다. PostgreSQL 리포지토리는 매번 재질의(`postgres.ts:429-451`)하므로 이 결함은 파일 백엔드 한정. **문서-구현 불일치.**
- **증거:** 실행 재현 — 두 번째 `FileConfigurationStore`가 파일에서 토큰을 폐기해도, 첫 인스턴스는 `load()` 후에도 폐기된 다이제스트를 계속 반환.
- **확신도:** 확인됨(코드 추적 + 재현 + 감사자 직접 재확인).
- **수정 제안:** `#load` 읽기 경로에서 mtime 체크 또는 무조건 재읽기(쓰기 직렬화 `#writeTail`은 유지), 또는 `accessTokens.list()`가 캐시를 우회하도록. 프로세스 간 파일 락도 함께 도입. 회귀: 외부 프로세스 폐기 후 ≤5초 내 서버가 401을 반환하는지.

---

#### H4. 마지막 admin 토큰 동시/교차-replica 폐기가 last-admin 보호를 깨고 런타임 인증을 꺼버린다
- **심각도:** High
- **위치:** `src/application/access-tokens.ts:132-146`(`revoke`, `#remainingAdmins`), `:156-158`(`enabled`); 소비 `src/security/http-authorization.ts:83`,`:162-167`; `src/http/api.ts:316-319`; 시작 전용 가드 `src/index.ts:27-30`
- **도달성:** 기본(스토어 발급 토큰만 쓰고 `PARALLAX_AUTH_TOKENS` break-glass가 없는 배포)
- **공격자·전제:** admin 주체가 겹치는 `DELETE /api/v1/tokens/{id}` 두 건을 보내거나(같은 프로세스), 다중 replica에서 5초 이내 서로 다른 replica에 도달하는 순차 폐기. 성사 후에는 **미인증 네트워크 호출자**가 공격자.
- **데이터 흐름:** `revoke()`가 캐시 `#stored` 대상 `find`+`#remainingAdmins()`를 **동기**로 검사한 뒤 `await repository.delete(id)`. 두 폐기가 서로의 admin을 아직 보므로 둘 다 가드를 통과·삭제. 이후 `load()`가 `#security`를 `digests: []`로 재구성 → `enabled = bootstrap>0 || digests>0` = **false**. `createAuthorizedHandler`는 요청마다 설정을 재해석(`http-authorization.ts:162`)하므로 즉시 `!config.enabled` 분기 → 모든 요청이 `authentication-disabled`로 통과, `authenticate()`가 `{role:"admin"}` 반환. 비루프백 개방을 막는 가드(`index.ts:27-30`)는 **시작 시점 전용**이라 런타임 전이에 재평가되지 않는다(프록시 헤더가 없는 직접 호출은 `index.ts:145` 거부도 우회).
- **결과:** 잔여 토큰이 있으면 admin 잠금(가용성), admin 토큰이 유일 토큰이면 **인증 완전 비활성화(우회)**.
- **기존·보완 통제와 불충분 이유:** last-admin 검사는 존재하나 가변 캐시 배열에 대한 check-then-act이고 사이에 `await`가 있으며, replica 간에는 최대 5초 stale이라 인프로세스 락으로도 못 막는다.
- **증거:** 실행 재현 — 순차 폐기는 거부되지만 `Promise.allSettled([revoke(a),revoke(b)])`는 둘 다 fulfilled이고 `{enabled:false, tokensLeft:0}`을 남김.
- **확신도:** 확인됨(재현).
- **수정 제안:** 불변식을 스토어에서 원자화(`DELETE ... WHERE role<>'admin' OR (SELECT count(*) ... role='admin')>1`을 트랜잭션/`FOR UPDATE` 안에서), `revoke`가 가드 전에 재`load()`. 독립적으로 `enabled`를 sticky하게 — 한 번이라도 토큰을 본 프로세스는 런타임에 개방 모드로 되돌아가지 않도록(개방은 시작 전용 상태로 한정).

---

#### H5. DNS forwarder가 임의 출처의 UDP 응답을 검증 없이 수락한다 → 응답 위조/캐시 포이즌
- **심각도:** High
- **위치:** `src/dns/server.ts:212-231`(`forward`), 배선 `src/index.ts`(dns 블록, `forwardTo: dnsConfig.forwardTo`)
- **도달성:** 지원 설정(dns-listener 브랜치) — `PARALLAX_DNS_PORT` + `PARALLAX_DNS_FORWARD_TO` 설정 시
- **공격자·전제:** 온패스 공격자는 자명하게 성사. 오프패스 공격자는 프로세스의 임시 UDP 소스 포트로 위조 응답을 주입(정품 upstream보다 먼저 도착).
- **데이터 흐름:** `forward()`가 `createSocket("udp4")`로 **connect하지 않은** 소켓을 만들고 `socket.once("message", ...)`로 **먼저 도착한 데이터그램**을 수락. 소스 IP/포트 검증 없음(unconnected 소켓은 커널이 소스를 필터링하지 않음), 트랜잭션 ID·question tuple·QR/opcode 재검증 없음. 받은 바이트를 그대로 클라이언트에 중계. 첫 응답을 받으면 소켓을 닫으므로, 위조 패킷이 정품 응답을 밀어낼 수 있다.
- **기존·보완 통제와 불충분 이유:** 인바운드 파서는 malformed 패킷에 무응답이라 스푸핑된 소스가 증폭할 게 없다는 커밋 주장은 인바운드에만 해당. **아웃바운드 위조 응답 수락에는 어떤 방어도 없다.** 클라이언트가 자체 TXID를 검사하므로 완전 포이즌은 클라이언트 TXID+포트(32비트) 추정이 필요하지만, connect 미사용으로 오프패스가 최소한 정품 응답을 위조로 대체(해석 거부/서비스 거부)할 수 있고, 온패스는 완전 포이즌.
- **증거:** 코드 추적 확인(`forward`가 `.connect()` 미호출, `rinfo`/응답 내용 미검사). 실 리졸버 대상 엔드투엔드 포이즌 재현은 안전 제약으로 미수행 → 영향 판정은 코드 기반.
- **확신도:** 확인됨(코드) / 엔드투엔드 영향은 부분 재현.
- **수정 제안:** upstream별로 소켓을 `connect()`하여 커널이 소스를 필터링하게 하고, 응답의 TXID·question이 질의와 일치하는지 검증한 뒤에만 수용. 회귀: 다른 소스/틀린 TXID의 응답이 거부되는지.

---

#### H6. 뷰 제거 후 무관한 2차 변경이 있으면 프로바이더 레코드가 영구 고아로 남는다(dangling DNS)
- **심각도:** High (integrity / dangling-DNS·takeover 노출)
- **위치:** `src/application/control-plane.ts:456-463`(`removedPendingViews`), `:533-537`(`status` 필터)
- **도달성:** 기본 배포, 레이스 불필요
- **공격자·전제:** editor 또는 단순 운영 실수. apply 전 두 번의 desired-state 변경.
- **데이터 흐름:** `replaceDesiredState`로 `external` 뷰를 제거 → 리비전 N의 pending 상태 기록. 이어 `internal`에 대한 `upsertRecord`(2차 변경)는 `external`을 `affectedViews`에 넣지 않아 그 상태는 N에 머무는데 `zone.revision`은 N+1이 됨. `#apply`가 `status.desiredRevision === zone.revision`(`:460`)을 요구하므로 `external`은 `removedPendingViews`에서 제외 → **끝까지 철회되지 않음**. `status()`도 같은 등식(`:535`)이라 그 뷰가 목록에서 사라짐.
- **증거:** 실행 재현 — 제거+2차 변경 후 status는 internal만, apply는 internal만 applied, external 레코드(`www=1.2.3.4`)는 계속 라이브. 단일 변경만 하면 정상 철회됨.
- **확신도:** 확인됨(재현).
- **수정 제안:** 제거 뷰를 `desiredRevision` 등식이 아니라 "desired에 없고 `appliedRevision>0`/`lastAttemptAt` 있음"으로 도출하고, 매 커밋마다 제거 뷰의 pending 상태를 carry-forward. 회귀: 뷰 제거 후 무관한 편집→apply가 그 뷰를 철회하는지.

---

#### H7. `adoptProviderRecords`가 파생 internal 뷰를 검증하지 않아 존을 영구 브릭한다
- **심각도:** High (가용성/무결성)
- **위치:** `src/application/control-plane.ts:331-363` — adopt는 `materializeProviderViews`를 호출하지 않는 유일한 변경 경로
- **도달성:** 기본 배포, 역할 editor(`cli/commands.ts:223-225`)
- **공격자·전제:** editor 하나. external `CNAME`을, internal에 다른 타입 오버라이드가 있는 이름에 adopt.
- **데이터 흐름:** adopt는 adopt 대상 뷰의 `ensureUniqueRecordKeys`만 검사(`:358`)하고 파생 internal 뷰를 검증하지 않아 커밋이 성공. 이후 매 호출이 internal 뷰를 재도출하며 "CNAME record ... cannot coexist"로 throw → `preview/apply/status/upsertRecord/deleteRecord/restoreRevision`가 모두 실패. 복구는 admin의 `zone replace`/`zone delete` 필요.
- **증거:** 실행 재현 — adopt 성공 후 preview/apply/status/편집이 전부 throw.
- **확신도:** 확인됨(재현).
- **수정 제안:** 다른 경로와 동일하게 `#adoptProviderRecords`에서 `#nextRevision` 전에 `materializeProviderViews(views)` 호출.

---

### 심각도 Medium

아래는 모두 코드 추적(다수는 실행 재현)으로 확인됨. 공통 필드를 압축해 제시한다.

| # | 제목 | 위치 | 도달성 | 데이터 흐름·영향(요약) | 확신도 |
|---|---|---|---|---|---|
| M1 | DNS 오픈 포워딩 리졸버 + 소스 ACL·응답 레이트리밋 부재 → reflection/amplification·오픈리졸버 남용 | `dns/server.ts:65-84,116-128` | 지원(`PARALLAX_DNS_FORWARD_TO`+비루프백 바인드) | forwardTo 설정 + 비루프백 바인드 시 임의 소스가 재귀 질의·증폭 반사에 악용. ACL/RRL 전무 | 확인됨(코드) |
| M2 | DNS TCP 리스너 타임아웃·연결 상한 부재(+UDP 무제한 forward 소켓) → slowloris/자원고갈 | `dns/server.ts:94-115,212-231` | 지원(`PARALLAX_DNS_PORT`) | HTTP 서버는 timeout 설정하나 DNS TCP는 `setTimeout`/`maxConnections`/idle 마감 전무. length-prefixed 프레임을 천천히 보내 소켓 무기한 점유. UDP는 질의마다 소켓+타이머 생성, 상한 없음; 순차 upstream 타임아웃이 단일 질의 점유시간을 배가 | 확인됨(코드) |
| M3 | apply 상태가 동시 desired 변경에 밀려 `lastAttemptAt` 소실 → `deleteZone`이 고아 생성, 감사엔 `removed:0`으로 허위 기록 | `control-plane.ts:214-218,488`, `postgres.ts:624-639` | 지원(PG 다중 replica) | desired 변경은 advisory 락/인프로세스 큐를 잡지 않아 replica B의 커밋이 replica A의 apply 상태를 `desired_revision<=` 가드로 폐기→ purge 대상이 `lastAttemptAt`로만 선택돼 뷰 스킵→ 레코드 라이브인데 감사는 0 | 확인됨(재현) |
| M4 | 세션 락 보유 중 중첩 pool.connect로 존 삭제가 풀 전체 데드락 | `postgres.ts:316-318,332,175`, `control-plane.ts:153` | 기본(PG) | `withZoneLock`이 raw pool에서 C1 확보 후 콜백 내 `commitZoneDeletion`이 다시 `connect()`(ALS 우회)로 C2 요구. `max=10`·`connectionTimeoutMillis` 미설정(무한 대기)이라 서로 다른 존 10건 동시 삭제 시 전 프로세스 질의가 영구 대기 | 확인됨(코드+pg 기본값 확인) |
| M5 | CoreDNS 파서가 `$INCLUDE`/`$GENERATE`/미지 타입 토큰을 조용히 "레코드 없음"으로 처리(fail-open) → 중복 RRset 생성 | `coredns-file.ts:83-87,94` | 지원(운영자 작성 존 파일) | 파서 docstring은 "이해 못하는 줄은 에러"라 하나 세 경로가 무음 스킵. reconcile가 그 이름을 못 봐 `create`를 계획→ CoreDNS가 이미 응답하는 answer 옆에 두 번째 값 추가 | 확인됨(재현), 문서-구현 불일치 |
| M6 | 파일 중간 `$ORIGIN`을 파싱만 하고 버려 레코드가 잘못된 이름으로 게시됨 | `coredns-file.ts:83-87,391-396` | 지원 | `$ORIGIN sub.example.com.` 이후 레코드를 타깃 존 기준으로 상대화→ Parallax는 `web.example.com`으로 보고, CoreDNS는 `web.sub.example.com`으로 서빙. apply는 파일 끝에 append하므로 후행 `$ORIGIN` 존재 시 모든 신규 게시가 오염 | 확인됨(재현) |
| M7 | CoreDNS `providerId`가 레코드 id 기반이라 비유일 → update/delete가 잘못된 줄을 건드림 | `coredns-file.ts:108,55-58` | 지원 | 같은 id 마커가 두 줄이면 `.find()` 첫 매치만 선택. 한 줄 삭제 요청이 다른 줄을 삭제 | 확인됨(재현) |
| M8 | 괄호 다중행 레코드의 update/delete가 시작 줄만 처리해 파일 손상 | `coredns-file.ts:57-58` vs `129-159` | 지원 | `lineIndex`는 시작 줄만 기록→ 연속 줄이 고아로 남아 다음 `list()`가 throw, 뷰가 영구 정지(손상 파일은 이미 기록·리로드됨) | 확인됨(재현) |
| M9 | 프로바이더 변경(생성/수정/**삭제**)이 감사 트레일에 전혀 기록되지 않음 | `dns.ts:77-85`, `control-plane.ts:466-525` | 기본 | `AUDIT_ACTIONS`에 apply 액션 없음. `#purgeProviderRecords`가 뷰 A 철회 후 뷰 B에서 throw하면 프로바이더에서 레코드가 파괴됐는데 감사 엔트리 없음 — 흔적은 HTTP 에러뿐. 주석의 "read-before-write" 주장은 list 실패만 보호 | 확인됨, 문서-구현 불일치 |
| M10 | 부분 apply 진행도(`completed/planned`)가 응답 1회에만 존재하고 영속화되지 않음 | `control-plane.ts:473-521`, `ports.ts:126-134`, `migrations/001` | 기본 | 해당 컬럼이 스키마에 없어 `saveStatus`가 버림. 이후 `GET /status`는 진행도 없이 `failed`, `appliedRevision`은 이전값 → 반쯤 게시된 뷰가 "미적용"처럼 보임. 롤백 없음 | 확인됨, 문서-구현 불일치 |
| M11 | `abandonProviderRecords`가 프로바이더 전체에 대해 all-or-nothing | `control-plane.ts:148-246`, `api.ts:207-213` | 기본(admin) | 한 프로바이더가 도달 불가(예: Cloudflare 바인딩 삭제로 `ProviderNotConfiguredError`)라 플래그를 켜면 건강한 PowerDNS/CoreDNS 레코드까지 추적정보 없이 버려짐 | 확인됨(코드 추적) |
| M12 | `settings.update`가 리스너 실행 전에 영속화 → PowerDNS 배포에서 `coreDnsDirectory` 설정이 시작을 영구 차단 | `settings.ts:99-103`, `runtime.ts:117-123` | 지원(`PARALLAX_POWERDNS_DATABASE_URL`) | verifier는 쓰기가능성만 검사하고, publisher 충돌 규칙은 리스너에 있어 값이 durable해진 뒤 throw. 이후 모든 `createRuntime`이 `process.exit(1)` → 수동 편집 없인 복구 불가 | 확인됨(코드 추적) |
| M13 | `coreDnsDirectory`가 쓰기가능성만 검증되는 admin-설정 임의 쓰기 루트(HTTP admin→파일시스템 경계 이월) | `settings.ts:119,151-156`, `runtime.ts:69-72,206-210`, `node-coredns-files.ts` | 지원(ownership secret 필요) | admin API 주체(셸 없음)가 임의 디렉터리를 루트로 지정→ 서비스 사용자로 `<zone>.zone`(mode 0644)을 씀. verifier는 `access(W_OK)`만 검사. `#safePath`/심링크 검사는 루트 **내부**만 보호 | 확인됨(코드 추적) |
| M14 | `EncryptedCredentialStore`가 복호화 상태를 영구 캐시 → 삭제/회전된 Cloudflare 자격증명이 다른 replica에서 계속 유효 | `credential-store.ts:282-283` | 지원(다중 replica) | H3와 같은 근본원인(문서 캐시 무효화 부재)이나 갱신 타이머조차 없음. replica A에서 프로필 삭제 후 replica B가 평문 토큰으로 계속 어댑터 등록·apply | 확인됨(재현) |
| M15 | `migrate`가 HTTP로 도달 가능해 서빙용 DB 롤에 DDL 권한 필요(최소권한 불가) | `runtime.ts:144`, `api.ts:146-157`, `cli/commands.ts:353-362` | 기본(PG) | admin 토큰이 `POST /api/v1/cli {"argv":["migrate"]}`로 서빙 풀에 DDL 실행. 상시 롤이 CREATE/ALTER/DROP 보유해야 함 → admin 토큰 유출이 스키마 파괴로 확대 | 확인됨(코드 추적) |
| M16 | 상향 탐색으로 찾은 디렉터리의 모든 `.sql`을 그대로 실행하며, 그 디렉터리는 이미지에서 런타임 사용자 쓰기가능 | `migrations.ts:38-65`, `Dockerfile:40` | 지원 | `Dockerfile:38-39`은 "never read at runtime", `:49-50`은 "not writable"이라 주장하나 `runtime.ts:144`+`migrations.ts:49`가 런타임에 읽고 `--chown=parallax`로 쓰기가능. uid 10001로 파일을 심고 `migrate`하면 임의 SQL 실행 | 확인됨(코드+Dockerfile), 문서-구현 불일치 |
| M17 | PostgreSQL TLS가 권고에 그치고, 비-URL 접속문자열에는 경고조차 fail-open | `config.ts:191-201`(`usesPlaintextPostgres`), `index.ts:315-317`, `postgres.ts:47-51` | 기본 | 어떤 호출부도 `ssl` 옵션을 설정하지 않아 TLS는 전적으로 URL의 `sslmode`에 의존. cleartext URL은 `console.warn` 후 그대로 기동. `usesPlaintextPostgres`는 URL 파싱 실패 시 `false`(경고 억제) — libpq keyword 문자열에서 무음 | 확인됨(코드 추적) |
| M18 | 파일 상태 파일이 요소 검증 없이 수용됨 | `file-state.ts:295-310` | 기본(파일 백엔드) | `version===1`과 상위 컨테이너 타입만 검사, 개별 zone/status/audit/revision 미검증. 공유/복원/사이드카로 상태 파일을 쓰면 위조 감사·`applied` 상태·malformed 존이 API/reconcile로 유입. PG 백엔드는 `readZone` 등으로 재검증하나 파일 백엔드는 등가물 없음 | 확인됨(코드 추적) |
| M19 | 파일 백엔드 whole-file 캐시로 CLI+서버 동시 사용 시 무음 데이터 소실 | `file-state.ts:178-202`, `file-settings.ts:73-97`, `file-provider.ts:64-82` | 기본 | H3와 같은 근본원인. CLI가 전체 파일을 rename하는 동안 서버는 시작 스냅샷을 들고 있다가 다음 mutate에서 stale 클론으로 파일을 재작성→ CLI 변경(존·리비전·감사) 소실. 프로세스 간 락 없음 | 확인됨(코드 추적) |

---

### 심각도 Low

| # | 제목 | 위치 | 도달성 | 요약 | 확신도 |
|---|---|---|---|---|---|
| L1 | `FailureThrottle`가 프로세스 전역이며 성공 시 리셋 → per-client 격리 없고, 유효 토큰 보유자에게 추측 제한이 무의미 | `http-authorization.ts:144,297-325` | 기본 | 단일 전역 카운터. `recordSuccess`가 카운터를 0으로 리셋하므로 유효 토큰 하나를 사이에 끼우면 제한이 트리거되지 않음. 429는 모든 후보 비교를 끝낸 뒤 응답코드만 바꿈. 토큰 엔트로피(256비트)가 실질 방어라 Low | 확인됨 |
| L2 | 유효하지 않은 `Authorization` 헤더가 있어도 OIDC identity 쿠키로 fallback(엄격 fail-closed 불변식 이탈) | `http-authorization.ts:376-414` | 지원(OIDC) | 잘못된/malformed Bearer가 있어도 `authenticateWithPreparedTokens`가 identity 쿠키로 폴백. same-origin 검사는 `Authorization` 존재 시 건너뜀. 단 세션쿠키 `SameSite=Strict`/identity `Lax` + CORS로 CSRF는 실질 차단, 권한상승 없음 → Low | 확인됨, 불변식 이탈 |
| L3 | HTTP 리다이렉트 리스너의 Host 반영 리다이렉트 | `index.ts:285-302` | 지원(`PARALLAX_HTTP_REDIRECT_PORT`) | `publicOrigin` 미설정 시 클라이언트 Host로 `https://<host><path>` 리다이렉트. 브라우저 항법에서는 Host가 실제 호스트라 고전적 오픈리다이렉트는 아니나, 비브라우저/프록시가 Host를 위조하면 반영 | 확인됨 |
| L4 | 토큰 갱신 fail-open에 상한 없음 → 스토어 장애 동안 폐기 토큰 계속 통용 | `access-tokens.ts:71-78` | 기본 | 의도된 트레이드오프이나 무한. 장애를 유발할 수 있는 공격자는 자신의 접근을 연장. `/health/ready`에 staleness 노출 권장 | 확인됨 |
| L5 | `revoke()`가 이미 삭제한 토큰에 실패를 보고 | `access-tokens.ts:138-140` | 기본 | delete 성공 후 `load()`가 throw하면 500 → 운영자가 재시도 시 404, 그 사이 폐기 토큰은 계속 통용 | 확인됨 |
| L6 | `MIN_TOKEN_BYTES`가 엔트로피가 아니라 인코딩 길이를 측정(환경 토큰) | `http-authorization.ts:41,363`, `config.ts:171-173` | 지원(`PARALLAX_AUTH_TOKENS`) | `"a".repeat(32)`가 break-glass admin으로 수용됨. 발급 토큰은 `randomBytes(32)`라 안전 | 확인됨 |
| L7 | `publicOrigin`/`trustForwardedHeaders`가 same-origin·`Secure` 결정의 admin-설정 입력 | `settings.ts:165-178`, `api.ts:98-114` | 지원 | TLS 배포에서 `http://` origin 설정 시 `Secure` 탈락, 무관 origin 설정 시 CSRF 증거 약화. `SameSite=Strict`가 실질 방어라 Low. `SettingsAdvisor` 경고 권장 | 확인됨 |
| L8 | 설정 디렉터리 0700이 기존 디렉터리엔 적용 안 됨(+기본적으로 항상 기존) | `file-settings.ts:101` vs `file-state.ts:219`,`file-provider.ts:152` | 기본 | 파일 자체는 0600이라 내용은 보호, 디렉터리 나열/메타만 유출 | 확인됨 |
| L9 | `file-settings`가 다른 두 백엔드가 하는 디렉터리 fsync 누락 | `file-settings.ts:99-116` | 기본(파일) | rename은 원자적이나 디렉터리 엔트리 미플러시 → 전원 장애 시 방금 발급/폐기가 조용히 되돌아갈 수 있음(토큰 다이제스트·봉인 자격증명 파일) | 확인됨 |
| L10 | `GET /api/v1/zones`가 페이지네이션 없음 | `control-plane.ts:124-126`, `postgres.ts:60-65` | 기본, viewer | history/audit는 클램프되나 존 목록은 전량 로드. 파일 백엔드는 존당 2회 `structuredClone` | 확인됨 |
| L11 | 큰 `auditRetentionDays`가 모든 쓰기 경로를 `RangeError`로 정지 | `control-plane.ts:119`, `settings.ts:158-163` | 지원(admin) | `readCount`가 2^53까지 허용→ `new Date(...).toISOString()`이 throw, 이후 모든 존 변경 500. 잘못된 값이 먼저 영속화돼 재시작에도 잔존 | 확인됨 |
| L12 | 마이그레이션 실패 시 advisory unlock이 aborted-tx로 실패, 연결 파기로만 해제; 버전 테이블 없음 | `migrations.ts:60-79` | PG | 락은 결국 해제되나 코드가 믿는 방식이 아님. 부분 적용이 미적용과 구분 불가. `release()`가 try 내부라 원본 에러 마스킹 가능 | 확인됨 |
| L13 | PowerDNS `UPDATE`가 `auth` 재계산·`ordername` 설정을 하지 않음 | `powerdns.ts:85-89` | 기본(PowerDNS) | apex↔서브 NS 전환 시 stale `auth`. 어댑터 자체 주석이 경고하는 실패("서명하는 날까지 안 보임")와 불일치 | 확인됨, 문서-구현 불일치 |
| L14 | PowerDNS 변경이 `domain_id`로 스코프되지 않음 + `asId` 문자열 분기의 safe-integer 미검사 | `powerdns.ts:82,86,215-222` | 기본(PowerDNS) | 소유권 검증이 있어 현재 악용 불가하나 행 스코프 가드가 무료. BIGINT>2^53이 부정확 number로 왕복 | 확인됨(방어심화) |
| L15 | `node-coredns-files` 임시파일/디렉터리 fsync 부재(내구성) | `node-coredns-files.ts:89-102` | 기본 | rename-원자적이나 fsync 없어 전원 장애 시 0바이트/절단 존 파일 가능 — 내부 이름 해석 중단 | 확인됨 |
| L16 | rename 이후 실패 시 인메모리 상태가 디스크와 어긋남 | `file-state.ts:217-242,178-188` | 기본 | rename 성공+디렉터리 sync throw 시 `#state` 미갱신 → 디스크 N+1, 메모리 N, 다음 변경이 조용히 되돌림 | 확인됨 |

---

## 6. 통합 전/조건부 잠재 위험 (dormant — 운영 심각도 집계와 분리)

익스플로잇에 선행 쓰기 권한이나 기본 off 옵트인이 필요해 현재 배포에서 스스로 성립하지 않는 항목. **아래는 §7의 심각도별 개수에 포함하지 않는다.**

| # | 제목 | 위치 | 전제(왜 dormant인가) | 잠재 심각도 | 확신도 |
|---|---|---|---|---|---|
| D1 | 봉인 자격증명 문서에 롤백/리플레이 바인딩 없음(상수 AAD) | `credential-store.ts:9,316-344` | 스토어(DB row/설정 파일) 직접 쓰기 필요. 그때 이전 유효 봉인문서로 교체해 삭제 프로필/미회전 토큰을 복원 가능 | Low | 확인됨(코드) |
| D2 | CoreDNS 읽기 경로 심링크 TOCTOU | `node-coredns-files.ts:24-34,69-82` | CoreDNS 존 디렉터리 로컬 쓰기 필요(이미 고권한). `lstat` 후 `readFile` 사이 스왑으로 임의 파일 읽기가 preview에 노출. 쓰기 경로는 안전 | Low | 확인됨(코드) |
| D3 | unmanaged 레코드가 desired와 정확히 일치하면 Parallax가 자신의 managed 레코드를 삭제 | `reconciliation.ts:52-68` | 프로바이더 측 쓰기 필요. 공격자가 desired와 동일한 unmanaged 사본을 선점하면 Parallax가 자기 관리 레코드를 지우고 공격자 레코드에 영구 위임 | Low(방어심화) | 확인됨(코드) |
| D4 | 설정 키의 프로토타입 setter 싱크 | `postgres.ts:367-369` | `parallax_settings`에 `__proto__` 키를 DB 직접 쓰기해야 함. HTTP는 `readPatch` 화이트리스트로 도달 불가 | Info | 확인됨(코드) |
| D5 | fallback 프로바이더가 바인딩 해제된 존을 흡수 | `router.ts:64-67`, `runtime.ts:110-112` | `allowLocalProvider` 기본 off. 켜면 바인딩 삭제된 존이 로컬 JSON에 기록되며 apply가 `applied` 보고 | Low | 확인됨(코드) |

---

## 7. 심각도별 개수

**운영 도달(기본/지원 설정):**

| 심각도 | 개수 |
|---|---|
| Critical | 0 |
| High | 7 (H1–H7) |
| Medium | 19 (M1–M19) |
| Low | 16 (L1–L16) |

- High 중 H5·(M1·M2)는 `PARALLAX_DNS_PORT` 옵트인(dns-listener 브랜치)에 한정. `main`(92fe76e)만 배포하는 곳에는 H5·M1·M2가 존재하지 않는다.
- H3·H4·M14·M19 등은 특정 백엔드/토폴로지(파일 백엔드 또는 다중 replica)에 조건적임을 각 항목에 명시.

**Dormant(통합 전 잠재 위험):**

| 심각도 | 개수 |
|---|---|
| Low | 3 (D1·D2·D3·D5) |
| Info | 1 (D4) |

**Informational(운영/도달 무관 관찰):**

- I1. Advisory 락 키가 마이그레이션과 apply에서 salt-1 네임스페이스를 공유(현재는 `normalizeZoneName`이 `:`를 거부해 우연히 분리). 마이그레이션에 salt 2 사용 권장. `hashtextextended`는 비암호 64비트 해시라 충돌은 과잉락(안전측). `postgres.ts:336,342`, `migrations.ts:60,70`.
- I2. Cloudflare가 무효 토큰에도 403을 반환해 "Zone Read 권한 없음"으로 오보고(정보 유출 아님, 표시상). `cloudflare.ts:194-198`.

---

## 8. 이전 감사(2026-08-10)의 회귀 검증

이전 보고서를 증거가 아닌 회귀 체크리스트로만 사용해 현재 커밋(`1608288`)에서 재검증했다.

| 항목 | 이전 | 현재 상태(코드 재검증) |
|---|---|---|
| S-1 CoreDNS `$TTL` 기본값 레코드 RRset 오염 | High/수정됨 | `$TTL` 상속 레코드는 이제 처리됨. **그러나** `$INCLUDE`/`$GENERATE`/미지 타입 토큰은 여전히 fail-open(→ **M5**). 클래스 미완결 |
| S-2 토큰 강도/레이트리밋 | Medium | `MIN_TOKEN_BYTES=32`+`FailureThrottle` 추가. 다만 throttle 전역·성공시 리셋(**L1**), 길이≠엔트로피(**L6**). 개선되었으나 약함 |
| S-3 프록시 뒤 쿠키 인증 403 | Medium | `requestOrigin`/`publicOrigin`/`trustForwardedHeaders`로 해결(확인). 단 이 값들이 admin-설정 입력이 됨(**L7**) |
| S-4 루프백 인증 off + actor 위조 | Medium | actor는 `withActor`가 `x-parallax-actor`를 덮어써 보안소유(확인). 프록시 요청 시작 거부(확인). **그러나 H4가 런타임에 `enabled=false`로 전이시키는 새 경로를 제공** |
| S-5 `allowLocalProvider` 기본 on | Medium | 기본 off로 변경됨(확인) |
| S-6 미인증 `/health/ready` 노출 | Low | `isAuthenticated` 게이트로 백엔드/프로바이더 정보 은닉(확인) |
| S-7 페이지네이션 부재 | Low | history/audit/revisions는 클램프. **`listZones`는 여전히 무페이지(**L10**)** |
| S-8 viewer가 프로바이더 API 유발 | Low | preview가 editor 레벨로 승격(확인) |
| S-9 HSTS/타임아웃 | Low | HTTP는 `setSecurityHeaders`+서버 타임아웃(확인). **새 DNS TCP 리스너엔 타임아웃 전무(**M2**) — 신규 표면에서 회귀** |
| S-10 CoreDNS 파일 0600 | Info | 이제 0644(CoreDNS 읽기용, 의도적) |

이전 보고서의 "남은 항목 없음"과 과거 통합 테스트 통과는 현재 커밋의 증거가 아니며, OIDC(`05bb3e1`,`48dba47`)와 `src/dns/**`(`1608288`)는 이전 감사 이후 추가된 신규 표면으로 별도 취급했다.

---

## 9. 검토했으나 문제 없음(코드 경로 확인)

- **DNS 와이어 리드(적대적 입력):** `readName`은 압축 포인터가 반드시 뒤로만 이동(`wire.ts:140`)해 루프 차단, 255바이트/라벨 길이/예약비트 검사. `readQuery`는 questionCount=1·응답비트 거부. malformed 패킷은 무응답. rdata 인코더는 도메인 검증을 통과한 저장 content만 다룸(적대적 와이어 입력 아님).
- **소유권 마커 암호화:** `sign = HMAC(secret, target ‖ NUL ‖ recordId)`, `timingSafeEqual`+길이검사, secret 32바이트 강제. target 바인딩으로 다른 존/뷰 복사 시 검증 실패(단 첫-매치-only 결함은 **H2**).
- **프로바이더 변경 전 소유권 재검증:** Cloudflare는 PATCH/DELETE 직전 `GET`으로 재검증(+providerId·managed 확인), PowerDNS는 같은 트랜잭션 내 재검증, CoreDNS는 파일 재파싱 후 재검증(단 providerId 비유일 **M7**).
- **PowerDNS SQL 인젝션:** 24개 문 전부 `$n` 바인딩, 부수 테이블은 `ON DELETE CASCADE`로 일관.
- **AES-256-GCM:** `#persist`마다 새 `randomBytes(12)` nonce, 16바이트 태그, 양측 AAD, 키 32바이트 강제. 태그 불일치 시 `Buffer.concat` 표현식 내에서 throw되어 부분 평문 미노출(fail-closed), 실패 모드가 단일 불투명 에러라 오라클 없음.
- **비밀 미유출:** 모든 `console.*` 확인 — 토큰/다이제스트/키 미출력. Cloudflare 전송 에러는 `redact()`로 토큰/`Bearer` 제거, API 에러는 상태/코드만. `control-plane`은 프로바이더 텍스트를 `"provider operation failed"`로 대체.
- **읽기 경로에 비밀 없음:** 액세스 토큰 `list()`는 메타데이터만, credential `listProfiles/getProfile/test`는 token 미포함. 발급 토큰은 1회·`no-store`.
- **명령/HTTP 인가 계층화:** `credentials/settings/tokens`는 읽기 포함 admin 전용(HTTP 게이트) + 각 명령 자체 `role:"admin"` 재검사. `/api/v1/cli` 패스스루가 권한을 상승시키지 못함. 최종 RBAC 주체와 `x-parallax-actor`가 일치.
- **CoreDNS 경로 traversal:** `router.ts` 라벨 정규식 + `#safePath`로 `..`/NUL 차단. 쓰기는 temp+`O_EXCL`+rename로 심링크 안전(읽기 TOCTOU는 **D2**).
- **파일 쓰기 원자성:** 세 백엔드 모두 create-exclusive temp + fsync + atomic rename, 0600. 쓰기 직렬화(`#writeTail`)는 실패를 흡수해 큐가 막히지 않음.
- **PostgreSQL 트랜잭션/락 위생:** `PostgresApplyLock`은 세션 스코프 advisory 락을 전용 클라이언트로 잡고 ALS로 중첩 질의를 같은 세션에 태우며, unlock 실패 시 클라이언트를 파기(풀 오염 방지). 낙관적 동시성은 `FOR UPDATE`+리비전 비교+23505 매핑으로 보장.
- **리텐션 프루닝:** 세 백엔드가 "최신 N 리비전 유지 + 해당 존 오래된 감사만 삭제"로 일치, 변경과 같은 트랜잭션 내 실행. `0`은 전체 유지.
- **설정 입력 처리:** 미지 키 거부(프로토타입 오염 포함 `unknown setting`), 화이트리스트 키만 반영, `readCount`는 `Number.isSafeInteger`+비음수, `readText`는 제어문자 거부(단 상한 미설정 **L11**).
- **포털 XSS:** `public/**`의 20개 `innerHTML` 싱크 전수 추적 — 서버/레코드 유래 문자열은 전부 `escapeHtml` 통과, URL 유래 텍스트는 `textContent`. `eval`/`Function`/문자열 타이머 없음, `javascript:`/`data:` URL 구성 없음. CSP(`script-src 'self'`, `unsafe-inline` 없음)+`nosniff`+`frame-ancestors 'none'`로 방어심화. (경미: `?signin_error=`가 인증 박스에 `textContent`로 표시돼 피싱 텍스트 심기 가능 — 스크립트 실행 아님, Low 하드닝.)
- **의존성:** 런타임 `pg@8.22.0` 하나(+전이 트리). scanner 없이 lockfile의 resolved 버전 확인 — 알려진 심각 advisory 해당 없음. 스캐너 단독 finding 없음.

---

## 10. 검증되지 않은 주장(추가 확인 필요)

- H1의 `$INCLUDE` 확대: 배포된 실제 CoreDNS `file` 플러그인이 존 파일 내 `$INCLUDE`를 실제로 처리하는지 미검증(안전 제약). miekg/dns 기본은 지원하나 CoreDNS 빌드에서 비활성일 수 있음.
- H5의 엔드투엔드 캐시 포이즌: 실 리졸버 대상 스푸핑 재현은 미수행. 오프패스 성공 확률은 클라이언트 TXID+임시포트 추정에 의존(코드상 온패스는 자명).
- M1의 amplification 계수(응답/질의 비)는 측정하지 않음.
- README/`docs/handoff.md`의 "실제 클러스터 배포"·다중 replica 운영 형태는 문서/메모리 기반 추정이며 직접 검증하지 않음(다중-replica 조건 항목의 도달성은 이 가정에 의존).
- PostgreSQL/PowerDNS 실 연결의 TLS·최소권한 실태는 미검증(정적 코드로만 M15·M17 판정).

---

## 11. 범위와 미검토

**검토 범위:** 서비스 진입점(`index.ts`,`runtime.ts`), CLI(`cmd/**`,`cli/**`), HTTP/API(`http/**`), 인증·OIDC·세션(`security/**`), DNS 제어면(`application/**`,`domain/**`,`adapters/**`), 저장소(`infrastructure/**`), raw DNS(`dns/**`), 포털(`public/**`), 마이그레이션·Dockerfile·ignore 규칙, 의존성 lockfile.

**미검토/부분 검토:** `scripts/verify-*.sh`는 내용을 읽지 않고 실행도 하지 않음(안전 제약). `test/**`는 주장 근거가 아니므로 보안 로직 확인 용도로만 참조. 실 프로바이더(Cloudflare/PowerDNS)의 서버측 검증 동작은 코드 밖이라 미검토.

---

## 12. 안전 제약으로 수행하지 않은 동적 검증

- `pnpm verify:cloudflare|coredns|powerdns|postgres|proxy|integration` 일절 미실행.
- 실제 `.env`·실 Cloudflare 계정·운영 DNS·운영 DB 미접촉.
- DNS 리스너를 실제로 바인드해 실 리졸버 대상 스푸핑/amplification/오픈리졸버 검증 미수행.
- CoreDNS `$INCLUDE`/`$GENERATE` 실 처리 검증 미수행.
- 동적 확인은 전부 스크래치패드의 인메모리 저장소·테스트 더블로만 수행했고, 외부 계정·운영 자원을 변경하지 않았다. 스크래치 스크립트는 세션 스크래치패드에 있으며 리포지토리 파일은 수정하지 않았다.

---

### 우선 조치 권고(요약)

1. **H3/H4**: 파일 백엔드 캐시 무효화(재읽기/파일락)와 `enabled` sticky화, last-admin 불변식의 스토어측 원자화 — 인증 보증의 근간.
2. **H1/H2**: `formatRecord`·`validateRecordContent`의 개행/`;`/`$directive` 차단, 소유권 마커 `matchAll` 순회 — CoreDNS 배포의 무결성.
3. **H5/M1/M2**: DNS forwarder 소켓 `connect()`+응답 검증, 소스 ACL/RRL, TCP 타임아웃·연결상한 — dns-listener 병합 전 필수.
4. **H6/H7/M3**: 제거 뷰 철회 도출을 `desiredRevision` 등식에서 분리, adopt의 internal 뷰 검증, apply 상태의 `lastAttemptAt` 보존.
5. **M15/M16**: `migrate`를 서빙 런타임에서 제거하고 마이그레이션 디렉터리를 root 소유·읽기전용으로.
