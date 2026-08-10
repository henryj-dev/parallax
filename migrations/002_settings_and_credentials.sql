-- Moves operational configuration out of the environment and into the database,
-- so a deployment is configured once and every instance reads the same values.
-- The environment keeps only what cannot be bootstrapped from storage: where to
-- bind, how to reach the database, and the keys that protect what is stored.
BEGIN;

-- One row per setting, so adding a setting needs no schema change and a
-- concurrent write to an unrelated setting cannot clobber it.
CREATE TABLE IF NOT EXISTS parallax_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Provider credentials are held as one AES-256-GCM document encrypted with
-- PARALLAX_CREDENTIAL_MASTER_KEY. The database stores ciphertext it cannot
-- read, and the format is identical to the file backend so a deployment can
-- move between them. Nothing queries credentials by SQL, so a single row keeps
-- the encryption boundary whole instead of splitting it across columns.
CREATE TABLE IF NOT EXISTS parallax_credential_store (
  id smallint PRIMARY KEY CHECK (id = 1),
  document text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Access tokens are stored only as digests: the control plane can verify a
-- presented token but cannot reproduce one, so a database leak does not hand an
-- attacker a working credential.
CREATE TABLE IF NOT EXISTS parallax_access_tokens (
  id text PRIMARY KEY,
  subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  token_digest text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);

COMMIT;
