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

echo "== applying every migration to a fresh database =="
# Through the command line, which is how a deployment applies them: the same
# path an initContainer or an operator takes, not a psql loop that only this
# script knows about.
apply_migrations() {
  DATABASE_URL="$DATABASE_URL" node "$ROOT/cmd/parallax/main.ts" migrate --json
}
# Counted from the directory rather than written here: a number that has to be
# edited with every migration gets edited without being thought about, and this
# assertion is meant to catch a file that is not being picked up at all.
EXPECTED=$(ls "$ROOT/migrations"/*.sql | wc -l | tr -d ' ')
APPLIED=$(apply_migrations | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).applied.length))')
[ "$APPLIED" = "$EXPECTED" ] || fail "expected $EXPECTED migrations to be applied, reported $APPLIED"
TABLES=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -tAU parallax -d parallax -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'parallax_%'")
[ "$TABLES" = "8" ] || fail "expected 8 tables, found $TABLES"
ok "schema applied through \`parallax migrate\` ($TABLES tables)"

echo "== re-applying the migrations is idempotent =="
apply_migrations >/dev/null
ok "second run succeeded"

echo "== concurrent migration runs serialize on the advisory lock =="
# Two instances starting together must not race each other through the schema.
for _ in 1 2 3; do apply_migrations >/dev/null & done
FAILED=0
for pid in $(jobs -p); do wait "$pid" || FAILED=1; done
[ "$FAILED" = "0" ] || fail "a concurrent migration run failed"
TABLES=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -tAU parallax -d parallax -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'parallax_%'")
[ "$TABLES" = "8" ] || fail "concurrent runs left $TABLES tables"
ok "three simultaneous runs all succeeded, schema unchanged"

echo "== late apply status merges with a newer desired revision =="
DATABASE_URL="$DATABASE_URL" PARALLAX_VERIFY_ROOT="$ROOT" node --input-type=module - <<'NODE'
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(`${process.env.PARALLAX_VERIFY_ROOT}/src/infrastructure/postgres.ts`).href;
const { createPostgresAdapters, createPostgresPool } = await import(moduleUrl);
const pool = createPostgresPool(process.env.DATABASE_URL);
const adapters = createPostgresAdapters(pool);
const zone = "status-merge.example";
const attemptedAt = "2026-08-15T00:00:00.000Z";
const snapshot = {
  name: zone,
  revision: 1,
  views: [],
  createdAt: attemptedAt,
  updatedAt: attemptedAt,
};
const expected = {
  desiredRevision: 3,
  appliedRevision: 2,
  state: "pending",
  lastAttemptAt: attemptedAt,
};

const assertMerged = (status, view) => {
  if (!status || Object.entries(expected).some(([key, value]) => status[key] !== value)) {
    throw new Error(`${view} status did not merge monotonically: ${JSON.stringify(status)}`);
  }
};

try {
  await adapters.zones.save(snapshot);
  // New desired status lands first; the late apply still contributes its
  // provider-attempt timestamp and applied progress without downgrading it.
  await adapters.statuses.save({ zone, view: "external", desiredRevision: 3, appliedRevision: 1, state: "pending" });
  await adapters.statuses.save({ zone, view: "external", desiredRevision: 2, appliedRevision: 2,
    state: "applied", lastAttemptAt: attemptedAt });
  assertMerged(await adapters.statuses.get(zone, "external"), "external");

  // The reverse interleaving must preserve the same two monotonic facts.
  await adapters.statuses.save({ zone, view: "internal", desiredRevision: 2, appliedRevision: 2,
    state: "applied", lastAttemptAt: attemptedAt });
  await adapters.statuses.save({ zone, view: "internal", desiredRevision: 3, appliedRevision: 1, state: "pending" });
  assertMerged(await adapters.statuses.get(zone, "internal"), "internal");
} finally {
  await adapters.zones.delete(zone);
  await pool.end();
}
NODE
ok "both status interleavings preserved the newer desired state and provider attempt"

start_app() {
  # Keep provider state inside the work directory: the default is under the
  # repository, so the run would otherwise write to the developer's own data.
  DATABASE_URL="$DATABASE_URL" HOST=127.0.0.1 PORT="$APPPORT" \
    PARALLAX_PROVIDER_STATE_FILE="$WORK/provider-state.json" \
    node "$ROOT/src/index.ts" > "$WORK/app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 60); do
    # Confirm the process we just launched is the one answering: a replacement
    # that died on EADDRINUSE would otherwise be masked by its predecessor.
    kill -0 "$APP_PID" 2>/dev/null || { cat "$WORK/app.log" >&2; fail "app exited during startup"; }
    curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  cat "$WORK/app.log" >&2
  fail "app did not start"
}
stop_app() {
  kill "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  APP_PID=""
  # Wait for the port to be released: starting the replacement too early makes
  # it die with EADDRINUSE while the health check still answers from the old one.
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  fail "the previous server did not release port ${APPPORT}"
}

API="http://127.0.0.1:${APPPORT}/api/v1"

echo "== the local provider is off until a stored setting turns it on =="
start_app
UNSET=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"name":"unrouted.example"}' "$API/zones"; \
  curl -s -o /dev/null -w '%{http_code}' "$API/zones/unrouted.example/preview")
[ "${UNSET#201}" = "200" ] || fail "expected a zone with no views to preview cleanly, got $UNSET"
curl -sf -X DELETE "$API/zones/unrouted.example" >/dev/null
curl -sf -X PUT -H 'content-type: application/json' -d '{"allowLocalProvider":true}' "$API/settings" >/dev/null
ok "allowLocalProvider enabled through the settings API, no restart"

echo "== zone lifecycle against real PostgreSQL =="
curl -sf -X POST -H 'content-type: application/json' -d '{"name":"example.com"}' "$API/zones" >/dev/null
curl -sf -X PUT -H 'content-type: application/json' \
  -d '{"name":"www","type":"A","content":"93.184.216.34","ttl":300}' \
  "$API/zones/example.com/views/external/records/www" >/dev/null
curl -sf -X PUT -H 'content-type: application/json' \
  -d '{"name":"_dmarc","type":"TXT","content":"v=DMARC1; p=none","ttl":300}' \
  "$API/zones/example.com/views/external/records/dmarc" >/dev/null
curl -sf -X POST "$API/zones/example.com/apply" >/dev/null
ok "zone created, records saved, apply reported"

echo "== settings round-trip through the database =="
curl -sf -X PUT -H 'content-type: application/json' -d '{"auditRetentionDays":30}' "$API/settings" >/dev/null
STORED=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -tAU parallax -d parallax -c \
  "SELECT value FROM parallax_settings WHERE key = 'auditRetentionDays'")
[ "$STORED" = "30" ] || fail "expected the setting in SQL, found '$STORED'"
ok "auditRetentionDays stored in parallax_settings as $STORED"

echo "== transactional commit landed in SQL =="
# Scoped to this zone: the earlier probe zone leaves its own audit trail behind,
# which is intentional -- a deletion stays recorded after the zone is gone.
ROWS=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -tAU parallax -d parallax -c \
  "SELECT (SELECT count(*) FROM parallax_zones WHERE name = 'example.com')
       || '/' || (SELECT count(*) FROM parallax_zone_revisions WHERE zone_name = 'example.com')
       || '/' || (SELECT count(*) FROM parallax_audit WHERE zone_name = 'example.com')")
[ "$ROWS" = "1/3/7" ] || fail "expected 1/3/7 zone/revision/audit rows, found $ROWS"
ok "zone/revision/audit rows = $ROWS"

echo "== adopting records the provider already holds =="
# Every audit action has to be one PostgreSQL will accept. The in-memory store
# used by the unit tests takes any string, so an action missing from the CHECK
# constraint is invisible until a real database refuses the write -- which is
# how `records.adopted` reached a release. Adoption needs a record Parallax did
# not create, so one is placed in the provider's state directly.
stop_app
# Added to the state, not written over it: replacing the document would drop the
# records applied above and the restart check below would read that as drift.
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const state = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : { version: 1, nextId: 1, targets: {} };
  state.targets["adopted.example/external"] = [
    { id: "human-1", providerId: "human-1", managed: false, name: "www", type: "A", content: "198.51.100.7", ttl: 300 },
  ];
  fs.writeFileSync(path, JSON.stringify(state));
' "$WORK/provider-state.json"
start_app
curl -sf -X POST -H 'content-type: application/json' -d '{"name":"adopted.example"}' "$API/zones" >/dev/null
# Deliberately not `curl -f`: the failure this step exists to catch returns 500,
# and -f would abort with an exit code and discard the body that says why.
ADOPTED=$(curl -s -w '\n%{http_code}' -X POST "$API/zones/adopted.example/adopt?view=external")
ADOPT_STATUS=$(printf '%s' "$ADOPTED" | tail -n1)
[ "$ADOPT_STATUS" = "200" ] || fail "adopt returned $ADOPT_STATUS: $(printf '%s' "$ADOPTED" | head -n1)"
case "$ADOPTED" in
  *'"seen":1'*) : ;;
  *) fail "expected the provider's record to be seen, got $ADOPTED" ;;
esac
ACTION=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -tAU parallax -d parallax -c \
  "SELECT action FROM parallax_audit WHERE zone_name = 'adopted.example' ORDER BY id DESC LIMIT 1")
[ "$ACTION" = "records.adopted" ] || fail "expected a records.adopted audit row, found '$ACTION'"
# Writing the row is only half of it: the reader rejects actions it does not
# know, so a value the constraint permits can still break the history endpoint.
HISTORY=$(curl -s -o /dev/null -w '%{http_code}' "$API/zones/adopted.example/history")
[ "$HISTORY" = "200" ] || fail "history returned $HISTORY after adopting"
ok "adoption recorded records.adopted and history still reads"

echo "== restart persistence =="
stop_app
start_app
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
# Retention is a stored setting now, so it is changed through the API.
curl -sf -X PUT -H 'content-type: application/json' -d '{"revisionRetention":3}' "$API/settings" >/dev/null
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
# Scoped to the deleted zone: the adoption check above leaves its own zone
# behind, and a global count would turn that into a cascade failure.
LEFT=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -tAU parallax -d parallax -c \
  "SELECT (SELECT count(*) FROM parallax_zones WHERE name = 'example.com')
       || '/' || (SELECT count(*) FROM parallax_zone_revisions WHERE zone_name = 'example.com')
       || '/' || (SELECT count(*) FROM parallax_apply_statuses WHERE zone_name = 'example.com')")
[ "$LEFT" = "0/0/0" ] || fail "expected cascade to empty child tables, found $LEFT"
AUDIT=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -tAU parallax -d parallax -c \
  "SELECT count(*) FROM parallax_audit WHERE action='zone.deleted' AND zone_name='example.com'")
[ "$AUDIT" = "1" ] || fail "expected the deletion to stay audited, found $AUDIT"
ok "children cascaded to $LEFT, deletion audit retained"

stop_app
echo
echo "PostgreSQL integration verification passed."
