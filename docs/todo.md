# 할 일

2026-08-23 전수검수에서 나온 작업 목록. **체크박스만 있는 문서이고, 왜·어떻게는
전부 다른 곳에 있다** — 무엇이 잘못됐는지는
[`security-audits/2026-08-23-code-review.md`](../security-audits/2026-08-23-code-review.md),
변경 내용·완료 정의·회귀 테스트·위험은
[`security-audits/2026-08-23-remediation-plan.md`](../security-audits/2026-08-23-remediation-plan.md)
의 같은 번호에 있다.

저 둘은 **날짜가 박힌 스냅샷**이라 지나고 나면 고치지 않는다. 이 파일은 그 반대다 —
살아 있는 목록이고, 체크는 여기에 한다. 다음 검수가 오면 항목을 여기에 이어 붙인다.

크기: **XS** 한 줄~다섯 줄 · **S** 한 함수 · **M** 한 모듈 · **L** 설계가 필요.

---

## 1단계 — 값싼 셋

- [x] **T1** · `XS` · CLI 출력이 파이프에서 64 KiB 에 잘리는 것 — `cmd/parallax/main.ts:82`
      <br>⚠️ 고친 뒤 이벤트 루프가 정말 비는지 실제 실행으로 확인할 것
- [x] **T2** · `XS` · Postgres 풀에 `max` · `connectionTimeoutMillis` — `src/infrastructure/postgres.ts:48`
      <br>⚠️ `pnpm verify:postgres`(Docker 필요)를 돌릴 수 있는 자리에서 할 것
- [x] **T3** · `XS` · `readPortalSignIn` 주석을 제 함수 위로 — `src/config.ts:344`

## 2단계 — 침묵을 없앤다

- [x] **T5** · `S` · `resetMetrics()` 가 카운터를 고아로 만드는 것 — `src/observability/metrics.ts:84`
      <br>📌 **T4 보다 먼저.** T4 의 회귀 테스트가 카운터를 본다
- [x] **T4** · `S` · AXFR 프레이밍 실패를 `onUnanswerable` 로 보고 — `src/dns/server.ts:343`
      <br>📌 AXFR 자체는 고치지 않는다(T18). 실패가 보이게만 한다
- [x] **T6** · `S` · ownership secret 이 없을 때 기동 실패가 엉뚱한 변수를 대던 것
      <br>계획은 「기동을 막으라」 했으나 **그 전제가 틀렸다** — 바인딩이 없으면 그
      조합은 정상 동작하고 그것이 설치 순서다. 좁게 넣었다: 원인별 메시지 · 기동
      경고 · `config check` 보고. 계획 §3 의 2026-08-24 블록 참조

## 3단계 — 정확성 (테스트를 먼저 쓴다)

- [x] **T7** · `S` · 와일드카드를 closest encloser 에서 멈추게 — `src/dns/server.ts:660`
- [ ] **T7-a** · 🔴 **배포 전 확인 — 이 저장소에서는 할 수 없었다.**
      이 체크아웃에는 desired state 가 없다(`data/` 비어 있음). 실제 배포에서 확인할
      것: **와일드카드가 있고, 그 와일드카드의 부모보다 깊은 곳에 실제로 존재하는
      이름이 있는 존.** 그런 존에서만 답이 바뀐다 — 그 이름 아래의 질의가
      와일드카드 합성 대신 NXDOMAIN 이 된다. 중간에 아무것도 없는 catch-all
      와일드카드는 깊이와 무관하게 그대로 답한다(회귀 테스트로 고정)
- [ ] **T8** · `S` · 라벨 안의 점이 apex 와 매칭되는 것 — `src/dns/wire.ts:readName`

## 4단계 — 포털

- [ ] **T9** · `S` · 실패한 apply 를 error 레벨로 — `public/store.js:413`
- [ ] **T10** · `XS` · 버려진 프로바이더 대상을 warning 으로 — `public/store.js:286`
- [ ] **T11** · `S` · 히스토리·리비전의 페이지 소진 중단 — `public/api-client.js:86`
      <br>UI 변경이 따라온다. 셋 중 가장 크고 앞의 둘과 독립이라 미뤄도 된다

## 5단계 — 잔재 정리

- [ ] **T12** · `S` · CoreDNS 잔재 5곳 + `noUnusedLocals`·`noUnusedParameters`
      <br>⚠️ **플래그를 먼저 켜고 무엇이 빨개지는지 본 다음** 지운다. 목록은
      리포트가 아니라 컴파일러가 준다

## 6단계 — 성능·견고성 (전/후를 같은 방법으로 잰다)

- [ ] **T13** · `S` · `prepareConfig` 의 O(n²)·캐시 무효화·`roleOf` 재계산
      <br>📌 셋 중 **중복 검사를 `Set` 으로 바꾸는 것만 해도 곡선이 사라진다**
- [ ] **T14** · `S` · 파일 락 회수에 boot id — `src/infrastructure/atomic-file.ts:113`
      <br>⚠️ **재현이 먼저.** 컨테이너에서 정말 pid 1 인지 확인한 뒤 고칠 것
- [ ] **T15** · `M` · 존 락과 상태 파일 락 분리 — `FileApplyLock`
      <br>🔴 동시성 변경. 지키는 불변식을 먼저 적을 것. 값싼 대안(타임아웃만 분리)을 먼저 검토
- [ ] **T16** · `S` · DNS 이름 인덱스를 스냅샷에서 함께 만들기 — `src/dns/snapshot.ts`
- [ ] **T17** · `M` · Cloudflare 429·5xx 지수 백오프
      <br>🔴 **`create` 는 멱등이 아니다.** 재시도 대상에서 빼거나 `list` 확인을 붙일 것

## 7단계 — 별건 설계 (착수 전)

- [ ] **T18** · `L` · AXFR 다중 메시지 + IXFR
- [ ] **T19** · `L` · 파일 백엔드에서 리비전·감사 분리
- [ ] **T20** · `L` · EDNS 쿠키 타임스탬프
- [ ] **T21** · `L` · CNAME 체인 추적

---

## 사람이 정해야 하는 것

코드가 아니라 결정이 먼저다. 답이 정해지기 전에는 착수하지 않는다.

- [ ] **D1** · OIDC — 상호운용이 요구사항인가?
      <br>**아니오면 `README.md:410` 에 한 줄 추가로 닫힌다.** 예면 discovery 구현(`L`)
- [ ] **D2** · 액세스 토큰에 `expiresAt`·`lastUsedAt` 을 더할 것인가
- [ ] **D3** · 저장소 전체 백업·복원 (파일→PostgreSQL 이관 포함)
- [ ] **D4** · 두 번째 프로바이더 어댑터
- [ ] **D5** · `zone import` 의 본문 상한 — 경로별 상한인가 스트리밍인가
- [ ] **D6** · 요청 로그·요청 ID·DNS 질의 메트릭
- [ ] **D7** · AXFR·NOTIFY 에 TSIG

---

## 하지 않기로 한 것

지운 것이 아니라 **판단한** 것이다. 다시 올라오면 이 줄을 먼저 볼 것.

- 이전 리포트 **L6** — 세션 쿠키가 bearer 토큰 원문을 담음. 보류 결정이 유효하다
- 이전 리포트 **L7** — `servedByProvider` 릴레이가 `forwardAllow` 바깥. 코드에 의도가 적혀 있고 논거가 타당하다
- **존별 RBAC** — 이전 리포트가 사람에게 넘겼고 그대로다
- **`statement_timeout`** — 값을 정하려면 질의 분포 측정이 앞선다
- **이름을 라벨 배열로 다루기** — T8 에서 옳은 쪽이지만 파급이 넓다

---

## 커밋 전 게이트

```
pnpm check && pnpm run check:portal && pnpm build && pnpm test
```

DNS 를 건드리는 **T4 · T7 · T8 · T16** 은 `pnpm verify:dns` 를 추가로 돌린다 —
Docker 도 네트워크도 쓰지 않으므로 돌리지 않을 이유가 없다.

푸시 후 CI 넷(`check` · `scripts` · `docker` · `codeql`)이 초록일 것.
