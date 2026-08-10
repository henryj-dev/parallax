# Parallax

[English](README.md) | 한국어

Parallax는 split-horizon DNS 컨트롤 플레인이자 운영 포털입니다. 내부 DNS와
외부 Cloudflare DNS의 목표 상태를 한곳에서 관리하고, 적용될 변경을 미리
확인한 뒤 Parallax가 명시적으로 관리하는 레코드만 반영합니다.

## 제공 기능

- 존, 내부/외부 레코드, 미리보기, 적용, 상태, 감사 이력, 불변 리비전,
  복원 및 존 삭제를 관리하는 웹 포털
- Cloudflare 프록시 제약을 포함한 A, AAAA, CNAME, TXT 검증
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
| `PARALLAX_ALLOW_LOCAL_PROVIDER` | 모의 프로바이더 사용 여부. 루프백 개발 환경에서만 기본 활성화 |
| `DATABASE_URL` | 선택적 PostgreSQL 기준 저장소. 먼저 `migrations/001_initial.sql` 적용 필요 |
| `PARALLAX_COREDNS_DIRECTORY` | 원자적으로 생성되는 CoreDNS 존 파일 디렉터리 |
| `PARALLAX_OWNERSHIP_SECRET` | 관리 레코드 소유권 마커를 서명하는 32바이트 이상의 비밀값 |
| `PARALLAX_CLOUDFLARE_ZONES` | 존 이름을 Cloudflare 존 ID 및 API 토큰에 연결하는 선택적 JSON 맵 |
| `PARALLAX_CREDENTIAL_FILE` | 마스터 키와 함께 설정하는 선택적 암호화 Cloudflare 자격 증명 파일 |
| `PARALLAX_CREDENTIAL_MASTER_KEY` | base64 또는 64자리 16진수로 인코딩된 정확히 32바이트의 마스터 키 |
| `PARALLAX_AUTH_TOKENS` | 선택적 admin/editor/viewer 액세스 토큰 JSON 배열 |

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
합니다. 기존 비 Parallax 레코드와 권한 데이터는 유지하며, 서명된 소유권
마커가 있는 레코드만 변경합니다.

PostgreSQL을 사용할 때는 서비스를 시작하기 전에 스키마를 적용합니다.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_initial.sql
```

## HTTP API

모든 컨트롤 플레인 경로는 `/api/v1` 아래에 있습니다.

- `GET|POST /zones`
- `GET|PUT|DELETE /zones/:zone`
- `PUT|DELETE /zones/:zone/views/:view/records/:id`
- `GET|POST /zones/:zone/preview`
- `POST /zones/:zone/apply`
- `GET /zones/:zone/status`
- `GET /zones/:zone/history`
- `GET /zones/:zone/revisions`
- `GET /zones/:zone/revisions/:revision`
- `POST /zones/:zone/revisions/:revision/restore`
- `GET /credentials/cloudflare`
- `GET|PUT|DELETE /credentials/cloudflare/:zone`
- `POST /credentials/cloudflare/:zone/test` — 저장하지 않은 `{ zoneId, token }`도 선택적으로 테스트
- `GET /health/live`, `GET /health/ready`

인증을 활성화한 경우 `Authorization: Bearer <token>`을 전달합니다. 목표 상태는
프로바이더 변경보다 먼저 저장됩니다. 미리보기는 프로바이더를 변경하지 않으며,
적용 결과는 뷰별로 독립적으로 보고됩니다.

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
