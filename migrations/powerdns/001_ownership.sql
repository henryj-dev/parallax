-- Applied to PowerDNS's own database, not Parallax's. `parallax migrate --target powerdns`.
--
-- PowerDNS stores records in `records`, which has no column Parallax can write a
-- marker into, and its `comments` table is keyed by name and type rather than by
-- record -- too coarse, because Parallax addresses individual RRset values by id.
--
-- So the marker gets a table of its own, keyed by the record it belongs to. It
-- lives here rather than in Parallax's database on purpose: ownership has to be
-- answerable from the provider alone, the same way a Cloudflare comment or a
-- zone-file comment is. Losing Parallax's database must not turn every record it
-- published into an orphan nothing will admit to owning.

BEGIN;

CREATE TABLE IF NOT EXISTS parallax_powerdns_ownership (
  -- The cascade is what keeps this honest. A record deleted directly in
  -- PowerDNS takes its ownership with it, so the table can never claim a row
  -- that is no longer there.
  record_id BIGINT PRIMARY KEY REFERENCES records (id) ON DELETE CASCADE,
  -- The same marker string the other providers carry, verified the same way.
  marker TEXT NOT NULL
);

COMMIT;
