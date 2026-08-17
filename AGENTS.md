# Working in this repository

## The main tree is read-only — every change happens in a worktree

`Edit`/`Write` and tree-changing git commands are **always refused** in the main
working tree, including in a solo session. Several sessions and tools (Claude,
codex, a person at a shell) share this checkout, so an edit made here mixes
someone else's unfinished work into your commit — and this repository's origin
feeds a deploy mirror, so whatever slips in ships.

Workflow: `EnterWorktree` → work and commit there →
`git fetch origin && git rebase origin/main && git push origin HEAD:<branch>`

Outside Claude:
`git worktree add .claude/worktrees/<name> -b <branch> origin/main`

The main tree fast-forwards on its own when a session starts and ends, so you
never have to update it by hand. What still passes here: `Read`, `Grep`, and
`git status|log|diff|pull|fetch`.

New worktrees need `node_modules` and `.env` — see
`.claude/worktree-bootstrap.md`, which the refusal message prints for you.

If something genuinely must happen in the main tree — rescuing work an ended
session left behind, for instance — `touch .git/claude-main-tree-rescue`
(expires after 30 minutes), **only after the user approves it**.

### Where these came from

`scripts/claude-hooks/**`, `scripts/git-hooks/**` and `.codex/hooks.json` are a
**snapshot of stardust's**, taken at its commit `3e1e1ea7`, with the two guard
scripts and their tests re-taken from `80bb6dbd`. stardust holds the canonical
copy; this one is allowed to fall behind.

Those are kept **byte-identical on purpose** -- no local header, no local tweak.
That is the only thing that makes drift checkable at all: with both checkouts
present, `cmp` answers in one line. Editing them here to say they are copies
would remove the property that lets anyone tell.

`scripts/git-hooks/install.sh` is not in that set either, and the reason is the
opposite one. stardust's grew a second hook -- `pre-push`, which refuses a
correspondence document whose number is already taken. There are no
correspondence documents here, and no `pre-push` file to install, so taking that
version would `chmod` a path that does not exist and the installer would stop.
The difference is **fit, not staleness**: leave it, and re-take it only if this
repository ever grows the thing that hook guards.

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

### Rewriting history on `main` breaks something outside this repository

stardust's release gate pins four commit shas from here: two ranges it runs
`scripts/what-ships.sh` over, before trusting the answer, to prove the tool
still speaks the two lines that gate greps for. A rebase or amend that moves
those commits does not corrupt anything -- it makes their gate refuse every
release, and the reason it prints is "our control could not read it", which
points at the tool rather than at the rewrite.

So: **tell them before rewriting `main`.** Nothing here can detect it, and this
is the one dependency that lives entirely in another repository's file.

### What this does not cover

`git commit --no-verify` bypasses the git layer, and a clone that never ran
`bash scripts/git-hooks/install.sh` has no git layer at all. All three layers
fail open: a hook that errors internally lets the action through, because a hook
bug stopping every session is worse than a concurrent edit.
