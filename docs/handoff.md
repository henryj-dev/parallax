# Parallax 작업 핸드오프

마지막 갱신: 2026-08-23 (Asia/Seoul) · 대상 커밋 `1303d46`

## 현재 상태

Parallax는 내부 DNS와 Cloudflare DNS의 desired state를 한곳에서 관리하는 TypeScript
애플리케이션이다. **구현이 끝났고, 실제 클러스터에 배포되어 돌고 있다.**

```
테스트          770/770 · tsc 통과 · build 통과 · 포털 타입 검사 통과
CI              check · scripts · docker · codeql · dependency-review (전부 통과)
실제 의존성      PostgreSQL 17 · nginx TLS 종단 · Cloudflare 실계정
배포            컨테이너 이미지, read-only 루트, uid 10001, initContainer 로 스키마 적용
```

⚠️ **첫 줄과 둘째 줄만 `1303d46` 에서 돌린 것이다.** 셋째 줄의 실제 의존성 대상 검증은
그보다 앞선 시점의 통과이고, 그중 어느 커밋이었는지를 기록해 둔 것은 Cloudflare 한
건뿐이다 — 나머지는 통과했다는 사실만 남아 있고 어느 시점인지는 남아 있지 않다. 이
문서는 한때 `verify:coredns` 의 옛 통과를 현재의 주장으로 재사용하고 있었고, 그 사이
그 스크립트는 설정 이관으로 **깨져 있었다**. 그 뒤 CoreDNS 자체가 빠졌다 — 아래 참조.

**2026-08-16, `1db6f25`: CoreDNS 와 PowerDNS 퍼블리셔가 제거됐다.** 내부 뷰는 이제
내장 DNS 리스너가 desired state 에서 바로 응답한다. `scripts/verify-coredns.sh` 와
`pnpm verify:coredns` 도 같이 사라졌다. 이 문서는 그 뒤로 일주일간 없는 어댑터와 없는
스크립트를 현재형으로 적고 있었다 — 지워진 것을 지우는 일이 남은 것을 고치는 일보다
늦게 눈에 띈다는 예시로 남긴다.

**2026-08-23: 저장소가 공개됐다.** `henryj-dev/parallax`. CI 다섯 워크플로,
Dependabot, CodeQL, secret scanning 이 붙었고 커뮤니티 문서가 생겼다.

`1608288` 에서 내장 DNS 리스너가 추가됐다. 프로바이더 경로는 건드리지 않았지만
`src/config.ts` 와 `src/index.ts` 는 바뀌었으므로, 배포 전에 `verify:proxy` 와
`verify:postgres` 는 다시 돌리는 것이 맞다.

## 하나의 표면, 세 진입로 (그리고 네 번째 포트)

모든 조작은 명령(command)으로 **한 번만** 정의된다. 동작을 가진 곳은 그곳뿐이다.

```
포털(GUI)  ──HTTP──▶  API  ──▶  명령 계층  ──▶  컨트롤 플레인
터미널(CLI) ─────────────────▶  명령 계층  ──▶  컨트롤 플레인
```

- 포털은 `public/api-client.js`(HTTP만) → `store.js`(상태·플로우) → `app.js`(그리기)
  세 층이고 의존 방향은 한쪽뿐이다. 뷰는 네트워크를 부르지 않고, 스토어는 DOM 을 모른다.
- `POST /api/v1/cli` 가 전용 라우트 없는 조작을 받는다. 셸이나 하위 프로세스를 쓰지 않는다.
- 컨테이너 안에서 `parallax` 가 PATH 에 있다. 명령줄은 저장소에 직접 닿으므로 토큰도
  네트워크도 필요 없다 — API 가 막혔을 때의 복구 경로다.

`PARALLAX_DNS_PORT` 를 설정하면 포트가 하나 더 열린다. 이건 네 번째 진입로가 아니라
**출구**다 — 조작을 받지 않고 desired state 를 읽어 DNS 로 답하기만 한다. 파일 백엔드에서는
저장소를 프로세스마다 캐시하므로, 터미널에서 실행한 명령줄의 쓰기는 포트를 쥔 서버에
보이지 않는다. 리스너가 따라가는 것은 포털과 API 를 통한 변경이다.

## 구현된 기능

- zone 및 internal/external view 관리, 레코드 타입 23종의 정규화와 검증
  (`8b774a6` 에서 넷에서 전부로 넓혔다)
- 공개 레코드를 기준으로 internal override 를 합성하는 split-horizon 모델
- desired revision, ETag/If-Match 낙관적 동시성, preview, 정확한 revision apply
- provider 별 적용 상태, 변경 이력, 감사 로그, revision restore, 보관 정책
- managed-only reconciliation 과 서명된 ownership marker (v3, v2 도 읽는다)
- Cloudflare REST 어댑터와 로컬 파일 프로바이더 (CoreDNS·PowerDNS 퍼블리셔는 `1db6f25`
  에서 제거)
- Cloudflare 클라이언트 측 리졸버 오버라이드 관리 — 프로필이 이미 쥔 자격 증명으로
  다루므로 두 번째 토큰이 없다
- 내부 뷰를 desired state 에서 바로 응답하는 내장 DNS 리스너 (UDP·TCP, 존 밖 이름은 포워딩)
- 원자적 JSON 저장소와 PostgreSQL 저장소 — `parallax migrate` 로 스키마 적용
- 암호화된 Cloudflare credential, 프로필 단위 재사용, 관리자 포털
- admin/editor/viewer RBAC, Bearer/쿠키 인증, CSRF·본문 크기·보안 헤더
- 운영 설정을 저장소에 두고 재배포 없이 반영 (프로바이더 배선, 프록시 origin, 보관)
- 프로세스 자체 TLS 종단과 80→443 리다이렉트, 인증서 무중단 재적재
- 데스크톱/모바일 대응 웹 GUI, 한국어/영어

## 핵심 운영 계약

1. desired mutation 은 revision·audit·pending status 를 하나의 저장소 트랜잭션으로 커밋한다.
2. preview 는 provider 를 변경하지 않는다.
3. apply 는 사용자가 확인한 정확한 revision 만 적용하며 zone 단위 잠금을 쓴다.
4. PostgreSQL 배포에서는 session advisory lock 으로 중복 apply 를 막는다.
5. Parallax 가 소유하지 않은 provider record 는 수정하거나 삭제하지 않는다.
6. external view 의 비공개/예약 IP 는 명시적 확인 없이 저장하지 않는다.
7. internal view 는 external baseline 을 보존하고 명시된 owner/type RRset 만 대체한다.
8. credential 원문은 API 응답·상태·감사 로그에 노출하지 않는다.
9. **스키마는 기동 시 자동 적용되지 않는다.** `parallax migrate` 를 사람이나 initContainer 가
   실행한다. 롤백된 이미지가 부팅하면서 스키마를 전진시키지 않게 하기 위해서다.
10. 쓸 수 없는 디렉터리를 가리키는 설정은 **저장 시점에 거부**한다. 정당하지만 대가가 있는
    변경은 거부 대신 `warnings` 로 그 변경을 한 사람에게 전달한다.
11. DNS 리스너는 답할 수 없는 레코드가 있으면 **RRset 전체를 SERVFAIL** 로 답하고 로그를
    남긴다. 반쪽 RRset 은 완전해 보이고 캐시되며, 빠진 값에 의존하던 쪽은 나중에 다른
    곳에서 알게 된다.
12. 내부 뷰가 비어 있는 존은 응답 대상에서 **뺀다**. adopt 직후의 정상 상태이고, 그 상태로
    권한을 주장하면 존 전체가 내부에서 NXDOMAIN 이 된다.
13. 파싱되지 않는 DNS 메시지에는 **아무 답도 보내지 않는다.** 위조된 출발지 주소에 증폭할
    바이트를 주지 않기 위해서다.
14. 포워딩은 **클라이언트가 쓴 전송을 그대로 쓴다.** TCP 로 온 질의를 UDP 로 넘기면 다시
    잘린 답이 돌아오고, 클라이언트는 이미 TC 가 시킨 일을 한 뒤라 더 할 수 있는 게 없다.
15. 와일드카드(`*`, `*.name`)는 **전개한다.** 가장 가까운 것이 이기고, 존재하는 이름 위로는
    답하지 않는다. 존 파일·PowerDNS·Cloudflare 가 같은 desired state 로 하는 것과 같다.
16. readiness 는 **리스너를 내부 뷰의 서비스 수단으로 인정한다.** 그러지 않으면 DNS 를 직접
    응답하는 배포가 모든 질의에 정확히 답하면서도 probe 를 영원히 통과하지 못한다.

## 개발 및 검증

요구사항을 테스트로 먼저 고정한 뒤 최소 구현과 리팩터링을 수행한다.

```sh
pnpm test          pnpm check          pnpm build
pnpm test:watch    pnpm test:coverage  pnpm audit
```

테스트는 `test/` 아래 `domain` · `application` · `infrastructure` · `adapters` ·
`http`/`security` · `cli` · `dns` 계층으로 나뉜다.

placeholder, `test.skip`, `test.only` 는 완료로 간주하지 않는다.

**검사를 추가할 때는 그 검사가 실제로 잡는지 확인한다** — 고친 줄을 되돌려 실패하는 것을
보고 나서 완료로 친다. 이 저장소에서 반복해 나온 실패는 *검사가 없는 것* 이 아니라
*검사가 대상이 아니라 대상의 모양을 보는 것* 이었다.

## 실행

```sh
pnpm install && pnpm build && pnpm start     # http://127.0.0.1:3000
```

PostgreSQL 을 쓸 때는 시작 전에 스키마를 적용한다. 재실행해도 안전하다.

```sh
parallax migrate
```

컨테이너는 `Dockerfile` 이 만든다. `0.0.0.0` 에 바인드하므로 `PARALLAX_AUTH_TOKENS` 가
반드시 필요하다. 상세는 [`README.md`](../README.md), 설계 배경은
[`product-design.md`](product-design.md) 를 참조한다.

## 배포 전 외부 검증

로컬 fake/mock 과 별개로, 실제 운영 배포 전에 아래를 대상 환경에서 확인한다. 전부
`scripts/` 에 자동화되어 있다.

- [x] **PostgreSQL** — `pnpm verify:postgres`. 마이그레이션 멱등성과 동시 3회 실행,
      트랜잭션 커밋, 재시작 후 상태 복원, 동시 apply 6건 직렬화, 보관 정책 pruning,
      FK cascade
- ~~**CoreDNS** — `pnpm verify:coredns`~~. **더 이상 없다.** 퍼블리셔가 `1db6f25` 에서
      빠지면서 스크립트도 함께 사라졌다. 이 줄을 지우지 않고 남기는 이유는, 없어진 검증을
      「돌았다」로 기억하는 것이 이 문서에서 실제로 일어난 실패이기 때문이다 — 위 §현재
      상태 참조. 내부 뷰가 답하는지는 이제 `pnpm verify:dns` 가 본다
- [x] **리버스 프록시와 자체 TLS** — `pnpm verify:proxy`. 설정 없이는 https Origin 이
      거부되는 것(=감사에서 찾은 결함 자체)을 **먼저 재현한 뒤** `trustForwardedHeaders` 와
      `publicOrigin` 이 각각 이를 복구함을 확인한다. 쿠키 속성, HSTS, 미인증 readiness
      차단, 교차 사이트 Origin 거부, 그리고 자체 TLS 에서의 인증서 무중단 교체까지
- [x] **Cloudflare 실계정** — `pnpm verify:cloudflare`. **`ef61201`, 2026-08-12,
      실계정(존 이름은 비공개).** 네 번 돌려 결함 셋이 나왔고 앞의 것이 뒤의 것을 가리고
      있었다 — 감사 리포트 §9.8 참조. 자격 증명이 없으면 건너뛴다

- [x] **내장 DNS 리스너** — `pnpm verify:dns`. Docker 도 네트워크도 필요 없다. 도메인이
      받는 **20개 타입 전부**를 넣고 `dig` 로 되읽는다 — 같은 바이트를 독립적으로 파싱하는
      쪽이고, 망가진 레코드는 출력하는 대신 오류로 보고한다. 타입은 이름이 아니라 **번호로**
      묻는다. 타입 이름을 모르는 `dig` 는 조용히 A 를 대신 묻고, 그러면 아무 답도 없어서
      리스너에 레코드가 없는 것처럼 읽히기 때문이다(`dig 9.10` 에서 HTTPS·SVCB 가 그렇다).
      그 밖에 두 부정(NXDOMAIN 과 빈 NOERROR)의 구분, 512 바이트를 넘는 응답의 TC 와 TCP
      재질의, 와일드카드 전개와 가장 가까운 매칭, UDP·TCP 각각의 전송으로 릴레이되는지와
      바이트 동일성, 상위가 없을 때의 REFUSED, 파싱 불가 메시지에 대한 무응답, 타이머가
      돌기 전에 반영되는 것, 프로바이더가 하나도 없는 배포의 readiness 통과까지 확인한다

⚠️ 로컬 mock 결과를 실제 provider 통합 성공으로 표현하지 않는다. 그리고 **통과한 실행은
그 실행이 돈 커밋에 대한 증거일 뿐이다.**

## 닫힌 결정 (2026-08-23)

이 절은 「열린 결정」이었다. **공개했다** — `henryj-dev/parallax`. 딸린 셋도 그때 함께
정해졌으므로, 무엇을 골랐는지와 왜 골랐는지를 남긴다.

| 그때의 질문 | 결정 | 이유 |
| --- | --- | --- |
| `product-design.md` §2 의 형제 프로젝트 이름 | **남긴다** | 이름만으로는 아무 곳에도 닿지 않는다. 지우면 그 문서가 기록인 이유가 함께 지워진다 |
| 같은 문서 §8 의 가시성 표기 | **고쳤다** | 「검토 중」은 이제 사실이 아니다 |
| `security-audits/` 공개 | **남긴다** | DNS 를 맡아 달라는 컨트롤 플레인이면 자기 숙제를 보여야 한다. 실제 존 이름 한 건은 가렸고 그 리포트 머리에 가렸다고 적었다. 남은 주소는 전부 지어낸 것이다 |

⚠️ **감사 리포트는 지우기 어렵다.** `what-ships.test.ts` 가
`security-audits/2026-08-15-security-audit.md` 를 경로로 지목하고, stardust 의 릴리스
게이트도 같은 디렉터리를 픽스처로 쓴다. `git rm` 은 이쪽 검사와 저쪽 게이트를 동시에
깬다 — 자세한 것은 [`../AGENTS.md`](../AGENTS.md).

히스토리 스캔은 그때 통과했다(사설 IP·실도메인·고엔트로피 문자열 0건).

## 지금 열린 것

하나뿐이고, 급하지 않다. **Node 하한선을 24 에 둘 것인가 26 으로 올릴 것인가.**
`engines.node` 가 `>=24` 이고 이미지도 24 다. 올린다면 `engines.node`,
`check.yml` 매트릭스, `Dockerfile` 베이스, `@types/node` 를 한 커밋에 움직여야 하고,
`.github/dependabot.yml` 의 `ignore` 두 줄을 지운다. 조사는 끝나 있다 —
`node:26-alpine` 은 Node 25 가 corepack 을 배포에서 빼서 그대로는 빌드되지 않고
(`npm i -g corepack` 이면 된다), `@types/node` 26 은 소켓 리스너 타입 명시가 필요한데
그건 `0024c09` 에서 이미 했다. 각 파일에 근거가 적혀 있다.
