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

환경변수에는 저장소에서 읽어올 수 없는 것만 둡니다. 어디에 바인드할지, 저장소에
어떻게 접속할지, 저장된 값을 보호하는 키가 전부입니다. `.env.example`을 `.env`로
복사한 뒤 값을 조정하세요. `dev`와 `start` 스크립트는 파일이 존재할 때 `.env`를
자동으로 읽고, 셸에서 직접 지정한 값이 우선합니다.

| 변수 | 용도 |
| --- | --- |
| `HOST`, `PORT` | 서버 바인드 주소. 기본값 `127.0.0.1:3000` |
| `DATABASE_URL` | PostgreSQL 원본 저장소. 스키마는 `parallax migrate`로 적용. TLS는 `?sslmode=verify-full` |
| `PARALLAX_STATE_FILE` | 데이터베이스가 없을 때 존·리비전·상태·감사 기록 파일 |
| `PARALLAX_CONFIG_FILE` | 데이터베이스가 없을 때 설정·자격 증명·접근 토큰 파일 |
| `PARALLAX_PROVIDER_STATE_FILE` | 로컬 프로바이더가 켜져 있을 때만 사용하는 상태 파일 |
| `PARALLAX_OWNERSHIP_SECRET` | 관리 레코드 소유권 마커에 서명하는 32바이트 이상 시크릿 |
| `PARALLAX_CREDENTIAL_MASTER_KEY` | 저장 자격 증명을 암호화하는 정확히 32바이트 키(base64 또는 64자 16진수) |
| `PARALLAX_TLS_CERT_FILE`, `PARALLAX_TLS_KEY_FILE` | 이 프로세스가 직접 TLS를 끝낼 인증서와 키. 둘 다 설정하거나 둘 다 비웁니다 |
| `PARALLAX_HTTP_REDIRECT_PORT` | 평문 HTTP에 TLS origin으로의 리다이렉트를 내는 포트. TLS 설정이 있어야 합니다 |
| `PARALLAX_AUTH_TOKENS` | `{"token","subject","role"}` 객체의 JSON 배열. `role`은 `admin`·`editor`·`viewer` 중 하나이고 토큰은 32바이트 이상. 루프백에서는 선택, **그 외 주소에 바인드하려면 필수** |

나머지는 전부 — 프로바이더 연결, 보관 정책, 프록시 origin, 접근 토큰, 프로바이더
자격 증명 — 존과 같은 저장소에 보관되며 포털의 **프로바이더 설정** 화면에서
관리합니다. 변경은 재배포 없이 즉시 반영되고, PostgreSQL을 쓰면 모든 인스턴스가
같은 값을 읽습니다.

| 설정 | 효과 |
| --- | --- |
| `allowLocalProvider` | 실제 프로바이더가 없을 때 로컬 파일에 게시. 기본값은 꺼짐이므로 라우팅되지 않는 대상은 성공으로 보고되지 않고 실패합니다 |
| `coreDnsDirectory` | 내부 뷰용 RFC 1035 존 파일 디렉터리. 비우면 비활성 |
| `publicOrigin` | 브라우저가 포털에 접속하는 절대 origin. 비우면 요청마다 유추 |
| `trustForwardedHeaders` | 리버스 프록시의 `X-Forwarded-Proto`/`X-Forwarded-Host` 신뢰 |
| `revisionRetention` | 존별 보관 리비전 스냅샷 수. `0`은 전부 보관 |
| `auditRetentionDays` | 존별 감사 기록 보관 일수. `0`은 전부 보관 |

### 접근 토큰

토큰은 포털에서 발급하며 SHA-256 다이제스트로만 저장됩니다. 제시된 토큰을 검증할
수는 있지만 저장소가 토큰을 되만들 수는 없습니다. 새 토큰은 발급 시 한 번만
표시됩니다. 토큰이 하나도 없으면 컨트롤 플레인은 열린 상태이며 이는 루프백 개발용
동작입니다. 그 상태에서는 비루프백 주소 바인드를 거부하고, 프록시 전달 헤더가 붙은
API 요청도 거부합니다. `PARALLAX_AUTH_TOKENS`는 스스로 잠긴 배포를 위한 비상
경로로 남아 있으며, 해당 토큰은 관리형으로 표시되고 API로 폐기할 수 없습니다.
마지막 관리자 토큰은 폐기되지 않습니다.

루프백이 아닌 배포를 시작하는 유일한 방법이기도 합니다. 첫 토큰을 발급받을 루프백
세션 자체가 없기 때문입니다. 컨테이너 이미지는 `0.0.0.0`에 바인드하므로 컨테이너
배포에는 항상 필요합니다:

```json
[{"token": "<32바이트 이상>", "subject": "deploy", "role": "admin"}]
```

그 외의 경우 서버가 바인드하기 전에 거부합니다:

```
parallax: refusing to serve a non-loopback address with no access token.
Issue one from a loopback session, or set PARALLAX_AUTH_TOKENS.
```

### 프로세스에서 TLS 종단하기

앞단에 프록시가 없는 배포는 직접 TLS를 낼 수 있습니다. 두 변수를 인증서와 키에 맞추면
주 포트가 HTTPS를 말합니다:

```sh
PARALLAX_TLS_CERT_FILE=/etc/tls/tls.crt \
PARALLAX_TLS_KEY_FILE=/etc/tls/tls.key \
PARALLAX_HTTP_REDIRECT_PORT=80 \
HOST=0.0.0.0 PORT=443 parallax-server
```

그 외에는 아무것도 달라지지 않습니다. 서버가 연결을 자기가 끝냈다는 것을 알기 때문에,
프록시 뒤에서 `publicOrigin`이 공급하던 same-origin 증명이 설정 없이 유도되고 쿠키에
`Secure`가 붙습니다. 주소가 고정돼 있다면 `publicOrigin`을 설정하십시오. 리다이렉트 리스너가 클라이언트를 보내는
곳이고, 없으면 리다이렉트는 요청한 호스트의 443을 가정할 수밖에 없습니다 — 이 프로세스가
바인드한 포트는 클라이언트가 닿은 포트가 아닙니다. Service나 게시된 컨테이너 포트가 그 사이를
매핑하기 때문입니다. 리다이렉트 리스너가 `publicOrigin` 없이 도는 경우 기동 시 그렇게 알리고, 나중에 그 값을 지우는
사람에게도 같은 말을 합니다. 정당하지만 대가가 있는 설정 변경은 새 설정과 함께 `warnings`를
돌려주며, 포털은 그것을 띄우고 명령줄은 stderr로 씁니다.

디스크에서 교체된 인증서는 재시작 없이 반영됩니다. 파일이 아니라 디렉터리를 감시합니다.
쿠버네티스 시크릿 마운트는 심볼릭 링크를 바꿔치는 방식으로 갱신되기 때문입니다. 교체 도중의
반쪽 상태는 쓰던 인증서를 그대로 두고 다음 이벤트에서 다시 시도합니다. 이것이 없으면 파드가
무언가 재시작될 때까지 만료된 인증서를 계속 내밉니다.

두 변수를 모두 비우면 평문 HTTP입니다. 로컬 개발과 종단 프록시 뒤 배포가 모두 원하는
동작입니다.

### 리버스 프록시 뒤에서 서비스하기

쿠키로 인증한 변경 요청은 same-origin을 증명해야 하며, 이때 브라우저가 실제로
사용한 origin이 필요합니다. TLS 종료 프록시 뒤에서는 `publicOrigin` 설정에
공개 origin을 지정하거나, 프록시를 통해서만 이 프로세스에 도달할 수 있다면
`trustForwardedHeaders`를 켭니다. 둘 다 없으면 서버가 요청을
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
삭제하면 해당 존의 프로바이더 연결이 끊깁니다.

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
비례해 증가합니다. `revisionRetention` 설정은 존별 최신 스냅샷 수를,
`auditRetentionDays`는 감사 기록 보관 기간을 제한합니다. 두 정책 모두
변경을 기록하는 것과 같은 원자적 커밋 안에서 적용되며, `0`으로 두면 제한이
없습니다. 보관 기간이 지나 삭제된 리비전을 복원하려 하면 404가 반환되므로,
실제로 필요한 롤백 범위에 맞춰 리비전 수를 정하세요.

PostgreSQL을 사용할 때는 서비스를 시작하기 전에 스키마를 적용합니다.

```sh
parallax migrate
```

`migrations/`의 모든 파일을 이름 순으로 다시 적용하며 재실행해도 안전합니다. 모든 객체가
`IF NOT EXISTS`로 만들어지고 각 파일이 자기 트랜잭션을 갖고 있어, 무엇을 건너뛸지 정하는
버전 테이블이 필요 없습니다. 동시 실행은 advisory lock으로 직렬화되므로 쿠버네티스 init
컨테이너나 배포 전 잡으로 쓸 수 있습니다.

기동 시 자동으로 적용하지는 않습니다. 의존하는 저장소를 부팅하면서 재구성하는 서버는 방금
롤백된 이미지에서도 스키마를 전진시켜 버립니다. 대신 기동을 거부하고 없는 릴레이션 이름을
알려 줍니다. 마이그레이션은 판단이므로 사람이 실행하는 명령입니다.

## 하나의 표면, 세 가지 진입로

모든 작업은 명령(command)으로 한 번만 정의됩니다. 동작을 가진 곳은 그곳뿐입니다.

```
포털(GUI)   ──HTTP──▶  API  ──▶  명령 계층  ──▶  컨트롤 플레인
터미널(CLI) ────────────────▶  명령 계층  ──▶  컨트롤 플레인
```

포털은 API하고만 통신하며 다른 어디에도 닿지 않습니다. API의 각 라우트는 번역기일
뿐입니다. 요청을 명령 호출 하나로 바꾸고, 그 결과를 응답으로 바꿉니다. `parallax`는
argv를 같은 호출로 파싱합니다. API는 명령 계층이 제공하지 않는 일을 할 수 없고 CLI는
바로 그 명령들을 실행하므로, 둘이 어긋날 수 없습니다.

`POST /api/v1/cli`는 명령줄 자체를 받습니다.

```sh
curl -X POST http://127.0.0.1:3000/api/v1/cli \
  -H 'content-type: application/json' \
  -d '{"argv":["zone","create","--zone","example.com"]}'
```

셸이나 하위 프로세스 없이 같은 디스패처를 프로세스 안에서 실행하며, 호출자의 역할을
해당 명령에 적용합니다. 따라서 이 엔드포인트로 토큰 권한을 우회할 수 없습니다.

## 명령줄

```sh
pnpm cli help                 # 전체 명령
pnpm cli help record set      # 특정 명령의 옵션
pnpm cli migrate                # 스키마 적용. 재실행 안전
pnpm cli zone list
pnpm cli zone create --zone example.com
pnpm cli record set --zone example.com --view external --id www \
  --record '{"name":"www","type":"A","content":"93.184.216.34","ttl":300}'
pnpm cli preview --zone example.com
pnpm cli apply --zone example.com
pnpm cli settings set --values '{"allowLocalProvider":true}'
pnpm cli token issue --subject deploy-bot --role editor
```

CLI는 서버와 같은 저장소를 읽으므로 한쪽의 변경이 다른 쪽에 즉시 보입니다. 감사
기록에는 실행자가 `cli:<user>`로 남습니다. 기계가 읽을 출력은 `--json`을 붙이세요.
종료 코드는 `sysexits`를 따릅니다. `64` 사용법, `65` 잘못된 입력, `69` 없음,
`70` 충돌, `77` 권한, `78` 사용 불가.

명령줄은 저장소에 직접 접근하므로 전체 권한으로 동작합니다. HTTP 호출자는 토큰의
역할이 허용하는 범위로 제한됩니다.

## HTTP API

모든 컨트롤 플레인 경로는 `/api/v1` 아래에 있습니다.

- `GET|POST /zones` (`{ "name": "example.com" }`)
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
- `POST /cli` (모든 명령 실행. `{ "argv": ["zone", "list"] }`)
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

## 컨테이너 이미지

리포지토리 루트의 `Dockerfile`은 세 표면 -- API, 포털, 명령줄 -- 을 모두 담은 런타임
이미지를 만듭니다.

```sh
docker build -t parallax .
docker run -p 3000:3000 \
  -e DATABASE_URL='postgres://...' \
  -e PARALLAX_OWNERSHIP_SECRET='...' \
  -e PARALLAX_CREDENTIAL_MASTER_KEY='...' \
  -e PARALLAX_AUTH_TOKENS='[{"token":"...","subject":"deploy","role":"admin"}]' \
  parallax
```

이미지는 `0.0.0.0`에 바인드하므로 `PARALLAX_AUTH_TOKENS`가 필요합니다. 형식과 이유는
[접근 토큰](#접근-토큰)을 보십시오.

서버가 뜨기 전에 같은 이미지로 스키마를 적용합니다:

```sh
docker run --rm -e DATABASE_URL='postgres://...' parallax parallax migrate
```

쿠버네티스에서는 `command: ["parallax", "migrate"]`인 init 컨테이너가 됩니다. 닿지 못하거나
적용하지 못하면 0이 아닌 코드로 끝나므로, 스키마가 없는 채로 서버가 뜨는 일이 없습니다.

이미지 안에서 `parallax`가 PATH에 있으므로, 토큰이나 네트워크 왕복 없이 모든 조작을
그대로 할 수 있습니다:

```sh
docker exec <컨테이너> parallax zone list
```

UID 10001로 실행되며 애플리케이션 디렉터리에는 쓸 수 없습니다. 런타임 의존성은 빌드와
분리해 설치하므로 소스를 컴파일한 도구 사슬은 최종 이미지에 들어가지 않습니다.

`DATABASE_URL`을 주면 쓰기 가능한 파일시스템이 전혀 필요 없습니다. 완전 읽기 전용 루트에
아무것도 마운트하지 않은 상태에서 포털 서빙·API 쓰기·CLI 실행까지 확인했습니다. 데이터베이스
없이 파일 백엔드를 쓸 때만 그 파일이 `/var/lib/parallax`에 놓이며, 그때 이 경로를 마운트합니다.
휘발성 볼륨으로 충분합니다 — PostgreSQL이 저장소인 한 거기 쓰이는 것 중 정본은 없습니다.

## 실제 의존성 대상 검증

단위 테스트와 HTTP 테스트는 인메모리 페이크를 사용합니다. 아래 스크립트는 실제
구성요소를 대상으로 실행합니다.

```sh
pnpm verify:postgres    # Docker PostgreSQL: 마이그레이션, 재시작, 잠금, 보관 정책
pnpm verify:coredns     # Docker CoreDNS + dig: 존 로드, SOA reload, 충돌 탐지
pnpm verify:proxy       # Docker nginx TLS 종단: Origin, 쿠키, HSTS, readiness
pnpm verify:cloudflare  # 옵트인. 실제 토큰이 필요하며 없으면 건너뜀
pnpm audit              # 의존성 취약점 점검
```

`verify:proxy`는 단위 테스트가 대신할 수 없는 형태를 다룹니다. 서버는 루프백에서
평문 HTTP를 보는데 브라우저는 HTTPS를 봅니다. 먼저 설정이 없을 때 `https` Origin이
거부되는 잘못된 상태를 재현해 이후 검사가 공허하게 통과할 수 없게 만든 뒤,
`trustForwardedHeaders`와 `publicOrigin`이 각각 이를 복구하는지, 그리고 교차 사이트
Origin은 여전히 거부되는지 확인합니다.

`verify:postgres`, `verify:coredns`, `verify:proxy`는 Docker가 필요하며 종료 시
컨테이너를 제거합니다.

통과한 실행은 그 실행이 돈 커밋에 대한 증거일 뿐입니다. Cloudflare 검증은 `ef61201`에서
실제 존을 대상으로 처음 통과했고, 그 앞의 세 번은 각각 결함을 하나씩 찾았습니다 — 앞의 것이
뒤의 것을 가리고 있었습니다. 그중에는 소유권 마커가 Cloudflare 주석 상한을 넘어 이름이 열한
자를 넘는 존에는 레코드를 하나도 발행할 수 없던 것도 있습니다. 이런 것은 로컬에서 보이지
않습니다 — 스텁 프로바이더는 보내는 것을 그대로 받습니다. `verify:cloudflare`는 실제 존에 쓰기를 하므로 `CF_ZONE`,
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
