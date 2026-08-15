-- Persists partial provider progress and widens the audit vocabulary for the
-- write-ahead/result records emitted around provider reconciliation.
BEGIN;

ALTER TABLE parallax_apply_statuses
  ADD COLUMN IF NOT EXISTS completed_operations integer,
  ADD COLUMN IF NOT EXISTS planned_operations integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'parallax_apply_statuses'::regclass
      AND conname = 'parallax_apply_status_progress_check'
  ) THEN
    ALTER TABLE parallax_apply_statuses
      ADD CONSTRAINT parallax_apply_status_progress_check CHECK (
        (completed_operations IS NULL AND planned_operations IS NULL)
        OR (
          completed_operations >= 0
          AND planned_operations >= 0
          AND completed_operations <= planned_operations
        )
      ) NOT VALID;
    ALTER TABLE parallax_apply_statuses
      VALIDATE CONSTRAINT parallax_apply_status_progress_check;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'parallax_audit'::regclass
      AND conname = 'parallax_audit_action_check_v3'
  ) THEN
    ALTER TABLE parallax_audit DROP CONSTRAINT IF EXISTS parallax_audit_action_check;
    ALTER TABLE parallax_audit DROP CONSTRAINT IF EXISTS parallax_audit_action_check_v2;
    ALTER TABLE parallax_audit ADD CONSTRAINT parallax_audit_action_check_v3 CHECK (action IN (
      'zone.created',
      'zone.deleted',
      'record.upserted',
      'record.deleted',
      'desired.replaced',
      'desired.restored',
      'records.adopted',
      'provider.apply.started',
      'provider.apply.completed',
      'provider.apply.failed'
    )) NOT VALID;
    ALTER TABLE parallax_audit VALIDATE CONSTRAINT parallax_audit_action_check_v3;
  END IF;
END $$;

COMMIT;
