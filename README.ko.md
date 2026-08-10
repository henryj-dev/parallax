# Parallax

[English](README.md) | 한국어

Parallax는 split-horizon DNS 컨트롤 플레인이자 운영 포털입니다. 내부 DNS와
외부 Cloudflare DNS의 목표 상태를 한곳에서 관리하고, 적용될 변경을 미리
확인한 뒤 Parallax가 명시적으로 관리하는 레코드만 반영합니다.

## 제공 기능

- 존, 내부/외부 레코드, 미리보기, 적용, 상태, 감사 이력, 불변 리비전,
  복원 및 존 삭제를 관리하는 웹 포털
- Cloudflare 프록시 제약을 포함한 A, AAAA, CNAME, TXT 검증
  (`_dmarc`, `_acme-challenge` 같은 RFC 8552 언더스코어 이름 포함)
- 외부 레코드를 보존하는 결정적 `managed-only` 동기화
- 원자적 파일 쓰기를 사용하는 단일 노드 JSON 상태 및 프로바이더 상태 저장
- 트랜잭션과 불변 리비전을 지원하는 선택적 PostgreSQL 기준 저장소
- 선택적으로 사용하는 Cloudflare API 및 CoreDNS RFC 1035 존 파일 어댑터
- 관리자 포털에서 관리하는 암호화된 쓰기 전용 Cloudflare 자격 증명
- 선택적 admin/editor/viewer 역할 기반 토큰 인증과 감사 주체 기록
- 상태 확인 엔드포인트와 보안 헤더
- 외부 의존성을 최소화한 Node.js HTTP 서버와 TypeScript 테스트 모음

제품 및 아키텍처 결정의 배경은
[`docs/product-design.md`](docs/product-design.md)에서 확인할 수 있습니다.

## 요구 사항

- Node.js 24 이상
- pnpm 11 이상

## 로컬 실행

```sh
pnpm install
pnpm test
pnpm check
pnpm build
pnpm start
```

브라우저에서 `http://127.0.0.1:3000`을 엽니다. 로컬 상태는 Git에서 제외되는
`data/` 아래에 저장됩니다. 개발 중에는 `pnpm dev`를 사용합니다.

## 환경 설정

`.env.example`을 `.env`로 복사한 뒤 값을 조정합니다. `dev`와 `start` 스크립트는
파일이 존재할 때 `.env`를 자동으로 읽습니다. 셸에서 직접 지정한 환경 변수가
`.env`보다 우선하며, 파일이 없으면 서비스 기본값을 사용합니다.

| 환경 변수 | 용도 |
| --- | --- |
| `HOST`, `PORT` | 서버 바인딩 주소. 기본값은 `127.0.0.1:3000` |
| `PARALLAX_STATE_FILE` | 존, 리비전, 상태, 감사 로그 영속 파일 |
| `PARALLAX_PROVIDER_STATE_FILE` | 대체 수단으로 사용하는 로컬 프로바이더 상태 파일 |
| `PARALLAX_ALLOW_LOCAL_PROVIDER` | 모의 프로바이더 사용 여부. 프로바이더를 설정하지 않은 루프백 개발 환경에서만 기본 활성화 |
| `PARALLAX_PUBLIC_ORIGIN` | 브라우저가 포털에 접속하는 절대 origin. TLS 종료 프록시 뒤에서 필요 |
| `PARALLAX_TRUST_FORWARDED_HEADERS` | 리버스 프록시의 `X-Forwarded-Proto`/`X-Forwarded-Host` 신뢰 여부 |
| `DATABASE_URL` | 선택적 PostgreSQL 기준 저장소. 먼저 `migrations/001_initial.sql` 적용 필요 |
| `PARALLAX_COREDNS_DIRECTORY` | 원자적으로 생성되는 CoreDNS 존 파일 디렉터리 |
| `PARALLAX_OWNERSHIP_SECRET` | 관리 레코드 소유권 마커를 서명하는 32바이트 이상의 비밀값 |
| `PARALLAX_CLOUDFLARE_ZONES` | 존 이름을 Cloudflare 존 ID 및 API 토큰에 연결하는 선택적 JSON 맵 |
| `PARALLAX_CREDENTIAL_FILE` | 마스터 키와 함께 설정하는 선택적 암호화 Cloudflare 자격 증명 파일 |
| `PARALLAX_CREDENTIAL_MASTER_KEY` | base64 또는 64자리 16진수로 인코딩된 정확히 32바이트의 마스터 키 |
| `PARALLAX_AUTH_TOKENS` | 선택적 admin/editor/viewer 액세스 토큰 JSON 배열. 각 토큰은 32바이트 이상 |

### 리버스 프록시 뒤에서 서비스하기

쿠키로 인증한 변경 요청은 same-origin을 증명해야 하며, 이때 브라우저가 실제로
사용한 origin이 필요합니다. TLS 종료 프록시 뒤에서는 `PARALLAX_PUBLIC_ORIGIN`에
공개 origin을 설정하거나, 프록시를 통해서만 이 프로세스에 도달할 수 있다면
`PARALLAX_TRUST_FORWARDED_HEADERS=true`를 설정합니다. 둘 다 없으면 서버가 요청을
`http`로 재구성해 비교하므로 `https` 요청이 거부됩니다.

인증은 `PARALLAX_AUTH_TOKENS`가 없을 때만 비활성화되며, 이는 루프백 개발 전용
동작입니다. 그렇지 않으면 해당 포트에 도달한 모든 호출자가 관리자가 됩니다.
인증이 비활성화된 상태에서 프록시 전달 헤더가 붙은 API 요청은 거부되고, 기동 시
경고를 출력합니다. 앞단에 무언가를 두기 전에 반드시 토큰을 설정하세요. 토큰은
32바이트 이상이어야 하며 `openssl rand -base64 32`로 생성할 수 있습니다. 인증
실패가 반복되면 `429`와 `Retry-After` 헤더로 응답하고, 유효한 토큰은 다른
클라이언트의 실패 때문에 지연되지 않습니다.

포털은 토큰을 메모리에 들고 있지 않고 세션 쿠키로 교환합니다.
`POST /api/v1/session`에 `{ "token": "..." }`을 보내면 `HttpOnly; SameSite=Strict;
Path=/` 쿠키를 발급하고(HTTPS 요청이면 `Secure`도 포함), `DELETE /api/v1/session`으로
지웁니다. 두 요청 모두 같은 origin에서 왔다는 증명을 요구하므로 포털만 세션을
얻거나 버릴 수 있습니다. 쿠키가 `HttpOnly`이므로 페이지 스크립트는 자격 증명을
볼 수 없습니다. API 클라이언트는 계속 `Authorization: Bearer`를 쓰면 됩니다.

### 프로바이더 자격 증명

Cloudflare 자격 증명은 계정 단위 토큰을 한 번만 입력하도록 분리되어 있습니다.
**프로필**이 재사용 가능한 계정 ID와 API 토큰을 담고, 각 **apex 도메인**은
프로필과 Cloudflare가 부여한 존 ID에 연결됩니다. 프로필의 토큰을 교체하면 그
프로필을 쓰는 모든 도메인의 라우팅이 즉시 갱신되며, 도메인이 연결된 프로필은
삭제할 수 없습니다.

관리자 포털의 **프로바이더 설정** 화면에서 둘 다 관리합니다. 한 탭은 저장된
프로필과 각 프로필을 재사용하는 도메인 목록을, 다른 탭은 apex 도메인과 프로필의
연결을 보여줍니다. 토큰은 쓰기 전용입니다. 암호화되어 저장되고 포털로 반환되지
않으므로 교체할 값을 입력하기 전까지 입력란은 비어 있습니다.

프로필 도입 이전에 만들어진 저장 파일은 처음 읽을 때 자동으로 변환됩니다. 서로
다른 토큰마다 프로필 하나가 만들어지고 이름은 그 토큰을 처음 쓴 존에서 따오며,
각 존은 자신의 존 ID를 그대로 유지합니다. 다시 입력할 것은 없습니다.

Cloudflare에는 최소 권한 API 토큰을 사용합니다. 인증이 설정되면 포털에서
액세스 토큰을 요청하며 현재 브라우저 탭의 메모리에만 보관합니다. 자격 증명
저장소 키는 `openssl rand -base64 32`로 생성할 수 있습니다. 프로바이더 설정
화면과 자격 증명 API는 관리자 전용입니다. API 토큰은 쓰기 전용이며 목록과
메타데이터 응답에는 존, 존 ID, 갱신 시각만 포함됩니다. 암호화 자격 증명은
동일 존의 `PARALLAX_CLOUDFLARE_ZONES` 설정보다 우선하고, 삭제하면 환경 변수로
설정한 어댑터가 다시 사용됩니다.

Cloudflare [TTL](https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/)은
[API 표현](https://developers.cloudflare.com/api/resources/dns/subresources/records/)에서
`1`을 **Auto**로 사용합니다. 프록시가 적용된 A, AAAA, CNAME 레코드는 TTL을
수정할 수 없으므로 항상 Auto로 정규화합니다. DNS-only 레코드는 Auto 또는
60–86400초를 허용합니다. Cloudflare Enterprise 존은 최소 30초를 지원할 수
있지만, Parallax는 프로바이더 요금제 기능을 명시적으로 설정하기 전까지
일반 요금제의 하한인 60초를 적용합니다.

CoreDNS 출력은 RFC 1035 형식의 권한 존입니다. Parallax가 새 파일을
만들 때 SOA와 NS 레코드를 추가하고, 관리 레코드를 변경할 때마다 32비트 SOA serial을
증가시킨 뒤 파일을 원자적으로 교체합니다. CoreDNS가 serial 변경을 감지하도록
`auto` 플러그인 또는 0이 아닌 재로드 간격을 지정한 `file` 플러그인을 설정해야
합니다. 파일은 다른 사용자로 실행되는 CoreDNS가 읽을 수 있도록 `0644` 모드로
기록합니다. 기존 비 Parallax 레코드와 권한 데이터는 유지하며, 서명된 소유권
마커가 있는 레코드만 변경합니다.

기존 존 파일을 읽을 때는 일반적인 RFC 1035 표기를 모두 처리합니다. `$TTL`을
상속하는 레코드, 앞 레코드의 소유자 이름을 상속하는 레코드, 선택적 class 필드,
괄호로 여러 줄에 걸친 레코드가 포함됩니다. 읽을 수 없는 레코드 줄은 "레코드
없음"이 아니라 오류로 처리합니다. 없는 것으로 간주하면 보지 못한 응답 옆에
두 번째 응답을 게시하게 되기 때문입니다.

### 보관 정책

목표 상태를 변경할 때마다 불변 스냅샷과 감사 기록이 쌓이므로 히스토리는 사용량에
비례해 증가합니다. `PARALLAX_REVISION_RETENTION`은 존별 최신 스냅샷 수를,
`PARALLAX_AUDIT_RETENTION_DAYS`는 감사 기록 보관 기간을 제한합니다. 두 정책 모두
변경을 기록하는 것과 같은 원자적 커밋 안에서 적용되며, `0`으로 두면 제한이
없습니다. 보관 기간이 지나 삭제된 리비전을 복원하려 하면 404가 반환되므로,
실제로 필요한 롤백 범위에 맞춰 리비전 수를 정하세요.

PostgreSQL을 사용할 때는 서비스를 시작하기 전에 스키마를 적용합니다.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_initial.sql
```

## HTTP API

모든 컨트롤 플레인 경로는 `/api/v1` 아래에 있습니다.

- `GET|POST /zones`
- `GET|PUT|DELETE /zones/:zone` (`DELETE ?abandonProviderRecords=true`)
- `PUT|DELETE /zones/:zone/views/:view/records/:id`
- `GET|POST /zones/:zone/preview`
- `POST /zones/:zone/apply`
- `GET /zones/:zone/status`
- `GET /zones/:zone/history` (`?limit=&offset=`, 최신순)
- `GET /zones/:zone/revisions` (`?limit=&offset=`, 최신 구간을 오름차순으로)
- `GET /zones/:zone/revisions/:revision`
- `POST /zones/:zone/revisions/:revision/restore`
- `GET /credentials/cloudflare`
- `GET|PUT|DELETE /credentials/cloudflare/:zone`
- `POST /credentials/cloudflare/:zone/test` — 저장하지 않은 `{ zoneId, token }`도 선택적으로 테스트
- `GET /health/live`, `GET /health/ready`

인증을 활성화한 경우 `Authorization: Bearer <token>`을 전달합니다. 목표 상태는
프로바이더 변경보다 먼저 저장됩니다. 미리보기는 프로바이더를 변경하지 않으며,
적용 결과는 뷰별로 독립적으로 보고됩니다. 미리보기는 호출할 때마다 실제
프로바이더를 조회하므로 아무것도 변경하지 않더라도 editor 이상 권한이
필요합니다. 히스토리와 리비전 목록은 페이지 단위로 반환합니다. 둘 다 `limit`
(최대 500, 기본 50)과 `offset`을 받고 항목과 함께 `limit`, `offset`, `hasMore`를
돌려줍니다.

동기화 가능한 뷰는 `internal`과 `external`뿐입니다. 다른 뷰 이름은 쓰기 시점에
거부되므로, 어떤 프로바이더도 적용할 수 없는 목표 상태가 존에 저장되는 일은
발생하지 않습니다.

존을 삭제하면 목표 상태를 제거하기 전에 Parallax가 게시한 모든 레코드를
프로바이더에서 회수하고, 무엇을 제거했는지 `removedProviderRecords`로
응답합니다. Parallax 소유권 마커가 없는 레코드는 건드리지 않습니다. 회수를 먼저
수행하므로, 프로바이더가 거부하거나 응답하지 않으면 존을 그대로 두어 삭제를 다시
시도할 수 있습니다. 추적되지 않는 게시 레코드를 남기지 않기 위한 순서입니다.
`?abandonProviderRecords=true`를 전달하면 회수를 의도적으로 건너뜁니다. 이는
프로바이더가 영구히 사라진 경우에만 사용하며, 해당 레코드는 살아 있는 상태로
남습니다.

## 실제 의존성 대상 검증

단위 테스트와 HTTP 테스트는 인메모리 페이크를 사용합니다. 아래 스크립트는 실제
구성요소를 대상으로 실행합니다.

```sh
pnpm verify:postgres    # Docker PostgreSQL: 마이그레이션, 재시작, 잠금, 보관 정책
pnpm verify:coredns     # Docker CoreDNS + dig: 존 로드, SOA reload, 충돌 탐지
pnpm verify:cloudflare  # 옵트인. 실제 토큰이 필요하며 없으면 건너뜀
pnpm audit              # 의존성 취약점 점검
```

`verify:postgres`와 `verify:coredns`는 Docker가 필요하며 종료 시 컨테이너를
제거합니다. `verify:cloudflare`는 실제 존에 쓰기를 하므로 `CF_ZONE`,
`CF_ZONE_ID`, `CF_API_TOKEN`, `CF_VERIFY_ALLOW_WRITES=true`가 모두 설정되지
않으면 실행을 거부합니다. 작업은 `parallax-verify-*` 이름으로 제한되며, Parallax가
소유하지 않은 레코드가 삭제 대상이 되지 않는지도 함께 확인합니다.

## 개발 방식

Node.js의 안정적인 내장 테스트 실행기를 사용합니다. 동작을 정의하는 실패 테스트를
먼저 추가하고, 테스트를 통과하는 최소 구현을 작성한 뒤 전체 테스트 모음이 통과하는
상태에서 리팩터링합니다.

```sh
pnpm test
pnpm test:watch
pnpm test:coverage
pnpm check
pnpm build
```
