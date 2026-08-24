# Parallax 코드 전수검수 리포트 — 2026-08-23

> ## 이 리포트의 성격
>
> **의뢰는 "문서를 제외한 모든 코드를 살펴보고, 필수 구현 누락·버그·이슈가 될 만한
> 지점과 추가하면 좋을 기능을 전수검수" 였다.** 보안 감사가 아니라 구현 검수이므로
> 발견 사항을 보안/기능으로 나누지 않고 하나의 심각도 축에 올리고, 각 항목에
> `성격` 을 붙였다. 형식은 [`2026-08-22-implementation-and-security-audit.md`](2026-08-22-implementation-and-security-audit.md)
> 를 따랐다. **무엇을 어떤 순서로 고칠지는
> [`2026-08-23-remediation-plan.md`](2026-08-23-remediation-plan.md) 에 있다.**
>
> **읽은 범위는 `src/` · `cmd/` · `public/` · `scripts/` 의 전 파일이다.**
> `README*.md` · `AGENTS.md` · `docs/` 는 대상에서 제외했으나, 발견 사항이 문서와
> 어긋나는지 확인해야 하는 자리에서는 해당 문단만 열었다(§4 M1, §6 I4).
> 기존 감사 리포트는 §7 대조를 위해 검수를 마친 **뒤에** 열었다.
>
> ⚠️ **`재현됨` 배지가 붙은 다섯 항목(H1 · H2 · H3 · M7 · I3)은 이 저장소에서
> 실제로 실행해 얻은 결과다.** 나머지는 코드를 읽어 확인한 것이며, 그렇게 적었다.
> 추측으로 적은 항목은 없다 — 확신이 서지 않은 것은 아예 넣지 않았다.
>
> **동적 확인은 전부 폐기 가능한 스크래치패드 스크립트로만 했다.** 인메모리 상태와
> 루프백 포트(15353 · 15354 · 15355)만 썼고, 실제 `.env` 는 열지 않았으며, `pnpm
> verify:*` 도 돌리지 않았다. CLI 재현에는 스크래치패드 안의 임시 상태 파일 경로를
> 넘겼으므로 `data/` 는 건드리지 않았다.

---

## 0. 대상 스냅샷

```
시각        2026-08-23 (Asia/Seoul)
브랜치      main
HEAD        0627aa7  docs(agents): 기록이 또 한 커밋 뒤처져 있었다 — 기준선과 「해소」를 실측으로 맞춘다
작업 트리    깨끗
```

기준선 검사는 검수 시작 시점에 전부 통과했다. 즉 아래 발견 사항 중 **컴파일러도
테스트도 잡지 못하는 것이 몇 개인지**가 이 표의 요점이다.

```
$ pnpm check          → 0    (tsc --noEmit -p tsconfig.test.json)
$ pnpm run check:portal → 0  (tsc -p tsconfig.portal.json)
$ pnpm test           → tests 770 / pass 770 / fail 0 / skipped 0 / todo 0
$ grep -rn 'TODO|FIXME|@ts-ignore|test.skip|test.only' src cmd public test → 0건
```

⚠️ **인용한 `파일:줄` 은 전부 `0627aa7` 기준이고, 앞으로의 수정으로 움직인다.** 줄
번호와 함께 심볼 이름을 적어 두었으니, 어긋나면 심볼로 찾을 것. 이 리포트를 쓰면서
한 번 틀렸고 — 처음 적은 번호 열두 개가 다른 줄을 가리켰다 — 커밋 전에 전부 다시
뽑아 맞췄다. `AGENTS.md` 가 경고하는 그 staleness 는 리포트 자신에게도 온다.

규모.

| | |
| --- | --- |
| `src/` + `cmd/` | 16,275 줄 (TypeScript, 46 파일) |
| `public/` | 3,003 줄 (포털 JavaScript, 7 모듈) |
| `test/` | 770 케이스 / 119 스위트 / 63 파일 |
| 런타임 의존성 | `pg` 하나 |

---

## 1. 방법 — 무엇을 읽었고 무엇을 돌렸나

읽기는 전수다. 아래는 그 위에서 **실행해 확인한** 것들이며, 각 항목이 어느 발견으로
이어졌는지를 적는다.

| 확인 | 방법 | 결과 |
| --- | --- | --- |
| CLI 출력 무결성 | `parallax openapi --json` 을 파이프 · 파일 · 파서에 각각 흘림 | **H1** |
| AXFR 크기 한계 | 레코드 800개 / 2,500개 존을 만들고 TCP 로 AXFR | **H2** |
| 와일드카드 확장 | `b` 와 `*` 가 함께 있는 존에 `a.b.example.com` 질의 | **H3** |
| 토큰 준비 비용 | `prepareConfig` 의 중복 검사 루프를 그대로 재현해 n 별 측정 | **M7** |
| 메트릭 리셋 | `resetMetrics()` 전후로 같은 카운터를 올리고 `render()` 비교 | **I3** |
| TCP 프레이밍 산술 | 65535 초과 길이의 `writeUInt16BE` 거동 | H2 의 근거 |

읽었지만 **문제를 찾지 못한** 경로는 §8 에 따로 적었다. 발견만 나열하면 어디까지
보았는지 알 수 없기 때문이다.

---

## 2. 발견 사항 개요

| # | 심각도 | 성격 | 제목 | 재현 |
| --- | --- | --- | --- | --- |
| H1 | High | 데이터 무결성 | CLI 출력이 파이프로 나가면 64 KiB 에서 잘린다 | ✅ |
| H2 | High | 가용성 | 64 KiB 를 넘는 AXFR 이 0 바이트를 주고 연결만 끊긴다 | ✅ |
| H3 | High | 정확성 | 와일드카드가 존재하는 하위 이름을 지나쳐 확장된다 (RFC 4592) | ✅ |
| M1 | Medium | 운용성 | ownership secret 누락이 엉뚱한 환경변수를 가리키는 실패로 나온다 | |
| M2 | Medium | 정확성 | 포털이 실패한 apply 를 성공으로 보고한다 | |
| M3 | Medium | 운용성 | 존 삭제가 버려진 프로바이더 대상을 어디에도 알리지 않는다 | |
| M4 | Medium | 가용성 | 죽은 파일 락 회수가 컨테이너에서 동작하지 않는다 | |
| M5 | Medium | 가용성 | 파일 백엔드의 존 락이 apply 전체를 15초 안에 요구한다 | |
| M6 | Medium | 가용성 | Cloudflare 호출에 재시도가 없어 뷰가 부분 적용으로 남는다 | |
| M7 | Medium | 성능 | 요청마다 토큰 다이제스트 준비가 최소 2회, O(n²) 로 돈다 | ✅ |
| L1 | Low | 가용성 | Postgres 풀에 한계값이 하나도 설정되어 있지 않다 | |
| L2 | Low | 성능 | DNS 질의마다 존 레코드를 여러 번 전수 스캔한다 | |
| L3 | Low | 성능 | 파일 백엔드가 레코드 하나에 상태 전체를 다시 쓴다 | |
| L4 | Low | 성능 | 포털이 서버 페이지네이션을 클라이언트에서 전부 소진한다 | |
| L5 | Low | 보안 | EDNS 쿠키에 만료가 없다 | |
| L6 | Low | 정확성 | DNS 스펙 잔가시 둘 (라벨 안의 점 · CNAME 체인) | |
| I1 | Info | 정합성 | 제거된 CoreDNS 어댑터의 잔재 5곳 | |
| I2 | Info | 정합성 | 문서 주석 하나가 엉뚱한 함수 위에 붙어 있다 | |
| I3 | Info | 정합성 | `resetMetrics()` 가 카운터를 영구히 고아로 만든다 | ✅ |
| I4 | Info | 문서-구현 | OIDC 엔드포인트 하드코딩 — **이전 리포트 L5 의 재확인** | |

**High 3 · Medium 7 · Low 6 · Info 4 = 20건.**

---

## 3. 발견 사항 — 심각도 High

세 건 다 재현했고, 세 건 다 **조용히** 실패한다. 예외도 로그도 카운터도 남지 않고,
종료 코드나 상태 코드는 성공을 가리킨다.

### H1. CLI 출력이 파이프로 나가면 64 KiB 에서 잘린다

- **성격:** 데이터 무결성
- **위치:** `cmd/parallax/main.ts:82` — `process.exit(exitCode)`.
  같은 파일 `:24` · `:38` · `:41` 의 조기 종료 3곳도 같다.

**재현.**

```
$ parallax openapi --json | wc -c
   65536          # 3회 모두 동일

$ parallax openapi --json > full.json ; wc -c < full.json
  219142          # 파일로는 온전. JSON.parse 통과

$ parallax openapi --json | node -e '...JSON.parse(stdin)...'
  pipe: TRUNCATED — Unterminated string in JSON at position 65536
```

**원인.** stdout 이 파이프면 Node 의 `write()` 는 비동기다. `process.exit()` 는
대기 중인 쓰기를 버리고 즉시 나간다. 정규 파일로 리다이렉트할 때만 온전한 이유가
이것이다 — 파일 디스크립터에는 동기로 쓴다. 65536 은 파이프 버퍼 크기이지 이
프로그램이 아는 수가 아니다.

**영향.** 64 KiB 를 넘는 모든 출력이 대상이다. 확인된 것만 해도 `openapi`,
`zone get`, `record list --limit 500`, `revision get`, `history`. `| jq`, `| tee`,
CI 스크립트가 전부 깨진 JSON 을 받으며 **종료 코드는 0** 이다. 잘림이 값의 한가운데서
일어나므로 파서가 잡아 주기는 하지만, 파서를 거치지 않는 파이프라인은 절반짜리
데이터를 그대로 쓴다.

⚠️ 이 프로젝트는 CLI 와 HTTP 가 같은 명령 레지스트리를 공유하는 것을 설계의 축으로
삼는다. HTTP 쪽에는 이 문제가 없으므로, **같은 명령이 두 경로에서 다른 답을 준다.**

**수정 제안.** `process.exitCode = exitCode` 로 두고 `process.exit()` 를 지운다.
이벤트 루프가 비면 정상 종료하며, 이 프로세스가 붙잡는 것은 이미 전부 `unref()` 되어
있다. 즉시 종료가 반드시 필요하다면 stdout 의 `drain` 을 기다린 뒤 나가야 한다.

**회귀 테스트.** `parallax openapi --json` 을 파이프로 받아 `JSON.parse` 가
성공하는지. 출력이 219 KiB 이므로 파이프 버퍼를 확실히 넘긴다.

---

### H2. 64 KiB 를 넘는 AXFR 이 0 바이트를 주고 연결만 끊긴다

- **성격:** 가용성
- **위치:** `src/dns/server.ts:343` — `handleMessage()` 안의 `framed.writeUInt16BE(reply.length, 0)`

**재현.**

| 존 크기 | 수신 바이트 | 결과 |
| --- | --- | --- |
| A 레코드 800개 | 45,687 | 정상 전송 |
| A 레코드 2,500개 | **0** | 소켓 destroy, 무음 |

```
$ node -e 'Buffer.alloc(2).writeUInt16BE(70000, 0)'
ERR_OUT_OF_RANGE  The value of "value" is out of range. It must be >= 0 and <= 65535.
```

**원인.** DNS-over-TCP 길이 접두어는 부호 없는 16비트다. 답이 65535 바이트를 넘으면
`writeUInt16BE` 가 던지고, 그 예외는 바로 옆의 `.catch(() => socket.destroy())` 가
삼킨다. `onUnanswerable` 도 `parallax_dns_unanswerable_replies_total` 도 오르지 않는다.

AXFR 은 원래 존을 **여러 메시지에 나눠** 보내는 프로토콜인데(RFC 5936 §2.2) 이
구현은 존 전체를 한 메시지에 담는다(`answerFromZone` 의 AXFR 분기가 SOA-레코드
전부-SOA 를 한 `answers` 배열에 넣는다). 일반 TCP 질의도 RRset 이 65535 를 넘으면
같은 벽에 부딪힌다.

**영향.** 세컨더리가 일정 크기를 넘긴 존을 전송받지 못한다. 세컨더리 쪽에는 "연결이
끊겼다" 만 남고 이쪽에는 아무것도 남지 않는다. `PARALLAX_DNS_TRANSFER_ALLOW` 는
기본이 비어 있어 지금 배포에서 도달 가능한지는 별개지만, 켜는 순간 존 크기에 보이지
않는 상한이 생긴다.

📌 **이것은 이전 리포트 H2 의 한 층 위다.** 그때는 *레코드* 하나의 RDATA 가 64 KiB 를
넘으면 질의가 사라졌고, 수정은 레코드별 가드(`servableRdata`) + SERVFAIL +
`onUnservable` + 카운터로 들어갔다. **메시지 전체의 같은 한계는 그때 함께 처리되지
않았다.** 한 층을 고치고 그 위층을 남긴 형태다.

**수정 제안.** 최소한 `writeUInt16BE` 를 예외 경계 안으로 옮겨 `onUnanswerable` 로
보고할 것 — 지금은 실패했다는 사실 자체가 어디에도 남지 않는다. 제대로 고치려면
AXFR 을 여러 메시지로 나눠 스트리밍하고, 일반 답변은 65535 에서 끊어 TC 를 세운다.

**회귀 테스트.** 존 하나의 wire 크기가 65535 를 넘도록 만든 뒤 AXFR 이 완결되는지,
그리고 그때까지는 최소한 `onUnanswerable` 이 불리는지.

---

### H3. 와일드카드가 존재하는 하위 이름을 지나쳐 확장된다

- **성격:** 정확성 (RFC 4592 §3.3.1 위반)
- **위치:** `src/dns/server.ts:660` — `wildcardMatch()`

**재현.** 존 `example.com` = { `b` A 203.0.113.5, `*` A 203.0.113.99 }

```
b.example.com        rcode=0 answers=1     // 맞음
x.example.com        rcode=0 answers=1     // 맞음 — 와일드카드
a.b.example.com      rcode=0 answers=1     // 틀림 — NXDOMAIN 이어야 한다
```

**원인.** `wildcardMatch` 는 질의 이름의 부모부터 위로 걸으며 처음 만나는 `*` 에서
멈춘다. 그런데 도중에 **존재하는 이름**을 만나도 멈추지 않는다. `a.b.example.com` 의
closest encloser 는 `b.example.com` 이고 source of synthesis 는 존재하지 않는
`*.b.example.com` 이므로 정답은 NXDOMAIN 인데, 한 칸 더 올라가 `*.example.com` 을 쓴다.

함수의 주석은 의도를 정확히 적어 두었다 — *"`*.eu.example.com` 이 `shop.eu.example.com`
에 답하고 `*.example.com` 은 기회를 얻지 못한다"*. 그 문장이 참이 되려면 위로 걷는
루프가 **존재하는 이름에서 멈춰야** 하는데, 지금은 와일드카드에서만 멈춘다.

**영향.** 같은 desired state 를 Cloudflare 나 존 파일로 게시했을 때와 내부 뷰의 답이
갈린다. 이 프로젝트의 전제 — 안과 밖이 같은 desired state 에서 나온다 — 와 정면으로
어긋나는 종류의 divergence 이고, 증상은 "밖에서는 없는 이름인데 안에서는 답이 온다"
라서 아무도 오래 눈치채지 못한다.

**수정 제안.** 위로 걷다가 레코드를 가졌거나 empty non-terminal 인 이름을 만나면 그
자리에서 멈추고 그 이름의 `*.` 만 확인한다. 마침 `answerFromZone` 안에 그 판정이
이미 있다 — `exists` 를 계산하는 `zone.records.some(... endsWith('.' + name))` 이
그것이므로, 함수로 빼서 walk 안에서 재사용하면 된다.

**회귀 테스트.** 위 세 줄 그대로. 특히 세 번째가 NXDOMAIN 이어야 한다.

---

## 4. 발견 사항 — 심각도 Medium

### M1. ownership secret 누락이 엉뚱한 환경변수를 가리키는 실패로 나온다

- **성격:** 운용성
- **위치:** `src/runtime.ts:95` → `src/adapters/cloudflare.ts:63` → `src/runtime.ts:119`

**경로.** `runtime.ts` 가 `config.ownershipSecret ?? ""` 를 넘긴다 →
`CloudflareProviderAdapter` 생성자가 생성 시점 검증으로 `ownershipComment(...)` 를
호출한다 → `assertSecret` 이 `"ownership secret must contain at least 32 bytes"` 를
던진다 → `credentials.initialize()` 의 catch 가 그것을
`". Check PARALLAX_CREDENTIAL_MASTER_KEY matches the key that sealed the stored
credentials."` 로 감싸고 `process.exit(1)`.

**영향.** 진짜 원인은 `PARALLAX_OWNERSHIP_SECRET` 인데 메시지는 **다른 키를 고치라고
안내한다.** 마스터 키를 재생성하면 저장된 자격증명 전부를 못 읽게 되므로, 안내를 그대로
따르는 것이 상황을 악화시킬 수 있는 방향이다.

그리고 이 상황을 미리 잡아 주는 곳이 없다.

| 검사 지점 | ownership secret 확인 |
| --- | --- |
| `readConfig()` | 값이 있으면 32바이트인지만 본다. **없는 것은 허용** |
| `parallax config check` | 보고 항목에 없다 |
| `index.ts` 기동 경고 | `credentialMasterKey` 만 경고한다 |

같은 저장소의 `src/application/fallback-domains.ts:216` 는 정확히 이 상황에 정확한
문장을 낸다 — `"PARALLAX_OWNERSHIP_SECRET is required to tell this control plane's
overrides from everyone else's"`. **두 경로가 서로 다르게 실패한다.**

**수정 제안.** 자격 마스터 키가 있는데 ownership secret 이 없으면 `readConfig` 에서
이름을 대고 거절하거나 — 이 조합으로는 Cloudflare 를 쓸 수 없으므로 —, 최소한
`config check` 의 보고 항목과 기동 경고에 넣는다.

---

### M2. 포털이 실패한 apply 를 성공으로 보고한다

- **성격:** 정확성
- **위치:** `public/store.js:413` — `apply()` · `src/application/control-plane.ts:#apply`

**내용.** `ControlPlane.apply()` 는 프로바이더 실패를 **던지지 않는다.**
`statuses[].state = "failed"` 로 담아 돌려주고 HTTP 는 200 이다. 그 설계는 옳다 —
뷰 하나의 실패가 다른 뷰의 결과를 가릴 이유가 없다. 그런데 포털 store 는
`result.statuses` 를 전혀 보지 않고 언제나 이렇게 한다.

```js
notice(result?.revision ? "apply.startedRevision" : "apply.started", ...);
```

`notice` 의 기본 레벨은 `"success"` 다(`public/store.js:80`).

**영향.** 모든 뷰가 실패해도 화면에는 초록색 성공 알림이 뜬다. 그다음
`selectZone()` 이 상태를 다시 읽어 점이 빨갛게 바뀌지만, 그 사이 조작자는 적용이
끝난 것으로 읽는다. 알림 문구가 `"started"` 인 것도 오해를 돕는다 — apply 는 동기
연산이라 돌아온 시점에 이미 끝나 있다.

**수정 제안.** `overallApplyState(result.statuses)` 를 그대로 쓴다. 이미
`control-plane.ts` 에서 export 되어 있고 서버가 존 목록의 점을 칠할 때 쓰는 바로 그
함수다 — 두 곳이 같은 판정을 공유하게 된다. `failed` 면 error 레벨로, 실패한 뷰
이름과 `completedOperations/plannedOperations` 까지 말해 준다. 후자는 **부분 적용**
여부라서 조작자가 재시도할지 프로바이더를 직접 볼지를 가르는 값이다.

---

### M3. 존 삭제가 버려진 프로바이더 대상을 어디에도 알리지 않는다

- **성격:** 운용성
- **위치:** `public/store.js:286` — `deleteActiveZone()`

**내용.** 포털은 삭제를 언제나 `abandonProviderRecords: true` 로 보낸다. 확인 문구에는
그 사실이 적혀 있으므로(`public/i18n.js:73`) 동의 자체는 받은 셈이다. 문제는 결과다 —
응답의 `abandonedProviderTargets` 를 무시하고 `removedProviderRecords.length` 만
알린다.

**영향.** 토큰이 깨졌거나 프로바이더가 닿지 않는 상태로 존을 지우면, Cloudflare 에
살아 있는 레코드가 **아무도 추적하지 않는 채로** 남는다. 화면은 "삭제됨" 만 말한다.
서버가 그 배열을 굳이 돌려주는 이유가 바로 이 blast radius 를 보여주기 위함이고,
`control-plane.ts` 의 주석에도 그렇게 쓰여 있다.

CLI 는 이 값을 출력한다(`main.ts` 의 `render()` 가 배열을 그대로 찍는다). **같은
연산이 두 경로에서 다른 것을 보여준다.**

**수정 제안.** `abandonedProviderTargets.length > 0` 이면 warning 레벨 알림으로 대상
목록을 그대로 보여준다. 문구는 "이 대상들에 남은 레코드는 이제 Parallax 가 추적하지
않는다" 여야 한다 — "실패" 가 아니다.

---

### M4. 죽은 파일 락 회수가 컨테이너에서 동작하지 않는다

- **성격:** 가용성
- **위치:** `src/infrastructure/atomic-file.ts:113` — `reclaimDeadLock()`

**내용.** 락이 죽었는지를 두 조건으로 판정한다: 락 파일에 적힌 `hostname` 이 현재
호스트와 같고, `process.kill(pid, 0)` 이 `ESRCH` 를 내는 것. inode 재확인까지 붙어
있어 교체된 락을 지우지 않는 배려도 되어 있다.

그런데 컨테이너에서는 두 전제가 모두 깨진다. hostname 은 Pod 이름으로 고정이고,
서버는 보통 **pid 1** 이다. 크래시 후 재시작하면 남은 락 파일의 pid 1 이 살아 있는
**새** 프로세스이므로 영원히 "살아 있는 writer" 로 읽힌다.

**영향.** 기본값인 파일 백엔드에서 모든 쓰기가 `LOCK_TIMEOUT_MS`(15초) 뒤 실패한다.
사람이 락 파일을 직접 지워야 풀린다 — 에러 메시지가 경로를 대며 그렇게 안내하는 것은
좋지만, Kubernetes 에서 OOMKill 한 번이면 그 상태가 되고 그때 사람이 붙어 있을
이유가 없다.

**수정 제안.** 락 파일에 boot id(`/proc/sys/kernel/random/boot_id`) 나 프로세스 시작
시각(`process.hrtime` 기준이 아니라 `Date.now() - process.uptime()*1000`) 을 함께 적고
비교한다. 같은 pid 라도 시작 시각이 다르면 다른 프로세스다. 값싼 대안으로는 mtime 이
충분히 오래된 락을 회수 조건에 추가하는 방법이 있으나, 그것만으로는 느린 writer 를
죽은 것으로 오판할 수 있다.

---

### M5. 파일 백엔드의 존 락이 apply 전체를 15초 안에 요구한다

- **성격:** 가용성
- **위치:** `src/infrastructure/file-state.ts` — `FileApplyLock` → `withFileLock`
  (`LOCK_TIMEOUT_MS = 15_000`)

**내용.** `withZoneLock` 이 파일 락을 프로바이더 네트워크 호출 전체 동안 잡는다.
같은 프로세스 안에서는 `ControlPlane.#operationTails` 가 먼저 직렬화하므로 보이지
않지만, 다른 프로세스 — 예를 들어 `kubectl exec` 로 띄운 CLI — 는 15초 후
`timed out acquiring file lock` 으로 실패한다.

**영향.** 레코드가 많은 존의 Cloudflare apply 는 15초를 쉽게 넘긴다. `#apply` 가
계획된 연산을 **하나씩 순차로** 보내기 때문이다(M6 참조). 서버가 apply 하는 동안
CLI 는 그 존을 건드릴 수 없고, 실패 메시지는 "락이 남아 있으니 지우라" 고 안내하는데
이 경우엔 지우면 안 된다 — 정말 살아 있는 writer 다.

**수정 제안.** 상태 파일 락과 존 apply 락을 분리한다. 프로바이더 I/O 중에 상태 파일을
잡고 있을 필요는 없다 — 커밋 순간에만 필요하다. 분리가 어렵다면 존 락의 타임아웃만
별도로 열어 두고, 타임아웃 메시지가 "락을 지우라" 대신 "다른 apply 가 진행 중일 수
있다" 를 함께 말하게 한다.

---

### M6. Cloudflare 호출에 재시도가 없어 뷰가 부분 적용으로 남는다

- **성격:** 가용성
- **위치:** `src/adapters/cloudflare.ts:#request` · `src/application/control-plane.ts:#apply`

**내용.** `#request` 는 429 와 5xx 를 그대로 실패로 만든다. 백오프도 `Retry-After`
존중도 없다. `#apply` 는 계획된 연산을 하나씩 보내다가 첫 실패에서
`PartialApplyError` 로 멈춘다.

**영향.** Cloudflare 의 1200 req / 5 min 한도에 큰 존이 걸리기 쉽고, 걸리면 그 뷰는
**절반만 적용된 채** 리졸버가 답하는 상태로 남는다. 상태에
`completedOperations`/`plannedOperations` 가 기록되고 감사에도 남는 것은 좋은 설계고
이전 리포트 이후 들어온 것으로 보이지만, 그 상황 자체를 줄이는 장치가 없다.

**수정 제안.** 429 와 5xx 에 지수 백오프 재시도를 넣고 `Retry-After` 를 존중한다.
DNS 레코드 연산은 멱등에 가깝다 — create 는 아니지만, 재시도 전에 `list` 로 확인할 수
있다. 왕복 자체를 줄이려면 Cloudflare 의 batch 엔드포인트(`/dns_records/batch`) 를
쓰는 방법이 있고, 이 코드베이스는 이미 `record batch` 라는 같은 모양의 개념을 갖고
있다.

---

### M7. 요청마다 토큰 다이제스트 준비가 최소 2회, O(n²) 로 돈다

- **성격:** 성능
- **위치:** `src/index.ts:110` — `securityConfig()` · `src/security/http-authorization.ts:prepareConfig`
  · `src/http/api.ts:roleOf`

**내용.** 세 가지가 겹친다.

1. `createAuthorizedHandler` 는 *"제공자가 다른 객체를 돌려줄 때까지 준비된 다이제스트를
   재사용한다"* 고 적혀 있고, 캐시를 **객체 동일성**(`cachedConfig !== config`)으로
   판정한다. 그런데 `index.ts` 의 `securityConfig()` 는 OIDC 가 켜져 있으면
   `withIdentityProvider(tokens, secret)` 로 **매번 새 객체**를 만든다
   (`{ ...config, enabled: true, identitySessionSecret }`). 캐시가 절대 적중하지 않는다.
2. 거기에 더해 `api.ts` 의 `roleOf()` 가 OIDC 여부와 무관하게 매 요청
   `authenticate()` → `prepareConfig()` 를 처음부터 다시 돌린다. 인증 계층이 이미
   principal 을 판정해 `x-parallax-actor` 로 붙여 두었는데도 역할만 다시 계산한다.
3. `prepareConfig` 의 중복 검사는 준비된 **모든** 다이제스트를 `timingSafeEqual` 로
   훑는다 — O(n²).

**측정.** 같은 알고리즘을 그대로 재현했다.

| 토큰 수 | `prepareConfig` 1회 | 요청당 (×2) |
| --- | --- | --- |
| 10 | 1.5 ms | 3.1 ms |
| 100 | 2.3 ms | 4.5 ms |
| 500 | 11.4 ms | 22.7 ms |
| 1,000 | 25.1 ms | 50.2 ms |

**영향.** 단일 스레드 이벤트 루프를 그만큼 막는다. 토큰이 수백 개인 배포는 인증만으로
요청당 수십 밀리초를 쓴다. 인증 실패 요청도 같은 비용을 치르므로 — `matchToken` 이
아니라 `prepareConfig` 쪽 비용이다 — 인증되지 않은 트래픽으로도 끌어올릴 수 있다.

**수정 제안.**

- 중복 검사를 base64url 문자열 `Set` 으로 바꾼다. 비교 대상은 비밀이 아니라 이미
  해시된 다이제스트이고, 이 루프는 **설정 검증**이지 인증이 아니므로 상수시간이 필요
  없다. 실제 인증 경로인 `matchToken` 의 상수시간 비교는 그대로 둔다.
- `withIdentityProvider` 의 결과를 입력이 같으면 같은 객체로 메모이즈한다.
  `accessTokens.security()` 는 이미 "바뀔 때만 새 객체" 를 보장하므로, 그 객체를 키로
  `WeakMap` 하나면 된다.
- `roleOf` 는 인증 계층이 판정한 결과를 재사용한다. `withActor` 가 subject 를 헤더로
  넘기는 것과 같은 방식으로 역할도 넘기거나, `WeakMap<Request, Principal>` 을 쓴다.

---

## 5. 발견 사항 — 심각도 Low

### L1. Postgres 풀에 한계값이 하나도 설정되어 있지 않다

- **성격:** 가용성
- **위치:** `src/infrastructure/postgres.ts:48` — `createPostgresPool`

`max`(pg 기본 10) · `connectionTimeoutMillis` · `statement_timeout` 모두 미설정이다.
한편 `PostgresApplyLock.withZoneLock` 은 프로바이더 네트워크 I/O 가 끝날 때까지
클라이언트 하나를 통째로 붙잡는다 — 세션 advisory lock 이라 그래야 한다.

`ContextualPgPool` 이 잠금 안에서의 재진입을 같은 클라이언트로 돌려 풀 고갈을 막는
설계는 이미 되어 있고 2026-08-10 리포트가 확인한 그대로다. 남은 것은 **바깥쪽**이다:
서로 다른 존 11개를 동시에 apply 하면 11번째는 `connect()` 에서 **무한히** 기다린다.
타임아웃이 없으니 에러도 나지 않고 요청이 그냥 매달린다.

`applyPending` 은 존을 순차로 돌므로 이 경로로는 오지 않는다. HTTP 로 존별 apply 를
동시에 던지는 경우가 대상이다.

**수정 제안.** `max` 를 명시하고 `connectionTimeoutMillis` 를 넣어 대기가 에러가 되게
한다. 읽기 경로에는 `statement_timeout` 도.

---

### L2. DNS 질의마다 존 레코드를 여러 번 전수 스캔한다

- **성격:** 성능
- **위치:** `src/dns/server.ts` — `matchZone` · `servedByProvider` · `answerFromZone`
  · `wildcardMatch` · `dnameSubstitution`

질의 하나에 `zone.records` 전체를 최소 3–4회 훑는다.

| 지점 | 연산 |
| --- | --- |
| `servedByProvider` | `records.some(...)` — 전체 |
| `answerFromZone` 의 `atName` | `records.filter(...)` — 전체 |
| empty non-terminal 판정 | `records.some(... endsWith)` — 전체 |
| `wildcardMatch` | 위로 걷는 **매 단계마다** `records.filter(...)` |
| `dnameSubstitution` | 같은 모양으로 한 번 더 |

이름/타입 인덱스가 없다. `matchZone` 도 존 목록을 선형 탐색한다.

**수정 제안.** 스냅샷은 이미 `servedZones()` 에서 갱신 때마다 새로 만들어지므로, 그
자리에서 `Map<absoluteName, records[]>` 를 함께 만들면 질의 경로가 상수시간에
가까워진다. 스냅샷 생성 빈도는 `DNS_REFRESH_MS`(5초) 이고 질의 빈도는 그보다 훨씬
높으므로 비용 방향이 맞다.

---

### L3. 파일 백엔드가 레코드 하나에 상태 전체를 다시 쓴다

- **성격:** 성능
- **위치:** `src/infrastructure/file-state.ts` — `#mutate` · `#writeAtomically`

모든 변경이 파일 전체를 파싱 → `structuredClone` → 통째로 재직렬화 → 임시 파일 →
rename → 디렉터리 fsync 를 거친다. 원자성을 위해 필요한 절차이고 그 자체는 옳다.

문제는 그 파일 안에 든 것이다. 존당 최대 **100개 리비전 스냅샷**(각각 존 전체 사본,
`revisionRetention` 기본값)과 **365일치 감사 로그**(`auditRetentionDays` 기본값)가 같은
JSON 에 들어 있다. 쓰기 비용이 `존 수 × 리비전 수 × 존 크기` 로 커진다.

문서상 단일 노드용이므로 결함이라기보다 **그 "단일 노드" 의 실제 상한이 얼마인지가
어디에도 적혀 있지 않다**는 쪽이 요점이다.

**수정 제안.** 당장은 기본 리텐션 값이 이 백엔드에 어떤 의미인지를 재검토하는 것으로
충분하다. 리비전과 감사를 본 상태 파일에서 분리하면 근본 해결이 되지만, 그것은 파일
백엔드를 사실상 다시 쓰는 일이다.

---

### L4. 포털이 서버 페이지네이션을 클라이언트에서 전부 소진한다

- **성격:** 성능
- **위치:** `public/api-client.js:58` · `:73` · `:86` — `listAllZones` · `listAllStatus` · `listAllKeyed`

`globalHistory()` · `history()` · `listRevisions()` · `listZones()` · `statusOverview()`
가 `hasMore` 가 끝날 때까지 500개씩 계속 받는다. API 는
`MAX_HISTORY_PAGE_SIZE = 500` 으로 성실히 제한하는데 UI 가 그 제한을 루프로 무력화한다.

`store.js` 에 `HISTORY_PAGE_SIZE = 5` 라는 상수가 있지만 그것은 **표시** 개수이고,
받아 오는 양과 무관하다.

**영향.** 기본 감사 리텐션이 365일이다. "전체 히스토리" 를 한 번 열면 그 전부가
브라우저 메모리로 들어온다. 서버도 그만큼의 `LIMIT/OFFSET` 질의를 받으며, offset
페이징이라 뒤로 갈수록 느려진다.

**수정 제안.** 히스토리·리비전 패널에 "더 보기" 를 두고 실제로 페이지 단위로 읽는다.
존 목록처럼 정말 전부 필요한 것만 소진 루프를 남긴다.

---

### L5. EDNS 쿠키에 만료가 없다

- **성격:** 보안
- **위치:** `src/dns/cookies.ts:54` — `serverCookieFor`

서버 쿠키가 `HMAC(secret, clientAddress ‖ 0x00 ‖ clientCookie)` 이고 비밀은 프로세스
수명 동안 고정이다. 타임스탬프도 회전도 없어서, 한 번 유효한 쿠키는 재시작 전까지
영원히 유효하다.

**영향.** `PARALLAX_DNS_REQUIRE_COOKIE=true` 인 배포에서, 어떤 주소에 대해 유효한
쿠키를 한 번 얻은 쪽은 그 주소를 위조하는 동안 증폭 방어를 계속 우회한다. RFC 7873bis
가 서버 쿠키에 타임스탬프와 회전을 권하는 이유가 이것이다.

기본값이 꺼져 있고(`requireCookie` 기본 false) 주소에 묶여 있어 우선순위는 낮다.
"프로세스 수명 = 쿠키 수명" 이라는 선택 자체는 주석에 적혀 있으나, 그 선택이 위
성질을 갖는다는 것은 적혀 있지 않다.

**수정 제안.** 서버 쿠키에 타임스탬프를 넣고 허용 창(예: 1시간)을 둔다. 쿠키는 8바이트가
아니라 최대 32바이트까지 쓸 수 있으므로 자리는 있다.

---

### L6. DNS 스펙 잔가시 둘

- **성격:** 정확성
- **위치:** `src/dns/wire.ts:readName` · `src/dns/server.ts:answerFromZone`

**(a) 라벨 안의 점.** `readName` 이 라벨을 `.` 로 이어 붙이므로, 점을 포함한 11바이트
**단일** 라벨 `example.com` 이 존 apex 와 같은 문자열이 된다. `matchZone` 이 매칭하고
`answerFromZone` 이 authoritative 로 답한다. 답을 만들 때 `writeName` 이 두 라벨로
다시 쓰므로 질문 섹션이 어긋나 리졸버가 버린다 — 악용 가치는 낮지만, 묻지 않은 이름에
authoritative 로 답하는 상태다. 라벨을 이스케이프(`\.`)해 이어 붙이거나 배열로 비교하면
사라진다.

**(b) CNAME 체인.** 대상이 같은 존 안에 있어도 CNAME 만 돌려주고 대상의 A/AAAA 를 답
섹션에 넣지 않는다. 틀린 답은 아니다 — 리졸버가 다시 물으면 된다 — 지만 왕복이 한 번
더 늘고, 대부분의 authoritative 서버와 동작이 다르다. 내부 뷰가 성능을 위해 존재하는
자리에서는 셀 만한 비용이다.

---

## 6. 발견 사항 — 심각도 Info (정합성 · 문서-구현)

### I1. 제거된 CoreDNS 어댑터의 잔재 5곳

- **성격:** 정합성
- **선행:** 이전 리포트의 `I1` 이 *"사라진 CoreDNS/PowerDNS 어댑터를 가리키는 주석
  4곳 정리는 어느 쪽을 고르든 함께 한다"* 고 적었다. `src/adapters/ns1.ts` 는 지워졌으나
  **정리는 절반만 됐다.**

| # | 위치 | 내용 |
| --- | --- | --- |
| 1 | `src/runtime.ts:2-3` | `lstat` · `realpath` · `isAbsolute` · `relative` · `sep` 전부 미사용. `coreDnsDirectory` 가 root 를 벗어나지 못하게 하던 경로 봉쇄 검사의 흔적 |
| 2 | `.env.example:21-23` | 아래에 변수가 하나도 없는 **고아 주석**: *"Immutable deployment-owned root … the stored `coreDnsDirectory` setting cannot leave this root"*. 그런 설정도 변수도 이제 없다 |
| 3 | `.env.example:25` | *"Required before Cloudflare or CoreDNS can be used"* |
| 4 | `src/adapters/router.ts:28` | `setInternal()` 을 프로덕션에서 아무도 호출하지 않는다 (`runtime.ts` 는 `setFallback` 만 쓴다) |
| 5 | `src/application/cloudflare-credentials.ts:22, 44, 266` | `environmentAdapters` 는 프로덕션에서 항상 빈 `Map` 이라 `#restoreEnvironmentRoute` 는 사실상 unregister 전용. `PROBE_ZONE` 상수는 어디서도 쓰이지 않는다 |

**왜 안 잡혔나.** `tsconfig.json` 에 `noUnusedLocals` 와 `noUnusedParameters` 가 없다.
켜면 1번과 `PROBE_ZONE` 이 즉시 잡히고, 앞으로도 잡힌다. 4번과 5번의 나머지는 타입
검사로는 잡히지 않는 죽은 API 이므로 사람이 지워야 한다.

⚠️ `AGENTS.md` 가 반복해서 경고하는 그 패턴이다 — **기록이 실제보다 한 걸음 뒤처지는**
것. 여기서는 기록이 아니라 코드가 그렇게 됐다.

---

### I2. 문서 주석 하나가 엉뚱한 함수 위에 붙어 있다

- **성격:** 정합성
- **위치:** `src/config.ts:344-356`

*"Refuses `idp` without an identity provider rather than falling back…"* 블록은
`readPortalSignIn` 을 설명하는 문장인데, 실제로는 `readStaleness` 의 주석 바로 위에
JSDoc 두 개가 연달아 붙어 있다. `readPortalSignIn` 은 그보다 아래에 주석 없이 있다.

```
344  /**
345   * Refuses `idp` without an identity provider rather than falling back.
...
351   */
352  /**
353   * Seconds, because the operator thinking about this is reading a probe's
354   * `periodSeconds` and `failureThreshold` beside it.
355   */
356  function readStaleness(...)
```

IDE 와 문서 생성기는 첫 문장을 `readStaleness` 의 설명으로 보여준다.

---

### I3. `resetMetrics()` 가 카운터를 영구히 고아로 만든다

- **성격:** 정합성 (테스트 인프라)
- **위치:** `src/observability/metrics.ts:38`(`counter`) · `:84`(`resetMetrics`) · `src/observability/signals.ts`

**재현.**

```
recordUnservable();  render()  →  counter visible
resetMetrics();
recordUnservable();  render()  →  MISSING (orphaned)
```

**원인.** `counter()` 가 돌려주는 클로저는 맵이 아니라 카운터 **객체**를 캡처한다.
`resetMetrics()` 는 맵만 비운다. `signals.ts` 의 카운터는 모듈 로드 시 한 번
생성되므로, 리셋 이후 아무리 증가시켜도 `render()` 에 다시는 나타나지 않는다.

**영향.** 지금 스위트는 통과한다 — 이 조합을 쓰는 테스트가 아직 없기 때문이다.
"이 카운터가 올랐는가" 를 `resetMetrics()` 뒤에서 확인하는 테스트를 새로 쓰면 이유
없이 실패하고, 그 이유는 테스트 대상이 아니라 헬퍼에 있다. 헬퍼가 조용히 틀린 답을
주는 것은 발견 자체를 왜곡할 수 있으므로 값싼 지금 고치는 편이 낫다.

**수정 제안.** `counter()` 가 돌려주는 클로저가 맵을 통해 조회하게 하거나,
`resetMetrics()` 가 맵을 비우는 대신 각 카운터의 `values` 만 비우게 한다.

---

### I4. OIDC 엔드포인트 하드코딩 — 이전 리포트 L5 의 재확인

- **성격:** 문서-구현 불일치
- **위치:** `src/security/oidc.ts:52` · `:61` · `:102` · `:147`

📌 **새 발견이 아니다.** 2026-08-22 리포트가 `L5. OIDC 엔드포인트가 하드코딩이고 ID
토큰을 검증하지 않는다` 로 이미 보고했고, 수정 계획은 그것을 **"사람이 정해야 하는
것"** 으로 미뤘다 — *"지금 배포가 쓰는 프로바이더 하나만 상대하면 되는가, 아니면
상호운용이 요구사항인가"*. 코드는 그대로다. 그 판단은 유효하고 이 리포트가 뒤집을
근거는 없다.

**이 리포트가 더하는 것은 하나다.** 결정이 미뤄져 있는 동안 `README.md:410` 은 이렇게만
말한다.

```
| PARALLAX_OIDC_ISSUER · _CLIENT_ID · _CLIENT_SECRET · _REDIRECT_URI · _SCOPES | OpenID Connect sign-in |
```

Keycloak · Google · Okta · Entra ID · Auth0 를 붙이려는 사람은 다섯 변수를 다 채우고
authorize 단계에서 404 를 만난다. 역할이 비표준 `entitlements` 클레임에서만 읽힌다는
것도 어디에도 적혀 있지 않다.

**수정 제안.** 코드 결정은 미뤄 두더라도, README 의 그 줄에 어떤 모양의 프로바이더를
전제하는지(`{issuer}/oidc/*` 경로와 `entitlements` 클레임)를 한 줄 덧붙인다. 문서
수정만으로 닫히는 항목이다.

---

## 7. 이전 리포트와의 대조

검수를 마친 뒤 기존 세 리포트를 열어 대조했다. **이 리포트의 발견이 새것인지
재발견인지**를 분명히 하기 위해서다.

### 이전에 보고되었고 지금은 닫힌 것

읽는 동안 해당 코드 경로에서 확인했다.

| 이전 | 항목 | 지금 상태 |
| --- | --- | --- |
| H1 | OIDC 전용 배포가 프록시 뒤에서 전면 401 | 닫힘 — 가드가 `securityConfig()` 를 본다 |
| H2 | RDATA 64 KiB 초과 레코드의 질의가 사라짐 | 닫힘 — `servableRdata` + SERVFAIL + 카운터. **단 메시지 단위는 남아 있다 → H2(신규)** |
| M1 | QCLASS · OPCODE 미검사 | 닫힘 — `opcodeOf` 검사와 CLASS 검사가 있다 |
| M2 | UDP 증폭 · 쿠키 없음 · 레이트리밋 노브 미노출 | 닫힘 — `dns/cookies.ts` 와 `PARALLAX_DNS_RATE_LIMIT_*` |
| M3 | zone file import 가 BIND 존 파일을 못 읽음 | 닫힘 — `logicalLines` 의 괄호 이어짐 처리 |
| M4 | 종료에 데드라인 없음 | 닫힘 — `shutdown.ts:withDeadline` |
| M5 | OIDC 쿠키 중복 → 로그인 CSRF | 닫힘 — `security/cookies.ts` 가 중복을 양쪽 다 거부 |
| L1 | 실패 스로틀이 추측을 늦추지 않음 | 닫힘(문서화 선택) — 주석이 그 사실을 명시한다 |
| L3 | 인증 전 1 MiB 버퍼 · 커넥션 상한 없음 | 부분 — `server.maxConnections = 1024` 는 들어왔다 |
| L8 | `applyPending` 이동 오프셋 페이징 | 닫힘 — 목록을 먼저 다 읽고 적용한다 |

### 이전에 보고되었고 지금도 열려 있는 것

| 이전 | 항목 | 이 리포트 |
| --- | --- | --- |
| L5 | OIDC 하드코딩 · ID 토큰 미검증 | **I4** — 의도된 보류. 문서만 보완 제안 |
| L6 | 세션 쿠키가 bearer 토큰 원문을 담음 · OIDC 세션 폐기 불가 | 재확인. 보류 결정이 유효하다고 보아 신규 항목으로 올리지 않았다 |
| L7 | `servedByProvider` 릴레이가 `forwardAllow` 바깥 | 재확인. 코드에 그것이 의도임을 밝히는 주석이 생겼다 |
| I1 | 사라진 어댑터를 가리키는 주석 정리 | **I1** — `ns1.ts` 는 지워졌으나 5곳이 남았다 |

### 이 리포트에서 처음 보고하는 것

H1 · H2(메시지 단위) · H3 · M1 · M2 · M3 · M4 · M5 · M6 · M7 · L1 · L2 · L3 · L4 ·
L5 · L6 · I2 · I3 — **18건.**

⚠️ **그중 M7 은 절반만 새것이다.** 이 절의 표는 감사 리포트 세 편만 대조하고
수정 계획은 보지 않은 채 썼는데, 나중에 [`2026-08-22-remediation-plan.md`](2026-08-22-remediation-plan.md)
1단계를 열어 보니 캐시 무효화를 이미 이렇게 적어 두었다 — *"`securityConfig()`는
호출될 때마다 … OIDC일 때 객체를 새로 만든다. `createAuthorizedHandler`는 객체
동일성으로 … 캐시하므로 … 매번 무효화된다 … 캐시 무효화가 이미 존재하는지는
1단계에서 같이 측정해 두는 편이 좋다(측정만; 최적화는 이 계획 밖)."* 관찰은 그쪽이
먼저였고 측정만 남아 있었다. **이 리포트가 그 측정이다** — 그리고 O(n²) 중복 검사와
`roleOf` 의 두 번째 호출은 거기 없던 것이다.

📌 대조 범위를 감사 리포트로만 잡은 것이 이 누락의 원인이다. 다음 리포트는 수정
계획까지 대조 대상에 넣을 것.

📌 이전 두 감사는 보안 축이 강했고 대상이 서버 코드였다. 이번에 처음 보고되는 것 중
M2 · M3 · L4 는 **포털(`public/`)** 이고 H1 은 **CLI** 다. 그 두 표면이 이전에 덜
읽혔던 것으로 보인다.

---

## 8. 검토했으나 문제 없음

발견만 나열하면 어디까지 보았는지 알 수 없으므로, 특별히 확인한 뒤 문제가 없던
경로를 적는다.

| 영역 | 확인한 것 |
| --- | --- |
| **인가 이중 게이트** | `authorize()`(경로 기반)와 `runCommand`(명령별 최소 역할)가 서로를 덮는다. `/api/v1/fallback/*` 처럼 경로 게이트가 통과시키는 자리도 명령 게이트가 admin 으로 막는다. `POST /api/v1/cli` 로 viewer→editor, editor→admin 승격이 되지 않음을 명령별로 확인 |
| **경로 디코딩 일치** | `authorize()` 와 `matchRoute()` 가 같은 `decodeURIComponent` 규칙으로 세그먼트를 나눈다. 인가와 라우팅이 다르게 읽어 생기는 우회가 없다 |
| **actor 위조** | `withActor` 가 헤더를 통째로 새로 만들어 `x-parallax-actor` 를 덮어쓴다. 클라이언트가 감사 주체를 고를 수 없다. 인증이 꺼진 모드에서도 같다 |
| **CSRF** | 쿠키 인증 + unsafe 메서드에 `Origin` 또는 `Sec-Fetch-Site` 동일 출처 증명을 요구한다. `/api/v1/session` 도 같다 |
| **OIDC 핸드셰이크 쿠키** | `__Host-` 접두어(https 일 때)와 중복 거부가 함께 있다. `state` 와 PKCE `verifier` 둘 다 HttpOnly. `next` 는 `safeReturnPath` 로 경로만 허용하며 `/\` 도 막는다 |
| **XSS** | 포털의 모든 `innerHTML` 경로에 `escapeHtml` 이 일관 적용. IdP 가 준 `error_description` 은 `setLiveMessage` → `textContent` 로만 들어간다. 인라인 스크립트·핸들러가 없어 CSP `script-src 'self'` 가 실제로 유효하다 |
| **DNS 파서 견고성** | 압축 포인터가 반드시 뒤로만 이동하도록 강제해 루프가 불가능. 이름 255바이트·라벨 63바이트 상한. OPT 옵션 파싱이 RDATA 길이 안에 갇혀 있다 |
| **포워딩 상관관계** | connected UDP 로 커널이 다른 출발지를 거르고, 그 위에서 ID·플래그·질문 섹션을 전부 대조한다. TCP 쪽은 위조 프레임을 소비하고도 뒤의 유효 응답이 이길 수 있게 되어 있다 |
| **자격 저장소** | AES-256-GCM, revision 을 AAD 에 묶어 롤백 감지, 토큰은 HTTP 로 절대 나가지 않으며 오류 메시지에서 `redact`. 프로파일 삭제는 바인딩이 남아 있으면 거부 |
| **소유권 마커** | HMAC 이 target 과 recordId 를 함께 서명하므로 다른 존으로 복사해도 검증에 실패한다. v2 는 읽기 전용으로 남아 하위 호환이 유지된다 |
| **SQL** | 모든 질의가 파라미터화. 마이그레이션은 체크섬 고정 + advisory lock + 매니페스트 대조 |
| **프로토타입 오염** | 파일·DB 역직렬화 경로와 CLI 옵션 파서를 훑었다. 키가 검증되거나(`isDangerousObjectKey`, 존 이름 정규화) `Object.fromEntries` 를 쓰거나, 값이 문자열/불리언이라 `__proto__` 세터가 무시한다 |
| **낙관적 동시성** | `If-Match` → `expectedRevision` → 저장소의 `RevisionConflictError` 까지 한 줄로 이어지고, 파일·PG 양쪽에 같은 의미로 구현되어 있다 |
| **감사 액션 목록** | `AUDIT_ACTIONS` · 마이그레이션 CHECK 제약 · 포털 라벨 맵 셋이 테스트로 대조된다 |
| **OpenAPI 문서** | 문서된 모든 오퍼레이션이 실제 라우터로 해석되는지, 역할이 두 게이트에서 계산되는지 테스트가 검사한다. 두 번째 사본이 표류하지 않는 구조 |

---

## 9. 신규로 추가하면 좋을 것

위 발견 사항의 수정 제안과 겹치는 것은 뺐다.

### 컨트롤 플레인

1. **액세스 토큰 만료 · 마지막 사용 시각.** 발급된 토큰은 명시적으로 폐기하기 전까지
   영원하다. `StoredAccessToken` 에 `expiresAt` 과 `lastUsedAt` 을 더하면 "쓰이지 않는
   토큰" 을 찾아 지울 수 있다. 스키마 변경 한 번과 `matchToken` 의 만료 확인이면 된다.
2. **저장소 전체 백업 · 복원.** 존 단위 zone-file export 는 있지만 desired state ·
   리비전 · 감사 · 설정을 한 번에 내보내고 되돌리는 경로가 없다. 파일 백엔드에서
   PostgreSQL 로 옮기는 길도 마찬가지다 — 지금은 사람이 손으로 옮겨야 한다.
3. **프로바이더 하나 더.** 실제 어댑터는 Cloudflare 와 로컬 파일뿐이다. 라우터에는
   `setInternal` 같은 자리가 남아 있고 도메인은 이미 프로바이더 중립적이니, 두 번째
   어댑터가 그 추상화가 실제로 중립적인지를 검증해 준다(I1 의 잔재도 그때 정리된다).
4. **`zone import` 의 본문 상한.** `MAX_REQUEST_BODY_BYTES`(1 MiB)가 모든 경로에
   일률적이다. `zone import` 는 존 파일을 통째로 받는 유일한 경로라 큰 존은 413 을
   만난다. 경로별 상한이거나 스트리밍 파싱이 필요하다.

### DNS

5. **IXFR 과 다중 메시지 AXFR.** H2 를 고치는 김에. 지금은 세컨더리가 매번 존 전체를
   받아야 하고, 그 전체가 64 KiB 를 넘으면 아예 못 받는다.
6. **AXFR · NOTIFY 에 TSIG.** 지금은 IP 허용목록만이 유일한 전송 통제다.
   (이전 리포트에서도 같은 제안이 있었다.)

### 운영

7. **요청 로그와 요청 ID.** 실패 시 `console.error("request failed", error)` 한 줄이
   전부다. 액세스 로그도 상관 ID 도 없어서, 감사 항목에 actor 는 남는데 그 요청을 다시
   찾을 방법이 없다.
8. **DNS 질의 · 지연 메트릭.** 지금 카운터는 전부 실패 전용이며 그것이 설계 의도라고
   `metrics.ts` 에 적혀 있다. 그 규칙은 옳지만, 질의 수 · rcode 분포 · 포워딩 지연이
   없으면 "느려졌다" 를 확인할 방법이 없다. 게이지로 더하면 규칙과도 충돌하지 않는다.
9. **`noUnusedLocals` · `noUnusedParameters`.** I1 의 절반이 이 두 플래그로 잡힌다.
   이 저장소가 반복해서 겪는 "기록이 실제보다 한 걸음 뒤처짐" 을 컴파일러가 대신
   잡아 준다.

---

## 10. 우선 조치 권고

| 순서 | 항목 | 이유 |
| --- | --- | --- |
| 1 | **H1** CLI 파이프 절단 | 고침이 한 줄이고, 지금 조용히 깨진 데이터를 내보내고 있다 |
| 2 | **H3** 와일드카드 확장 | 내부와 외부의 답이 갈리는 종류다. 이 프로젝트의 전제와 충돌한다 |
| 3 | **M2** 실패한 apply 를 성공으로 보고 | 고침이 작고(이미 있는 함수 재사용), 조작자를 직접 오도한다 |
| 4 | **H2** AXFR 64 KiB | 최소한 실패를 보고하게 만드는 것부터. 완전한 수정은 별건 |
| 5 | **M1** ownership secret 오안내 | 안내를 따르면 상황이 나빠질 수 있는 방향이다 |
| 6 | **L1** Postgres 풀 한계값 | 요청이 무한히 매달리는 경로를 에러로 바꾼다. 설정 두 줄 |
| 7 | **M4** 파일 락 회수 | 파일 백엔드가 기본값이고, OOMKill 한 번이면 걸린다 |

**하나만 고른다면 H1 이다** — 수정이 가장 작고 영향이 가장 즉시적이다.

⚠️ **M7 은 지금 배포에서 급하지 않다.** 토큰이 수십 개 수준이면 요청당 수 밀리초이고,
표의 곡선이 문제가 되는 것은 수백 개부터다. 다만 고침이 어렵지 않으므로 다른 인증
계층 작업이 있을 때 함께 하면 된다.

---

## 11. 범위와 미검토

**보지 않은 것.**

- `README.md` · `README.ko.md` · `AGENTS.md` · `docs/**` — 의뢰 범위 밖.
  발견 사항이 문서와 어긋나는지 확인해야 하는 자리에서만 해당 문단을 열었다(M1 · I4).
- `.github/workflows/**` 는 읽었으나 검수 대상으로 다루지 않았다.
  `check.yml` 의 `deployment-gate` 잡이 `test/infrastructure/schema-surface.test.ts` 를
  맨 체크아웃에서 돌린다는 사실만 확인했고, 이 파일은 그 잡의 감시 경로
  (`migrations/`, `src/infrastructure/migrations.ts`)를 건드리지 않는다.
- `scripts/claude-hooks/**` · `scripts/git-hooks/**` — stardust 의 스냅샷이며
  `AGENTS.md` 가 정한 대로 정본에서 관리된다. 읽었으나 이 리포트의 대상이 아니다.
- `security-audits/**` — 검수를 마친 뒤 §7 대조를 위해서만 열었다.

**돌리지 않은 것.**

- `pnpm verify:postgres` · `verify:proxy` · `verify:dns` · `verify:cloudflare`.
  Docker 와 네트워크(그리고 마지막 하나는 실제 Cloudflare 자격증명)를 요구한다.
  따라서 **PostgreSQL 백엔드의 동적 거동은 코드 읽기로만 확인했다** — L1 의 풀 고갈은
  재현하지 않았고, 그렇게 적었다.
- Docker 이미지 빌드. `Dockerfile` 은 읽었고 Node 26 에서 `corepack` 이 빠진다는 자체
  경고가 유효해 보이나, 빌드해 확인하지는 않았다.
- 브라우저에서의 포털 실제 조작. `public/**` 는 정적 읽기와 `tsc --checkJs` 로만 봤다.
  M2 · M3 는 코드 경로 추적이며, 화면에서 확인한 것이 아니다.

**의도적으로 신규 항목으로 올리지 않은 것.**

- 이전 리포트 L6(세션 쿠키가 bearer 토큰 원문을 담음). 재확인했으나 보류 결정이
  유효하다고 보았다.
- 이전 리포트 L7(`servedByProvider` 릴레이가 `forwardAllow` 바깥). 코드에 그것이
  의도임을 밝히는 주석이 생겼고, 그 논거가 타당하다.
- 존별 RBAC 부재. 이전 리포트가 "사람이 정해야 하는 것" 으로 올렸고 그대로다.
