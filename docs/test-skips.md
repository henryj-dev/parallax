# Intentional test skips

The test suite currently reports three intentional skips. Reviewers should
compare the `skipped N` total in the `pnpm test` summary with this list; a
different total requires investigating the new skip before the audit is closed.

- `test/infrastructure/atomic-file.test.ts:103` — `linuxOnly()`: stale-lock
  recovery depends on Linux-only process-start metadata.
- `test/infrastructure/atomic-file.test.ts:122` — `linuxOnly()`: the paired
  stale-lock recovery case has the same platform requirement.
- `test/adapters/provider-contract.test.ts:75` — `context.skip(...)`: the
  in-memory provider intentionally lacks the ownership check exercised by the
  shared contract; the skip includes its reason at line 307.

The first two cases run on the Linux CI runner. The third is an explicit,
reasoned contract exception, not an unimplemented test.
