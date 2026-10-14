# Working in this repository

작업마다 별도 브랜치와 워크트리를 사용한다. 다른 작업의 변경을 포함하거나 덮어쓰지 않는다.

`main` 은 PR 전용이다. 변경은 PR로 제출하고 필수 검사가 통과한 뒤 병합한다.

이 저장소의 origin 은 배포 미러로 이어진다. 새 워크트리에는 `node_modules` 와 `.env` 가 필요하다. 준비 방법은 `.claude/worktree-bootstrap.md` 를 참고한다.

## CI checks

`check.yml` has eight jobs: `verify`, `deployment-gate`, `docker`, `shellcheck`, `policy`, `audit`, `flake-watch`, and `gate`. The branch ruleset requires two check names: `gate` and `codeql`.

`gate` 에서는 `success` 만 통과한다. 스킵이 허용된 잡은 `ALLOWED_SKIP` 에 이름으로 적힌 것뿐이다(현재 `flake-watch`). 잡에 `if:` 를 붙이면 게이트가 통과하는 대신 실패한다.

`check.yml` 의 `deployment-gate` 잡은 `test/infrastructure/schema-surface.test.ts` 를 설치하지 않은 체크아웃에서 실행한다. 이 검사는 두 README 에 적힌 `git diff --name-only ... -- <경로>` 를 파싱해 감시 경로를 읽고, 양쪽 README 가 같은 경로를 대는지도 확인한다. README 를 수정할 때 그 문단을 보존한다.

`git ls-files` 를 사용하는 `test/source-reviewability.test.ts` 와 `test/scripts/what-ships.test.ts` 는 추적 파일만 검사한다. 새 파일을 만들면 `git add -A` 한 뒤 테스트를 실행한다. 로컬과 CI 가 서로 다른 파일 목록을 검사할 수 있다.

## Repository-specific constraints

- **Do not rewrite history on `main`.** A release gate in another repository pins commit shas from here; a rebase or amend makes it refuse releases. Tell the maintainers of that gate before any history rewrite.
- **Keep `security-audits/` and `tsconfig.test.json`.** `test/scripts/what-ships.test.ts` and the external release gate depend on their paths.
- DDL belongs only in `migrations/` and `src/infrastructure/migrations.ts`. A test enforces this because deployments compare those paths to decide whether schema changes can overlap during a rolling update.
- Do not put real names, addresses, or tokens in code, tests, or fixtures. Use `example.com`, `203.0.113.7`, and `10.0.0.11` as placeholders.

### External release-gate dependencies

stardust's release gate pins four commit shas from this repository: two ranges it runs `scripts/what-ships.sh` over, before trusting the answer, to prove the tool still speaks the two lines that gate greps for. A rebase or amend that moves those commits makes the gate refuse every release. Tell the maintainers before rewriting `main`.

stardust's release gate also depends on these path classifications:

| path | the answer their fixture needs | why it holds here |
|---|---|---|
| `tsconfig.test.json` | does not ship | it and `tsconfig.build.json` are both children of `tsconfig.json`, and the walk goes toward parents -- a sibling is unreachable |
| `security-audits/*.md` | does not ship | no `COPY` reaches it |

A third way to flip the second classification is to delete the reports. `test/scripts/what-ships.test.ts` names `security-audits/2026-08-15-security-audit.md` by path and commits a touch to it in a clone; the external fixture pins the same directory. Removing it breaks this side's test and the external gate.

The reports remain public. The one real zone name in the 2026-08-10 report was redacted, that report's head records the redaction, and every finding those reports carry has been remediated. The remaining addresses in them (`10.9.9.9`, `1.2.3.4`, `6.6.6.6`) are invented.

Both classifications are measured in `test/scripts/what-ships.test.ts`. Two things flip the first without anything in the external repository moving: making the test config a link in the build chain, and breaking that chain at all -- a chain the tool cannot follow widens the list to the whole tree. Widening over-reports, so no release is wrongly approved; the external fixture goes red.
