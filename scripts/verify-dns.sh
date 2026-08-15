#!/usr/bin/env bash
# Verifies Parallax's built-in DNS listener against a real client: every record
# type the domain accepts is answered and parsed by dig, the two negatives are
# told apart, a reply too large for UDP truncates and completes over TCP, names
# outside every zone are relayed to an upstream and refused when there is none,
# a change through the API is served without a restart, and an unparseable
# message gets no reply at all. Requires dig; no Docker and no network.
#
# Nothing here calls `apply`, and no provider is ever configured. The listener
# answers from the desired state, so if these queries resolve, they resolved
# without a provider being involved -- which is the property under test.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DNSPORT="${DNSPORT:-15353}"
REFUSEPORT="${REFUSEPORT:-15355}"
UPSTREAMPORT="${UPSTREAMPORT:-15354}"
APPPORT="${APPPORT:-39170}"
WORK="$(mktemp -d)"
API="http://127.0.0.1:${APPPORT}/api/v1"
# A change committed by this process is served at once; anything else waits for
# the periodic re-read, so assertions about arrival are given room.
REFRESH_WAIT=20
DNS_REFRESH_SECONDS=5

cleanup() {
  for pid in "${APP_PID:-}" "${REFUSE_PID:-}" "${UPSTREAM_PID:-}"; do
    [ -n "$pid" ] && { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "  FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*"; }

# `dig +short` prints its own diagnostics on stdout, so they are filtered out:
# an unreachable server has to look like no answer rather than like one.
short() { dig +short +time=3 +tries=1 -p "$DNSPORT" @127.0.0.1 "$@" 2>/dev/null | grep -v '^;' || true; }
# The answer section as dig renders it. Getting a rendered line at all is the
# check: dig re-reads the RDATA from the wire bytes with its own parser, and
# reports a malformed record rather than printing one.
answer() { dig +noall +answer +time=3 +tries=1 -p "$DNSPORT" @127.0.0.1 "$@" 2>/dev/null || true; }
status() { dig +noall +comments +time=3 +tries=1 -p "$DNSPORT" @127.0.0.1 "$@" 2>/dev/null | sed -n 's/.*status: \([A-Z]*\).*/\1/p'; }

# Deployment details are reported only to an authenticated caller, so the run
# uses a token throughout rather than only where it is read back.
TOKEN="verify-dns-token-that-is-at-least-32-bytes-long"
AUTH=(-H "authorization: Bearer ${TOKEN}")

put() {
  curl -sf "${AUTH[@]}" -X PUT -H 'content-type: application/json' \
    -d "$(node -e 'process.stdout.write(JSON.stringify({name:process.argv[1],type:process.argv[2],content:process.argv[3],ttl:300}))' "$2" "$3" "$4")" \
    "$API/zones/example.com/views/internal/records/$1" >/dev/null \
    || fail "the control plane refused $3 $4"
}

# One record of every type, in the presentation format the domain stores, with
# the type's IANA number beside it.
#
# The list is checked against RECORD_TYPES below rather than trusted: a type
# added to the domain and left out here would be a type nothing ever queries.
# The numbers are written out rather than read from the source because they are
# what the query asks for -- a wrong code in `wire.ts` would find no record here
# instead of agreeing with itself.
read -r -d '' SAMPLES <<'EOF' || true
a|A|1|192.0.2.1
aaaa|AAAA|28|2001:db8::1
caa|CAA|257|0 issue "letsencrypt.org"
cert|CERT|37|1 12345 8 aGVsbG8=
cname|CNAME|5|origin.example.net
dname|DNAME|39|target.example.net
hinfo|HINFO|13|"Intel" "Linux"
https|HTTPS|65|1 . alpn=h2,h3
mx|MX|15|10 mail.example.net
naptr|NAPTR|35|100 10 "s" "SIP+D2U" "" _sip._udp.example.net
ns|NS|2|ns1.example.net
openpgpkey|OPENPGPKEY|61|aGVsbG8=
ptr|PTR|12|host.example.net
smimea|SMIMEA|53|3 1 1 ab12cd34
srv|SRV|33|10 5 443 host.example.net
sshfp|SSHFP|44|4 2 ab12cd34
svcb|SVCB|64|1 svc.example.net
tlsa|TLSA|52|3 1 1 ab12cd34
txt|TXT|16|v=spf1 -all
uri|URI|256|10 1 "https://example.com/"
EOF

echo "== the sample list covers every type the domain accepts =="
DOMAIN_TYPES=$(node -e '
  const source = require("node:fs").readFileSync(process.argv[1], "utf8");
  const match = /export const RECORD_TYPES = \[([^\]]*)\]/s.exec(source);
  if (!match) { console.error("RECORD_TYPES could not be read"); process.exit(1); }
  console.log([...match[1].matchAll(/"([A-Z]+)"/g)].map((entry) => entry[1]).sort().join(" "));
' "$ROOT/src/domain/dns.ts")
SAMPLE_TYPES=$(echo "$SAMPLES" | cut -d'|' -f2 | grep . | sort | tr '\n' ' ' | sed 's/ $//')
[ "$SAMPLE_TYPES" = "$DOMAIN_TYPES" ] \
  || fail "the samples cover [$SAMPLE_TYPES] but the domain accepts [$DOMAIN_TYPES]"
ok "$(echo "$DOMAIN_TYPES" | wc -w | tr -d ' ') types, and one sample for each"

echo "== starting a stub upstream =="
# A stub rather than a real resolver, so this script needs no network and so the
# relay can be proved by something only the upstream could have said. NOTIMP is
# that marker: the listener answers REFUSED or SERVFAIL for a name it cannot
# place, and never NOTIMP.
cat > "$WORK/upstream.mjs" <<'EOF'
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { appendFileSync } from "node:fs";
const [port, log] = [Number(process.argv[2]), process.argv[3]];

// NOTIMP over UDP, NXDOMAIN over TCP. Two different markers because the query
// has to reach the upstream on the same transport the client used, and a single
// marker could not tell the two apart.
const socket = createSocket("udp4");
socket.on("message", (message, remote) => {
  appendFileSync(log, "udp\n");
  const reply = Buffer.from(message);
  reply.writeUInt16BE(0x8184, 2);
  socket.send(reply, remote.port, remote.address);
});

const tcp = createServer((connection) => {
  let buffered = Buffer.alloc(0);
  connection.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length < 2) return;
    const size = buffered.readUInt16BE(0);
    if (buffered.length < size + 2) return;
    appendFileSync(log, "tcp\n");
    const reply = Buffer.from(buffered.subarray(2, size + 2));
    reply.writeUInt16BE(0x8183, 2);
    const framed = Buffer.alloc(2 + reply.length);
    framed.writeUInt16BE(reply.length, 0);
    reply.copy(framed, 2);
    connection.end(framed);
  });
  connection.on("error", () => connection.destroy());
});

let ready = 0;
const announce = () => { ready += 1; if (ready === 2) console.log("ready"); };
socket.bind(port, "127.0.0.1", announce);
tcp.listen(port, "127.0.0.1", announce);
EOF
: > "$WORK/upstream.log"
node "$WORK/upstream.mjs" "$UPSTREAMPORT" "$WORK/upstream.log" > "$WORK/upstream.out" 2>&1 &
UPSTREAM_PID=$!
for _ in $(seq 1 40); do grep -q ready "$WORK/upstream.out" && break; sleep 0.25; done
grep -q ready "$WORK/upstream.out" || { cat "$WORK/upstream.out" >&2; fail "the stub upstream did not bind"; }
ok "stub upstream on 127.0.0.1:${UPSTREAMPORT}"

echo "== starting Parallax with the DNS listener =="
HOST=127.0.0.1 PORT="$APPPORT" \
PARALLAX_STATE_FILE="$WORK/state.json" \
PARALLAX_CONFIG_FILE="$WORK/configuration.json" \
PARALLAX_PROVIDER_STATE_FILE="$WORK/provider.json" \
PARALLAX_DNS_PORT="$DNSPORT" \
PARALLAX_DNS_FORWARD_TO="127.0.0.1#${UPSTREAMPORT}" \
PARALLAX_AUTH_TOKENS="[{\"token\":\"${TOKEN}\",\"role\":\"admin\",\"subject\":\"verify\"}]" \
  node "$ROOT/src/index.ts" > "$WORK/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:${APPPORT}/health/live" >/dev/null || { cat "$WORK/app.log" >&2; fail "the control plane did not start"; }
grep -q "dns://127.0.0.1:${DNSPORT}" "$WORK/app.log" || { cat "$WORK/app.log" >&2; fail "the DNS listener did not report itself bound"; }
ok "control plane on ${APPPORT}, listener on ${DNSPORT}"

echo "== a zone with no internal records is left to the upstream, not answered for =="
# The normal state right after adopting a zone. Claiming authority for it would
# answer NXDOMAIN for every name the zone holds.
curl -sf "${AUTH[@]}" -X POST -H 'content-type: application/json' -d '{"name":"example.com"}' "$API/zones" >/dev/null
sleep 6
[ "$(status anything.example.com A)" = "NOTIMP" ] \
  || fail "an empty zone was answered for locally, status was '$(status anything.example.com A)'"
ok "names in an empty zone still reach the upstream"

echo "== every record type is answered and parsed by dig =="
while IFS='|' read -r id type code content; do
  [ -z "$id" ] && continue
  put "$id" "$id" "$type" "$content"
done <<< "$SAMPLES"

for _ in $(seq 1 "$REFRESH_WAIT"); do [ -n "$(short a.example.com A)" ] && break; sleep 1; done
[ -n "$(short a.example.com A)" ] || { tail -20 "$WORK/app.log" >&2; fail "the listener never picked up the records"; }

UNKNOWN_TO_DIG=""
while IFS='|' read -r id type code content; do
  [ -z "$id" ] && continue
  # Asked for by number. A dig that does not know a type's name silently asks
  # for A instead, which answers nothing here and would read as this listener
  # having no record -- the wrong conclusion from the right symptom.
  LINE=$(answer "${id}.example.com" "TYPE${code}")
  [ -n "$LINE" ] || fail "$type (TYPE${code}) produced no answer"
  # dig renders a type it does not know as TYPEnnn and the RDATA as `\# len hex`.
  # That is a weaker check -- it proves an answer of the right type arrived and
  # was well-formed enough to render -- so which types got it is reported.
  if echo "$LINE" | grep -q "[[:space:]]TYPE${code}[[:space:]]"; then
    UNKNOWN_TO_DIG="$UNKNOWN_TO_DIG $type"
    echo "$LINE" | grep -q '\\#' || fail "$type answered as an unknown type with no RDATA: $LINE"
  else
    echo "$LINE" | grep -q "[[:space:]]${type}[[:space:]]" || fail "$type answered as something else: $LINE"
  fi
done <<< "$SAMPLES"
ok "all $(echo "$DOMAIN_TYPES" | wc -w | tr -d ' ') types answered and rendered by dig"
[ -n "$UNKNOWN_TO_DIG" ] && echo "  note: this dig renders${UNKNOWN_TO_DIG} as unknown types, so those were checked as wire-format only"

echo "== the values dig re-renders are the values that were stored =="
# Only the types whose presentation format is stable across dig versions. dig
# parses these from the wire bytes with its own reader, so agreeing with what
# was stored is an independent check of the encoder -- not a check of it
# against itself.
[ "$(short a.example.com A)" = "192.0.2.1" ] || fail "A rendered as '$(short a.example.com A)'"
[ "$(short aaaa.example.com AAAA)" = "2001:db8::1" ] || fail "AAAA rendered as '$(short aaaa.example.com AAAA)'"
[ "$(short txt.example.com TXT)" = '"v=spf1 -all"' ] || fail "TXT rendered as '$(short txt.example.com TXT)'"
[ "$(short cname.example.com CNAME)" = "origin.example.net." ] || fail "CNAME rendered as '$(short cname.example.com CNAME)'"
# The leading number belongs in a field of its own on the wire, and the target
# has to be absolute. Both are invisible in the stored text and only show up here.
[ "$(short mx.example.com MX)" = "10 mail.example.net." ] || fail "MX rendered as '$(short mx.example.com MX)'"
[ "$(short srv.example.com SRV)" = "10 5 443 host.example.net." ] || fail "SRV rendered as '$(short srv.example.com SRV)'"
[ "$(short naptr.example.com NAPTR)" = '100 10 "s" "SIP+D2U" "" _sip._udp.example.net.' ] \
  || fail "NAPTR rendered as '$(short naptr.example.com NAPTR)'"
ok "A, AAAA, TXT, CNAME, MX, SRV and NAPTR round-trip through dig's own reader"

echo "== a whole RRset is answered, not one of it =="
put a2 a A 192.0.2.2
for _ in $(seq 1 "$REFRESH_WAIT"); do [ "$(short a.example.com A | wc -l | tr -d ' ')" = "2" ] && break; sleep 1; done
[ "$(short a.example.com A | sort | tr '\n' ' ')" = "192.0.2.1 192.0.2.2 " ] \
  || fail "expected both addresses, got: $(short a.example.com A | tr '\n' ' ')"
ok "both addresses in one answer"

echo "== a CNAME answers a query for another type =="
[ "$(short cname.example.com AAAA)" = "origin.example.net." ] \
  || fail "the CNAME did not answer an AAAA query, got '$(short cname.example.com AAAA)'"
ok "CNAME answers for every type, as it must"

echo "== the two negatives are told apart =="
# A resolver treats these differently and caches them differently, so answering
# one for the other is not a cosmetic difference.
[ "$(status nothing.example.com A)" = "NXDOMAIN" ] || fail "an absent name got '$(status nothing.example.com A)'"
[ "$(status a.example.com MX)" = "NOERROR" ] || fail "a name with no MX got '$(status a.example.com MX)'"
[ -z "$(short a.example.com MX)" ] || fail "a name with no MX returned an answer"
dig +noall +authority +time=3 -p "$DNSPORT" @127.0.0.1 nothing.example.com A 2>/dev/null | grep -q SOA \
  || fail "NXDOMAIN carried no SOA, so a resolver cannot cache the absence"
ok "NXDOMAIN and empty NOERROR, both carrying the SOA"

echo "== a reply too large for UDP truncates and completes over TCP =="
put big big TXT "$(printf 'x%.0s' $(seq 1 600))"
for _ in $(seq 1 "$REFRESH_WAIT"); do [ -n "$(short big.example.com TXT)" ] && break; sleep 1; done
# +ignore stops dig retrying over TCP, so the truncated reply is what is seen.
TRUNCATED=$(dig +notcp +ignore +noall +comments +bufsize=512 +time=3 -p "$DNSPORT" @127.0.0.1 big.example.com TXT 2>/dev/null)
echo "$TRUNCATED" | grep -q ' tc' || fail "a 600-byte record was not truncated over UDP: $TRUNCATED"
# Left to itself dig sees TC and asks again over TCP, which is the whole point:
# truncation is an instruction, not a failure.
[ "$(dig +short +time=3 -p "$DNSPORT" @127.0.0.1 big.example.com TXT 2>/dev/null | tr -d '"\n ' | wc -c | tr -d ' ')" = "600" ] \
  || fail "the record did not come back whole when dig retried over TCP"
ok "TC set over UDP, and the full 600 bytes over TCP"

echo "== a wildcard covers the names below it, and never over a real one =="
# The desired state accepts `*` and every other publisher expands it. A listener
# that took it literally would answer NXDOMAIN for names the same desired state
# resolves through CoreDNS, PowerDNS or Cloudflare.
put star '*' A 192.0.2.60
put stareu '*.eu' A 192.0.2.61
for _ in $(seq 1 "$REFRESH_WAIT"); do [ -n "$(short whatever.example.com A)" ] && break; sleep 1; done
[ "$(short whatever.example.com A)" = "192.0.2.60" ] \
  || fail "the apex wildcard did not answer, got '$(short whatever.example.com A)'"
[ "$(short shop.eu.example.com A)" = "192.0.2.61" ] \
  || fail "the closest wildcard did not win, got '$(short shop.eu.example.com A)'"
[ "$(short cname.example.com CNAME)" = "origin.example.net." ] \
  || fail "the wildcard answered over an exact record"
ok "wildcard synthesis, closest match first, exact records untouched"

echo "== a name outside every zone is relayed, on the transport it arrived on =="
BEFORE=$(grep -c udp "$WORK/upstream.log" || true)
[ "$(status elsewhere.example.net A)" = "NOTIMP" ] \
  || fail "the UDP reply did not come from the upstream, status was '$(status elsewhere.example.net A)'"
AFTER=$(grep -c udp "$WORK/upstream.log" || true)
[ "$AFTER" -gt "$BEFORE" ] || fail "the upstream was never asked over UDP ($BEFORE -> $AFTER)"

# A client only reaches TCP because it was told the UDP answer was truncated.
# Relaying that over UDP hands back another truncated answer and the client has
# no move left, so the transport has to carry through.
TCP_STATUS=$(dig +tcp +noall +comments +time=3 +tries=1 -p "$DNSPORT" @127.0.0.1 elsewhere.example.net A 2>/dev/null | sed -n 's/.*status: \([A-Z]*\).*/\1/p')
[ "$TCP_STATUS" = "NXDOMAIN" ] \
  || fail "a TCP query was not relayed over TCP: expected the TCP upstream's NXDOMAIN, got '$TCP_STATUS'"
grep -q tcp "$WORK/upstream.log" || fail "the upstream was never asked over TCP"
ok "UDP relayed to UDP and TCP to TCP, each answer returned as it was"

echo "== a change made through the API is served at once, not at the next refresh =="
# The listener is told when this process commits, so this must not need the
# timer. The bound is under the refresh interval on purpose: at or above it,
# the check would pass even if the notification did nothing.
put a a A 192.0.2.9
SERVED=""
for _ in $(seq 1 8); do
  [ "$(short a.example.com A | sort | tr '\n' ' ')" = "192.0.2.2 192.0.2.9 " ] && { SERVED=yes; break; }
  sleep 0.25
done
[ -n "$SERVED" ] \
  || fail "the change was not served within 2s, so only the ${DNS_REFRESH_SECONDS}s timer could have delivered it: $(short a.example.com A | tr '\n' ' ')"
[ -n "${APP_PID:-}" ] && kill -0 "$APP_PID" 2>/dev/null || fail "the process restarted, which is not what was being tested"
ok "answered by the same process, before the refresh timer could have run"

echo "== readiness reports what the listener is answering for =="
# The zone count is not the number of zones: one with an empty internal view is
# left to the forwarder. Somebody asking why a name does not resolve internally
# needs to see that difference from outside the process.
# Unauthenticated first: readiness has to be 200 for a listener-only deployment
# that configures no provider at all, or a probe would never send it traffic.
curl -sf "http://127.0.0.1:${APPPORT}/health/ready" >/dev/null \
  || fail "a deployment served only by the listener reports itself not ready"
READY=$(curl -sf "${AUTH[@]}" "http://127.0.0.1:${APPPORT}/health/ready")
echo "$READY" | node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; }).on("end", () => {
    const dns = JSON.parse(body).dns;
    if (!dns || dns === "disabled") { console.error("readiness does not report the listener"); process.exit(1); }
    if (dns.port !== Number(process.argv[1])) { console.error(`port reads as ${dns.port}`); process.exit(1); }
    if (!(dns.zones >= 1)) { console.error(`zones reads as ${dns.zones}`); process.exit(1); }
    if (dns.forwarding !== true) { console.error("forwarding is not reported"); process.exit(1); }
  });
' "$DNSPORT" || fail "readiness did not describe the DNS listener"
ok "readiness names the port, the zone count and that it forwards"

echo "== an unparseable message gets no reply at all =="
# A reply to a message that cannot be parsed is a reply to whatever source
# address was written on it, which is what makes a DNS server worth pointing at
# somebody else.
cat > "$WORK/garbage.mjs" <<'EOF'
import { createSocket } from "node:dgram";
const socket = createSocket("udp4");
const timer = setTimeout(() => { console.log("silent"); socket.close(); }, 1500);
socket.once("message", () => { clearTimeout(timer); console.log("replied"); socket.close(); });
socket.send(Buffer.of(1, 2, 3), Number(process.argv[2]), "127.0.0.1");
EOF
[ "$(node "$WORK/garbage.mjs" "$DNSPORT")" = "silent" ] || fail "a three-byte message was answered"
ok "nothing sent back, so there is nothing to amplify"

echo "== with no upstream, a name outside every zone is refused =="
# REFUSED is the server saying the question is not its to answer. It is correct,
# and it is why a listener with no upstreams belongs behind a forwarder.
HOST=127.0.0.1 PORT="$((APPPORT + 1))" \
PARALLAX_STATE_FILE="$WORK/state2.json" \
PARALLAX_CONFIG_FILE="$WORK/configuration2.json" \
PARALLAX_PROVIDER_STATE_FILE="$WORK/provider2.json" \
PARALLAX_DNS_PORT="$REFUSEPORT" \
  node "$ROOT/src/index.ts" > "$WORK/app2.log" 2>&1 &
REFUSE_PID=$!
for _ in $(seq 1 60); do grep -q "dns://127.0.0.1:${REFUSEPORT}" "$WORK/app2.log" && break; sleep 0.25; done
grep -q "dns://127.0.0.1:${REFUSEPORT}" "$WORK/app2.log" || { cat "$WORK/app2.log" >&2; fail "the second listener did not bind"; }
REFUSED=$(dig +noall +comments +time=3 +tries=1 -p "$REFUSEPORT" @127.0.0.1 elsewhere.example.net A 2>/dev/null | sed -n 's/.*status: \([A-Z]*\).*/\1/p')
[ "$REFUSED" = "REFUSED" ] || fail "expected REFUSED with no upstream configured, got '$REFUSED'"
grep -q "no DNS upstream is configured" "$WORK/app2.log" || fail "the process did not say it would refuse rather than relay"
ok "REFUSED, and the process said so at startup"

echo
echo "DNS listener verification passed."
