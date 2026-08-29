# Working in this repository

## 에이전트는 워크트리, 사람은 메인에서 작업

에이전트의 `Edit`/`Write`/트리 변경 git 명령은 메인에서 **항상 거부**된다. 사람은 메인에서
수정·커밋·push 할 수 있다. 에이전트 작업 흐름: 하네스 전용 worktree 도구 또는
`python3 scripts/claude-hooks/enter-worktree.py <name>` → 생성된 경로에서 작업·커밋 →
`git fetch origin && git rebase origin/main && git push origin HEAD:<branch>`

**That push is what "done with a work cycle" means here — there is no separate
merge step.** A worktree left with commits but no push has not landed on main
yet; the cycle isn't finished until `HEAD` is on `origin/main`.

**2026-08-23 부터는 거기서 한 걸음 더 간다: 푸시하고 CI 가 초록이어야 끝이다.**
그 전까지 이 저장소에는 워크플로가 `check` 하나뿐이었고, 그래서 이 문단은 푸시를
종점으로 적을 수 있었다. 빨간 결과를 남기고 떠난 사이클은 끝난 것이 아니라 남에게
넘긴 것이다.

⚠️ **그리고 이 문단도 한 번 뒤처졌다.** 2026-08-23 에는 워크플로가 다섯이었고 여기에
그 다섯을 나열해 두었다. `#9` 가 PR·머지·배포를 세 층으로 가르면서 `scripts` 와
`docker` 는 `check.yml` 안의 잡이 되었고, `dependency-review` 는 공용 재사용
워크플로로 옮겨갔고, `scorecard` 가 새로 붙었다. **측정 2026-08-29:** 워크플로 파일은
`check.yml` · `codeql.yml` · `scorecard.yml` 세 개, `check.yml` 의 잡은 `verify` ·
`deployment-gate` · `docker` · `hooks` · `shellcheck` · `policy` · `gate` 일곱 개다.
숫자를 다시 세는 것 말고 이 문단을 최신으로 유지하는 장치는 없다 — 이 파일의 다른
경고와 같은 종류다. `README` 쪽 같은 문장은 **`test/scripts/documented-counts.test.ts`
가 강제한다**; 여기는 그렇지 않으니 `ls .github/workflows` 를 믿을 것.

**또 하나: 푸시가 끝이라고 적힌 위 문단도 지금은 절반이다.** `#9` 이후 `main` 은
`gate` 를 요구하는 브랜치 규칙 아래 있고, 최근 사이클은 전부 PR 로 들어갔다(`#8`~).
그래서 실제 종점은 「브랜치 푸시 → PR → `gate` 초록 → 머지」이고, origin 이 배포
미러로 이어지므로 **머지는 곧 배포다.** 머지 여부는 사람이 결정한다.

에이전트에게 특히 걸리는 지점 둘:

- `scripts/claude-hooks/**` 와 `scripts/git-hooks/**` 의 검사가 **이제 CI 에서 돈다.**
  전에는 `pnpm test`(`node --test`)가 `.py` 를 보지 못해 아무도 돌리지 않았다. 그 스냅샷을
  건드리면 이제 결과가 나온다.
- `check.yml` 의 `deployment-gate` 잡은 `test/infrastructure/schema-surface.test.ts` 를
  **아무것도 설치하지 않은 맨 체크아웃에서** 돌린다. 그 검사는 두 README 에 적힌
  `git diff --name-only ... -- <경로>` 를 파싱해 감시 경로를 읽고, 양쪽 README 가 같은
  경로를 대는지까지 본다. README 를 다시 쓰면서 그 문단을 지우면 이 잡이 빨개진다 —
  실제로 한 번 그렇게 됐다.

Raw `git worktree add` remains blocked for agents. The checked-in creator is
the harness-neutral fallback and records ownership for cleanup.

The main tree fast-forwards on its own when a session starts and ends, and only
when it is clean. A person leaving uncommitted work on main makes auto-ff skip
— that is the cost of allowing human commits there. The user can pull the main
tree directly, any time; `pull`/`fetch` are always allowed there regardless of
what else is going on. What still passes here for an agent: `Read`, `Grep`, and
`git status|log|diff|pull|fetch`.

This repository's origin feeds a deploy mirror, so whatever an agent slips onto
main ships. New worktrees need `node_modules` and `.env` — see
`.claude/worktree-bootstrap.md`, which the refusal message prints for you.

If something genuinely must happen in the main tree — rescuing work an ended
session left behind, for instance — `touch .git/claude-main-tree-rescue`
(expires after 30 minutes), **only after the user approves it**.

### Where these came from

`scripts/claude-hooks/**`, `scripts/git-hooks/**` and `.codex/hooks.json` are a
**snapshot of stardust's**. It was first taken at its commit `3e1e1ea7` and has
been re-taken since. stardust holds the canonical copy; this one is allowed to
fall behind.

**Measured 2026-08-23:** `main-tree-guard.py` and its regression test were
re-taken from stardust. They had drifted in the three days since the previous
measurement, while the paragraph above still said the nine were identical —
exactly the staleness the warning below describes, and the second time this
record has been caught a step behind the thing it records. stardust's
`390af71c` fixes a false positive: an Add File into a **new nested directory**
inside a worktree has no existing parent, so the walk fell back to the session
cwd — usually main — and refused legitimate worktree work as a main-tree edit.
Repository-specific settings, bootstrap, installer, and the intentionally
absent correspondence pre-push hook remain fit.

The same walk sent a fix the other way, which is the direction this file had
not yet had an occasion to record. `scripts/git-hooks/pre-commit` looked for
`CLAUDE_CODE` and `CLAUDE_SESSION_ID`; Claude Code actually plants `CLAUDECODE`
and `CLAUDE_CODE_SESSION_ID`. One character apart, so the list read as correct.
Measured with `printenv` inside a Bash tool subprocess: **all eight** of the
list's names are empty there, so the git layer had been classifying Claude
sessions as *people*. A/B from a main tree, same cwd and the real session
environment — old hook `exit 0`, fixed hook `exit 1`. PreToolUse normally
refuses first, so nothing visibly broke; but all three layers fail open, and
this was the layer meant to catch the other two doing so. It went to stardust
first (`4e04d5c0`) and came back here in the same re-take, so both sides stay
byte-identical. Nothing was wrong here that was not also wrong there — which
is the case the "fix it upstream" rule exists for.

**Measured 2026-08-23** against this re-take and stardust `4e04d5c0`.
The walk is the **union** of both sides' paths under those
globs — a file that exists on only one side is a difference, the same way a
byte-unequal file is. The 2026-08-18 measurement walked the files this side
has and reported ten `cmp` plus `install.sh`. That was the intersection. The
range was written as `scripts/git-hooks/**`, so "all ten identical" read as
an answer about everything that glob covers.

| | count | |
|---|---|---|
| both sides, byte-identical | 11 | the nine under `scripts/claude-hooks/**`, `pre-commit`, `test-pre-commit.py` |
| both sides, different | 2 | `scripts/git-hooks/install.sh`, `.codex/hooks.json` — both fit, below |
| only there | 2 | `scripts/git-hooks/pre-push`, `scripts/git-hooks/test-pre-push.py` (`00ee877e`) |
| only here | 0 | |

⚠️ **Re-measured later the same day, after `511fd79`: the counts above still
hold — 11 / 2 / 2 / 0, walked again as the union — but the baseline sentence
that used to sit here did not.** It named `4e04d5c0` as the last commit there
to touch the identical eleven. Three landed after it, all on 2026-08-23:
`a0b2c953` (the race-recheck fix, authored from this side), `8b6ca178` (four
guard defects), and `fa1b2667` (a fixture leaning on the default branch name of
the *git build* it runs under). So the last one is now **`fa1b2667`**, and it is
here — the eleven are byte-identical against a stardust tree that contains it.

📌 **That is the third time this record has been a step behind the thing it
records**, after the `80bb6dbd` correction above and the pair before it. The
counts survived because they get re-walked; the commit number did not, because
nothing re-derives it. Treat a sha in this section as **the date it was written
on**, not as a current fact — and re-run the walk rather than reading it.

The two that exist only there still date from `00ee877e`. The eleven match after this re-take; before
it, `main-tree-guard.py` and `test-main-tree-guard.py` had drifted while the
previous paragraph still said they had not. That is the same sentence the
2026-08-20 measurement had to write about two different files, so treat the
pattern rather than the pair as the finding: **the record goes stale between
occasions to run the walk, and only running it says which files moved.**

⚠️ **This paragraph said `80bb6dbd` for two of those files, and that was wrong
one commit after it was written.** `66959a3` wrote the sentence; `409d2c2` took
`test-main-tree-guard.py` again from `33a6863f` — and edited this very file
without touching the number. So the record was a commit behind the thing it
recorded, in the one document whose whole job is to be the record. A per-file
baseline is what made that possible, so there is one commit here now.

Those are kept **byte-identical on purpose** -- no local header, no local tweak.
That is the only thing that makes drift checkable at all: with both checkouts
present, `cmp` answers in one line. Editing them here to say they are copies
would remove the property that lets anyone tell.

`scripts/git-hooks/install.sh` is not in the identical set, and the reason is
the opposite one. stardust's grew a second hook -- `pre-push`, which refuses a
correspondence document whose number is already taken. There are no
correspondence documents here, and no `pre-push` file to install, so taking
that installer would `chmod` a path that does not exist and the installer
would stop. The difference is **fit, not staleness**: leave it, and re-take it
only if this repository ever grows the thing that hook guards.

**2026-08-23 — `.codex/hooks.json` left that set, and for the same kind of
reason.** Its first `PreToolUse` entry auto-approved `ssh`/`scp` to any
`10.0.0.0/8` host, tagged `mesh-10/8-ssh`. That is a fine thing to carry in a
private repository and the wrong thing to publish: it tells a reader that a
private mesh exists, and it hands every future contributor who clones this an
auto-approval into it. The entry is gone here; the three that call
`scripts/claude-hooks/**` are untouched, so what the file does for the main-tree
guard is unchanged. **Fit, not staleness** — the divergence is this repository
going public, not stardust moving ahead, and re-taking the file would put the
entry back. If stardust changes the guard wiring, take that part and leave the
ssh entry out.

The two files that exist only there are the same decision, not a second one.
Taking `pre-push` itself would be a third copy of a hook whose job does not
exist here. A walk of this side cannot see them — they are not different, they
are absent, and `cmp` has nothing to compare.

`.claude/settings.json` is **not** in that set, though this file used to claim it
was. It cannot be: `symlinkDirectories` names this repository's own dependency
directories, and stardust's copy names three of its own. Only the `hooks` block
and `worktree.baseRef` are meant to agree, and `cmp` will always report a
difference here -- so compare those two keys, not the file.

stardust's `.codex/config.toml` is deliberately **not** taken: it sets shell
environment for that repository, and copying it here would put a second copy of
someone's credentials in a second place.

### 스냅샷을 CI 에서 돌리기 시작하니 하나가 흔들렸다 — 그리고 그게 진짜였다

**측정 2026-08-23, 같은 날 해소.** `scripts.yml` 이 이 스위트들을 처음으로 실제로
돌리기 시작했고 — 그전에는 `pnpm test`(`node --test`)가 `.py` 를 못 봐서 **아무도 돌린
적이 없었다** — `test-session-end-cleanup.py` 의 `동시 실행을 실패로 보고하지 않는다`
가 **CI 11회 중 1회** 실패했다. 재실행하면 통과했고, 맥에서 격리 클론 12회는 0회였다.

**흔들린 이유를 좁혔더니 결함이 둘이었다.** `fast_forward_main` 은 merge 가 실패하면
HEAD 와 업스트림을 다시 읽어 「남이 이미 올렸나」를 보는데, 그 읽기가 **즉시 한 번**이라
두 방향으로 틀렸다:

| | 무엇이 | 얼마나 나쁜가 |
|---|---|---|
| 비관 | 이긴 쪽이 아직 ref 를 갱신하기 전에 읽어 실패로 적는다 | 시끄러울 뿐 — **CI 에서 본 그 한 건** |
| 낙관 | 경합으로 `rev-parse` 가 죽으면 두 호출이 같은 에러 문자열을 돌려줘 「같다」로 읽힌다 | 🔴 **트리가 뒤처진 채 성공을 보고한다** |

🔑 **간헐 실패를 「러너가 느려서」로 넘겼으면 두 번째를 못 봤다.** 눈에 띈 것은 시끄러운
쪽인데, 같은 코드 세 줄에 조용한 쪽이 붙어 있었다.

⚠️ **동시 실행 검사로는 이 둘을 못 잡는다** — 재현이 기계 속도에 달렸다(이 맥 32 스레드
20 라운드 0회). 그래서 정본 쪽 검사는 진 쪽이 보는 상태를 **git 대역으로 주입해
결정적으로** 잰다. 두 창 각각 + 「끝까지 다르면 실패」 + rc 확인을 지운 변이본.

**고친 곳은 stardust** (`a0b2c953`) — Parallax 에 국한된 문제가 아니라 가드 자신의
동시성 처리라, 위의 규칙대로 정본에서 고치고 여기로 다시 떴다(`f29d177`).

**그리고 그것으로 끝이 아니었다.** 같은 날 `511fd79` 가 정본을 **통째로** 다시 떴고,
그때 딸려 온 것이 이 건을 포함해 넷이었다 — 즉 이 사본은 이 건 말고도 **세 가지가 더
뒤처져 있었다**:

| | 무엇이 | 왜 나쁜가 |
|---|---|---|
| ① | `MUTATING` 정규식의 지수 백트래킹 | 이 훅은 **모든 도구 호출 앞**에서 돈다. 실측 n=26 에 **40초** — fail-open 은 「오류가 나면 통과」이지 **「멈추면 통과」가 아니다** |
| ② | 다중 경로에서 앞의 하나가 전체를 대표 | 남의 저장소 경로를 앞에 세우면 뒤에 붙은 우리 트리 파일이 그대로 실려 갔다 |
| ③ | `apply_patch` 인식이 세 곳에서 두 답 | 봉투를 배열로 주거나 머리말을 빼면 같은 편집이 지나갔다 |
| ④ | 이 문단의 경합 재확인 | 위 참조. 정본은 여기에 **락 재시도**까지 붙였다 |

📌 **한 건을 좇아 정본에 갔더니 세 건이 더 있었다.** 「우리 것만 고쳐 오면 된다」로
좁게 뜨면 나머지 셋은 그대로 남는다 — 부분 스냅샷보다 **전체 재스냅샷이 맞다**는 쪽의
증거다. 이후 `fa1b2667` 까지 들어와 지금 열한 개가 바이트 동일이다.

⚠️ **재스냅샷하다 한 번 헛짚었다.** 소스를 stardust 의 **메인 트리**로 잡았는데 그쪽이
3커밋 뒤처져 있었다 — `cmp` 는 「전부 동일」이라 답했고 그건 **옛것끼리 비교한 결과**다.
`git status` 가 깨끗한 것을 보고서야 알았다. **정본을 뜨기 전에 정본을 먼저 당길 것.**

⚠️ Nothing detects stardust moving ahead. This is a record, not a mechanism: if
those hooks change there, this copy goes quietly stale, and the staleness lives
in a different repository than the check would. A fix belongs here rather than
upstream only if it is about this repository specifically -- otherwise it goes
to stardust and comes back with the next snapshot.

That is still true, and the cost of it has now been paid in both directions.
stardust asked the same question from their end, measured against `3e1e1ea7`,
and read the three commits since as this copy having fallen behind -- it had
not. They used the baseline this paragraph handed them, and the letter that
handed it over quoted only the `3e1e1ea7` half of a sentence that already had
two. **The check was never the hard part: walk both trees, `cmp` the
intersection, list each remainder.** What is missing is an occasion to run it,
and until there is one, the honest form of this record is a measurement with a
date on it rather than a commit number with a story about it.

### Rewriting history on `main` breaks something outside this repository

stardust's release gate pins four commit shas from here: two ranges it runs
`scripts/what-ships.sh` over, before trusting the answer, to prove the tool
still speaks the two lines that gate greps for. A rebase or amend that moves
those commits does not corrupt anything -- it makes their gate refuse every
release, and the reason it prints is "our control could not read it", which
points at the tool rather than at the rewrite.

So: **tell them before rewriting `main`.** Nothing here can detect it, because
the dependency lives entirely in another repository's file — and it is no longer
the only one of those, see below.

### Their gate also rests on two classifications from here

stardust's release gate moved its own fixtures onto paths in this repository,
and what those fixtures pin is what `scripts/what-ships.sh` answers for them:

| path | the answer their fixture needs | why it holds here |
|---|---|---|
| `tsconfig.test.json` | does not ship | it and `tsconfig.build.json` are both children of `tsconfig.json`, and the walk goes toward parents -- a sibling is unreachable |
| `security-audits/*.md` | does not ship | no `COPY` reaches it |

⚠️ **A third way to flip the second one: delete it.** Going public raised the
question of whether the audit reports should stay in a public repository at all
— they describe the attack surface of a deployment that is running. The answer
here is that they stay, and the reason is not preference. `what-ships.test.ts`
names `security-audits/2026-08-15-security-audit.md` by path and commits a touch
to it in a clone; their (G) fixture pins the same directory. Removing it breaks
this side's test and their gate at once, in the same way rewriting `main` does,
and for the same reason — the dependency lives in a file nothing here can see.

What was done instead is narrower: the one real zone name in the 2026-08-10
report was redacted, that report's head records the redaction, and every finding
those reports carry has been remediated. The remaining addresses in them
(`10.9.9.9`, `1.2.3.4`, `6.6.6.6`) are invented. **If these ever should leave,
that is a conversation with stardust first, not a `git rm`.**

Both are measured in `test/scripts/what-ships.test.ts` rather than left to this
table, because a paragraph is what went stale above. Two things flip the first
without anything in their repository moving: making the test config a link in
the build chain, and **breaking that chain at all** -- a chain the tool cannot
follow widens the list to the whole tree, and then every path here reads
`🔴 실립니다`, that one included.

⚠️ The second is the quiet one, and quiet *because* it is the safe direction for
us. Widening over-reports, so no release is wrongly approved and nothing here
stops -- while their fixture goes red looking exactly like a fixture that is
working. That is why the narrowing has its own control now.

### What this does not cover

The git layer only refuses an agent harness. A person at a shell can commit on
main. A harness not on the env list is treated as a person.

`git commit --no-verify` bypasses the git layer, and a clone that never ran
`bash scripts/git-hooks/install.sh` has no git layer at all. All three layers
fail open: a hook that errors internally lets the action through, because a hook
bug stopping every session is worse than a concurrent edit.
