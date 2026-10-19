# Migrations

`parallax migrate` applies a fixed, target-specific manifest. It refuses to
connect to PostgreSQL if the trusted migrations directory contains an
unexpected SQL file or a manifest entry is missing.

Every applied file is recorded in `parallax_schema_migrations` with its SHA-256
checksum. A later run skips an entry whose checksum matches and fails closed if
an already-applied file changed. Migration files are therefore immutable: fix
or extend an installed schema with a new numbered file, never by editing an old
one.

## Transaction and concurrency model

Each checked-in SQL file has exactly one outer `BEGIN` / `COMMIT` wrapper so it
is still safe to run directly with `psql`. The application runner removes that
wrapper and owns the transaction:

1. `BEGIN`
2. execute the migration body
3. insert its checksum ledger row
4. `COMMIT`

The schema change and ledger entry are consequently indivisible. A crash cannot
leave an applied migration unrecorded and cause it to be replayed next time.
A session advisory lock serializes the complete manifest across concurrent init
containers, while every manifest entry remains its own transaction.

## Adding a migration

Name it `NNN_short_description.sql`, continuing the sequence, and add the exact
filename to the appropriate `MIGRATION_FILES` target in
`src/infrastructure/migrations.ts`. Keep the single outer transaction wrapper.
An unlisted file is treated as possible SQL injection and is never executed.

Prefer additive, compatibility-preserving DDL. Existing installations may run
old and new application replicas during a rollout, so a migration should not
drop or reinterpret data that the previous version still uses.

Run `pnpm verify:postgres` before merging. It exercises the manifest and
checksum ledger against real PostgreSQL, verifies that a second run is a no-op,
and runs concurrent migrators under the advisory lock.

## 006 and member accounts

`006_member_accounts.sql` adds `parallax_auth_features`,
`parallax_account_state` and `parallax_account_audit` and inserts nothing, so
applying it leaves member accounts off. `parallax accounts enable` is what
writes the `member-accounts-v1` marker, in the same transaction as the account
state.

Additive here does not mean an older binary is safe afterwards. A binary that
predates the authentication feature check ignores the marker and would serve
the old sign-in over a store that has members. Once accounts are enabled, roll
back only to a version that refuses the marker, and never by dropping these
tables.
