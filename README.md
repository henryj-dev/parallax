# Parallax

English | [한국어](README.ko.md)

Parallax is a split-horizon DNS control plane and operations portal. It keeps
one desired state for internal DNS and external Cloudflare DNS, previews the
resulting changes, and applies only records explicitly managed by Parallax.

## Included features

- Browser portal for zones, internal/external records, preview, apply, status,
  audit history, immutable revisions, restore, and zone deletion
- A, AAAA, CNAME, and TXT validation with Cloudflare proxy constraints,
  including RFC 8552 underscored names such as `_dmarc` and `_acme-challenge`
- Deterministic `managed-only` reconciliation that leaves foreign records alone
- Durable single-node JSON state and provider state with atomic writes
- Optional PostgreSQL source of truth with transactional immutable revisions
- Optional Cloudflare API and CoreDNS RFC 1035 zone-file adapters
- Encrypted, write-only Cloudflare credential management from the admin portal
- Optional admin/editor/viewer token authentication and audit actors
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
| `DATABASE_URL` | PostgreSQL source of truth; apply `migrations/*.sql` in order. Append `?sslmode=verify-full` for TLS |
| `PARALLAX_STATE_FILE` | Zones, revisions, statuses and audit, when no database is configured |
| `PARALLAX_CONFIG_FILE` | Settings, credentials and access tokens, when no database is configured |
| `PARALLAX_PROVIDER_STATE_FILE` | Local provider state, used only while the local provider is enabled |
| `PARALLAX_OWNERSHIP_SECRET` | 32+ byte secret that signs managed-record ownership markers |
| `PARALLAX_CREDENTIAL_MASTER_KEY` | Exactly 32 bytes as base64 or 64 hexadecimal characters; encrypts stored credentials |
| `PARALLAX_TLS_CERT_FILE`, `PARALLAX_TLS_KEY_FILE` | Certificate and key for this process to end TLS itself; set both or neither |
| `PARALLAX_HTTP_REDIRECT_PORT` | Port answering plain HTTP with a redirect to the TLS origin; needs TLS configured |
| `PARALLAX_AUTH_TOKENS` | JSON array of `{"token","subject","role"}`; `role` is `admin`, `editor` or `viewer`, and each token is at least 32 bytes. Optional on loopback, **required to bind any other address** |

Everything else -- provider wiring, retention, proxy origin, access tokens and
provider credentials -- is stored alongside the zones and managed from the
portal's **Provider settings** screen. A change takes effect immediately across
the process; nothing needs a redeploy, and with PostgreSQL every instance reads
the same value.

| Setting | Effect |
| --- | --- |
| `allowLocalProvider` | Publish to a local file when no real provider is configured. Off by default, so an unrouted target fails loudly instead of reporting success |
| `coreDnsDirectory` | Directory of RFC 1035 zone files for the internal view; empty disables it |
| `publicOrigin` | Absolute origin browsers reach the portal at; empty derives it per request |
| `trustForwardedHeaders` | Trust `X-Forwarded-Proto`/`X-Forwarded-Host` from a reverse proxy |
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

It is also the only way to start a deployment that is not on loopback, since
there is no loopback session to issue the first token from. Any container image
binds `0.0.0.0`, so a container always needs it:

```json
[{"token": "<32+ bytes>", "subject": "deploy", "role": "admin"}]
```

Anything else is refused before the server binds:

```
parallax: refusing to serve a non-loopback address with no access token.
Issue one from a loopback session, or set PARALLAX_AUTH_TOKENS.
```

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
without configuration, and cookies carry `Secure`. Setting `publicOrigin` is
still worthwhile when the hostname is fixed, because it is what the redirect
listener sends clients to.

A certificate replaced on disk is picked up without a restart. The directory is
watched rather than the file, because a Kubernetes secret mount is renewed by
swapping a symlink; a half-written pair during rotation leaves the running
certificate in place and is retried. Without this a pod would present an expired
certificate until something happened to restart it.

Set neither variable and the server is plain HTTP, which is what local
development and a deployment behind a terminating proxy both want.

### Serving the portal behind a reverse proxy

Cookie-authenticated mutations must prove same-origin, which needs the origin a
browser actually used. Behind TLS termination, set the `publicOrigin` setting
to the public origin, or turn on `trustForwardedHeaders` when the proxy is the
only way to reach this process. Without either, a proxied `https` request is
rejected because the server would compare it against `http`.

Authentication is disabled only when `PARALLAX_AUTH_TOKENS` is absent, which is
intended for loopback development: every caller that reaches the port would
otherwise be an administrator. API requests that arrive with proxy forwarding
headers are refused while authentication is disabled, and the service logs a
warning at startup. Configure tokens before putting anything in front of it.
Each token needs at least 32 bytes; generate one with `openssl rand -base64 32`.
Repeated authentication failures are answered with `429` and a `Retry-After`
header, and a valid token is never delayed by another client's failures.

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
binds to a profile plus the zone ID Cloudflare assigned it. Rotating a token on
one profile immediately re-routes every domain that uses it, and a profile
cannot be deleted while a domain still points at it.

The admin portal's **Provider settings** screen manages both: one tab lists
saved profiles with the domains reusing them, the other binds apex domains to a
profile. Tokens are write-only -- they are encrypted at rest and never returned
to the portal, so the field is blank until you type a replacement.

Store files written before profiles existed are migrated on first read: each
distinct token becomes one profile, named after the first zone that used it, and
every zone keeps its own zone ID. Nothing has to be re-entered.

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

Reading an existing zone file covers the common RFC 1035 forms: records that
inherit `$TTL`, records that inherit the previous owner name, an optional class
field, and parenthesized multi-line records. A record line Parallax cannot read
is an error rather than an absent record, because treating it as absent would let
reconciliation publish a second answer beside one it never saw.

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

It replays every file in `migrations/` in name order and is safe to re-run:
each object is created with `IF NOT EXISTS` and each file carries its own
transaction, so there is no version table deciding what to skip. Concurrent
runs serialize on an advisory lock, which is what makes it usable as a
Kubernetes init container or a pre-deploy job.

It is never applied implicitly at startup. A server that reshaped the store it
depends on while booting would carry the schema forward under an image that had
just been rolled back; instead it refuses to start and names the missing
relation. Migrating is a decision, so it is a command someone runs.

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

It runs the same dispatcher in-process -- no shell, no subprocess -- and applies
the caller's role to the command it names, so the endpoint is not a way around
what a token cannot already do.

## Command line

```sh
pnpm cli help                 # every command
pnpm cli help record set      # one command's options
pnpm cli migrate                # apply the schema; safe to re-run
pnpm cli zone list
pnpm cli zone create --zone example.com
pnpm cli record set --zone example.com --view external --id www \
  --record '{"name":"www","type":"A","content":"93.184.216.34","ttl":300}'
pnpm cli preview --zone example.com
pnpm cli apply --zone example.com
pnpm cli settings set --values '{"allowLocalProvider":true}'
pnpm cli token issue --subject deploy-bot --role editor
```

The CLI reads the same store as the server, so a change made in one is visible
in the other immediately. It records who ran it (`cli:<user>`) in the audit
trail. Add `--json` for machine-readable output. Exit codes follow `sysexits`:
`64` usage, `65` invalid input, `69` not found, `70` conflict, `77` permission,
`78` unavailable.

Because the command line reaches the store directly it acts with full rights;
HTTP callers are limited to what their token's role allows.

## HTTP API

All control-plane routes are under `/api/v1`.

- `GET|POST /zones` (`{ "name": "example.com" }`)
- `GET|PUT|DELETE /zones/:zone` (`DELETE ?abandonProviderRecords=true`)
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
- `POST /credentials/profiles/:name/test` (needs a `{ zoneId }` to read through)
- `GET /credentials/cloudflare`
- `GET|PUT|DELETE /credentials/cloudflare/:zone`
- `POST /credentials/cloudflare/:zone/test` (optionally tests an unsaved `{ zoneId, token }`)
- `POST /cli` (runs any command; `{ "argv": ["zone", "list"] }`)
- `GET /health/live` and `GET /health/ready`

Supply `Authorization: Bearer <token>` when authentication is enabled. Desired
state is stored before provider changes; preview never mutates a provider, and
apply reports each view independently. Preview queries the live provider on every
call, so it requires an editor or administrator token even though it changes
nothing. History and revision listings are paged: both accept `limit` (up to 500,
default 50) and `offset`, and return `limit`, `offset`, and `hasMore` alongside
the items.

The only reconcilable views are `internal` and `external`; any other view name is
rejected at write time so a zone can never hold desired state no provider can
apply.

Deleting a zone withdraws every record Parallax published for it before removing
the desired state, and responds with `removedProviderRecords` describing exactly
what was taken out of the provider. Records without Parallax's ownership marker
are never touched. Withdrawal happens first: if the provider rejects it or is
unreachable the zone is kept so the deletion can be retried, rather than leaving
published records nothing tracks. Pass `?abandonProviderRecords=true` to skip
withdrawal deliberately — that is only for a provider that is gone for good, and
it leaves those records live.

## Container image

The `Dockerfile` at the repository root builds a runtime image that carries all
three surfaces: the API, the portal, and the command line.

```sh
docker build -t parallax .
docker run -p 3000:3000 \
  -e DATABASE_URL='postgres://...' \
  -e PARALLAX_OWNERSHIP_SECRET='...' \
  -e PARALLAX_CREDENTIAL_MASTER_KEY='...' \
  -e PARALLAX_AUTH_TOKENS='[{"token":"...","subject":"deploy","role":"admin"}]' \
  parallax
```

The image binds `0.0.0.0`, so `PARALLAX_AUTH_TOKENS` is required -- see
[Access tokens](#access-tokens) for the shape and why.

Apply the schema before the server starts, with the same image:

```sh
docker run --rm -e DATABASE_URL='postgres://...' parallax parallax migrate
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
pnpm verify:proxy       # Docker nginx over TLS: origin, cookies, HSTS, readiness
pnpm verify:cloudflare  # opt-in; needs a real scoped token, skips without one
pnpm audit              # dependency advisories
```

`verify:proxy` covers the one shape unit tests cannot stand in for: the server
sees plain HTTP on loopback while the browser sees HTTPS. It first reproduces
the misconfigured case, where the `https` Origin is refused, so the checks that
follow cannot pass vacuously; then it proves `trustForwardedHeaders` and
`publicOrigin` each repair it, and that a cross-site Origin is still refused.

`verify:postgres`, `verify:coredns`, and `verify:proxy` need Docker and remove
their containers on exit. `verify:cloudflare` writes to a live zone, so it refuses to run unless
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
