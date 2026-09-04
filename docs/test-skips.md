# Intentional test skips

The test suite reports **five** intentional skips on Linux and macOS. Reviewers
should compare the `skipped N` total in the `pnpm test` summary with this list; a
different total requires investigating the new skip before the audit is closed.

> ⚠️ **The total is platform-dependent, and it always was — this file just did
> not say so.** `posixOnly()` returns `false` on Linux and macOS, so the first
> entry below runs there and skips only on Windows. Read the total as "five here,
> six on Windows", not as a constant.

## Platform gates — `test/infrastructure/atomic-file.test.ts`

- `:43` — `posixOnly()`: `/tmp` directory modes have no meaning on Windows.
  **Runs on Linux and macOS.** Until 2026-09-04 this was a bare
  `if (process.platform === "win32") return;`, which produced a *passing* test
  rather than a skip — invisible to the very ledger this file establishes. It is
  a real skip now, which is why the Windows total is six rather than five.
- `:102` — `linuxOnly()`: stale-lock recovery depends on Linux-only
  process-start metadata read from `/proc`.
- `:121` — `linuxOnly()`: the paired stale-lock recovery case has the same
  platform requirement.

The two `linuxOnly()` cases run on the Linux CI runner and skip on a
developer's Mac. The `posixOnly()` case runs on both.

## Contract exemptions — `test/adapters/provider-contract.test.ts`

The shared provider contract runs every rule against four harnesses. A harness
that cannot answer a rule declares an `exempt` entry giving its reason, and the
runner turns that into `context.skip(excuse)` at `:100`. **Three exemptions
exist, and each is a reasoned contract exception rather than an unimplemented
test.**

- `:364` (in-memory) — the in-memory provider intentionally lacks the ownership
  check the shared contract exercises.
- `:324` (file provider) and `:481` (RFC 2136) — neither implements
  `serviceOwnership`; the concept has no meaning for a flat state file or for a
  primary reached over RFC 2136.

⚠️ **The last two are new on 2026-09-04, and they are the point of the change
that added them.** The rule they exempt — "not knowing who owns a name is never
reported as nobody owning it" — used to begin `if (!adapter.serviceOwnership)
return;`. Those two harnesses therefore ran it with **zero assertions and
reported a pass**. Two of four harnesses were silently exempt from the rule that
guards the ownership check, and nothing said so. Declaring the exemption is what
makes them visible here; the count went 3 → 5 because two silent passes became
two stated skips.

That is the general lesson for this ledger: **a skip that shows up is cheaper
than a pass that means nothing.** An early `return` in a test body is the shape
to look for.
