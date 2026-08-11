#!/usr/bin/env bash
# Verifies Parallax behind a real TLS-terminating reverse proxy, which is the
# normal production shape and the one configuration unit tests cannot stand in
# for: the server sees plain HTTP on loopback while the browser sees HTTPS, so
# everything derived from "what origin did the client actually use" is at risk.
#
# The audit found exactly that defect -- the request URL was rebuilt as `http://`,
# so the same-origin proof compared a browser's `https` Origin against `http` and
# refused every cookie-authenticated mutation. This reproduces the broken shape
# first, then proves each supported fix repairs it. Requires Docker and openssl;
# the container is removed on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="parallax-verify-proxy-$$"
APPPORT="${APPPORT:-39180}"
PROXYPORT="${PROXYPORT:-39443}"
WORK="$(mktemp -d)"
HOSTNAME_UNDER_TEST="parallax.test"
SITE="https://${HOSTNAME_UNDER_TEST}:${PROXYPORT}"
TOKEN="$(openssl rand -hex 32)"
JAR="$WORK/cookies"

cleanup() {
  if [ -n "${APP_PID:-}" ]; then kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "  FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*"; }

command -v docker >/dev/null || { echo "skipped: Docker is required to run a real reverse proxy"; exit 0; }
docker info >/dev/null 2>&1 || { echo "skipped: Docker is installed but not running"; exit 0; }
command -v openssl >/dev/null || { echo "skipped: openssl is required to issue a certificate"; exit 0; }

# Requests arrive the way a browser would send them: through the proxy, naming
# the site by hostname, carrying the Origin the address bar shows. `-k` accepts
# the self-signed certificate; nothing else about the exchange is relaxed.
site() {
  local method="$1" path="$2"; shift 2
  curl -sk -X "$method" \
    --resolve "${HOSTNAME_UNDER_TEST}:${PROXYPORT}:127.0.0.1" \
    -H "Origin: ${SITE}" \
    -b "$JAR" -c "$JAR" \
    "$@" "${SITE}${path}"
}
status() { site "$@" -o /dev/null -w '%{http_code}'; }
# Settings are changed out of band with a bearer token, which is exempt from the
# same-origin proof -- otherwise a misconfigured deployment could never be fixed
# through its own API.
configure() {
  curl -sf -X PUT -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
    -d "$1" "http://127.0.0.1:${APPPORT}/api/v1/settings" >/dev/null \
    || fail "could not apply settings: $1"
}

echo "== issuing a certificate for ${HOSTNAME_UNDER_TEST} =="
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
  -subj "/CN=${HOSTNAME_UNDER_TEST}" \
  -addext "subjectAltName=DNS:${HOSTNAME_UNDER_TEST}" >/dev/null 2>&1
ok "self-signed certificate issued"

echo "== starting Parallax on loopback with authentication enabled =="
HOST=127.0.0.1 PORT="$APPPORT" \
PARALLAX_STATE_FILE="$WORK/state.json" \
PARALLAX_CONFIG_FILE="$WORK/configuration.json" \
PARALLAX_AUTH_TOKENS="[{\"token\":\"${TOKEN}\",\"subject\":\"proxy-verify\",\"role\":\"admin\"}]" \
  node "$ROOT/src/index.ts" > "$WORK/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do
  kill -0 "$APP_PID" 2>/dev/null || { cat "$WORK/app.log" >&2; fail "app exited during startup"; }
  curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null || { cat "$WORK/app.log" >&2; fail "app did not start"; }
ok "control plane listening on http://127.0.0.1:${APPPORT}"

cat > "$WORK/nginx.conf" <<EOF
events {}
http {
  server {
    listen 443 ssl;
    server_name ${HOSTNAME_UNDER_TEST};
    ssl_certificate     /etc/nginx/cert.pem;
    ssl_certificate_key /etc/nginx/key.pem;
    location / {
      proxy_pass http://host.docker.internal:${APPPORT};
      proxy_set_header Host              \$host:${PROXYPORT};
      proxy_set_header X-Forwarded-Proto \$scheme;
      proxy_set_header X-Forwarded-Host  \$host:${PROXYPORT};
      proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    }
  }
}
EOF

echo "== starting nginx as the TLS termination point =="
docker run -d --name "$CONTAINER" \
  --add-host "host.docker.internal:host-gateway" \
  -v "$WORK/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$WORK/cert.pem:/etc/nginx/cert.pem:ro" \
  -v "$WORK/key.pem:/etc/nginx/key.pem:ro" \
  -p "${PROXYPORT}:443" nginx:1.27-alpine >/dev/null
for _ in $(seq 1 60); do
  [ "$(status GET /health/live)" = "200" ] && break
  sleep 0.25
done
[ "$(status GET /health/live)" = "200" ] || { docker logs "$CONTAINER" 2>&1 | tail -20 >&2; fail "proxy did not become reachable"; }
ok "${SITE} reaches the control plane through nginx"

echo "== the misconfigured shape is refused, so the checks below are not vacuous =="
CODE=$(status POST /api/v1/session -H 'content-type: application/json' -d "{\"token\":\"${TOKEN}\"}")
[ "$CODE" = "403" ] || fail "expected the https Origin to be refused while the origin is rebuilt as http, got $CODE"
ok "with neither publicOrigin nor forwarded trust, the https Origin is refused (403)"

echo "== trusting the proxy's forwarding headers repairs it =="
configure '{"trustForwardedHeaders":true}'
HEADERS=$(site POST /api/v1/session -H 'content-type: application/json' -d "{\"token\":\"${TOKEN}\"}" -D - -o /dev/null)
echo "$HEADERS" | head -1 | grep -q ' 200' || fail "sign-in through the proxy did not succeed: $(echo "$HEADERS" | head -1)"
ok "sign-in through the proxy succeeds"

COOKIE=$(echo "$HEADERS" | tr -d '\r' | grep -i '^set-cookie:' || true)
[ -n "$COOKIE" ] || fail "no session cookie was issued"
for attribute in Secure HttpOnly "SameSite=Strict"; do
  echo "$COOKIE" | grep -qi "$attribute" || fail "session cookie is missing $attribute: $COOKIE"
done
ok "session cookie carries Secure, HttpOnly and SameSite=Strict"

echo "$HEADERS" | tr -d '\r' | grep -qi '^strict-transport-security: max-age=' \
  || fail "HSTS was not sent over TLS"
ok "HSTS sent over the TLS connection"

echo "== a cookie-authenticated mutation now reaches the control plane =="
CODE=$(status POST /api/v1/zones -H 'content-type: application/json' -d '{"name":"example.com"}')
[ "$CODE" = "201" ] || fail "cookie-authenticated zone creation returned $CODE"
ok "zone created with the session cookie alone, no bearer token"

echo "== readiness detail stays with authenticated callers =="
AUTHED=$(site GET /health/ready)
ANON=$(curl -sk --resolve "${HOSTNAME_UNDER_TEST}:${PROXYPORT}:127.0.0.1" "${SITE}/health/ready")
[ "${#AUTHED}" -gt "${#ANON}" ] || fail "an anonymous readiness probe saw as much as an authenticated one"
if echo "$ANON" | grep -qi "provider\|backend"; then
  fail "anonymous readiness leaked deployment detail: $ANON"
fi
ok "anonymous readiness is a bare verdict; detail requires a session"

echo "== an explicit public origin works without trusting any header =="
configure "{\"trustForwardedHeaders\":false,\"publicOrigin\":\"${SITE}\"}"
: > "$JAR"
CODE=$(status POST /api/v1/session -H 'content-type: application/json' -d "{\"token\":\"${TOKEN}\"}")
[ "$CODE" = "200" ] || fail "sign-in with an explicit publicOrigin returned $CODE"
CODE=$(status POST /api/v1/zones -H 'content-type: application/json' -d '{"name":"second.example"}')
[ "$CODE" = "201" ] || fail "mutation with an explicit publicOrigin returned $CODE"
ok "publicOrigin alone is sufficient; forwarded headers stay untrusted"

echo "== a forged Origin is still refused under both settings =="
FORGED=$(curl -sk -X POST --resolve "${HOSTNAME_UNDER_TEST}:${PROXYPORT}:127.0.0.1" \
  -H "Origin: https://evil.example" -H 'content-type: application/json' \
  -b "$JAR" -d '{"name":"forged.example"}' \
  -o /dev/null -w '%{http_code}' "${SITE}/api/v1/zones")
[ "$FORGED" = "403" ] || fail "a cross-site Origin was accepted with $FORGED"
ok "a cross-site Origin is refused even with a valid session cookie"

echo "== the same guarantees when Parallax ends TLS itself =="
# A deployment with no proxy in front of it is the other supported shape, and it
# reaches the same code by a different route: nothing sets X-Forwarded-Proto, so
# the server has to know its own scheme.
NATIVE_PORT=$((PROXYPORT + 1))
NATIVE_SITE="https://${HOSTNAME_UNDER_TEST}:${NATIVE_PORT}"
mkdir -p "$WORK/tls"
cp "$WORK/cert.pem" "$WORK/tls/cert.pem"
cp "$WORK/key.pem" "$WORK/tls/key.pem"

kill "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true
HOST=127.0.0.1 PORT="$NATIVE_PORT" \
PARALLAX_TLS_CERT_FILE="$WORK/tls/cert.pem" \
PARALLAX_TLS_KEY_FILE="$WORK/tls/key.pem" \
PARALLAX_HTTP_REDIRECT_PORT=$((NATIVE_PORT + 1)) \
PARALLAX_STATE_FILE="$WORK/native-state.json" \
PARALLAX_CONFIG_FILE="$WORK/native-configuration.json" \
PARALLAX_AUTH_TOKENS="[{\"token\":\"${TOKEN}\",\"subject\":\"proxy-verify\",\"role\":\"admin\"}]" \
  node "$ROOT/src/index.ts" > "$WORK/native.log" 2>&1 &
APP_PID=$!
native() {
  local method="$1" path="$2"; shift 2
  curl -sk -X "$method" --resolve "${HOSTNAME_UNDER_TEST}:${NATIVE_PORT}:127.0.0.1" \
    -H "Origin: ${NATIVE_SITE}" -b "$JAR" -c "$JAR" "$@" "${NATIVE_SITE}${path}"
}
for _ in $(seq 1 60); do
  kill -0 "$APP_PID" 2>/dev/null || { cat "$WORK/native.log" >&2; fail "app exited while starting with TLS"; }
  [ "$(native GET /health/live -o /dev/null -w '%{http_code}')" = "200" ] && break
  sleep 0.25
done
[ "$(native GET /health/live -o /dev/null -w '%{http_code}')" = "200" ] \
  || { cat "$WORK/native.log" >&2; fail "the TLS listener did not answer"; }
ok "serving TLS directly on ${NATIVE_PORT}, no proxy involved"

: > "$JAR"
HEADERS=$(native POST /api/v1/session -H 'content-type: application/json' -d "{\"token\":\"${TOKEN}\"}" -D - -o /dev/null)
echo "$HEADERS" | head -1 | grep -q ' 200' || fail "sign-in over native TLS failed: $(echo "$HEADERS" | head -1)"
# Nothing told the server it was serving https; it has to know because it is the
# thing that ended the connection.
echo "$HEADERS" | tr -d '\r' | grep -i '^set-cookie:' | grep -qi Secure \
  || fail "the cookie issued over native TLS is missing Secure"
ok "the https Origin is accepted and the cookie is Secure, with no publicOrigin set"

CODE=$(native POST /api/v1/zones -H 'content-type: application/json' -d '{"name":"native.example"}' -o /dev/null -w '%{http_code}')
[ "$CODE" = "201" ] || fail "cookie-authenticated write over native TLS returned $CODE"
ok "a cookie-authenticated write reaches the control plane"

REDIRECT=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' \
  "http://127.0.0.1:$((NATIVE_PORT + 1))/api/v1/zones")
case "$REDIRECT" in
  "308 https://"*"/api/v1/zones") ok "plain HTTP is redirected to TLS, path intact ($REDIRECT)" ;;
  *) fail "expected a 308 to https, got: $REDIRECT" ;;
esac

echo "== a renewed certificate is picked up without a restart =="
# The failure this prevents arrives months later: a pod presenting a certificate
# that expired because nothing restarted it.
BEFORE=$(echo | openssl s_client -connect "127.0.0.1:${NATIVE_PORT}" -servername "$HOSTNAME_UNDER_TEST" 2>/dev/null \
  | openssl x509 -noout -serial 2>/dev/null)
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$WORK/tls/key.new" -out "$WORK/tls/cert.new" \
  -subj "/CN=${HOSTNAME_UNDER_TEST}" -addext "subjectAltName=DNS:${HOSTNAME_UNDER_TEST}" >/dev/null 2>&1
mv "$WORK/tls/cert.new" "$WORK/tls/cert.pem"
mv "$WORK/tls/key.new" "$WORK/tls/key.pem"
AFTER=""
for _ in $(seq 1 40); do
  AFTER=$(echo | openssl s_client -connect "127.0.0.1:${NATIVE_PORT}" -servername "$HOSTNAME_UNDER_TEST" 2>/dev/null \
    | openssl x509 -noout -serial 2>/dev/null)
  [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ] && break
  sleep 0.25
done
[ -n "$BEFORE" ] || fail "could not read the certificate the server started with"
[ "$AFTER" != "$BEFORE" ] || fail "the server kept serving the old certificate after renewal"
ok "the new certificate is served without restarting ($BEFORE -> $AFTER)"

[ "$(native GET /health/live -o /dev/null -w '%{http_code}')" = "200" ] \
  || fail "the server stopped answering after the certificate was replaced"
ok "connections still succeed on the renewed certificate"

echo
echo "Reverse proxy verification passed."
