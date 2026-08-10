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

Copy `.env.example` to `.env` and adjust its values. The `dev` and `start`
scripts automatically load `.env` when it exists; shell environment variables
still take precedence. If the file is absent, the service uses its normal
defaults.

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | Server bind address; defaults to `127.0.0.1:3000` |
| `PARALLAX_STATE_FILE` | Durable zones, revisions, statuses, and audit file |
| `PARALLAX_PROVIDER_STATE_FILE` | Durable local provider state used as fallback |
| `PARALLAX_ALLOW_LOCAL_PROVIDER` | Simulated provider; defaults on only for loopback development with no provider configured |
| `PARALLAX_PUBLIC_ORIGIN` | Absolute origin browsers reach the portal at; required behind TLS termination |
| `PARALLAX_TRUST_FORWARDED_HEADERS` | Trust `X-Forwarded-Proto`/`X-Forwarded-Host` from a reverse proxy |
| `DATABASE_URL` | Optional PostgreSQL source of truth; apply `migrations/001_initial.sql` first. Append `?sslmode=verify-full` for TLS |
| `PARALLAX_REVISION_RETENTION` | Newest revision snapshots kept per zone; `0` keeps every one. Defaults to 100 |
| `PARALLAX_AUDIT_RETENTION_DAYS` | Days of audit history kept per zone; `0` keeps every entry. Defaults to 365 |
| `PARALLAX_COREDNS_DIRECTORY` | Optional directory for atomically generated zone files |
| `PARALLAX_OWNERSHIP_SECRET` | 32+ byte secret that signs managed-record ownership markers |
| `PARALLAX_CLOUDFLARE_ZONES` | Optional JSON map of zone names to Cloudflare zone IDs and API tokens |
| `PARALLAX_CREDENTIAL_FILE` | Optional encrypted Cloudflare credential file; configure with the master key |
| `PARALLAX_CREDENTIAL_MASTER_KEY` | Exact 32-byte master key encoded as base64 or 64 hexadecimal characters |
| `PARALLAX_AUTH_TOKENS` | Optional JSON array of admin/editor/viewer access tokens, each at least 32 bytes |

### Serving the portal behind a reverse proxy

Cookie-authenticated mutations must prove same-origin, which needs the origin a
browser actually used. Behind TLS termination, set `PARALLAX_PUBLIC_ORIGIN` to
the public origin, or set `PARALLAX_TRUST_FORWARDED_HEADERS=true` when the proxy
is the only way to reach this process. Without either, a proxied `https` request
is rejected because the server would compare it against `http`.

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
time. Encrypted credentials override `PARALLAX_CLOUDFLARE_ZONES` for the same
zone; deleting one restores the environment-configured adapter when present.

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
history grows with use. `PARALLAX_REVISION_RETENTION` keeps the newest snapshots
per zone and `PARALLAX_AUDIT_RETENTION_DAYS` ages out audit entries; both are
enforced inside the same atomic commit as the change that triggered them, and
`0` disables the bound. Restoring a revision that has aged out returns 404, so
size the revision bound to the rollback window you actually need.

For a PostgreSQL deployment, apply the schema before starting the service:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_initial.sql
```

## HTTP API

All control-plane routes are under `/api/v1`.

- `GET|POST /zones`
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

## Verifying against real dependencies

Unit and HTTP tests use in-memory fakes. These scripts exercise the real thing:

```sh
pnpm verify:postgres    # Docker PostgreSQL: migration, restart, locks, retention
pnpm verify:coredns     # Docker CoreDNS + dig: zone load, SOA reload, conflicts
pnpm verify:cloudflare  # opt-in; needs a real scoped token, skips without one
pnpm audit              # dependency advisories
```

`verify:postgres` and `verify:coredns` need Docker and remove their containers
on exit. `verify:cloudflare` writes to a live zone, so it refuses to run unless
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
