# Parallax

English | [한국어](README.ko.md)

Parallax is a split-horizon DNS control plane and operations portal. It keeps
one desired state for internal DNS and external Cloudflare DNS, previews the
resulting changes, and applies only records explicitly managed by Parallax.

## Included features

- Browser portal for zones, internal/external records, preview, apply, status,
  audit history, immutable revisions, restore, and zone deletion
- Every common record type, validated by its RDATA grammar, with Cloudflare proxy constraints,
  including RFC 8552 underscored names such as `_dmarc` and `_acme-challenge`
- Deterministic `managed-only` reconciliation that leaves foreign records alone
- Durable single-node JSON state and provider state with atomic writes
- Optional PostgreSQL source of truth with transactional immutable revisions
- Optional Cloudflare API and CoreDNS RFC 1035 zone-file adapters
- Optional built-in DNS listener that answers the internal view from the desired
  state over UDP and TCP, and relays every other name to an upstream
- Encrypted, write-only Cloudflare credential management from the admin portal
- Optional admin/editor/viewer token authentication, OpenID Connect sign-in, and audit actors
- Health endpoints and security headers
- Dependency-light Node.js HTTP server and TypeScript test suite

The product and architecture rationale are in
[docs/product-design.md](docs/product-design.md).

## Requirements

- Node.js 24 or later
- pnpm 11 or later

## Run locally

```sh
pnpm install
pnpm test
pnpm check
pnpm build
pnpm start
```

Open `http://127.0.0.1:3000`. Local state is stored under `data/`, which is
ignored by Git. During development, use `pnpm dev`.

## Configuration

The environment carries only what cannot be read out of the store: where to
bind, how to reach the store, and the keys that protect what is stored.

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | Server bind address; defaults to `127.0.0.1:3000` |
| `DATABASE_URL` | PostgreSQL source of truth. A non-loopback URL must use `sslmode=verify-full` or `verify-ca` |
| `PARALLAX_ALLOW_PLAINTEXT_POSTGRES` | Explicitly allow a non-loopback PostgreSQL URL without verified TLS; use only on a separately protected network |
| `PARALLAX_STATE_FILE` | Zones, revisions, statuses and audit, when no database is configured |
| `PARALLAX_CONFIG_FILE` | Settings, credentials and access tokens, when no database is configured |
| `PARALLAX_PROVIDER_STATE_FILE` | Local provider state, used only while the local provider is enabled |
| `PARALLAX_COREDNS_ROOT` | Deployment-owned root that confines the stored `coreDnsDirectory`; required before CoreDNS publishing can be enabled |
| `PARALLAX_OWNERSHIP_SECRET` | 32+ byte secret that signs managed-record ownership markers |
| `PARALLAX_CREDENTIAL_MASTER_KEY` | Exactly 32 bytes as base64 or 64 hexadecimal characters; encrypts stored credentials |
| `PARALLAX_POWERDNS_DATABASE_URL` | PowerDNS's own database, subject to the same PostgreSQL TLS policy, when the internal view is published into it |
| `PARALLAX_DNS_PORT` | Answer DNS for the internal view from this process. Unset leaves the port unbound |
| `PARALLAX_DNS_HOST` | Address the DNS listener binds; defaults to `HOST`, which is loopback unless set |
| `PARALLAX_DNS_FORWARD_TO` | Comma-separated upstreams (`host` or `host#port`) for names outside every zone. Empty answers `REFUSED` instead of relaying |
| `PARALLAX_DNS_FORWARD_ALLOW` | Client CIDRs allowed to recurse. Defaults to loopback; required explicitly for forwarding on a non-loopback listener |
| `PARALLAX_TLS_CERT_FILE`, `PARALLAX_TLS_KEY_FILE` | Certificate and key for this process to end TLS itself; set both or neither |
| `PARALLAX_HTTP_REDIRECT_PORT` | Port answering plain HTTP with a redirect to the stored `publicOrigin`; needs both TLS and that setting |
| `PARALLAX_AUTH_TOKENS` | JSON array of `{"token","subject","role"}`; tokens must be canonical base64url encodings of 32 random bytes. Optional on loopback, **required to bind any other address** |

File-backed deployments require the parent directory of each configured data
file to be owned by the service user and have mode **exactly `0700`**. A missing
directory is created with that mode, but Parallax deliberately does not `chmod`
an existing directory: a path may name a shared parent such as `/tmp`, and
silently restricting it would break unrelated services. Before upgrading an
older installation whose data directory is commonly `0755`, stop every writer
and provision the existing directory explicitly (repeat for each distinct
parent directory):

```sh
# Default relative file paths in a source installation:
chmod 0700 data

# Example system-service path:
sudo chown parallax:parallax /var/lib/parallax
sudo chmod 0700 /var/lib/parallax
```

Use the actual service account and path for the deployment. Change only the
directory mode, not every file recursively. This permission migration is
separate from stale-lock recovery: do not remove a lock for a mode error; follow
the named-lock procedure below only after confirming that no writer is active.

Everything else -- provider wiring, retention, proxy origin, access tokens and
provider credentials -- is stored alongside the zones and managed from the
portal's **Provider settings** screen. A local change takes effect immediately;
each other server or CLI process re-reads settings every five seconds and runs
the same machine-specific verifier before re-wiring itself. Nothing needs a
redeploy, and a replica that cannot safely apply a value keeps its last good
wiring and reports the refresh failure.

| Setting | Effect |
| --- | --- |
| `allowLocalProvider` | Publish to a local file when no real provider is configured. Off by default, so an unrouted target fails loudly instead of reporting success |
| `coreDnsDirectory` | Directory of RFC 1035 zone files beneath `PARALLAX_COREDNS_ROOT`; empty disables it |
| `publicOrigin` | HTTPS origin browsers reach the portal at (HTTP is accepted only on loopback) |
| `trustForwardedHeaders` | Trust proxy headers; requires `publicOrigin` so forwarded host/protocol never choose the security origin |
| `revisionRetention` | Newest revision snapshots kept per zone; `0` keeps every one |
| `auditRetentionDays` | Days of audit history kept per zone; `0` keeps every entry |

### Access tokens

Tokens are issued from the portal and stored only as SHA-256 digests, so the
store can verify a presented token but never reproduce one. A new token is shown
exactly once. With no token anywhere the control plane is open, which is
intended for loopback development: it refuses to bind a non-loopback address in
that state, and refuses API requests that arrive with proxy forwarding headers.
`PARALLAX_AUTH_TOKENS` remains as a break-glass path for a deployment that has
locked itself out; those tokens are listed as managed and cannot be revoked
through the API. The last administrator token cannot be revoked.

Issue one token per person or per automation, not one for the deployment. The
audit trail records the token's subject as the actor, so a shared token makes
every change -- portal, `curl`, another session -- look like the same actor, and
there is no way to tell them apart afterwards.

A server reads the tokens at startup and re-reads them every five seconds, so a
token issued or revoked from the command line, another replica, or a second
server takes effect within that window rather than at the next restart. The
delay matters in both directions: a freshly issued token is refused for a
moment, and a revoked one keeps working for the same moment. A brief store
failure keeps the last list, but after 60 seconds stored-token authentication
fails closed and `/health/ready` reports not ready. Environment break-glass
tokens remain available for recovery. Once a process has observed any token it
never falls back to authentication-disabled mode, even if the store becomes
empty or unavailable.

It is also the only way to start a deployment that is not on loopback, since
there is no loopback session to issue the first token from. Any container image
binds `0.0.0.0`, so a container always needs it:

Generate the required canonical 43-character base64url value with
`openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'`, then place it in the
JSON array as `{"token":"…","subject":"deploy","role":"admin"}`.

Anything else is refused before the server binds:

```
parallax: refusing to serve a non-loopback address with no access token.
Issue one from a loopback session, or set PARALLAX_AUTH_TOKENS.
```

### Signing in through an identity provider

Access tokens stay: the command line uses them, automation uses them, and
`PARALLAX_AUTH_TOKENS` is how a deployment that has locked itself out gets back
in. What this adds is a way for a person to sign in as themselves.

```sh
PARALLAX_OIDC_ISSUER=https://idp.example
PARALLAX_OIDC_CLIENT_ID=parallax
PARALLAX_OIDC_CLIENT_SECRET=…
PARALLAX_OIDC_REDIRECT_URI=https://parallax.example/auth/callback
PARALLAX_OIDC_SESSION_SECRET=…            # 32 bytes or more
PARALLAX_OIDC_SCOPES="openid profile email"   # optional
PARALLAX_OIDC_SESSION_SECONDS=43200           # optional, 60..604800
```

Setting some but not all of the required five is refused at startup. A partly
configured deployment meant to offer this, and starting anyway would leave a
sign-in button that fails only when somebody presses it.

**The role comes from the provider, not from here.** Parallax reads the
`entitlements` claim the provider returns for this client and takes the highest
of `admin`, `editor` and `viewer`. Keys it does not know are ignored. An account
the provider grants nothing to is refused -- authenticating proves who someone
is, not that they are anyone here, and a default would turn every account in the
directory into an account in this control plane.

⚠️ **`entitlements`, not `roles` or `groups`.** A provider that distinguishes
them means the distinction: `roles` says what a person *is* and is meant to be
displayed, `groups` says where they sit in the organization, and neither is a
grant. Reading either as permission turns a label into authority, and the label
is usually maintained by someone who does not know it is doing that.

So a person is granted access wherever the other services' access is granted.
With KeyStone that is a per-client entitlement, whose keys must be `admin`,
`editor` or `viewer` for Parallax to recognise them.

The client authenticates with `client_secret_post` -- the secret travels in the
token request body, not in an `Authorization` header -- so a provider that asks
how to authenticate this client must be told that.

The flow is Authorization Code with PKCE. `/auth/login` sends the browser to the
provider, `/auth/callback` finishes, `/auth/logout` ends both sessions. Nothing
it sets is readable by script, and the state and PKCE values live only for the
ten minutes a sign-in takes.

`PARALLAX_OIDC_SESSION_SECRET` signs the browser session. Unlike the other two
secrets, **rotating it is safe** -- it ends every session and nothing else. The
session is self-contained, which is also why it cannot be revoked before it
expires: shorten `PARALLAX_OIDC_SESSION_SECONDS` if that matters more than how
often people sign in.

### Ending TLS in the process

A deployment with no proxy in front of it can serve TLS itself. Point both
variables at a certificate and its key, and the main port speaks HTTPS:

```sh
PARALLAX_TLS_CERT_FILE=/etc/tls/tls.crt \
PARALLAX_TLS_KEY_FILE=/etc/tls/tls.key \
PARALLAX_HTTP_REDIRECT_PORT=80 \
HOST=0.0.0.0 PORT=443 parallax-server
```

Nothing else changes. The server knows it ended the connection, so the same
proof of same-origin that `publicOrigin` supplies behind a proxy is derived
without configuration, and cookies carry `Secure`. Before enabling the redirect
port, set `publicOrigin` to the public HTTPS origin. The redirect listener uses
only that trusted value and never reflects a request's `Host`; until a target is
configured, or whenever it is cleared, the redirect port answers `503`.

A certificate replaced on disk is picked up without a restart. The directory is
watched rather than the file, because a Kubernetes secret mount is renewed by
swapping a symlink; a half-written pair during rotation leaves the running
certificate in place and is retried. Without this a pod would present an expired
certificate until something happened to restart it.

Set neither variable and the server is plain HTTP, which is what local
development and a deployment behind a terminating proxy both want.

### Serving the portal behind a reverse proxy

Cookie-authenticated mutations must prove same-origin, which needs the origin a
browser actually used. Behind TLS termination, set `publicOrigin` to the public
HTTPS origin. Turn on `trustForwardedHeaders` only when a trusted proxy is the
sole route to the process; the setting is refused without `publicOrigin`, so a
forwarded Host or protocol can never choose the security origin.

Authentication is disabled only when `PARALLAX_AUTH_TOKENS` is absent, which is
intended for loopback development: every caller that reaches the port would
otherwise be an administrator. API requests that arrive with proxy forwarding
headers are refused while authentication is disabled, and the service logs a
warning at startup. Configure tokens before putting anything in front of it.
Each token is exactly 32 random bytes in canonical base64url form; use the
generation command above.
Repeated authentication failures are answered with `429` and a `Retry-After`
header. Budgets are isolated per trusted transport client, and a successful
request does not erase that client's failed guesses; valid tokens themselves
are never delayed.

The portal exchanges a token for a session cookie rather than holding it in
memory: `POST /api/v1/session` with `{ "token": "..." }` replies with
`HttpOnly; SameSite=Strict; Path=/` (and `Secure` when the request arrived over
HTTPS), and `DELETE /api/v1/session` clears it. Both require proof the request
came from this origin, so only the portal can obtain or drop a session. Because
the cookie is `HttpOnly`, page script never sees the credential. API clients can
keep using `Authorization: Bearer` and skip sessions entirely.

### Provider credentials

Cloudflare credentials are split so an account-wide token is entered once. A
**profile** holds the reusable account ID and API token; each **apex domain**
binds to a profile, and its Cloudflare zone ID is looked up from the domain
rather than typed. Rotating a token on
one profile immediately re-routes every domain that uses it, and a profile
cannot be deleted while a domain still points at it.

The admin portal's **Provider settings** screen manages both: one tab lists
saved profiles with the domains reusing them, the other binds apex domains to a
profile. Tokens are write-only -- they are encrypted at rest and never returned
to the portal, so the field is blank until you type a replacement.

Store files written before profiles existed are migrated on first read: each
distinct token becomes one profile, named after the first zone that used it, and
every zone keeps its own zone ID. Nothing has to be re-entered.

Each server re-reads the encrypted credential document every five seconds.
Profile rotation and zone unbinding therefore reach every replica without a
restart; a removed binding is also removed from that replica's provider router
instead of retaining a decrypted token in memory indefinitely.

The encrypted envelope carries an authenticated, increasing revision. A process
that has observed a newer revision rejects an older valid envelope, as well as
ordinary ciphertext tampering. A cold process has no external monotonic trust
anchor, however, so restoring the entire credential store to an older valid
ciphertext before that process starts cannot be distinguished cryptographically.
Deployments whose threat model includes privileged store rollback need that
anchor in their storage platform (for example immutable backup/audit controls),
not only the envelope key.

The token needs two zone permissions, scoped to the domains it manages:

| Permission | Why |
| --- | --- |
| `Zone` → `DNS` → `Edit` | every record read and write; this is the whole runtime surface |
| `Zone` → `Zone` → `Read` | resolving a domain to its zone ID, once, when a binding is created |

No account-level permission is needed. The zone ID is resolved at bind time and
stored, so applying never exercises the second permission -- a compromised
process can do no more with it than one without it.

Use a minimum-scope Cloudflare API token. When authentication is configured,
the portal asks for an access token and keeps it only in the current browser
tab's memory. Generate the credential-store key with `openssl rand -base64 32`.
The provider settings dialog and credential API are admin-only. API tokens are
write-only: list and metadata responses contain only zone, zone ID, and update
time.

Cloudflare [TTL](https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/)
uses the [API representation](https://developers.cloudflare.com/api/resources/dns/subresources/records/)
`1` for **Auto**. Proxied A, AAAA,
and CNAME records are always normalized to Auto because Cloudflare does not
allow their TTL to be edited. DNS-only records accept Auto or 60–86400 seconds.
Cloudflare Enterprise zones can support a 30-second minimum, but Parallax keeps
the non-Enterprise 60-second safety floor until provider plan capabilities are
configured explicitly.

CoreDNS output is an RFC 1035-style authoritative zone: Parallax adds SOA and
NS records when it creates a file, increments the 32-bit SOA serial for every
managed mutation, and atomically replaces the file with mode `0644` so a CoreDNS
process running as another user can read it. Configure CoreDNS with the `auto`
plugin or the `file` plugin's nonzero `reload` interval so it observes serial
changes. Existing non-Parallax records and authority data are retained; Parallax
only updates records carrying its signed ownership marker.

Set `PARALLAX_COREDNS_ROOT` to a deployment-owned directory before enabling the
stored `coreDnsDirectory` setting. The selected directory must stay beneath that
root both lexically and after resolving symlinks; the setting is rejected before
it is persisted when the boundary or writeability check fails.

Reading an existing zone file covers the common RFC 1035 forms: records that
inherit `$TTL`, records that inherit the previous owner name, an optional class
field, and parenthesized multi-line records. A record line Parallax cannot read
is an error rather than an absent record, because treating it as absent would let
reconciliation publish a second answer beside one it never saw.
`$ORIGIN` is tracked while parsing and new managed records are written with
absolute owner names. `$INCLUDE`, `$GENERATE`, unknown directives or record
types, duplicate ownership ids, and malformed multi-line spans all fail closed
before the file is written or CoreDNS is reloaded.

### Publishing the internal view

The internal view reaches clients three ways. Two of them publish it into a DNS
server that then answers for it; the third answers from this process directly.

| | `coreDnsDirectory` | `PARALLAX_POWERDNS_DATABASE_URL` | `PARALLAX_DNS_PORT` |
| --- | --- | --- | --- |
| Served as | RFC 1035 zone files | rows in PowerDNS's database | answers from this process |
| Needs | a filesystem both processes reach | nothing beyond the database | nothing |
| In a cluster | a volume that must survive restarts | no volume | no volume |
| Change is served after | `reload` interval, about a second | the resolver's cache TTL | at once, or one refresh (5s) for a change made elsewhere |
| Reconciles | yes | yes | no |

**The two publishers are exclusive; the listener is not.** Configuring
`coreDnsDirectory` and `PARALLAX_POWERDNS_DATABASE_URL` together is refused at
startup rather than resolved by a precedence rule nobody would remember when the
wrong one turned out to be serving. `PARALLAX_DNS_PORT` is a different kind of
thing and does not enter that rule: it publishes nothing, writes no ownership
marker, and compares nothing against a provider. It reads the desired state and
answers, which is why `apply` is not involved and why a change appears within
one refresh rather than after a reconcile. Running it beside a publisher is two
servers answering, and which one clients ask is the deployment's decision.

The listener is off unless `PARALLAX_DNS_PORT` names a port, and then it binds
`PARALLAX_DNS_HOST` -- or `HOST`, which is loopback unless a deployment said
otherwise. A resolver that starts answering the whole network because a port was
set is not a default anybody should have to discover.

The upstreams stay in the environment rather than the stored settings, with the
keys, and for the same reason: everything this process is not authoritative for
is relayed to them, so whoever can change them can silently answer for every
name in the network that is not in a managed zone. That is not a tuning knob.

Two things are worth knowing before pointing anything at it:

**A zone whose internal view is empty is left out, not answered for.** That is
the normal state right after [adopting](#adopting-records-that-already-exist) a
zone, and claiming authority for it would answer NXDOMAIN for every name the
zone holds. Left out, those names go to the upstreams and keep resolving
publicly until an override exists.

**The listener follows changes made by another process.** File-backed reads do
not retain a process-lifetime snapshot: mutations take a cross-process lock,
re-read under that lock, and atomically replace the durable file. The listener's
five-second refresh therefore observes CLI writes without a restart. PostgreSQL
instances likewise read the shared rows.

A process killed during a file mutation can leave its hidden lock file behind.
Parallax deliberately never removes a pre-existing lock automatically: doing so
cannot be made race-free with a replacement writer. After the 15-second timeout,
the error names the lock. Verify that no Parallax process is writing that data
file, then remove only the named stale lock manually.

Forwarding is limited to client CIDRs in `PARALLAX_DNS_FORWARD_ALLOW` (loopback
only by default); a non-loopback listener with upstreams refuses to start until
the allow-list is explicit. UDP and TCP replies are rate-limited per source
(100/s with a burst of 200), concurrent upstream queries are capped at 256, and
TCP uses a 10-second idle timeout with at most 1,024 connections. Upstream UDP
sockets are connected, and a reply is accepted only when its source, QR/opcode,
transaction id, and complete question match the query.

A change committed by this process is served as soon as it commits, because the
repository the control plane writes through says so. The 5-second refresh stays
for everything that cannot announce itself: a second instance sharing a
database, or the command line writing to the same file.

**Wildcards are expanded, not taken literally.** A record named `*` or `*.eu`
answers for the names below it, the closest one wins, and neither answers over a
name that exists. That is what a zone file, PowerDNS and Cloudflare all do with
the same desired state, and a listener that disagreed would resolve a name
differently depending on which publisher a deployment happened to use.

**Readiness counts the listener as serving the internal view.** A deployment
that answers DNS itself and configures no provider at all is ready. Without
that, its probe would never pass while it answered every query correctly.
The public readiness route reads only a constant-size process cache; the full
zone scan runs at most once at a time in the background. Zone or provider-route
changes invalidate it immediately, and a failed or ten-second-stale refresh is
not ready.

The zone-file shape needs persistent storage and not an ephemeral volume,
because a zone file also holds records nobody else has a copy of -- the ones an
operator maintains by hand. Losing it loses those.

PowerDNS has no per-record field to mark ownership with, so Parallax adds one
table to PowerDNS's own database:

```sh
parallax migrate --target powerdns
```

It lives there, not in Parallax's database, because ownership has to be
answerable from the provider alone -- the same property a Cloudflare comment or
a zone-file comment gives. A record deleted directly in PowerDNS takes its
marker with it, so the table can never claim a row that is no longer there.

Either way the zone must already exist in the DNS engine: PowerDNS serves what
its `domains` table lists, and Parallax publishes records into a zone rather
than creating one.

The direct-SQL adapter refuses mutations when PowerDNS reports an active DNSSEC
key. `ordername` depends on the zone's NSEC/NSEC3 mode and must be calculated by
PowerDNS rectification; guessing it in SQL would corrupt denial proofs. Keep the
published zone unsigned, or use a future API/rectify-capable adapter for signed
zones.

Two things about running PowerDNS are worth knowing before the first zone,
because both look like Parallax failing when they are not:

**PowerDNS caches the list of zones for `zone-cache-refresh-interval` seconds,
300 by default.** A zone added while it is running is answered with `REFUSED`
until that expires -- `apply` reports `applied`, the rows are in the database,
and the name does not resolve. Parallax adds records to zones an operator
creates whenever they like, so set the interval to `0` for this use. Measured:
with the default a zone added after startup is `REFUSED`; with `0` the same
zone resolves at once.

**It writes a control socket at startup**, so `readOnlyRootFilesystem: true`
needs a writable `/var/run/pdns`. An ephemeral volume is right -- a control
socket has no reason to survive a restart.

### Pointing a resolver at the internal view

Whatever answers the internal view is authoritative for the zone, so it replies
NXDOMAIN for a name it does not hold -- an answer, not a failure, which a
forwarder accepts and does not fall back from. That is why the internal view has
to be complete before anything is pointed at it, and why [adoption](#adopting-records-that-already-exist)
exists.

**A publisher is not the resolver clients should be given.** CoreDNS and
PowerDNS serving the internal view answer for that zone and refuse everything
else -- `REFUSED` to `google.com` is the server saying the question is not its to
answer, which is correct and is not a fault. Clients point at a forwarder, and
the forwarder sends the one zone here and the rest upstream:

```
client → forwarder ──(example.com)──→ the internal view
                   └─(everything else)──→ a recursive resolver
```

Handing clients that address directly leaves them with one zone and no internet.

**The built-in listener is the exception, and only with upstreams set.** It is
both halves at once: authoritative for the managed zones, and a relay for
everything else, which is what `PARALLAX_DNS_FORWARD_TO` configures.

```
client → PARALLAX_DNS_PORT ──(example.com)──→ answered from the desired state
                           └─(everything else)──→ PARALLAX_DNS_FORWARD_TO
```

Both halves in one listener is the point. Split across two, something in front
has to know which names are whose, and that knowledge then lives in a list on
every resolver, maintained by hand, going stale the moment a zone is added. Here
the list is the desired state. Without upstreams the listener refuses everything
it is not authoritative for, and then it is a publisher's equal and belongs
behind a forwarder like one.

Two more things sit in front of it and answer first, and both look like Parallax
serving the wrong value:

**A forwarder may answer from `/etc/hosts` before it asks anything.** dnsmasq
reads it by default, so a host whose own name is inside the zone answers itself
as `127.0.0.1` no matter what the internal view says. `no-hosts` turns that off.
Reported from a deployment where the gateway running dnsmasq was itself named
inside the zone it was forwarding.

**The resolver has to be reachable before clients are told to use it.** Handing
out a resolver address by DHCP while a firewall still drops port 53 takes DNS
away from every client that renews, and they have no way back. Open the port
first, confirm a query from a client, and change the DHCP option after.

### Reading the history

Every audit entry carries `added`, `removed` and `changed`: how many records
that revision brought into the desired state, took out of it, and rewrote under
the same id. They are what separates a revision that emptied a zone from any
other line in the list, which otherwise differ only by an actor and a time.

The counts are worked out from the snapshots the entry already holds rather than
recorded next to them, so entries written before the counts existed report them
too. That is usually the history someone is reading: nobody asks what a revision
did until after it has happened.

The actor is the token's subject, so what the history can tell you about *who*
depends on how many tokens exist. See [Access tokens](#access-tokens).

Provider writes have their own write-ahead audit entries:
`provider.apply.started`, `provider.apply.completed`, and
`provider.apply.failed`. They record the target view and planned/completed
operation counts, including partial apply or zone-purge progress. Provider
errors are reduced to a safe category before persistence, so tokens or other
provider response details do not enter the audit trail.

### Restoring a revision

Restoring does not undo the past. It makes that revision's intent the current
desired state, and the next `apply` carries it out. Whether a restore is safe
therefore does not turn on how old it is, but on whether what it says should
happen now: a snapshot holding a record that was a demonstration at the time
will be published for real the next time the view is applied.

Read the snapshot before restoring it, and prefer the newest revision that says
only what you still mean.

### Retention

Every desired-state change stores an immutable snapshot and an audit entry, so
history grows with use. The `revisionRetention` setting keeps the newest
snapshots per zone and `auditRetentionDays` ages out audit entries; both are
enforced inside the same atomic commit as the change that triggered them, and
`0` disables the bound. Restoring a revision that has aged out returns 404, so
size the revision bound to the rollback window you actually need.

For a PostgreSQL deployment, apply the schema before starting the service:

```sh
parallax migrate
```

It accepts only the release's fixed migration manifest and records every
applied file with its SHA-256 checksum in `parallax_schema_migrations`. Missing,
unexpected, or subsequently changed SQL is rejected before execution; a re-run
skips matching ledger entries. Each schema change and its ledger row commit in
the same transaction. Concurrent runs serialize on a migration-specific advisory
lock, which is what makes the command usable as a Kubernetes init container or a
pre-deploy job. The image keeps the trusted migration directory root-owned and
non-writable by the serving UID.

It is never applied implicitly at startup, and the serving runtime does not
expose it through `POST /api/v1/cli`. A server that reshaped the store it depends
on while booting would carry the schema forward under an image that had just
been rolled back; instead it refuses to start and names the missing relation.
Migrating is a deployment decision, so it is available only to the local CLI's
separate migration runtime.

## One surface, three ways in

Every operation is defined once, as a command. Nothing else holds behaviour:

```
portal (GUI)  ──HTTP──▶  API  ──▶  command layer  ──▶  control plane
terminal (CLI) ─────────────────▶  command layer  ──▶  control plane
```

The portal talks only to the API and reaches nothing else. Each API route is a
translation: it turns a request into one command invocation and that command's
result into a response. `parallax` parses argv into the same invocation. Because
the API cannot do anything the command layer does not expose, and the CLI runs
the very same commands, the two can never drift apart.

`POST /api/v1/cli` takes the command line itself:

```sh
curl -X POST http://127.0.0.1:3000/api/v1/cli \
  -H 'content-type: application/json' \
  -d '{"argv":["zone","create","--zone","example.com"]}'
```

It runs the serving dispatcher's commands in-process -- no shell, no subprocess
-- and applies the caller's role to the command it names, so the endpoint is not
a way around what a token cannot already do. `migrate` is deliberately absent:
database DDL is a local CLI/deployment capability, not an HTTP administrator
capability.

## Command line

```sh
pnpm cli help                 # every command
pnpm cli help record set      # one command's options
pnpm cli migrate                # apply the schema; safe to re-run
pnpm cli zone list
pnpm cli zone create --zone example.com
pnpm cli record set --zone example.com --view external --id www \
  --record '{"name":"www","type":"A","content":"93.184.216.34","ttl":300}'
pnpm cli zone adopt --zone example.com --view external
pnpm cli preview --zone example.com
pnpm cli apply --zone example.com
pnpm cli settings set --values '{"allowLocalProvider":true}'
pnpm cli token issue --subject deploy-bot --role editor
```

If a machine-specific stored value prevents the server from starting, serving
remains fail-closed, but the local `settings set` command is still available as
a recovery path. It initializes only the settings repository, merges the patch
with the latest stored values, and verifies the complete repaired snapshot
before writing; it does not start providers, tokens, or the control plane. For
example, clear a CoreDNS path that belongs to another machine with
`pnpm cli settings set --values '{"coreDnsDirectory":""}'`. A patch that leaves
any stored invariant invalid is rejected and writes nothing.

The CLI reads the same store as the server, so a change made in one is visible
in the other immediately. It records who ran it (`cli:<user>`) in the audit
trail. Add `--json` for machine-readable output. Exit codes follow `sysexits`:
`64` usage, `65` invalid input, `69` not found, `70` conflict, `77` permission,
`78` unavailable.

Because the command line reaches the store directly it acts with full rights;
HTTP callers are limited to what their token's role allows.

## Record types

`content` holds the record's RDATA in presentation format -- the same text a
zone file puts after the type:

```
MX     10 mail.example.com
SRV    10 5 5060 sip.example.com
CAA    0 issue "letsencrypt.org"
HTTPS  1 . alpn=h2,h3
TXT    v=spf1 -all
```

Each type's grammar is checked when the record is saved, not when it is applied:
a record that a provider would reject is one an operator saved, walked away
from, and finds broken later, possibly against a zone that is already half
published.

Every type in that list can also be put on the wire by the [built-in
listener](#publishing-the-internal-view), and the compiler is what requires it:
the encoder is a table over the same list the domain validates against, so a
type added to one and not the other does not build. A record that validates,
publishes, and then cannot be answered for is the failure that guards against.
If a stored record still cannot be encoded, the whole RRset is answered
SERVFAIL and the reason is logged -- never a partial RRset, which looks complete,
gets cached, and silently loses whatever went missing.

Two things are handled by the adapters rather than written into the content.
Cloudflare keeps the leading number of `MX`, `SRV` and `URI` in a field of its
own, and a zone file needs hostnames made absolute -- an `MX` target written as
`mail.example.com` in `example.com`'s file otherwise resolves to
`mail.example.com.example.com`. Both are put back the way they were written when
the record is read again, so neither shows up as drift.

`SOA` and the DNSSEC records are not managed. They describe the zone's authority
rather than its contents, every provider generates and signs them itself, and
publishing our own would overwrite the provider's answer to a question we did
not ask. An apex `NS` record is also not inherited by the internal view: it
names the servers that answer for the zone, which is a fact about each provider,
and copying it inward would delegate the internal view away from itself.

## Adopting records that already exist

A zone usually has a history before Parallax arrives. Records made by hand at the
provider are not in the desired state, so Parallax treats them as somebody else's:
it will not touch them, and it cannot derive anything from them.

That is a problem for the internal view, which is materialized from the external
desired state. Whatever the desired state does not describe, the internal view
does not answer for -- and an authoritative server does not say "I don't know",
it says NXDOMAIN. A resolver takes that as an answer and stops. So an internal
view of a zone that has other records has to be complete before it is wired up.

`zone adopt` reads what the provider currently holds and writes it into the
desired state:

```sh
pnpm cli zone adopt --zone example.com --view external
# seen: what the provider listed. adopted: what is newly described.
pnpm cli preview --zone example.com --view external   # expect no operations
```

The internal view is derived when it is reconciled, not stored, so `zone get`
shows only the records adoption wrote to the external view. An internal view
that reports no records is the normal state, not a failed adoption.

Read `seen` before reading the preview. A preview with no operations means the
desired state and the provider agree -- which is also true when the desired
state is empty, so on its own it does not tell you that adoption put anything
there. `seen` above zero with nothing adopted means the view was already
complete. `seen` of zero means the provider offered nothing this control plane
could read, which is the type limit below rather than an empty zone.

**Adopting does not take the records over.** A desired record identical to an
unmanaged one produces no operation, so the provider's copies stay exactly as
they are, unmanaged, and whoever maintained them still does. What changes is
that Parallax now knows they exist. If one of them later changes at the
provider, the difference appears as a conflict in `preview` -- naming both
values -- rather than being silently overwritten in either direction.

Re-running it is safe: records already described are skipped, so a second run
adopts nothing and does not create a revision. Run it again whenever records
are added at the provider by hand.

Two limits worth knowing before you rely on it:

- A provider may hold types Parallax does not manage -- `SOA` and the DNSSEC
  records, which every provider generates for itself. Those are skipped rather
  than adopted. Compare `seen` against the provider's own record count to see
  how many that is.
- Adoption commits the view in one step, so a record that cannot be described
  stops all of them and nothing is written. The error names the record.
- A record that differs from the desired state by TTL alone is left as the
  conflict it already was. Adoption describes what is there; it does not settle
  disagreements.

## HTTP API

All control-plane routes are under `/api/v1`.

- `GET|POST /zones` (`GET ?limit=&offset=`, `POST { "name": "example.com" }`)
- `GET|PUT|DELETE /zones/:zone` (`DELETE ?abandonProviderRecords=true`)
- `POST /zones/:zone/adopt?view=external`
- `PUT|DELETE /zones/:zone/views/:view/records/:id`
- `GET|POST /zones/:zone/preview`
- `POST /zones/:zone/apply`
- `GET /zones/:zone/status`
- `GET /zones/:zone/history` (`?limit=&offset=`, newest first)
- `GET /zones/:zone/revisions` (`?limit=&offset=`, newest window, ascending)
- `GET /zones/:zone/revisions/:revision`
- `POST /zones/:zone/revisions/:revision/restore`
- `GET /credentials/profiles`
- `GET|PUT|DELETE /credentials/profiles/:name`
- `POST /credentials/profiles/:name/test` (needs a `{ zone }` to read through)
- `GET /credentials/cloudflare`
- `GET|PUT|DELETE /credentials/cloudflare/:zone`
- `POST /credentials/cloudflare/:zone/test` (tests the stored binding, or an unsaved `{ profile }` or `{ token }`)
- `POST /cli` (runs serving commands, never `migrate`; `{ "argv": ["zone", "list"] }`)
- `GET /health/live` and `GET /health/ready`

Supply `Authorization: Bearer <token>` when authentication is enabled. Desired
state is stored before provider changes; preview never mutates a provider, and
apply reports each view independently. Preview queries the live provider on every
call, so it requires an editor or administrator token even though it changes
nothing. A view whose provider cannot be read reports why instead of failing
the whole preview, and carries that reason beside an empty plan so it is never
read as nothing to do; when no view can be read at all, the request fails. Zone,
history, and revision listings are paged: each accepts `limit` (up to 500,
default 50) and `offset`, and returns `limit`, `offset`, and `hasMore` alongside
the items.

The only reconcilable views are `internal` and `external`; any other view name is
rejected at write time so a zone can never hold desired state no provider can
apply.

Deleting a zone withdraws every record Parallax published for it before removing
the desired state, and responds with `removedProviderRecords` describing exactly
what was taken out of the provider. Records without Parallax's ownership marker
are never touched. Withdrawal happens first: if the provider rejects it or is
unreachable the zone is kept so the deletion can be retried, rather than leaving
published records nothing tracks. Pass `?abandonProviderRecords=true` only when
one or more provider targets may be gone for good. Parallax still reads every
target first and withdraws all reachable records; only targets that cannot be
read are left live and returned explicitly as `abandonedProviderTargets`.

## Container image

The `Dockerfile` at the repository root builds a runtime image that carries all
three surfaces: the API, the portal, and the command line.

```sh
docker build -t parallax .
docker run -p 3000:3000 \
  -e DATABASE_URL='postgres://parallax:password@db:5432/parallax?sslmode=verify-full' \
  -e PARALLAX_OWNERSHIP_SECRET='...' \
  -e PARALLAX_CREDENTIAL_MASTER_KEY='...' \
  -e PARALLAX_AUTH_TOKENS='[{"token":"<43-character-base64url-token>","subject":"deploy","role":"admin"}]' \
  parallax
```

The image binds `0.0.0.0`, so `PARALLAX_AUTH_TOKENS` is required -- see
[Access tokens](#access-tokens) for the shape and why.

Apply the schema before the server starts, with the same image:

```sh
docker run --rm \
  -e DATABASE_URL='postgres://parallax:password@db:5432/parallax?sslmode=verify-full' \
  parallax parallax migrate
```

As a Kubernetes init container that is `command: ["parallax", "migrate"]`. It
exits non-zero when it cannot reach or apply, so the pod does not go on to start
a server against a schema that is not there.

`parallax` is on the PATH inside the image, so every operation stays available
without a token or a network round trip:

```sh
docker exec <container> parallax zone list
```

It runs as UID 10001 and the application directory is not writable. Runtime
dependencies are installed separately from the build, so the toolchain that
compiles the sources is not in the final image.

With `DATABASE_URL` set the image needs no writable filesystem at all: it has
been verified serving the portal, accepting API writes and running the CLI on a
fully read-only root with nothing mounted. Without a database the file backend
is used and its files live in `/var/lib/parallax`, which is then the path to
mount. An ephemeral volume is enough -- nothing written there is authoritative
while PostgreSQL is the store.

## Verifying against real dependencies

Unit and HTTP tests use in-memory fakes. These scripts exercise the real thing:

```sh
pnpm verify:postgres    # Docker PostgreSQL: migration, restart, locks, retention
pnpm verify:coredns     # Docker CoreDNS + dig: zone load, SOA reload, conflicts
pnpm verify:powerdns    # Docker PowerDNS + PostgreSQL + dig: publish, conflict, withdraw
pnpm verify:proxy       # Docker nginx over TLS: origin, cookies, HSTS, readiness
pnpm verify:dns         # dig against the built-in listener: every type, TC, relay
pnpm verify:cloudflare  # opt-in; needs a real scoped token, skips without one
pnpm audit              # dependency advisories
```

`verify:dns` needs neither Docker nor a network: the listener is in-process and
the upstream it relays to is a stub, which is also what lets it prove the relay
returned exactly what the upstream said. Its centre is that all twenty record
types are asked for and rendered by `dig` -- an independent reader of the same
bytes, which reports a malformed record instead of printing one. Types are asked
for by number, because a `dig` that does not know a type's name quietly asks for
`A` instead and answers nothing, which reads as the listener having no record.
It also covers what only a running listener can show: truncation over UDP
completing over TCP, a TCP query relayed to the upstream over TCP rather than
downgraded, wildcard synthesis, a change served before the refresh timer could
have run, and readiness passing with no provider configured at all.

`verify:proxy` covers the one shape unit tests cannot stand in for: the server
sees plain HTTP on loopback while the browser sees HTTPS. It first reproduces
the misconfigured case, where the `https` Origin is refused, so the checks that
follow cannot pass vacuously; then it proves `trustForwardedHeaders` and
`publicOrigin` each repair it, and that a cross-site Origin is still refused.

`verify:postgres`, `verify:coredns`, `verify:powerdns`, and `verify:proxy` need
Docker and remove their containers on exit.

A passing run is evidence about the commit it ran on and nothing else. The
Cloudflare one first passed at `ef61201`, against a live zone, and the three
runs before it each found a defect that the previous one had been hiding --
including an ownership marker that exceeded Cloudflare's comment limit, so no
record could be published to any zone with a name of more than about eleven
characters. None of that is visible locally: a stubbed provider accepts
whatever it is sent. `verify:cloudflare` writes to a live zone, so it refuses to run unless
`CF_ZONE`, `CF_ZONE_ID`, `CF_API_TOKEN`, and `CF_VERIFY_ALLOW_WRITES=true` are
all set; it confines itself to a `parallax-verify-*` name and asserts that
records Parallax does not own are never scheduled for deletion.

## Development workflow

The project uses Node's stable built-in test runner. Keep changes in the TDD
cycle: add one failing behavior test, implement the smallest domain behavior,
then run the whole suite and refactor.

```sh
pnpm test
pnpm test:watch
pnpm test:coverage
pnpm check
pnpm build
```
