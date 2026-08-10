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
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPPORT="${APPPORT:-39170}"
WORK="$(mktemp -d)"
API="http://127.0.0.1:${APPPORT}/api/v1"
LABEL="parallax-verify-$$"

fail() { echo "  FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*"; }
cleanup() {
  if [ -n "${APP_PID:-}" ]; then kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

for name in CF_ZONE CF_ZONE_ID CF_API_TOKEN; do
  [ -n "${!name:-}" ] || { echo "skipped: set $name to run the Cloudflare verification"; exit 0; }
done
[ "${CF_VERIFY_ALLOW_WRITES:-}" = "true" ] \
  || { echo "skipped: set CF_VERIFY_ALLOW_WRITES=true to allow writes to ${CF_ZONE}"; exit 0; }

echo "== starting Parallax with the supplied Cloudflare credential =="
HOST=127.0.0.1 PORT="$APPPORT" \
PARALLAX_STATE_FILE="$WORK/state.json" \
PARALLAX_OWNERSHIP_SECRET="${CF_OWNERSHIP_SECRET:-verify-ownership-secret-that-is-at-least-32-bytes}" \
PARALLAX_CLOUDFLARE_ZONES="{\"${CF_ZONE}\":{\"zoneId\":\"${CF_ZONE_ID}\",\"token\":\"${CF_API_TOKEN}\"}}" \
  node "$ROOT/src/index.ts" > "$WORK/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null || { cat "$WORK/app.log" >&2; fail "app did not start"; }
ok "control plane running against ${CF_ZONE}"

json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d);console.log(eval(process.argv[1]))})' "$1"; }

echo "== listing the live zone exercises pagination and type filtering =="
PLAN=$(curl -sf "$API/zones" >/dev/null; curl -sf -X POST -H 'content-type: application/json' \
  -d "{\"name\":\"${CF_ZONE}\"}" "$API/zones" >/dev/null 2>&1 || true; \
  curl -sf "$API/zones/${CF_ZONE}/preview?view=external" | json 'v.views.external.summary.create + "/" + v.views.external.summary.conflict')
[ -n "$PLAN" ] || fail "preview against the live zone returned nothing"
ok "preview read the live zone (create/conflict = $PLAN)"

echo "== unmanaged records are never scheduled for deletion =="
DELETES=$(curl -sf "$API/zones/${CF_ZONE}/preview?view=external" | json 'v.views.external.summary.delete')
[ "$DELETES" = "0" ] || fail "an empty desired state proposed $DELETES deletions against a live zone"
ok "no deletions proposed for records Parallax does not own"

echo "== create, proxied TTL normalization, update and withdraw =="
curl -sf -X PUT -H 'content-type: application/json' \
  -d "{\"name\":\"${LABEL}\",\"type\":\"A\",\"content\":\"192.0.2.10\",\"ttl\":300,\"acknowledgeNonGlobalIp\":true}" \
  "$API/zones/${CF_ZONE}/views/external/records/verify" >/dev/null
curl -sf -X POST "$API/zones/${CF_ZONE}/apply?view=external" | json 'v.statuses[0].state' | grep -qx applied \
  || { cat "$WORK/app.log" >&2; fail "apply did not report applied"; }
ok "record ${LABEL}.${CF_ZONE} created through the Cloudflare API"

DRIFT=$(curl -sf "$API/zones/${CF_ZONE}/preview?view=external" | json 'v.views.external.operations.length')
[ "$DRIFT" = "0" ] || fail "expected convergence after apply, found $DRIFT operations"
ok "second preview shows no drift: the adapter round-trips its own writes"

curl -sf -X PUT -H 'content-type: application/json' \
  -d "{\"name\":\"${LABEL}\",\"type\":\"A\",\"content\":\"192.0.2.11\",\"ttl\":120,\"proxied\":true,\"acknowledgeNonGlobalIp\":true}" \
  "$API/zones/${CF_ZONE}/views/external/records/verify" >/dev/null
STORED_TTL=$(curl -sf "$API/zones/${CF_ZONE}" | json 'v.views.find(x=>x.name==="external").records.find(r=>r.id==="verify").ttl')
[ "$STORED_TTL" = "1" ] || fail "expected a proxied record to normalize to Auto TTL (1), found $STORED_TTL"
curl -sf -X POST "$API/zones/${CF_ZONE}/apply?view=external" | json 'v.statuses[0].state' | grep -qx applied \
  || fail "proxied update did not apply"
ok "proxied record normalized to Auto TTL and updated"

curl -sf -X DELETE "$API/zones/${CF_ZONE}" | json 'v.removedProviderRecords.length' | grep -qv '^0$' \
  || fail "zone deletion did not withdraw the record it published"
ok "published record withdrawn from Cloudflare"

echo
echo "Cloudflare integration verification passed."
