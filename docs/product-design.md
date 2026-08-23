# Parallax 제품 설계 초안

> **이 문서는 구현 이전의 제안서다** (2026-08-08). 왜 이렇게 만들었는지에 대한 기록으로
> 남겨 두며, 무엇이 실제로 만들어졌는지는 [`../README.md`](../README.md) 와
> [`handoff.md`](handoff.md) 가 말한다. 제안과 결과가 갈린 자리는 각 절에 표시했다.
>
> 갈린 자리를 지우지 않고 표시만 하는 이유는, 무엇을 고르지 *않았는지* 가 무엇을
> 골랐는지만큼 설명해 주기 때문이다.

## 1. 프로젝트 개요

Parallax는 내부 DNS와 외부 DNS를 한곳에서 선언하고 관리하는
split-horizon DNS control plane이다.

같은 도메인 이름이라도 요청자의 위치에 따라 서로 다른 주소를 제공하는
것이 핵심이다. 예를 들어 `example.com`은 다음과 같이 동작할 수 있다.

| DNS view | 응답 | 비고 |
| --- | --- | --- |
| Internal | `10.10.10.10` | 사내망 또는 VPN에서 사용하는 사설 주소 |
| External | `12.34.56.78` | 외부에서 사용하는 공인 주소 |
| External + Proxy | `12.34.56.78` | Cloudflare Proxy를 활성화한 외부 레코드 |

사용자는 내부 DNS와 Cloudflare를 각각 수정하는 대신 Parallax에 원하는
상태를 한 번 정의한다. Parallax는 내부 DNS와 Cloudflare DNS가 그 상태에
도달하도록 동기화한다.

## 2. 이름

프로젝트 이름은 `parallax`이며 팀 이름은 `tinyuniverse`이다. 기존 관리용
프로젝트인 `stardust`, `heliopause`와 같은 우주 테마를 이어간다.

Parallax는 관측 위치에 따라 같은 천체가 다르게 보이는 **시차**를 뜻한다.
동일한 도메인이 내부와 외부의 관측 위치에 따라 다른 결과를 반환하는
제품의 성격을 표현한다.

표현 문구 후보는 다음과 같다.

> Parallax by tinyuniverse — One domain, different views.

> DNS changes with where you stand.

관련 명칭은 다음 규칙을 사용할 수 있다.

- 서비스 및 저장소: `parallax`
- 장기 실행 서버: `parallaxd`
- CLI: `parallaxctl`
- 설정 파일: `parallax.yaml`
- 관리 화면: `Parallax Console`

> **실제로는 이 중 하나도 쓰지 않는다.** 서버와 CLI 가 같은 명령 계층을 공유하므로 이름을
> 나눌 이유가 없었고 둘 다 `parallax` 다. 설정 파일은 만들지 않았다 — 서버 환경설정은
> 환경변수, 운영 설정은 저장소에 있다. 관리 화면은 그냥 포털이라 부른다.

## 3. 핵심 모델

레코드에 내부/외부 필드를 고정하기보다 DNS `view`를 독립적인 개념으로
모델링한다. 이 방식은 향후 사내망, VPN, 개발망처럼 view가 늘어나거나
Cloudflare 이외의 provider가 추가될 때 확장하기 쉽다.

```yaml
zone: example.com

views:
  internal:
    records:
      - name: "@"
        type: A
        content: 10.10.10.10
        ttl: 60

  external:
    provider: cloudflare
    records:
      - name: "@"
        type: A
        content: 12.34.56.78
        ttl: auto
        proxied: true
```

> **view 를 독립 개념으로 둔 것은 그대로 갔다.** 다만 `provider` 는 desired state 에
> 넣지 않았다 — 어느 프로바이더가 어느 타깃을 맡는지는 배선이지 목표 상태가 아니고,
> 저장소의 설정과 자격증명이 정한다. 그리고 reconcile 가능한 view 는 `internal` 과
> `external` 둘로 제한했다: 어떤 프로바이더도 적용할 수 없는 목표 상태를 zone 이
> 가질 수 없게 하기 위해서다.

Parallax가 저장하는 설정은 **desired state**다. API 요청 시 외부 시스템을
동시에 직접 변경하는 대신 desired state와 revision을 먼저 저장하고,
reconciler가 각 대상의 실제 상태를 비교하여 수렴시킨다.

```text
                       Parallax
              API / Console / Source of Truth
                         |
               +---------+---------+
               |                   |
        Internal DNS          Cloudflare API
               |                   |
 example.com -> 10.10.10.10  example.com -> 12.34.56.78
                                  proxied: true/false
```

## 4. 제안 아키텍처

### Control plane

- Zone, view, record 관리 API
- 웹 기반 관리 화면
- 인증 및 역할 기반 권한 관리
- desired state와 revision 저장
- 변경 이력 및 감사 로그
- 적용 전 변경 내용 미리보기

### Internal DNS adapter

- CoreDNS 또는 PowerDNS 같은 검증된 DNS 엔진 사용
- Parallax가 zone data를 생성하거나 DNS 서버 API를 호출
- DNS 프로토콜과 authoritative server를 처음부터 직접 구현하지 않음

### Provider reconciler

- desired state와 Cloudflare의 실제 레코드 비교
- 레코드 생성, 수정 및 삭제
- TTL과 Cloudflare `proxied` 상태 관리
- 일시적인 API 실패에 대한 재시도
- provider별 적용 상태와 오류 기록
- 향후 Route 53 등 다른 provider adapter 추가 가능

### Persistence

- PostgreSQL을 기본 데이터베이스로 고려
- zone, view, record, provider credential 저장
- desired revision과 provider별 applied revision 저장
- 작업 결과 및 감사 로그 저장

## 5. API 형태 예시

```http
PUT /api/v1/zones/example.com/records/root
Content-Type: application/json
```

```json
{
  "name": "@",
  "type": "A",
  "views": {
    "internal": {
      "content": "10.10.10.10",
      "ttl": 60
    },
    "external": {
      "content": "12.34.56.78",
      "ttl": 300,
      "proxied": true
    }
  }
}
```

> **실제 API 는 view 를 경로에 둔다** — `PUT /api/v1/zones/{zone}/views/{view}/records/{id}`.
> 위처럼 한 요청에 두 view 를 담으면 한쪽만 유효한 경우를 표현할 수 없어서다. 전체 목록은
> [`../README.md`](../README.md) 의 HTTP API 절에 있다.

저장 성공과 실제 적용 성공은 서로 다른 상태다. 응답과 UI에서는 이를
구분해서 표시한다.

```json
{
  "desiredRevision": 42,
  "status": {
    "internal": "applied",
    "cloudflare": "pending"
  }
}
```

## 6. 중요한 설계 고려사항

### 내부 zone의 권한 범위

내부 DNS가 `example.com` 전체의 authoritative server가 되었지만 일부
레코드만 알고 있다면, 내부에서 정의하지 않은 공개 레코드가 NXDOMAIN으로
응답될 수 있다.

초기 설계에서는 공개 레코드를 내부 view의 기본값으로 가져오고 필요한
레코드만 내부 값으로 override하여 완전한 내부 zone을 합성하는 방식을
우선 고려한다. 대안은 다음과 같다.

- Cloudflare의 전체 zone을 내부 DNS에 복제
- CoreDNS 플러그인 등으로 특정 이름만 override
- 내부 전용 `internal.example.com` 서브도메인 사용

### Cloudflare Proxy

`proxied`는 단순 표시 옵션이 아니다. 지원 레코드 유형과 포트, 인증서,
원본 서버 접근 정책에 영향을 준다. API와 UI에서 지원 여부를 검증하고
사용자에게 영향을 안내해야 한다.

### 삭제 및 소유권 정책

초기에는 Parallax가 생성하거나 명시적으로 관리 대상으로 가져온 레코드만
수정하고 삭제하는 `managed-only` 정책을 사용한다. Zone 전체를 독점적으로
관리하는 `authoritative` 모드는 별도의 명시적 설정으로 추후 제공한다.

```yaml
managementPolicy: managed-only
```

### 보안

- Cloudflare Global API Key 대신 최소 권한 API Token 사용
- provider credential 암호화 저장
- 사용자 및 service account별 RBAC 적용
- 레코드 변경 전후 값과 실행 주체 기록
- 사설 IP가 외부에 노출될 때 경고
- 필요하면 변경 승인 절차 제공

## 7. MVP 범위

첫 번째 버전의 목표 범위는 다음과 같다.

- 단일 조직
- `internal`, `external` 두 view
- A, AAAA, CNAME, TXT 레코드
- CoreDNS 또는 PowerDNS 중 하나와 연동
- Cloudflare 단방향 reconcile
- TTL과 Cloudflare Proxy 관리
- 변경 미리보기와 수동 apply
- provider별 동기화 상태 및 오류 표시
- 변경 이력과 감사 로그
- PostgreSQL 기반 persistence

MVP 이후에는 다중 조직, 추가 DNS view, 자동 apply, 승인 workflow,
다중 Cloudflare 계정 및 다른 DNS provider 지원을 고려한다.

> **이 범위는 전부 구현됐다.** 내부 DNS 는 처음에 CoreDNS 로 갔다(PowerDNS 는 쓰지
> 않았다). 여기에 없던 것 중 실제로 들어간 것: 명령줄, 컨테이너 이미지, 프로세스 자체
> TLS 종단, 프로필 단위 자격증명 재사용, 저장소 기반 운영 설정, 보관 정책. 다중
> Cloudflare 계정은 프로필로 이미 가능하다.
>
> **그리고 그 뒤에 한 번 더 갈렸다 — 2026-08-16, `1db6f25`.** CoreDNS 와 PowerDNS
> 퍼블리셔를 걷어내고, 내부 뷰를 desired state 에서 **직접 응답하는 DNS 리스너를 안에
> 넣었다.** 제안서가 §5 에서 「검증된 DNS 엔진을 쓴다」고 적은 그 결정을 되돌린 것이다.
> 존 파일을 쓰는 쪽이 검증하기 쉽다는 이유는 맞았지만, 파일을 쓴 다음에도 그 파일을
> 읽는 프로세스가 언제 그것을 반영했는지는 여전히 알 수 없었다 — 그리고 그 간극이
> 이 제품에서 답을 틀리게 만드는 자리였다. 직접 답하면 목표 상태와 응답 사이에
> 파일도, 리로드도, 남의 프로세스도 없다.



## 8. 기술 결정

- 구현 언어: TypeScript (strict, 타입 스트리핑 — 빌드 없이 `.ts` 를 직접 실행)
- 런타임: Node.js 24 이상 · 패키지 매니저 pnpm 11 · 모듈 시스템 ESM
- Git 기본 브랜치: `main` · GitHub 저장소: `henryj-dev/parallax`
  (2026-08-23 에 `mack-erel/parallax` 에서 옮겨 왔다. 형제 프로젝트인
  `heliopause`·`barycenter` 와 같은 조직이다. 감사 리포트들이 대상으로 적은
  `mack-erel/parallax` 는 그 시점의 이름이므로 그대로 둔다.)

이 절이 한때 *"아직 확정하지 않았다"* 고 적어 두었던 것들은 모두 정해졌다.

| 항목 | 결정 | 이유 |
| --- | --- | --- |
| 웹 프레임워크 | **쓰지 않는다** | `node:http` 하나로 충분했다. 런타임 의존성은 `pg` 하나뿐이다 |
| DB 접근 계층 | **ORM 없이 `pg`** | 스키마가 작고, 트랜잭션과 advisory lock 을 직접 다뤄야 했다 |
| DNS 엔진 | ~~**CoreDNS** (RFC 1035 존 파일)~~ → **직접 답한다** | 파일을 쓰는 쪽이 검증하기 쉬웠지만, 그 파일을 읽는 쪽이 언제 반영했는지는 알 수 없었다. `1db6f25` 에서 내장 리스너로 바꿨다 — §5 각주 참조 |
| API 명세 도구 | **쓰지 않는다** | 명령 계층이 단일 정의라 명세를 따로 두면 두 번째 진실이 된다 |
| 배포 | **컨테이너 이미지** | `Dockerfile` 하나. API·포털·CLI 가 한 프로세스라 이미지도 하나다 |

그리고 제안서에 없던 결정이 하나 있다 — **모든 조작은 명령으로 한 번만 정의하고 GUI 와
CLI 가 같은 계층에 붙는다.** 동작을 두 곳에 두면 갈라지고, 갈라진 뒤에야 갈라진 줄 안다.

> **2026-08-23 에 공개했다.** 그때 §2 의 형제 프로젝트 이름은 **남기기로** 정했다 —
> 이름만으로는 아무 곳에도 닿지 않고, 지우면 이 문서가 기록인 이유가 함께 지워진다.
> 함께 정한 것들은 [`handoff.md`](handoff.md) 의 「닫힌 결정」에 있다.
