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

## Changing something 001 already created

`CREATE TABLE IF NOT EXISTS` does not revisit a table that exists, so editing a
column, a default, or a constraint in `001` reaches only databases that have not
been created yet. Every installation already running keeps what it was created
with, while the file reads as though it were fixed -- which is worse than not
fixing it, because the next person believes the file.

Changing something that already exists takes a new file with a statement that
says so. Guard it on the catalog rather than re-running the change, so that
re-applying it on every pod start costs a lookup:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'the_new_name') THEN
    ALTER TABLE ... DROP CONSTRAINT IF EXISTS the_old_name;
    ALTER TABLE ... ADD CONSTRAINT the_new_name CHECK (...) NOT VALID;
  END IF;
END $$;
```

`IF NOT EXISTS` does not apply to constraints, which is why the guard names the
new constraint instead. `NOT VALID` skips the scan of existing rows; it is only
sound when the new rule accepts everything the old one did. See
`003_audit_actions.sql`.

## Adding one

Name it `NNN_short_description.sql`, continuing the sequence.

Re-runnability is checked behaviourally, not by inspection: `pnpm verify:postgres`
applies the whole set to a fresh PostgreSQL, applies it again, and asserts the
second run succeeds and the schema is unchanged — then runs three applications
concurrently and asserts the same. Run it before adding a migration, because it
is the only thing standing between an irreversible statement and a pod restart.
