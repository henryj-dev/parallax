#!/usr/bin/env bash
# Verifies Parallax against a real CoreDNS server: generated zones load, answers
# resolve over DNS, SOA serials advance and are picked up by the file plugin's
# reload, hand-maintained records are preserved, and zone files are readable by
# the CoreDNS process. Requires Docker and dig; containers are removed on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="parallax-verify-coredns-$$"
DNSPORT="${DNSPORT:-15353}"
APPPORT="${APPPORT:-39160}"
WORK="$(mktemp -d)"
ZONES="$WORK/zones"
API="http://127.0.0.1:${APPPORT}/api/v1"

cleanup() {
  if [ -n "${APP_PID:-}" ]; then kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "  FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*"; }
# `dig +short` prints its own diagnostics (";; connection timed out") on stdout,
# so they are filtered out; an unreachable server must look like no answer.
# Queries go over TCP: Docker Desktop's UDP port forwarding is unreliable, and
# the zone data under test is identical on either transport.
query() { dig +short +tcp +time=3 +tries=2 -p "$DNSPORT" @127.0.0.1 "$@" 2>/dev/null | grep -v '^;' || true; }
serial() { query example.com SOA | awk '{print $3}'; }

mkdir -p "$ZONES"
# A zone the operator maintained by hand before Parallax existed: the records
# inherit $TTL and the second one inherits the owner name.
cat > "$ZONES/example.com.zone" <<'EOF'
$ORIGIN example.com.
$TTL 3600
@   3600 IN SOA ns1.example.com. hostmaster.example.com. 7 3600 600 604800 300
@   3600 IN NS  ns1.example.com.
ns1 3600 IN A   127.0.0.1
legacy       IN A   10.9.9.9
             IN A   10.9.9.12
EOF

cat > "$WORK/Corefile" <<EOF
example.com:53 {
    file /zones/example.com.zone {
        reload 1s
    }
    errors
}
EOF

echo "== starting CoreDNS on the generated zone directory =="
docker run -d --name "$CONTAINER" \
  -v "$WORK/Corefile:/etc/coredns/Corefile:ro" -v "$ZONES:/zones" \
  -p "${DNSPORT}:53/udp" -p "${DNSPORT}:53/tcp" \
  coredns/coredns:1.12.0 -conf /etc/coredns/Corefile >/dev/null
for _ in $(seq 1 60); do
  [ "$(query ns1.example.com A)" = "127.0.0.1" ] && break
  sleep 0.5
done
[ "$(query ns1.example.com A)" = "127.0.0.1" ] \
  || { docker logs "$CONTAINER" 2>&1 | tail -20 >&2; fail "CoreDNS did not serve the zone"; }
ok "CoreDNS serving example.com (serial $(serial))"

echo "== hand-maintained records resolve before Parallax touches the zone =="
[ "$(query legacy.example.com A | sort | tr '\n' ' ')" = "10.9.9.12 10.9.9.9 " ] \
  || fail "expected the inherited-TTL RRset to resolve, got: $(query legacy.example.com A | tr '\n' ' ')"
ok "legacy RRset resolves from the hand-written file"

echo "== starting Parallax against the same directory =="
# Provider wiring is a stored setting, not an environment variable. It used to be
# PARALLAX_COREDNS_DIRECTORY and PARALLAX_ALLOW_LOCAL_PROVIDER; both stopped being
# read when configuration moved into the store, and this script kept setting them
# for months -- so it was configuring nothing and failing at the first preview.
HOST=127.0.0.1 PORT="$APPPORT" \
PARALLAX_STATE_FILE="$WORK/state.json" \
PARALLAX_CONFIG_FILE="$WORK/configuration.json" \
PARALLAX_OWNERSHIP_SECRET="verify-ownership-secret-that-is-at-least-32-bytes" \
  node "$ROOT/src/index.ts" > "$WORK/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null || { cat "$WORK/app.log" >&2; fail "app did not start"; }

curl -sf -X PUT -H 'content-type: application/json' \
  -d "{\"coreDnsDirectory\":\"${ZONES}\",\"allowLocalProvider\":true}" \
  "http://127.0.0.1:${APPPORT}/api/v1/settings" >/dev/null \
  || { cat "$WORK/app.log" >&2; fail "the provider settings were not accepted"; }
# Proves the wiring took, rather than assuming it did -- the failure this
# replaces was silent precisely because nothing checked.
CONFIGURED=$(curl -sf "http://127.0.0.1:${APPPORT}/api/v1/settings" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).settings.coreDnsDirectory))')
[ "$CONFIGURED" = "$ZONES" ] || fail "coreDnsDirectory reads back as '$CONFIGURED', not '$ZONES'"
ok "control plane running"

echo "== a desired record that collides with a hand-written answer is a conflict =="
curl -sf -X POST -H 'content-type: application/json' -d '{"name":"example.com"}' "$API/zones" >/dev/null
curl -sf -X PUT -H 'content-type: application/json' \
  -d '{"name":"legacy","type":"A","content":"10.1.1.1","ttl":300}' \
  "$API/zones/example.com/views/internal/records/legacy" >/dev/null
CONFLICTS=$(curl -sf "$API/zones/example.com/preview?view=internal" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).views.internal.summary.conflict))')
[ "$CONFLICTS" = "1" ] || fail "expected 1 conflict against the hand-written record, found $CONFLICTS"
ok "reconciliation reports the collision instead of duplicating the RRset"

echo "== a fresh name applies and resolves over DNS =="
curl -sf -X DELETE "$API/zones/example.com/views/internal/records/legacy" >/dev/null
curl -sf -X PUT -H 'content-type: application/json' \
  -d '{"name":"portal","type":"A","content":"10.0.0.7","ttl":120}' \
  "$API/zones/example.com/views/internal/records/portal" >/dev/null
curl -sf -X PUT -H 'content-type: application/json' \
  -d '{"name":"_dmarc","type":"TXT","content":"v=DMARC1; p=none","ttl":300}' \
  "$API/zones/example.com/views/internal/records/dmarc" >/dev/null
BEFORE=$(serial)
curl -sf -X POST "$API/zones/example.com/apply?view=internal" >/dev/null
for _ in $(seq 1 40); do [ -n "$(query portal.example.com A)" ] && break; sleep 0.5; done
[ "$(query portal.example.com A)" = "10.0.0.7" ] || fail "portal.example.com did not resolve, got: $(query portal.example.com A)"
[ "$(query _dmarc.example.com TXT)" = '"v=DMARC1; p=none"' ] \
  || fail "underscored TXT did not resolve, got: $(query _dmarc.example.com TXT)"
ok "applied records resolve: portal=10.0.0.7, _dmarc TXT present"

echo "== the SOA serial advanced and CoreDNS reloaded it =="
AFTER=$(serial)
[ -n "$BEFORE" ] && [ -n "$AFTER" ] || fail "could not read the SOA serial"
[ "$AFTER" -gt "$BEFORE" ] || fail "serial did not advance ($BEFORE -> $AFTER)"
ok "serial $BEFORE -> $AFTER observed through DNS"

echo "== hand-maintained records survived the rewrite =="
[ "$(query legacy.example.com A | sort | tr '\n' ' ')" = "10.9.9.12 10.9.9.9 " ] \
  || fail "hand-written RRset was altered, now: $(query legacy.example.com A | tr '\n' ' ')"
[ "$(query ns1.example.com A)" = "127.0.0.1" ] || fail "authority record was altered"
ok "foreign records and authority data untouched"

echo "== the zone file is readable by the CoreDNS process =="
MODE=$(stat -f '%Lp' "$ZONES/example.com.zone" 2>/dev/null || stat -c '%a' "$ZONES/example.com.zone")
[ "$MODE" = "644" ] || fail "expected mode 644 so another user can read it, found $MODE"
# The image is distroless, so the proof that CoreDNS can read the rewritten file
# is that it is answering from it -- which the queries above already required.
docker logs "$CONTAINER" 2>&1 | grep -qi "permission denied" && fail "CoreDNS reported a permission error"
ok "mode $MODE, and CoreDNS answers from the rewritten file"

echo "== withdrawing a record removes the answer =="
curl -sf -X DELETE "$API/zones/example.com/views/internal/records/portal" >/dev/null
curl -sf -X POST "$API/zones/example.com/apply?view=internal" >/dev/null
for _ in $(seq 1 40); do [ -z "$(query portal.example.com A)" ] && break; sleep 0.5; done
[ -z "$(query portal.example.com A)" ] || fail "portal.example.com still resolves after removal"
ok "removed record no longer resolves"

kill "$APP_PID" 2>/dev/null || true
echo
echo "CoreDNS integration verification passed."
