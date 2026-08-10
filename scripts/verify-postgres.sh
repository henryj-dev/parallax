#!/usr/bin/env bash
# Verifies Parallax against a real PostgreSQL server: fresh migration, zone
# lifecycle, restart persistence, concurrent apply under the advisory lock, and
# retention pruning. Requires Docker; the container is removed on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="parallax-verify-postgres-$$"
PGPORT="${PGPORT:-55432}"
APPPORT="${APPPORT:-39150}"
WORK="$(mktemp -d)"
DATABASE_URL="postgres://parallax:parallax@127.0.0.1:${PGPORT}/parallax?sslmode=disable"

cleanup() {
  if [ -n "${APP_PID:-}" ]; then kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "  FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*"; }

echo "== starting PostgreSQL =="
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=parallax -e POSTGRES_PASSWORD=parallax -e POSTGRES_DB=parallax \
  -p "${PGPORT}:5432" postgres:17-alpine >/dev/null
# Probe over TCP, not the unix socket: during initdb the entrypoint runs a
# temporary server that listens on the socket only, so a socket probe reports
# ready while the real server is still starting.
ready=""
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" psql -h 127.0.0.1 -U parallax -d parallax -c 'SELECT 1' >/dev/null 2>&1; then ready=yes; break; fi
  if [ -z "$(docker ps -q --filter "name=^${CONTAINER}$")" ]; then
    echo "  container exited; last log lines:" >&2
    docker logs "$CONTAINER" 2>&1 | tail -20 >&2
    fail "PostgreSQL container stopped (is port ${PGPORT} already in use?)"
  fi
  sleep 1
done
[ -n "$ready" ] || { docker logs "$CONTAINER" 2>&1 | tail -20 >&2; fail "PostgreSQL did not become ready"; }
ok "server ready on ${PGPORT}"

echo "== applying migrations/001_initial.sql to a fresh database =="
docker exec -i "$CONTAINER" psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U parallax -d parallax < "$ROOT/migrations/001_initial.sql" >/dev/null
TABLES=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -tAU parallax -d parallax -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'parallax_%'")
[ "$TABLES" = "4" ] || fail "expected 4 tables, found $TABLES"
ok "schema applied ($TABLES tables)"

echo "== re-applying the migration is idempotent =="
docker exec -i "$CONTAINER" psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U parallax -d parallax < "$ROOT/migrations/001_initial.sql" >/dev/null
ok "second run succeeded"

start_app() {
  DATABASE_URL="$DATABASE_URL" HOST=127.0.0.1 PORT="$APPPORT" \
  PARALLAX_REVISION_RETENTION="${1:-100}" PARALLAX_AUDIT_RETENTION_DAYS=365 \
    node "$ROOT/src/index.ts" > "$WORK/app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  cat "$WORK/app.log" >&2
  fail "app did not start"
}
stop_app() { kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; APP_PID=""; }

API="http://127.0.0.1:${APPPORT}/api/v1"

echo "== zone lifecycle against real PostgreSQL =="
start_app 100
curl -sf -X POST -H 'content-type: application/json' -d '{"name":"example.com"}' "$API/zones" >/dev/null
curl -sf -X PUT -H 'content-type: application/json' \
  -d '{"name":"www","type":"A","content":"93.184.216.34","ttl":300}' \
  "$API/zones/example.com/views/external/records/www" >/dev/null
curl -sf -X PUT -H 'content-type: application/json' \
  -d '{"name":"_dmarc","type":"TXT","content":"v=DMARC1; p=none","ttl":300}' \
  "$API/zones/example.com/views/external/records/dmarc" >/dev/null
curl -sf -X POST "$API/zones/example.com/apply" >/dev/null
ok "zone created, records saved, apply reported"

echo "== transactional commit landed in SQL =="
ROWS=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -tAU parallax -d parallax -c \
  "SELECT (SELECT count(*) FROM parallax_zones) || '/' || (SELECT count(*) FROM parallax_zone_revisions) || '/' || (SELECT count(*) FROM parallax_audit)")
[ "$ROWS" = "1/3/3" ] || fail "expected 1/3/3 zone/revision/audit rows, found $ROWS"
ok "zone/revision/audit rows = $ROWS"

echo "== restart persistence =="
stop_app
start_app 100
REV=$(curl -sf "$API/zones/example.com" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).revision))')
[ "$REV" = "3" ] || fail "expected revision 3 after restart, found $REV"
DRIFT=$(curl -sf "$API/zones/example.com/preview" | node -e 'let d="";process.stdin.on("data",c=>c&&(d+=c)).on("end",()=>{const v=JSON.parse(d).views;console.log(Object.values(v).reduce((n,p)=>n+p.operations.length,0))})')
[ "$DRIFT" = "0" ] || fail "expected no drift after restart, found $DRIFT operations"
ok "state restored, desired and actual still converged"

echo "== concurrent applies serialize on the advisory lock =="
pids=()
for _ in 1 2 3 4 5 6; do curl -sf -X POST "$API/zones/example.com/apply" >/dev/null & pids+=($!); done
# Wait only on the requests: a bare `wait` would also block on the server process.
for pid in "${pids[@]}"; do wait "$pid" || fail "a concurrent apply request failed"; done
STATE=$(curl -sf "$API/zones/example.com/status" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).statuses.map(s=>s.state).join(",")))')
[ "$STATE" = "applied,applied" ] || fail "expected both views applied, found $STATE"
ok "six concurrent applies converged without deadlock ($STATE)"

echo "== retention prunes revisions in real SQL =="
stop_app
start_app 3
for i in 1 2 3 4 5; do
  curl -sf -X PUT -H 'content-type: application/json' \
    -d "{\"name\":\"host$i\",\"type\":\"A\",\"content\":\"93.184.216.3$i\",\"ttl\":300}" \
    "$API/zones/example.com/views/external/records/host$i" >/dev/null
done
KEPT=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -tAU parallax -d parallax -c \
  "SELECT count(*) FROM parallax_zone_revisions WHERE zone_name='example.com'")
[ "$KEPT" = "3" ] || fail "expected 3 retained revisions, found $KEPT"
ok "revision table bounded at $KEPT rows"

echo "== zone deletion cascades and withdraws provider records =="
curl -sf -X DELETE "$API/zones/example.com" >/dev/null
LEFT=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -tAU parallax -d parallax -c \
  "SELECT (SELECT count(*) FROM parallax_zones) || '/' || (SELECT count(*) FROM parallax_zone_revisions) || '/' || (SELECT count(*) FROM parallax_apply_statuses)")
[ "$LEFT" = "0/0/0" ] || fail "expected cascade to empty child tables, found $LEFT"
AUDIT=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -tAU parallax -d parallax -c \
  "SELECT count(*) FROM parallax_audit WHERE action='zone.deleted'")
[ "$AUDIT" = "1" ] || fail "expected the deletion to stay audited, found $AUDIT"
ok "children cascaded to $LEFT, deletion audit retained"

stop_app
echo
echo "PostgreSQL integration verification passed."
