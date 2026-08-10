# Parallax 작업 핸드오프

마지막 갱신일: 2026-08-08 (Asia/Seoul)

## 현재 상태

Parallax는 내부 DNS와 Cloudflare DNS의 desired state를 한 포털에서 관리하는
TypeScript 애플리케이션이다. 초기 골격 단계는 끝났으며, API·웹 포털·영속성·
DNS 어댑터·인증·감사 로그를 포함한 동작 가능한 MVP가 구현되어 있다.

작업 트리에는 아직 커밋하지 않은 구현 변경이 많다. 사용자 변경으로 간주하여
임의로 되돌리거나 정리하지 않는다.

## 구현된 기능

- zone 및 internal/external view 관리
- A, AAAA, CNAME, TXT 레코드 생성·수정·삭제와 정규화/검증
- 공개 레코드를 기준으로 internal override를 합성하는 split-horizon 모델
- desired revision, ETag/If-Match 낙관적 동시성, preview, exact-revision apply
- provider별 적용 상태, 재시도 가능한 오류, 변경 이력, 감사 로그, revision restore
- managed-only reconciliation과 서명된 ownership marker
- Cloudflare REST 및 CoreDNS zone-file adapter
- 원자적 JSON 저장소와 선택적 PostgreSQL 저장소
- 암호화된 Cloudflare credential 저장과 관리자용 credential 포털
- admin/editor/viewer RBAC, Bearer/cookie 인증, CSRF·본문 크기·보안 헤더 방어
- 데스크톱/모바일 대응 웹 GUI

## 핵심 운영 계약

1. desired mutation은 revision, audit, pending status를 하나의 저장소 트랜잭션으로
   커밋한다.
2. preview는 provider를 변경하지 않는다.
3. apply는 사용자가 확인한 정확한 revision만 적용하며 zone 단위 잠금을 사용한다.
4. PostgreSQL 배포에서는 session advisory lock으로 여러 프로세스의 중복 apply를
   막는다.
5. Parallax가 소유하지 않은 provider record는 수정하거나 삭제하지 않는다.
6. external view의 비공개/예약 IP는 명시적 확인 없이 저장하지 않는다.
7. internal view는 external baseline을 보존하고 명시된 owner/type RRset만 대체한다.
8. credential 원문은 API 응답, 상태, 감사 로그에 노출하지 않는다.

## 개발 및 검증

요구사항을 테스트로 먼저 고정한 뒤 최소 구현과 리팩터링을 수행한다.

```sh
pnpm test
pnpm test:watch
pnpm test:coverage
pnpm check
pnpm build
node --check public/app.js
```

테스트는 `test/` 아래에 다음 계층으로 나뉜다.

- `domain`: DNS 정규화, 타입별 검증, conflict, deterministic reconciliation
- `application`: revision, preview/apply, 상태, 감사, 동시성, 실패 원자성
- `infrastructure`: JSON/PostgreSQL 저장소와 apply lock 계약
- `adapters`: Cloudflare/CoreDNS 매핑, 오류, ownership, 파일 안전성
- `http`/`security`: API 계약, ETag, RBAC, CSRF, credential redaction

placeholder, `test.skip`, `test.only`는 완료로 간주하지 않는다. 전체 suite와 타입 검사,
빌드가 모두 통과해야 한다.

## 실행

```sh
pnpm install
pnpm test
pnpm build
pnpm start
```

기본 주소는 `http://127.0.0.1:3000`이다. 상세 환경 변수와 API 목록은
[`README.md`](../README.md), 제품 결정은 [`product-design.md`](product-design.md)를
참조한다.

PostgreSQL을 사용할 때는 시작 전에 migration을 적용한다.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_initial.sql
```

## 배포 전 외부 검증

자동화된 fake/mock 및 로컬 HTTP 검증과 별개로, 실제 운영 배포 전에는 다음을
대상 환경에서 확인한다. 아래 항목 중 PostgreSQL과 CoreDNS는 `scripts/`의 검증
스크립트로 자동화되어 있으며 실제 컨테이너를 상대로 통과했다.

- [x] 실제 PostgreSQL에 fresh migration, 재시작, transaction/advisory-lock 부하 테스트
      — `pnpm verify:postgres` (마이그레이션 멱등성, 트랜잭션 커밋, 재시작 후 상태
      복원, 동시 apply 6건 직렬화, 보관 정책 pruning, FK cascade 확인)
- [x] 실제 CoreDNS 프로세스에서 생성 zone load, SOA serial reload, `dig` 응답 확인
      — `pnpm verify:coredns` (손으로 관리하던 `$TTL` 상속 레코드와의 충돌 탐지,
      언더스코어 TXT 응답, serial 증가 후 reload 관측, 외부 레코드 보존, 파일 모드)
- [ ] 최소 권한 Cloudflare API token으로 pagination, rate limit, proxy/TTL 동작 확인
      — `pnpm verify:cloudflare` 스크립트는 준비되어 있으나 실제 계정이 없어
      **미실행**이다. `CF_ZONE`, `CF_ZONE_ID`, `CF_API_TOKEN`,
      `CF_VERIFY_ALLOW_WRITES=true`를 설정해 운영자가 직접 실행해야 한다.
- [x] reverse proxy/TLS 환경의 Origin 처리 — `publicOrigin` / `trustForwardedHeaders`
      설정으로 해결하고 회귀 테스트로 고정했다.
- [x] Secure cookie — 서버가 `POST /api/v1/session`에서 `HttpOnly; SameSite=Strict`
      쿠키를 발급하며 HTTPS 요청에는 `Secure`를 붙인다.
- [ ] 실제 TLS 종단 프록시(nginx 등) 뒤에서의 readiness 및 secret redaction 최종 확인
      — 코드 경로는 테스트로 고정했으나 실제 프록시 구성에서는 미검증이다.

외부 계정이나 실행 바이너리가 없는 로컬 mock 결과를 실제 provider 통합 성공으로
표현하지 않는다.
