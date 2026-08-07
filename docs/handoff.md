# Parallax 작업 핸드오프

마지막 갱신일: 2026-08-08 (Asia/Seoul)

## 새 세션에서 먼저 할 일

1. 이 문서를 끝까지 읽는다.
2. [제품 설계 초안](product-design.md)을 읽는다.
3. `git status --short`로 아직 커밋되지 않은 변경을 확인한다.
4. `pnpm check`와 `pnpm build`로 현재 기준선을 검증한다.
5. 아래의 미확정 항목을 사용자와 결정하거나 권장 다음 작업부터 진행한다.

## 사용자의 목표

내부 DNS와 Cloudflare DNS를 한곳에서 관리하는 솔루션을 만든다. 같은
도메인이 조회 위치에 따라 다른 결과를 반환해야 한다.

현재 대표 사용 사례는 다음과 같다.

- `example.com`을 내부에서는 `10.10.10.10`으로 응답
- 외부에서는 `12.34.56.78`로 응답
- 외부 레코드에 Cloudflare Proxy를 선택적으로 적용
- 내부 DNS와 외부 DNS의 desired state를 하나의 API 및 관리 화면에서 관리

## 프로젝트 정체성

- 팀: `tinyuniverse`
- 프로젝트: `parallax`
- 이름의 의미: 관측 위치에 따라 같은 대상이 다르게 보이는 시차
- 기존 관리 프로젝트: `stardust`, `heliopause`
- 제품 설명: `A split-horizon DNS control plane`
- 문구 후보: `One domain, different views.`

## 확정된 결정

- 저장소 로컬 경로: `/Users/henry/github/mack-erel/parallax`
- GitHub 저장소: `https://github.com/mack-erel/parallax`
- GitHub 공개 범위: private
- 기본 브랜치: `main`
- 구현 언어: TypeScript
- 런타임: Node.js 24 이상
- 패키지 매니저: pnpm 11
- 모듈 시스템: ESM
- TypeScript strict mode 사용
- Node.js의 내장 TypeScript 실행 기능으로 개발 서버 실행
- 현재 외부 런타임 의존성은 없음

처음에는 Go 골격으로 시작했지만 사용자 요청으로 TypeScript로 전환했다.
따라서 Go 관련 파일이나 설계를 다시 추가하지 않는다.

## 설계 방향

Parallax의 데이터는 내부/외부 값을 레코드에 고정하는 대신 독립적인 DNS
`view`로 모델링한다. API는 변경 요청을 desired state로 먼저 저장하고,
reconciler가 내부 DNS와 Cloudflare의 actual state를 원하는 상태로
수렴시킨다.

주요 구성요소 후보는 다음과 같다.

- Control plane API 및 관리 화면
- PostgreSQL 기반 source of truth
- Internal DNS adapter (CoreDNS 또는 PowerDNS)
- Cloudflare provider reconciler
- 변경 미리보기, apply 및 provider별 상태 관리
- 변경 이력과 감사 로그

상세 내용과 예제는 [제품 설계 초안](product-design.md)에 있다.

## 중요한 제약과 주의점

### 내부 DNS의 NXDOMAIN 문제

내부 DNS가 `example.com` 전체에 authoritative하지만 일부 레코드만 알고
있으면, 내부에서 정의하지 않은 공개 레코드가 NXDOMAIN이 될 수 있다.
현재 우선 제안은 공개 zone을 기본값으로 삼고 내부 override를 합성하는
방식이다. 아직 DNS 엔진과 구체적인 구현은 확정되지 않았다.

### 레코드 삭제 정책

초기에는 Parallax가 만든 레코드만 수정 및 삭제하는 `managed-only` 정책을
권장한다. 기존 Cloudflare 레코드를 자동으로 전부 삭제하거나 zone 전체의
소유권을 가정하면 안 된다.

### Cloudflare 인증

Global API Key가 아니라 최소 권한 API Token을 사용하고, credential은
암호화 저장해야 한다. `proxied` 설정은 레코드 유형, 포트, TLS 및 origin
접근 정책에 영향을 주므로 단순 boolean UI만 제공하기 전에 검증이 필요하다.

## 현재 저장소 상태

최초 커밋은 다음과 같다.

```text
5300e61 chore: initialize parallax
```

이 커밋은 `origin/main`에 푸시되어 있다. 최초 커밋 이후 제품 설계 문서와
README 링크가 추가되었으며, 이 핸드오프 문서를 작성하는 시점에는 문서
변경분이 아직 커밋되지 않은 상태다. 새 세션에서는 실제 `git status`를
기준으로 판단해야 한다.

현재 주요 파일은 다음과 같다.

```text
README.md
package.json
pnpm-lock.yaml
tsconfig.json
tsconfig.build.json
src/index.ts
docs/product-design.md
docs/handoff.md
```

`src/index.ts`는 서비스 이름을 출력하는 초기 placeholder일 뿐이며 실제
DNS 또는 API 기능은 아직 구현되지 않았다.

## 개발 및 검증 명령

```sh
pnpm install
pnpm dev
pnpm check
pnpm build
pnpm start
```

마지막 확인 당시 `pnpm check`, `pnpm build`, 빌드 결과 실행이 모두
성공했다. `dist/`와 `node_modules/`는 Git에서 제외된다.

## 아직 결정하지 않은 항목

- API 프레임워크
- 웹 UI 프레임워크와 monorepo 여부
- ORM 또는 SQL 접근 방식
- 데이터베이스 schema와 migration 도구
- 내부 DNS 엔진: CoreDNS 또는 PowerDNS
- 내부 DNS 동기화 방식: zone file, API 또는 plugin
- Cloudflare SDK 사용 여부와 adapter interface
- 인증 및 RBAC 방식
- 수동 apply와 자동 reconcile의 구체적인 workflow
- 배포 방식과 운영 환경
- 테스트 프레임워크

사용자가 선택을 요청하지 않았다면 한 번에 전체 스택을 확정하기보다,
첫 vertical slice에 필요한 최소 결정부터 제안한다.

## 권장 다음 작업

첫 구현 단위로 도메인 모델과 provider-independent reconciliation 계약을
정의하는 것이 좋다.

1. `Zone`, `View`, `Record`, `Provider`, `Revision` 도메인 타입 정의
2. A/AAAA/CNAME/TXT 레코드 유효성 검사 정의
3. desired state와 actual state의 diff 모델 정의
4. provider adapter interface 정의
5. 메모리 기반 저장소와 fake provider로 reconcile 흐름 테스트
6. 이후 PostgreSQL과 Cloudflare adapter 연결

이 순서는 특정 웹 프레임워크나 DNS 엔진을 너무 일찍 고정하지 않으면서
Parallax의 핵심인 “한 도메인의 여러 view와 상태 수렴”을 먼저 검증한다.

## 완료의 현재 의미

현재까지 완료된 것은 프로젝트 생성, TypeScript 기본 설정, GitHub private
저장소 연결, 제품 방향 문서화다. 실제 API, 데이터베이스, DNS 서버 연동,
Cloudflare 연동 및 UI는 아직 시작하지 않았다.
