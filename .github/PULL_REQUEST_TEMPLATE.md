<!--
Keep this short. The checklist below is the part that saves a round trip; the
prose above it is for whatever the diff cannot say on its own.
-->

## What this changes

<!-- One or two sentences. If it fixes an issue: "Fixes #123". -->

## Why

<!--
The reasoning, not the restatement. This repository's comments explain why
something is the way it is rather than what it does — pull requests are held to
the same bar, and a good "why" here usually ends up as the comment in the code.
-->

## How it was verified

<!--
What you actually ran, and what it said. "Tests pass" is what CI is for; this
field is for the part CI cannot see — the manual check, the reproduction that
now behaves, the verifier script you pointed at a real account.
-->

---

- [ ] `pnpm check` and `pnpm test` pass locally
- [ ] Behaviour change is covered by a test that fails without the change
- [ ] Docs updated — **both** `README.md` and `README.ko.md` if either changed
- [ ] No secrets, real zone names, or internal addresses in the diff or in test
      fixtures (`example.com`, `203.0.113.7`, and `10.0.0.11` are the house
      placeholders)

<!--
Two things worth knowing before you push:

- Rewriting history on `main` breaks a release gate outside this repository,
  which pins commit shas from here. Do not force-push `main`; say something
  first. See AGENTS.md.
- `security-audits/` and `tsconfig.test.json` are load-bearing for that same
  gate and for `test/scripts/what-ships.test.ts`. Moving or deleting either
  breaks a check whose cause is not visible from the diff.
-->
