# Parallax 작업 핸드오프

마지막 갱신: 2026-08-12 (Asia/Seoul) · 대상 커밋 `0ad3312`

## 현재 상태

Parallax는 내부 DNS와 Cloudflare DNS의 desired state를 한곳에서 관리하는 TypeScript
애플리케이션이다. **구현이 끝났고, 실제 클러스터에 배포되어 돌고 있다.**

```
테스트          220/220 · tsc 통과 · build 통과 · 의존성 취약점 0건
실제 의존성      PostgreSQL 17 · CoreDNS 1.12 · nginx TLS 종단 · Cloudflare 실계정 — 전부 통과
배포            컨테이너 이미지, read-only 루트, uid 10001, initContainer 로 스키마 적용
```

⚠️ **위 통과는 `0ad3312` 시점에 대한 것이다.** 프로바이더나 설정 경로를 건드리면 다시
돌려야 한다. 이 문서는 한때 `verify:coredns` 의 옛 통과를 현재의 주장으로 재사용하고
있었고, 그 사이 그 스크립트는 설정 이관으로 **깨져 있었다**.

## 하나의 표면, 세 진입로

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

## 구현된 기능

- zone 및 internal/external view 관리, A·AAAA·CNAME·TXT 정규화와 검증
- 공개 레코드를 기준으로 internal override 를 합성하는 split-horizon 모델
- desired revision, ETag/If-Match 낙관적 동시성, preview, 정확한 revision apply
- provider 별 적용 상태, 변경 이력, 감사 로그, revision restore, 보관 정책
- managed-only reconciliation 과 서명된 ownership marker (v3, v2 도 읽는다)
- Cloudflare REST · CoreDNS zone-file 어댑터, 로컬 파일 fallback
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

## 개발 및 검증

요구사항을 테스트로 먼저 고정한 뒤 최소 구현과 리팩터링을 수행한다.

```sh
pnpm test          pnpm check          pnpm build
pnpm test:watch    pnpm test:coverage  pnpm audit
```

테스트는 `test/` 아래 `domain` · `application` · `infrastructure` · `adapters` ·
`http`/`security` · `cli` 계층으로 나뉜다.

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
- [x] **CoreDNS** — `pnpm verify:coredns`. 손으로 관리하던 `$TTL` 상속 레코드와의 충돌
      탐지, 언더스코어 TXT 응답, serial 증가 후 reload 관측, 외부 레코드 보존, 파일 모드
- [x] **리버스 프록시와 자체 TLS** — `pnpm verify:proxy`. 설정 없이는 https Origin 이
      거부되는 것(=감사에서 찾은 결함 자체)을 **먼저 재현한 뒤** `trustForwardedHeaders` 와
      `publicOrigin` 이 각각 이를 복구함을 확인한다. 쿠키 속성, HSTS, 미인증 readiness
      차단, 교차 사이트 Origin 거부, 그리고 자체 TLS 에서의 인증서 무중단 교체까지
- [x] **Cloudflare 실계정** — `pnpm verify:cloudflare`. **`ef61201`, 2026-08-12,
      실계정 `tinytools.work`.** 네 번 돌려 결함 셋이 나왔고 앞의 것이 뒤의 것을 가리고
      있었다 — 감사 리포트 §9.8 참조. 자격 증명이 없으면 건너뛴다

⚠️ 로컬 mock 결과를 실제 provider 통합 성공으로 표현하지 않는다. 그리고 **통과한 실행은
그 실행이 돈 커밋에 대한 증거일 뿐이다.**

## 열린 결정

코드에 남은 항목은 없다. 사람이 정할 것만 남았다 — **정본을 공개할 것인가**, 그리고
공개한다면 다음 셋을 어떻게 할 것인가:

1. `product-design.md` §2 가 형제 프로젝트 `stardust`·`heliopause` 를 이름으로 노출한다
2. 같은 문서 §8 의 저장소 가시성 표기
3. `security-audits/` 의 감사 리포트를 함께 공개할 것인가

히스토리 스캔은 통과했다(사설 IP·실도메인·고엔트로피 문자열 0건). 막는 것은 없고
결정만 남았다.
