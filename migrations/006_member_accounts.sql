BEGIN;

-- Additive preparation only. Explicit accounts enable writes the feature marker.
CREATE TABLE IF NOT EXISTS parallax_auth_features (
  feature text PRIMARY KEY CHECK (feature ~ '^[a-z][a-z0-9_-]{0,63}$')
);
CREATE TABLE IF NOT EXISTS parallax_account_state (
  id integer PRIMARY KEY CHECK (id = 1),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  revision bigint NOT NULL CHECK (revision > 0)
);
CREATE TABLE IF NOT EXISTS parallax_account_audit (
  id text PRIMARY KEY,
  entry jsonb NOT NULL CHECK (jsonb_typeof(entry) = 'object')
);

COMMIT;
