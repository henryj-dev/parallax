BEGIN;

CREATE TABLE IF NOT EXISTS parallax_zones (
  name text PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE TABLE IF NOT EXISTS parallax_zone_revisions (
  zone_name text NOT NULL REFERENCES parallax_zones(name) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  PRIMARY KEY (zone_name, revision)
);

CREATE TABLE IF NOT EXISTS parallax_apply_statuses (
  zone_name text NOT NULL REFERENCES parallax_zones(name) ON DELETE CASCADE,
  view_name text NOT NULL,
  desired_revision integer NOT NULL CHECK (desired_revision >= 0),
  applied_revision integer NOT NULL CHECK (applied_revision >= 0),
  state text NOT NULL CHECK (state IN ('pending', 'applied', 'failed')),
  last_attempt_at timestamptz,
  error text,
  PRIMARY KEY (zone_name, view_name)
);

-- Audit history intentionally has no zone foreign key: deletion is itself audited.
CREATE TABLE IF NOT EXISTS parallax_audit (
  id bigserial PRIMARY KEY,
  zone_name text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action IN (
    'zone.created',
    'zone.deleted',
    'record.upserted',
    'record.deleted',
    'desired.replaced',
    'desired.restored'
  )),
  actor text NOT NULL,
  occurred_at timestamptz NOT NULL,
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX IF NOT EXISTS parallax_audit_zone_id_idx
  ON parallax_audit (zone_name, id);

COMMIT;
