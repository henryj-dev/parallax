-- Widens the audit action list to include `records.adopted`.
--
-- 001 declares the list inside `CREATE TABLE IF NOT EXISTS`, so editing it there
-- would only reach databases that did not exist yet: an installation already
-- running keeps the constraint it was created with, forever, while the file
-- reads as though it had been fixed. Changing a constraint on a table that
-- already exists takes a statement that says so.
--
-- The replacement is guarded by the new constraint's name rather than by
-- `IF NOT EXISTS`, which does not apply to constraints. Once the guard sees its
-- own name the whole block is skipped, so re-applying this file on every pod
-- start costs one catalog lookup instead of re-validating the audit table --
-- which only grows.
--
-- `NOT VALID` skips the one scan the initial ADD would do. It is sound here
-- because the new list contains every value the old one allowed, so no stored
-- row can violate it. A future migration that *removes* an action must think
-- about this again: `NOT VALID` would let historical rows keep a value the
-- constraint no longer permits, which for an audit trail is the right outcome
-- but should be a decision rather than an inheritance.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'parallax_audit'::regclass
      AND conname = 'parallax_audit_action_check_v2'
  ) THEN
    ALTER TABLE parallax_audit DROP CONSTRAINT IF EXISTS parallax_audit_action_check;
    ALTER TABLE parallax_audit ADD CONSTRAINT parallax_audit_action_check_v2 CHECK (action IN (
      'zone.created',
      'zone.deleted',
      'record.upserted',
      'record.deleted',
      'desired.replaced',
      'desired.restored',
      'records.adopted'
    )) NOT VALID;
  END IF;
END $$;

COMMIT;
