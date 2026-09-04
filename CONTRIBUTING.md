# Contributing to Parallax

Thanks for looking. This is a small project with a specific shape, and the
fastest path to a merged change is knowing that shape before you start.

## Getting set up

Node 24 or newer, and pnpm — the version is pinned in `packageManager`, so
`corepack enable` gets you the right one without installing anything globally.

```bash
git clone https://github.com/henryj-dev/parallax
cd parallax
corepack enable
pnpm install --frozen-lockfile

pnpm check     # typecheck, no emit
pnpm test      # node --test over test/
pnpm build     # tsc -p tsconfig.build.json
```

Those three are what CI runs, so a green local run is a good predictor.

`.env` is not needed for `check`, `test`, or `build`. It is needed for
`pnpm dev`, `pnpm cli`, and the `verify:*` scripts. Start from `.env.example`,
which documents every variable.

**Install the git hooks once per clone:**

```bash
bash scripts/git-hooks/install.sh
```

They are hygiene rather than a boundary — `--no-verify` bypasses them, and they
say so — but they catch the common accident before it becomes a commit.

## When the suite is red or a total changed

Two records exist so a reader does not have to guess whether what they are seeing
has been seen before.

- [`docs/test-skips.md`](docs/test-skips.md) — the three intentional skips. Compare
  the `skipped N` total against it; a different total means a new skip to look at.
- [`docs/test-flakes.md`](docs/test-flakes.md) — failures observed **once** and not
  reproduced, with what was ruled out and how. If `pnpm test` goes red and passes on
  the next run, look here first, then add to it.

⚠️ **Keep the output.** `pnpm test 2>&1 | tee /tmp/px-test.log`. An intermittent
failure whose name was not captured cannot be narrowed at all — that is exactly the
gap the current entry in `test-flakes.md` records about itself.

## Running the real verifiers

`pnpm test` is hermetic. The scripts under `scripts/verify-*.sh` are not: they
drive a real Postgres, a real DNS listener, a real proxy, and a real Cloudflare
account.
```bash
pnpm verify:postgres
pnpm verify:dns
pnpm verify:proxy
pnpm verify:cloudflare     # ⚠️ talks to an actual Cloudflare zone
```

`pnpm verify:integration` runs all four. **`verify:cloudflare` writes records to
whatever zone your token can reach** — point it at a zone you are willing to have
edited, never a production one. None of these run in CI, for that reason.

## What CI will ask of you

Three workflows. `check` carries most of it as **jobs**, one per question, so
that a red result names its own cause instead of being one job that failed for
any of nine reasons:

| job in `check` | what it answers |
|---|---|
| `verify` | typecheck, portal typecheck, build, and `node --test` on Node 24 and 26 |
| `deployment-gate` | the schema surface, from a bare checkout with nothing installed — because that is how a deployment runs it |
| `docker` | the image builds, runs as uid 10001, and keeps `migrations/` unwritable |
| `hooks` | the Python hook suites under `scripts/`, which `node --test` cannot see |
| `shellcheck` | `scripts/*.sh` and `scripts/git-hooks/install.sh`, at `--severity=warning` |
| `policy` | secret scan, workflow audit, dependency review — from a shared reusable workflow, so five repositories agree |
| `audit` | the installed dependency tree against published advisories |
| `flake-watch` | the suite three times over on three platforms — **schedule and manual dispatch only** |
| `gate` | collects the above; this is a required check name |

The other two workflows are separate because their verdicts change while the
code does not: `codeql` (static analysis, also weekly over unchanged code) and
`scorecard` (a repository-posture scoreboard).

**The branch ruleset requires two check names: `gate` and `codeql`.** `scorecard`
is deliberately not required.

Two things worth knowing before you wonder why something is red:

- **A skipped job does not count as a pass.** `gate` accepts `success` only, and
  names the single job allowed to skip (`flake-watch`). If you add an `if:` to a
  job, the gate goes red until that job is added to the allowlist on purpose.
- **`policy` needs an organisation secret** (a gitleaks licence). Everything else
  runs without secrets. If you are contributing from a fork and `policy` fails
  for a reason that is clearly not your change, say so in the pull request — that
  is ours to fix, not yours to work around. The scan itself still happens: the
  same job runs an unlicensed gitleaks over the full history regardless.

⚠️ **`flake-watch` will not run on your pull request**, by design — three runs on
every PR would cost more waiting than the information is worth. It runs weekly,
and anyone can trigger it by hand from the Actions tab.

## House style

Read a few files before writing one. Two conventions are stronger here than in
most repositories:

**Comments explain why, not what.** The code says what it does. A comment earns
its place by recording the thing that is not recoverable from reading it — a
measurement, a failure that happened, a option that was tried and rejected.
Several comments in this repository carry a date and a number because that is
what made them worth keeping.

**Tests measure both directions.** A guard is tested by what it blocks *and* by
what it lets through; several suites here include a deliberately mutated copy of
the thing under test, to prove the test would notice if it broke. A test that
only asserts the failure path passes just as happily against code that fails at
everything.

Both READMEs are maintained. If your change touches documented behaviour, update
`README.md` and `README.ko.md` together — a translation that drifts is worse than
one that does not exist.

## Some things that will surprise you

- **Do not rewrite history on `main`.** A release gate in another repository
  pins commit shas from here; a rebase or amend makes it refuse every release,
  and the reason it prints points at the wrong thing. `AGENTS.md` has the
  details.
- **`security-audits/` and `tsconfig.test.json` are load-bearing.** Both are
  named by `test/scripts/what-ships.test.ts` and by that same external gate.
  Moving or deleting either breaks a check whose cause is not visible from your
  diff.
- **DDL lives in exactly two places, and a test enforces that.** A deployment
  decides whether two versions may overlap during a rolling update by diffing
  `migrations/` and `src/infrastructure/migrations.ts` — nothing else. Put a
  `CREATE TABLE` anywhere else in `src/` or `cmd/` and that check keeps
  answering "no schema change", which reads as *safe*.
  `test/infrastructure/schema-surface.test.ts` fails your pull request for it,
  and it reads the watched paths out of the command documented in both READMEs
  rather than repeating them — so if you change where schema lives, the READMEs
  are what you edit. Both of them, identically.
- **The hook scripts are a snapshot.** Everything under `scripts/claude-hooks/`
  and `scripts/git-hooks/` is copied from another repository and kept
  byte-identical on purpose, so that drift is checkable with one `cmp`. A fix
  that is not specific to Parallax belongs upstream, not here. `AGENTS.md`
  explains which files are exceptions and why.
- **No real names in the diff.** Zone names, addresses, and tokens stay out of
  code, tests, and fixtures. `example.com`, `203.0.113.7`, and `10.0.0.11` are
  the house placeholders.

## Opening the pull request

Branch off `main`, keep the change focused, and describe what you verified by
hand — CI covers the rest. Commit messages here are written in Korean or English;
either is fine, as long as the subject line says what changed rather than that
something changed.

## Reporting a vulnerability

Not here. See [SECURITY.md](.github/SECURITY.md) — use private reporting, never a
public issue.

## Licence

Parallax is Apache-2.0. Contributions are accepted under the same licence.
