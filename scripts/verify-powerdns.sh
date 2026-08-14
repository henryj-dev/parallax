#!/usr/bin/env bash
# Verifies the PowerDNS adapter against a real PowerDNS serving from a real
# PostgreSQL: records Parallax publishes resolve over DNS, records it does not
# own survive everything it does, and withdrawing one removes the answer.
#
# This is the internal view's other shape. CoreDNS needs a filesystem both
# processes can reach; PowerDNS keeps records in rows, so the deployment has no
# shared volume to arrange. Requires Docker and dig; containers are removed on
# exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NET="parallax-verify-pdns-$$"
DB="parallax-verify-pdnsdb-$$"
DNS="parallax-verify-pdns-auth-$$"
PGPORT="${PGPORT:-55440}"
DNSPORT="${DNSPORT:-15500}"
WORK="$(mktemp -d)"
ZONE="verify.example"
export PARALLAX_POWERDNS_DATABASE_URL="postgres://pdns:pdns@127.0.0.1:${PGPORT}/pdns?sslmode=disable"
export PARALLAX_STATE_FILE="$WORK/state.json"
export PARALLAX_CONFIG_FILE="$WORK/configuration.json"
export PARALLAX_OWNERSHIP_SECRET="verify-ownership-secret-that-is-at-least-32-bytes"

cleanup() {
  docker rm -f "$DNS" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "  FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*"; }
command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "skipped: Docker is required"; exit 0; }
command -v dig >/dev/null || { echo "skipped: dig is required"; exit 0; }

parallax() { node "$ROOT/cmd/parallax/main.ts" "$@"; }
# Docker Desktop's UDP forwarding is unreliable, and the data under test is the
# same on either transport.
query() { dig +short +tcp +time=3 +tries=2 -p "$DNSPORT" @127.0.0.1 "$@" 2>/dev/null | grep -v '^;' || true; }
rows() { docker exec "$DB" psql -h 127.0.0.1 -tAU pdns -d pdns -c "$1"; }

docker network create "$NET" >/dev/null

echo "== starting PostgreSQL and PowerDNS =="
docker run -d --name "$DB" --network "$NET" \
  -e POSTGRES_PASSWORD=pdns -e POSTGRES_USER=pdns -e POSTGRES_DB=pdns \
  -p "${PGPORT}:5432" postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$DB" psql -h 127.0.0.1 -U pdns -d pdns -c 'select 1' >/dev/null 2>&1 && break
  sleep 0.5
done
docker exec "$DB" psql -h 127.0.0.1 -U pdns -d pdns -c 'select 1' >/dev/null || fail "PostgreSQL did not become ready"

cat > "$WORK/pdns.conf" <<EOF
launch=gpgsql
gpgsql-host=${DB}
gpgsql-user=pdns
gpgsql-password=pdns
gpgsql-dbname=pdns
local-address=0.0.0.0
local-port=53
cache-ttl=0
query-cache-ttl=0
negquery-cache-ttl=0
# The list of zones is cached separately, for 300 seconds by default, and a zone
# added while PowerDNS is running is answered REFUSED until that expires. Records
# reach zones an operator creates whenever they like, so this belongs at 0 in a
# deployment too -- not just here to keep the test quick.
zone-cache-refresh-interval=0
EOF

# The image carries its own schema, so this never drifts from the version under
# test the way a copy in this repository would.
docker create --name "$DNS" --network "$NET" -p "${DNSPORT}:53/tcp" -p "${DNSPORT}:53/udp" \
  -v "$WORK/pdns.conf:/etc/powerdns/pdns.conf:ro" powerdns/pdns-auth-49:latest >/dev/null
docker cp "$DNS:/usr/local/share/doc/pdns/schema.pgsql.sql" "$WORK/schema.sql" \
  || fail "the PowerDNS image did not carry a PostgreSQL schema"
docker exec -i "$DB" psql -h 127.0.0.1 -q -v ON_ERROR_STOP=1 -U pdns -d pdns < "$WORK/schema.sql" >/dev/null
ok "PowerDNS's own schema applied ($(wc -l < "$WORK/schema.sql") lines)"

# A zone with authority data and one record an operator maintains by hand: the
# thing Parallax must never touch.
docker exec -i "$DB" psql -h 127.0.0.1 -q -v ON_ERROR_STOP=1 -U pdns -d pdns >/dev/null <<EOF
INSERT INTO domains (name, type) VALUES ('${ZONE}', 'NATIVE');
INSERT INTO records (domain_id, name, type, content, ttl) VALUES
  ((SELECT id FROM domains WHERE name='${ZONE}'), '${ZONE}', 'SOA', 'ns1.${ZONE} hostmaster.${ZONE} 1 10800 3600 604800 3600', 3600),
  ((SELECT id FROM domains WHERE name='${ZONE}'), '${ZONE}', 'NS', 'ns1.${ZONE}', 3600),
  ((SELECT id FROM domains WHERE name='${ZONE}'), 'hand-made.${ZONE}', 'A', '10.99.99.99', 300);
EOF
docker start "$DNS" >/dev/null
for _ in $(seq 1 60); do [ -n "$(query "hand-made.${ZONE}" A)" ] && break; sleep 0.5; done
[ "$(query "hand-made.${ZONE}" A)" = "10.99.99.99" ] || { docker logs "$DNS" 2>&1 | tail -10 >&2; fail "PowerDNS did not serve the hand-made record"; }
ok "PowerDNS answering from PostgreSQL, hand-made record resolves"

echo "== the ownership table is added to PowerDNS's database, not Parallax's =="
APPLIED=$(parallax migrate --target powerdns --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).applied.length))')
[ "$APPLIED" = "1" ] || fail "expected one PowerDNS migration, applied $APPLIED"
parallax migrate --target powerdns >/dev/null
ok "migration applied and re-applying is a no-op"

echo "== a published record resolves =="
parallax zone create --zone "$ZONE" >/dev/null
parallax record set --zone "$ZONE" --view internal --id portal \
  --record "{\"name\":\"portal\",\"type\":\"A\",\"content\":\"10.10.10.10\",\"ttl\":300}" >/dev/null
parallax apply --zone "$ZONE" --view internal | grep -q "state=applied" || fail "apply did not report applied"
sleep 1
[ "$(query "portal.${ZONE}" A)" = "10.10.10.10" ] || fail "the published record did not resolve"
ok "portal.${ZONE} resolves as 10.10.10.10 through PowerDNS"

echo "== the SOA serial advances, so secondaries and caches see a change =="
SERIAL=$(rows "SELECT split_part(content,' ',3) FROM records WHERE type='SOA'")
[ "$SERIAL" -gt 1 ] || fail "the SOA serial did not advance (still $SERIAL)"
ok "serial 1 -> $SERIAL"

echo "== an update changes the answer, not the record's identity =="
BEFORE=$(rows "SELECT record_id FROM parallax_powerdns_ownership")
parallax record set --zone "$ZONE" --view internal --id portal \
  --record "{\"name\":\"portal\",\"type\":\"A\",\"content\":\"10.20.30.40\",\"ttl\":60}" >/dev/null
parallax apply --zone "$ZONE" --view internal >/dev/null
sleep 1
[ "$(query "portal.${ZONE}" A)" = "10.20.30.40" ] || fail "the updated record did not resolve"
[ "$(rows "SELECT record_id FROM parallax_powerdns_ownership")" = "$BEFORE" ] \
  || fail "the update replaced the row instead of changing it"
ok "answer changed in place, ownership row unchanged"

echo "== a name an operator owns is a conflict, never an overwrite =="
parallax record set --zone "$ZONE" --view internal --id clash \
  --record "{\"name\":\"hand-made\",\"type\":\"A\",\"content\":\"10.1.1.1\",\"ttl\":300}" >/dev/null
CONFLICTS=$(parallax preview --zone "$ZONE" --view internal --json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).views.internal.summary.conflict))')
[ "$CONFLICTS" = "1" ] || fail "expected 1 conflict against the hand-made record, found $CONFLICTS"
parallax apply --zone "$ZONE" --view internal | grep -q "state=failed" || fail "apply did not refuse the conflict"
[ "$(query "hand-made.${ZONE}" A)" = "10.99.99.99" ] || fail "the hand-made record was changed"
ok "conflict reported, hand-made record untouched"

echo "== withdrawing removes the answer and leaves everything else =="
parallax record delete --zone "$ZONE" --view internal --id clash >/dev/null
parallax record delete --zone "$ZONE" --view internal --id portal >/dev/null
parallax apply --zone "$ZONE" --view internal | grep -q "state=applied" || fail "the withdrawal did not apply"
sleep 1
[ -z "$(query "portal.${ZONE}" A)" ] || fail "the withdrawn record still resolves"
[ "$(query "hand-made.${ZONE}" A)" = "10.99.99.99" ] || fail "withdrawal touched the hand-made record"
# The foreign key cascades, so a row and its marker cannot outlive each other.
[ "$(rows "SELECT count(*) FROM parallax_powerdns_ownership")" = "0" ] || fail "an ownership row outlived its record"
[ "$(rows "SELECT count(*) FROM records WHERE type IN ('SOA','NS')")" = "2" ] || fail "authority data was disturbed"
ok "answer gone, hand-made record and authority data intact, no orphan markers"

echo "== deleting a record inside PowerDNS takes its marker with it =="
parallax record set --zone "$ZONE" --view internal --id orphan \
  --record "{\"name\":\"orphan\",\"type\":\"A\",\"content\":\"10.5.5.5\",\"ttl\":300}" >/dev/null
parallax apply --zone "$ZONE" --view internal >/dev/null
rows "DELETE FROM records WHERE name='orphan.${ZONE}'" >/dev/null
[ "$(rows "SELECT count(*) FROM parallax_powerdns_ownership")" = "0" ] \
  || fail "the marker survived the record it belonged to"
ok "cascade removed the marker, so ownership can never claim a row that is gone"


echo "== every record type Parallax supports answers from PowerDNS =="
# The presentation format Parallax keeps in `content` is what PowerDNS stores,
# so this is where "supported" is decided: not that the row was written, but
# that the server answers with it. PowerDNS also has a `prio` column, which the
# writer leaves alone -- if 4.x needed it, MX and SRV would fail here.
set_and_apply() {
  parallax record set --zone "$ZONE" --view internal --id "$1" \
    --record "{\"name\":\"$2\",\"type\":\"$3\",\"content\":\"$4\",\"ttl\":300}" >/dev/null
}
set_and_apply mxrec  mail  MX    "10 mailhost.${ZONE}"
set_and_apply srvrec _sip  SRV   "10 5 5060 sip.${ZONE}"
set_and_apply caarec caa   CAA   '0 issue \"letsencrypt.org\"'
set_and_apply nsrec  sub   NS    "ns1.${ZONE}"
set_and_apply ptrrec ptr   PTR   "host.${ZONE}"
parallax apply --zone "$ZONE" --view internal | grep -q "state=applied" \
  || fail "publishing the additional record types did not apply"
sleep 1
[ "$(query "mail.${ZONE}" MX)"  = "10 mailhost.${ZONE}." ]        || fail "MX answered '$(query "mail.${ZONE}" MX)'"
[ "$(query "_sip.${ZONE}" SRV)" = "10 5 5060 sip.${ZONE}." ]      || fail "SRV answered '$(query "_sip.${ZONE}" SRV)'"
[ "$(query "caa.${ZONE}" CAA)"  = '0 issue "letsencrypt.org"' ]   || fail "CAA answered '$(query "caa.${ZONE}" CAA)'"
# An NS below the apex is a delegation, so the server answers it as a referral in
# the authority section rather than as data. Reading only `dig +short` would
# report the record as missing when it is published and behaving correctly.
dig +tcp +time=3 +noall +authority -p "$DNSPORT" @127.0.0.1 "sub.${ZONE}" NS 2>/dev/null \
  | grep -q "sub.${ZONE}.*NS.*ns1.${ZONE}." || fail "NS was not served as a delegation"
# And PowerDNS is told it is a delegation, which is what it signs a zone by.
[ "$(rows "SELECT auth FROM records WHERE name='sub.${ZONE}' AND type='NS'")" = "f" ] \
  || fail "a delegation NS was stored as authoritative data"
[ "$(query "ptr.${ZONE}" PTR)"  = "host.${ZONE}." ]               || fail "PTR answered '$(query "ptr.${ZONE}" PTR)'"
# And what was published still matches what is wanted, so nothing drifts.
DRIFT=$(parallax preview --zone "$ZONE" --view internal --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).views.internal.operations.length))')
[ "$DRIFT" = "0" ] || fail "the new types propose $DRIFT operations against what was just written"
ok "MX, SRV, CAA, NS and PTR answer over the wire and propose no drift"

echo "== a name whose marker exceeds a Cloudflare comment still publishes here =="
# Internal ids are derived from the name, so a name with several labels produces
# an id long enough that its ownership marker passes 100 characters -- the limit
# Cloudflare puts on a record comment. PowerDNS keeps markers in a `text` column
# and has no such limit, and these are exactly the names an internal view exists
# for, so the limit must not reach this path.
LONG_NAME="gw-01.dev-icn-vtr.internal"
parallax record set --zone "$ZONE" --view external --id long-marker \
  --record "{\"name\":\"${LONG_NAME}\",\"type\":\"A\",\"content\":\"93.184.216.34\",\"ttl\":300}" >/dev/null
parallax apply --zone "$ZONE" --view internal | grep -q "state=applied" \
  || fail "a long derived id stopped the internal view from applying"
sleep 1
[ "$(query "${LONG_NAME}.${ZONE}" A)" = "93.184.216.34" ] || fail "the long name did not resolve"
LONGEST=$(rows "SELECT max(length(marker)) FROM parallax_powerdns_ownership")
[ "$LONGEST" -gt 100 ] || fail "expected a marker over 100 characters, longest is $LONGEST -- the check proves nothing"
ok "a ${LONGEST}-character marker published, which Cloudflare would refuse"

echo
echo "PowerDNS integration verification passed."
