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

`scripts/claude-hooks/**`, `scripts/git-hooks/**` and `.claude/settings.json` are
a **snapshot of stardust's**, taken at its commit `3e1e1ea7`. stardust holds the
canonical copy; this one is allowed to fall behind.

They are kept **byte-identical on purpose** -- no local header, no local tweak.
That is the only thing that makes drift checkable at all: with both checkouts
present, `cmp` answers in one line. Editing them here to say they are copies
would remove the property that lets anyone tell.

⚠️ Nothing detects stardust moving ahead. This is a record, not a mechanism: if
those hooks change there, this copy goes quietly stale, and the staleness lives
in a different repository than the check would. A fix belongs here rather than
upstream only if it is about this repository specifically -- otherwise it goes
to stardust and comes back with the next snapshot.

### What this does not cover

`git commit --no-verify` bypasses the git layer, and a clone that never ran
`bash scripts/git-hooks/install.sh` has no git layer at all. All three layers
fail open: a hook that errors internally lets the action through, because a hook
bug stopping every session is worse than a concurrent edit.
