# Working in this repository

## 에이전트는 워크트리, 사람은 메인에서 작업

에이전트의 `Edit`/`Write`/트리 변경 git 명령은 메인에서 **항상 거부**된다. 사람은 메인에서
수정·커밋·push 할 수 있다. 에이전트 작업 흐름: 하네스 전용 worktree 도구 또는
`python3 scripts/claude-hooks/enter-worktree.py <name>` → 생성된 경로에서 작업·커밋 →
`git fetch origin && git rebase origin/main && git push origin HEAD:<branch>`

**That push is what "done with a work cycle" means here — there is no separate
merge step.** A worktree left with commits but no push has not landed on main
yet; the cycle isn't finished until `HEAD` is on `origin/main`.

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

**Measured 2026-08-20:** the tool-neutral creator, its regression test, and
owner-record locking were re-taken from stardust. Repository-specific settings,
bootstrap, installer, and the intentionally absent correspondence pre-push hook remain fit.

**Measured 2026-08-19** against this re-take and a stardust checkout at
`a74ebf4c`. The walk is the **union** of both sides' paths under those
globs — a file that exists on only one side is a difference, the same way a
byte-unequal file is. The 2026-08-18 measurement walked the files this side
has and reported ten `cmp` plus `install.sh`. That was the intersection. The
range was written as `scripts/git-hooks/**`, so "all ten identical" read as
an answer about everything that glob covers.

| | count | |
|---|---|---|
| both sides, byte-identical | 10 | the seven under `scripts/claude-hooks/**`, `pre-commit`, `test-pre-commit.py`, `.codex/hooks.json` |
| both sides, different | 1 | `scripts/git-hooks/install.sh` — fit, below |
| only there | 2 | `scripts/git-hooks/pre-push`, `scripts/git-hooks/test-pre-push.py` (`00ee877e`) |
| only here | 0 | |

The last commit there to touch any of the identical ten is `bdd4420b` — the
2026-08-19 change that lets a person commit on main and still refuses an
agent. The two that exist only there arrived at `00ee877e`. Today's identical
ten match after this re-take; before it, `pre-commit` and
`test-pre-commit.py` had already drifted while the previous paragraph still
said they had not.

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
