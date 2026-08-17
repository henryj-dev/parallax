#!/usr/bin/env bash
# Verifies the Cloudflare adapter against a real account. This is the one
# integration that cannot be faked locally, so it is opt-in and needs an
# operator to supply a scoped token for a zone they are willing to write to.
#
#   CF_ZONE=example.com CF_ZONE_ID=... CF_API_TOKEN=... \
#   CF_VERIFY_ALLOW_WRITES=true bash scripts/verify-cloudflare.sh
#
# It creates and removes records under a dedicated `parallax-verify-*` name and
# never touches anything else. Records without Parallax's ownership marker are
# left alone by construction; the run asserts that.
#
# The token needs `Zone -> DNS -> Edit` for the records and `Zone -> Zone -> Read`,
# which Parallax uses once to resolve the domain to its zone id.
#
# Adoption also asks two account-scoped endpoints which names Workers and R2
# publish for themselves. Those are checked only when `CF_ACCOUNT_ID` is set, and
# the token then also needs `Account -> Workers Scripts -> Read` and
# `Account -> Workers R2 Storage -> Read`. Read-only, and skipped loudly without
# it, because the zone reconciles perfectly well while those go unread.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPPORT="${APPPORT:-39170}"
WORK="$(mktemp -d)"
API="http://127.0.0.1:${APPPORT}/api/v1"
LABEL="parallax-verify-$$"

fail() { echo "  FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*"; }

# Withdrawing the verify record cannot depend on the run reaching its last step.
# A failure anywhere after the first apply would otherwise leave a live record
# in the zone with the temporary state file already gone, so nothing local would
# remember that Parallax had published it. This talks to Cloudflare directly for
# that reason: by the time it runs the control plane may be dead.
withdraw_verify_record() {
  # Armed only once a write is about to be attempted. A run that skips, or that
  # dies before publishing anything, must not reach the provider at all.
  [ "${PUBLISHED:-}" = "1" ] || return 0
  local api="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/zones/${CF_ZONE_ID}/dns_records"
  local fqdn="${LABEL}.${CF_ZONE}" ids id
  # Two guards, because a cleanup path that deletes the wrong record is worse
  # than one that leaves litter: the API filters by exact name, and the response
  # is filtered again against the same name and this run's dedicated prefix.
  ids=$(curl -sf -H "Authorization: Bearer ${CF_API_TOKEN}" "${api}?name=${fqdn}" 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{
        console.log((JSON.parse(d).result||[])
          .filter(r=>r.name===process.argv[1]&&r.name.startsWith("parallax-verify-"))
          .map(r=>r.id).join(" "));
      }catch{}})' "$fqdn" 2>/dev/null) || return 0
  for id in $ids; do
    curl -sf -X DELETE -H "Authorization: Bearer ${CF_API_TOKEN}" "${api}/${id}" >/dev/null 2>&1 \
      && echo "  cleanup: withdrew leftover ${fqdn}" >&2
  done
  return 0
}

cleanup() {
  if [ -n "${APP_PID:-}" ]; then kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; fi
  withdraw_verify_record || true
  rm -rf "$WORK"
}
trap cleanup EXIT

for name in CF_ZONE CF_ZONE_ID CF_API_TOKEN; do
  [ -n "${!name:-}" ] || { echo "skipped: set $name to run the Cloudflare verification"; exit 0; }
done
[ "${CF_VERIFY_ALLOW_WRITES:-}" = "true" ] \
  || { echo "skipped: set CF_VERIFY_ALLOW_WRITES=true to allow writes to ${CF_ZONE}"; exit 0; }

echo "== starting Parallax =="
# Credentials reach the provider through the credential store, which is the only
# path there is -- an earlier version of this script set PARALLAX_CLOUDFLARE_ZONES,
# a name nothing in src/ reads, so the adapter was never configured and the run
# died at the first apply. Storing them needs a master key.
HOST=127.0.0.1 PORT="$APPPORT" \
PARALLAX_STATE_FILE="$WORK/state.json" \
PARALLAX_CONFIG_FILE="$WORK/configuration.json" \
PARALLAX_CREDENTIAL_MASTER_KEY="$(openssl rand -base64 32)" \
PARALLAX_OWNERSHIP_SECRET="${CF_OWNERSHIP_SECRET:-verify-ownership-secret-that-is-at-least-32-bytes}" \
  node "$ROOT/src/index.ts" > "$WORK/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null || { cat "$WORK/app.log" >&2; fail "app did not start"; }
ok "control plane running"

json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d);console.log(eval(process.argv[1]))})' "$1"; }

echo "== binding the supplied credential to ${CF_ZONE} =="
# No zone id in the body: Parallax resolves it from the domain. CF_ZONE_ID is
# still needed below, where this script talks to Cloudflare directly.
curl -sf -X PUT -H 'content-type: application/json' \
  -d "{\"token\":\"${CF_API_TOKEN}\"}" \
  "$API/credentials/cloudflare/${CF_ZONE}" >/dev/null \
  || { cat "$WORK/app.log" >&2; fail "the credential was not accepted -- if the token cannot list zones, grant it Zone -> Zone -> Read"; }
ok "credential stored and routed to ${CF_ZONE}/external"

curl -sf -X POST -H 'content-type: application/json' -d "{\"name\":\"${CF_ZONE}\"}" "$API/zones" >/dev/null 2>&1 || true

echo "== create, proxied TTL normalization, update and withdraw =="
# The record comes before the first preview on purpose. A view exists only once
# a record is set into it, so `preview?view=external` on a zone that has none is
# a 404 -- which an earlier version of this script walked straight into.
#
# The cleanup is armed before the write, not after: a failure inside the apply is
# exactly the case where a record exists at the provider and nothing local says so.
PUBLISHED=1
curl -sf -X PUT -H 'content-type: application/json' \
  -d "{\"name\":\"${LABEL}\",\"type\":\"A\",\"content\":\"192.0.2.10\",\"ttl\":300,\"acknowledgeNonGlobalIp\":true}" \
  "$API/zones/${CF_ZONE}/views/external/records/verify" >/dev/null \
  || fail "the record could not be staged"

echo "== the live zone is read, and nothing unowned is scheduled for deletion =="
PLAN=$(curl -sf "$API/zones/${CF_ZONE}/preview?view=external" | json 'v.views.external.summary.create + "/" + v.views.external.summary.conflict')
[ -n "$PLAN" ] || { cat "$WORK/app.log" >&2; fail "preview against the live zone returned nothing"; }
ok "preview read the live zone (create/conflict = $PLAN)"

DELETES=$(curl -sf "$API/zones/${CF_ZONE}/preview?view=external" | json 'v.views.external.summary.delete')
[ "$DELETES" = "0" ] || fail "a desired state holding one record proposed $DELETES deletions against a live zone"
# That assertion is vacuous against an empty zone -- with nothing there, nothing
# can be proposed for deletion. Nothing has been applied yet, so every record the
# zone holds right now is one Parallax does not own. Counting them is what tells
# a reader whether the check above meant anything.
FOREIGN=$(curl -sf -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "${CF_API_BASE:-https://api.cloudflare.com/client/v4}/zones/${CF_ZONE_ID}/dns_records?per_page=1" \
  | json 'v.result_info.total_count' 2>/dev/null || echo 0)
if [ "${FOREIGN:-0}" = "0" ]; then
  echo "  note: the zone holds no records of its own, so that assertion proved nothing" >&2
  ok "no deletions proposed (vacuously -- the zone is empty)"
else
  ok "no deletions proposed against ${FOREIGN} records Parallax does not own"
fi

curl -sf -X POST "$API/zones/${CF_ZONE}/apply?view=external" | json 'v.statuses[0].state' | grep -qx applied \
  || { cat "$WORK/app.log" >&2; fail "apply did not report applied"; }
ok "record ${LABEL}.${CF_ZONE} created through the Cloudflare API"

DRIFT=$(curl -sf "$API/zones/${CF_ZONE}/preview?view=external" | json 'v.views.external.operations.length')
[ "$DRIFT" = "0" ] || fail "expected convergence after apply, found $DRIFT operations"
ok "second preview shows no drift: the adapter round-trips its own writes"

echo "== an MX record round-trips Cloudflare's separate priority field =="
# Cloudflare keeps the MX preference in its own field rather than in the content
# it returns. Nothing local can settle whether the adapter puts it back the same
# way: a stand-in provider hands back exactly what it was given, so the join and
# the split cancel out and the test passes either way.
curl -sf -X PUT -H 'content-type: application/json' \
  -d "{\"name\":\"${LABEL}\",\"type\":\"MX\",\"content\":\"10 mail.${CF_ZONE}\",\"ttl\":300}" \
  "$API/zones/${CF_ZONE}/views/external/records/verifymx" >/dev/null
curl -sf -X POST "$API/zones/${CF_ZONE}/apply?view=external" | json 'v.statuses[0].state' | grep -qx applied \
  || fail "the MX record did not apply"
MX_DRIFT=$(curl -sf "$API/zones/${CF_ZONE}/preview?view=external" | json 'v.views.external.operations.length')
[ "$MX_DRIFT" = "0" ] || fail "an MX record Parallax wrote proposes $MX_DRIFT operations against itself"
ok "MX round-trips: the preference comes back where it was written"

echo "== SRV and URI round-trip the same field, which MX could not prove =="
# The same separate-priority field, and the reason MX alone was not enough: an
# MX content is a hostname, so a leading number can only be the priority. An SRV
# content starts with its weight and a URI content with its own, so the rule
# "there is already a number in front" reads a different number and drops the
# priority. Adopting an SRV from a live zone failed on exactly that.
for spec in "verifysrv:SRV:1 0 443 mail.${CF_ZONE}:_autodiscover._tcp" \
            "verifyuri:URI:5 10 \"https://${CF_ZONE}/\":_uri"; do
  IFS=':' read -r id type value label <<< "$spec"
  curl -sf -X PUT -H 'content-type: application/json' \
    -d "{\"name\":\"${label}.${LABEL}\",\"type\":\"${type}\",\"content\":\"${value}\",\"ttl\":300}" \
    "$API/zones/${CF_ZONE}/views/external/records/${id}" >/dev/null \
    || fail "the control plane refused the ${type} record"
done
curl -sf -X POST "$API/zones/${CF_ZONE}/apply?view=external" | json 'v.statuses[0].state' | grep -qx applied \
  || fail "the SRV and URI records did not apply"
PRIORITY_DRIFT=$(curl -sf "$API/zones/${CF_ZONE}/preview?view=external" | json 'v.views.external.operations.length')
[ "$PRIORITY_DRIFT" = "0" ] \
  || fail "SRV/URI records Parallax wrote propose $PRIORITY_DRIFT operations against themselves"
ok "SRV and URI come back with their priority where it was written"

echo "== a TXT record survives Cloudflare's quoting =="
# Cloudflare returns TXT in presentation form -- each character-string in double
# quotes, split at 255 characters whether or not it was written that way. The
# desired state holds the value itself, so an adapter that passed the quotes
# through would differ from what it just wrote and propose the same update
# forever. Nothing local can catch that: a stand-in provider hands back exactly
# what it was given.
TXT_VALUE="parallax-verify=1 and a space"
curl -sf -X PUT -H 'content-type: application/json' \
  -d "{\"name\":\"${LABEL}\",\"type\":\"TXT\",\"content\":\"${TXT_VALUE}\",\"ttl\":300}" \
  "$API/zones/${CF_ZONE}/views/external/records/verifytxt" >/dev/null
curl -sf -X POST "$API/zones/${CF_ZONE}/apply?view=external" | json 'v.statuses[0].state' | grep -qx applied \
  || fail "the TXT record did not apply"
TXT_DRIFT=$(curl -sf "$API/zones/${CF_ZONE}/preview?view=external" | json 'v.views.external.operations.length')
[ "$TXT_DRIFT" = "0" ] || fail "a TXT record Parallax wrote proposes $TXT_DRIFT operations against itself"
# And the value read back is the value, not the value wrapped in quotes.
READ_BACK=$(curl -sf -H "Authorization: Bearer ${CF_API_TOKEN}" \
  "${CF_API_BASE:-https://api.cloudflare.com/client/v4}/zones/${CF_ZONE_ID}/dns_records?type=TXT&name=${LABEL}.${CF_ZONE}" \
  | json 'v.result[0].content')
echo "  note: Cloudflare returns this TXT content as ${READ_BACK}" >&2
ok "TXT round-trips: no drift proposed against a record Parallax wrote"

curl -sf -X PUT -H 'content-type: application/json' \
  -d "{\"name\":\"${LABEL}\",\"type\":\"A\",\"content\":\"192.0.2.11\",\"ttl\":120,\"proxied\":true,\"acknowledgeNonGlobalIp\":true}" \
  "$API/zones/${CF_ZONE}/views/external/records/verify" >/dev/null
STORED_TTL=$(curl -sf "$API/zones/${CF_ZONE}" | json 'v.views.find(x=>x.name==="external").records.find(r=>r.id==="verify").ttl')
[ "$STORED_TTL" = "1" ] || fail "expected a proxied record to normalize to Auto TTL (1), found $STORED_TTL"
curl -sf -X POST "$API/zones/${CF_ZONE}/apply?view=external" | json 'v.statuses[0].state' | grep -qx applied \
  || fail "proxied update did not apply"
ok "proxied record normalized to Auto TTL and updated"

echo "== which names Workers and R2 publish for themselves =="
# The one part of the adapter no stand-in can settle. A DNS record does not say
# which service created it -- Cloudflare's record API enumerates the 21 real
# types and carries no marker -- so the labels come from the services that hold
# the bindings, over two account-scoped endpoints this script otherwise never
# touches. Read-only: it asks, compares, and writes nothing.
if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  echo "  skipped: set CF_ACCOUNT_ID to check the Workers and R2 lookups (the token also needs Account -> Workers Scripts -> Read and Account -> Workers R2 Storage -> Read)" >&2
else
  cat > "$WORK/service-ownership.mjs" <<'NODE'
import { pathToFileURL } from "node:url";

// The script lives in a temporary directory, so the adapter is reached by the
// path this run was given rather than by one relative to this file.
const { CloudflareProviderAdapter } = await import(pathToFileURL(process.env.ADAPTER).href);

const target = `${process.env.CF_ZONE}/external`;
const adapter = new CloudflareProviderAdapter({
  token: process.env.CF_API_TOKEN,
  zoneId: process.env.CF_ZONE_ID,
  accountId: process.env.CF_ACCOUNT_ID,
  ownershipSecret: "verify-ownership-secret-that-is-at-least-32-bytes",
  ...(process.env.CF_API_BASE ? { apiBaseUrl: process.env.CF_API_BASE } : {}),
});

const owned = await adapter.serviceOwnership(target);
if (!Array.isArray(owned)) throw new Error(`serviceOwnership answered ${typeof owned}, not a list`);
for (const entry of owned) {
  if (!["worker", "r2"].includes(entry.service)) throw new Error(`unknown service ${entry.service}`);
  if (!entry.resource) throw new Error(`${entry.service} claimed ${entry.name} with no resource name`);
}

// Every name a service claims must be a name this zone actually holds a proxied
// address record for. This is what checks the relative-name mapping against real
// hostnames: an apex must come back as `@`, and a bucket's domains in somebody
// else's zone must not come back at all. A claim with no record behind it means
// the mapping is wrong, and the label would attach to nothing -- or worse, to
// the wrong row.
const records = await adapter.list(target);
const proxiable = new Set(records
  .filter((record) => ["A", "AAAA", "CNAME"].includes(record.type))
  .map((record) => record.name));
const orphans = owned.filter((entry) => !proxiable.has(entry.name));
if (orphans.length > 0) {
  throw new Error(`claimed names with no address record in this zone: ${orphans.map((entry) => entry.name).join(", ")}`);
}
console.log(JSON.stringify({ owned, records: records.length }));
NODE
  # stderr kept out of the answer: it is JSON, and a warning printed into it
  # would fail the parse rather than the check it belongs to.
  if ! OWNERSHIP=$(ADAPTER="$ROOT/src/adapters/cloudflare.ts" \
    CF_ZONE="$CF_ZONE" CF_ZONE_ID="$CF_ZONE_ID" CF_API_TOKEN="$CF_API_TOKEN" \
    CF_ACCOUNT_ID="$CF_ACCOUNT_ID" CF_API_BASE="${CF_API_BASE:-}" \
    node "$WORK/service-ownership.mjs" 2>"$WORK/ownership.err"); then
    fail "the Workers and R2 lookups failed -- if the token was refused it needs Account -> Workers Scripts -> Read and Account -> Workers R2 Storage -> Read: $(tr '\n' ' ' < "$WORK/ownership.err")"
  fi
  COUNT=$(printf '%s' "$OWNERSHIP" | json 'v.owned.length')
  if [ "${COUNT:-0}" = "0" ]; then
    # Said out loud, like the empty-zone case above: a lookup that legitimately
    # finds nothing passes every assertion here, and reading that as "the labels
    # work" is the mistake this note exists to prevent.
    echo "  note: no Workers custom domain and no R2 custom domain in ${CF_ZONE}, so the field names went unchecked" >&2
    ok "the lookups answered (vacuously -- this zone has neither)"
  else
    echo "  found: $(printf '%s' "$OWNERSHIP" | json 'v.owned.map(o=>o.service+" "+o.resource+" at "+o.name).join(", ")')" >&2
    ok "${COUNT} name(s) matched to the worker or bucket that publishes them"
  fi
fi

curl -sf -X DELETE "$API/zones/${CF_ZONE}" | json 'v.removedProviderRecords.length' | grep -qv '^0$' \
  || fail "zone deletion did not withdraw the record it published"
ok "published record withdrawn from Cloudflare"

echo
echo "Cloudflare integration verification passed."
