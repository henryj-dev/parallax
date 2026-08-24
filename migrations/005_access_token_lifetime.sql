-- Gives an access token an end and a record of its last use.
--
-- Until now an issued token was valid until somebody remembered to revoke it,
-- and nothing said whether anybody still used it -- so the safe action and the
-- discoverable one were different, which is how unused credentials survive.
--
-- Both columns are nullable and both default to NULL, which is exactly what
-- every existing row means: no expiry, never observed. Nothing is invalidated
-- by applying this.
BEGIN;

ALTER TABLE parallax_access_tokens
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'parallax_access_tokens'::regclass
      AND conname = 'parallax_access_token_expiry_check'
  ) THEN
    -- An expiry before the token existed would be a row that was never usable,
    -- which is a mistake rather than a policy.
    ALTER TABLE parallax_access_tokens
      ADD CONSTRAINT parallax_access_token_expiry_check
        CHECK (expires_at IS NULL OR expires_at > created_at);
  END IF;
END $$;

COMMIT;
