# 프로바이더 어댑터를 하나 더 붙이려면

`ProviderAdapter` 는 메서드 셋짜리 인터페이스다. 어려운 것은 메서드가 아니라
**소유권**이고, 이 문서는 거기에 대해서만 길다.

규범은 이 문서가 아니라 [`test/adapters/provider-contract.test.ts`](../test/adapters/provider-contract.test.ts)
다. 거기에 열한 개의 규칙이 있고 구현마다 같은 것을 묻는다. 새 어댑터를 쓴다면
**하네스를 하나 추가하는 것이 첫 번째 할 일**이지 마지막 할 일이 아니다 — 그 스위트가
곧 무엇을 만들어야 하는지의 명세다.

이 문서는 그 규칙들이 **왜** 그런지를 적는다.

---

## 지금 있는 것

| | 무엇 |
|---|---|
| `src/adapters/cloudflare.ts` | 실제 외부 프로바이더 |
| `src/adapters/rfc2136.ts` | RFC 2136 동적 업데이트. BIND·Knot·PowerDNS 에 한 번에 붙는다. internal 뷰용 |
| `src/infrastructure/file-provider.ts` | 로컬 폴백. 단일 노드·개발용 |
| `src/infrastructure/in-memory.ts` | 검사용. **계약 스위트를 함께 통과한다** |
| `src/adapters/router.ts` | `<존>/<뷰>` 대상을 구현으로 보낸다 |

⚠️ **한때 셋이 더 있었다** — CoreDNS(존 파일), PowerDNS(SQL). `1db6f25` 에서 지웠고,
이유가 「인터페이스가 안 맞아서」가 **아니다**: 이 프로세스가 스스로 DNS 를 답하게 되면서
아무도 돌리지 않는 코드가 됐기 때문이다. 그래서 이 인터페이스는 한때 **실제 프로바이더
셋**(Cloudflare·CoreDNS·PowerDNS)에 파일과 인메모리까지 얹고 돌았다. 새로 쓰는 쪽에게
이건 좋은 소식이다 — 추상화가 한 프로바이더 모양에 테두리만 그린 것은 아니라는 뜻이다.

지운 커밋이 무엇을 포기했는지도 적어 뒀다: **publish 경로는 Parallax 가 죽어도 internal
뷰가 함께 죽지 않는 유일한 배치였다.** 지금은 그 속성을 다른 데서 얻는다 — AXFR·IXFR·
NOTIFY·TSIG 를 이 프로세스가 primary 로서 말하므로, 세컨더리를 두면 된다. 어댑터를
하나도 쓰지 않고서.

---

## 세 메서드

```ts
list(target: string): Promise<ProviderRecord[]>
apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void>
serviceOwnership?(target: string): Promise<ServiceOwnedHostname[] | undefined>
```

`target` 은 항상 `<존>/<뷰>` 이고 뷰는 `internal` 또는 `external` 이다. 어댑터는 자기가
받은 대상만 본다.

`apply` 는 **연산 하나씩** 불린다. 배치가 아니다 — 프로바이더가 네트워크 너머에 있고
중간에 실패하면 뷰가 절반만 적용된 채 남는데, 그걸 `completedOperations` 로 보고하려면
어디까지 갔는지를 알아야 하기 때문이다.

---

## 소유권 — 이 인터페이스의 전부

Parallax 의 약속은 「자기가 소유한 것만 건드린다」이고, 그 약속은 **레코드마다 붙는
표시**로 지켜진다. `src/adapters/ownership.ts` 가 만든다:

```ts
ownershipComment(target, recordId, secret) // → 문자열
readOwnershipComment(marker, secret, target) // → { recordId } | undefined
```

HMAC 이고, **대상이 서명 안에 들어간다.** 그래서 `example.com/internal` 의 표시를 단
`example.com/external` 어댑터는 그것을 자기 것으로 읽지 않는다. 뷰 하나가 다른 뷰의
레코드를 덮어쓰는 일이 여기서 막힌다.

### 이 표시는 프로바이더에 있어야 한다. Parallax 안이 아니라.

이게 핵심이고, 새로 쓰는 사람이 가장 먼저 타협하고 싶어지는 지점이다. 「어차피 우리가
쓴 걸 우리가 아는데 왜 프로바이더에 두나, 로컬에 표만 하나 두면 되지」 —

**안 된다.** 표시가 프로바이더에 있는 이유는 Parallax 가 자기 상태를 잃어도, 다른
인스턴스가 붙어도, 처음 보는 존을 adopt 해도 **무엇이 우리 것인지 알아낼 수 있게**
하기 위해서다. 로컬 표는 그 순간 전부 무너진다. 계약 스위트의 마지막 규칙(`reopen`)이
정확히 이것을 묻는다.

### 프로바이더에 넣을 필드가 없으면

**대부분 없다.** Cloudflare 가 레코드 코멘트를 가진 게 오히려 예외다. 지금까지 나온
답 넷:

| 프로바이더 | 표시가 사는 곳 |
|---|---|
| Cloudflare | 레코드의 `comment` 필드 |
| PowerDNS | 곁테이블 `parallax_powerdns_ownership`, 레코드 id 로 키. **여전히 프로바이더 안이다** |
| CoreDNS | 존 파일의 줄 주석 |
| **RFC 2136** | 존 안의 예약된 이름 TXT — `_parallax.<이름>` |

📌 규칙은 「필드를 찾아라」가 아니라 **「그 프로바이더가 문자열을 붙들어 줄 자리를
찾아라」**다. PowerDNS 는 자기 데이터베이스에 우리 테이블을 하나 만들었고, 그건 로컬
표가 아니다 — 프로바이더가 그 데이터를 갖고 있으므로 새 인스턴스가 읽어 낼 수 있다.

### 어떤 종류의 표를 만들지 말아야 하나

- Parallax 의 상태 파일이나 데이터베이스에 두는 소유권 표 → `reopen` 규칙에는 통과할
  수 있지만(같은 저장소니까) **다른 인스턴스와 adopt 에서 무너진다**
- 레코드 내용에서 유도한 표시(내용 해시만) → 같은 이름·타입·내용을 사람이 손으로
  만들면 우리 것으로 읽힌다
- 이름 규칙만으로 판단(`_parallax` 로 시작하면 우리 것) → 서명이 없으므로 아무나
  우리 것인 척 만들 수 있고, 그러면 우리가 남의 것을 지운다

---

## `serviceOwnership` 의 세 가지 답

가장 잘못 구현되기 쉬운 자리다. 답이 셋이고 **둘은 같고 하나만 다르다**:

| 답 | 뜻 | 결과 |
|---|---|---|
| `undefined` | 말할 수 없다 | 기존 표시가 그대로 유지된다 |
| **던진다** | 말할 수 없다, **그리고 이유가 있다** | 위와 같고, 이유가 경고로 운영자에게 간다 |
| `[]` | 어떤 서비스도 이 이름들을 소유하지 않는다 | 🔴 **레코드가 풀린다** |

Cloudflare 는 account id 가 없으면 **던진다**. 그게 옳다 — 「account id 와 토큰 권한
둘을 채워라」는 고칠 수 있는 말이고, `undefined` 는 그 말을 실을 자리가 없다.

⚠️ 모르면서 `[]` 를 답하면 운영자에게 「이 레코드는 아무도 안 쓰니 편집해도 된다」고
말하는 것이고, 그 편집이 Worker 바인딩을 끊는다. 메서드를 구현하지 않는 편이 낫다.

---

## 새 어댑터를 붙이는 순서

1. **계약 스위트에 하네스를 먼저 쓴다.** `open()` 이 빈 프로바이더를,
   `seedUnmanaged()` 가 「남이 넣은 레코드」를, `reopen()` 이 같은 데이터 위의 새
   어댑터를 준다. 이 셋을 못 주겠으면 그 어댑터는 아직 설계가 안 끝난 것이다.
2. 규칙 열한 개를 통과시킨다. 통과 못 하는 것이 있으면 `exempt` 에 **이유와 함께**
   적는다 — 스위치가 아니라 문장이 붙은 예외라, 다음 사람이 읽는다.
3. `RoutingProviderAdapter` 에 등록한다. 외부 뷰는 `registerExternal(zone, adapter)`,
   내부 뷰는 생성자의 `internal` — RFC 2136 어댑터가 지금 그 자리에 있다.
4. 설정을 `src/config.ts` 에 연다.

RFC 2136 어댑터가 이 순서로 만들어졌다. 규칙 열한 개가 먼저 있었고, 하네스가 어댑터
본체보다 먼저 있었고, 다 쓰고 나니 **첫 실행에 열한 개가 전부 통과했다.** 스위트가
명세 노릇을 한 것이고, 그게 이 파일들이 존재하는 이유다.

면제를 하나 지우는 것도 이 스위트가 하는 일이다: in-memory 프로바이더는 소유권 검사를
하지 않았고, 스위트가 그것을 물었고, 답이 「진짜 어댑터 둘은 한다」였다. 그래서 면제가
아니라 구현이 바뀌었다.
