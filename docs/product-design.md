# Parallax 제품 설계 초안

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

## 8. 현재 기술 결정

현재 저장소에 실제로 적용된 결정은 다음과 같다.

- 구현 언어: TypeScript
- 런타임: Node.js 24 이상
- 패키지 매니저: pnpm 11
- 모듈 시스템: ESM
- TypeScript strict mode 사용
- Git 기본 브랜치: `main`
- GitHub 저장소: `mack-erel/parallax` (private)

아직 웹 프레임워크, 데이터베이스 접근 계층, DNS 엔진, API 명세 도구 및
배포 방식은 확정하지 않았다. 앞 절의 구성은 구현을 시작하기 위한 제안이다.
