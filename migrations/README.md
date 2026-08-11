# Migrations

Applied with `parallax migrate`, which replays **every file in this directory in
name order, on every run**. There is no version table deciding what to skip.

## The constraint that makes that safe

Each file must be re-appliable with no effect the second time:

- every object created with `IF NOT EXISTS`
- each file wrapped in its own `BEGIN` / `COMMIT`
- no irreversible DDL — nothing that drops or rewrites data

## Why this is a constraint and not a preference

A deployment can run the command as an init container, which means **the schema
is applied every time a pod starts** — not once, by a person, at a moment they
chose. A restart applies it. A node moving applies it. Scaling out applies it,
concurrently, which is why `applyMigrations` takes a session advisory lock.

So a file that is not re-appliable does not fail during review. It fails the
next time something reschedules a pod, which may be weeks later and will not
look like it was caused by the migration.

## Adding one

Name it `NNN_short_description.sql`, continuing the sequence.

Re-runnability is checked behaviourally, not by inspection: `pnpm verify:postgres`
applies the whole set to a fresh PostgreSQL, applies it again, and asserts the
second run succeeds and the schema is unchanged — then runs three applications
concurrently and asserts the same. Run it before adding a migration, because it
is the only thing standing between an irreversible statement and a pod restart.
