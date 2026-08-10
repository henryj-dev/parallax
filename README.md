# Parallax

English | [한국어](README.ko.md)

Parallax is a split-horizon DNS control plane and operations portal. It keeps
one desired state for internal DNS and external Cloudflare DNS, previews the
resulting changes, and applies only records explicitly managed by Parallax.

## Included features

- Browser portal for zones, internal/external records, preview, apply, status,
  audit history, immutable revisions, restore, and zone deletion
- A, AAAA, CNAME, and TXT validation with Cloudflare proxy constraints
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
| `PARALLAX_ALLOW_LOCAL_PROVIDER` | Simulated provider; defaults on only for loopback development |
| `DATABASE_URL` | Optional PostgreSQL source of truth; apply `migrations/001_initial.sql` first |
| `PARALLAX_COREDNS_DIRECTORY` | Optional directory for atomically generated zone files |
| `PARALLAX_OWNERSHIP_SECRET` | 32+ byte secret that signs managed-record ownership markers |
| `PARALLAX_CLOUDFLARE_ZONES` | Optional JSON map of zone names to Cloudflare zone IDs and API tokens |
| `PARALLAX_CREDENTIAL_FILE` | Optional encrypted Cloudflare credential file; configure with the master key |
| `PARALLAX_CREDENTIAL_MASTER_KEY` | Exact 32-byte master key encoded as base64 or 64 hexadecimal characters |
| `PARALLAX_AUTH_TOKENS` | Optional JSON array of admin/editor/viewer access tokens |

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
managed mutation, and atomically replaces the file. Configure CoreDNS with the
`auto` plugin or the `file` plugin's nonzero `reload` interval so it observes
serial changes. Existing non-Parallax records and authority data are retained;
Parallax only updates records carrying its signed ownership marker.

For a PostgreSQL deployment, apply the schema before starting the service:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_initial.sql
```

## HTTP API

All control-plane routes are under `/api/v1`.

- `GET|POST /zones`
- `GET|PUT|DELETE /zones/:zone`
- `PUT|DELETE /zones/:zone/views/:view/records/:id`
- `GET|POST /zones/:zone/preview`
- `POST /zones/:zone/apply`
- `GET /zones/:zone/status`
- `GET /zones/:zone/history`
- `GET /zones/:zone/revisions`
- `GET /zones/:zone/revisions/:revision`
- `POST /zones/:zone/revisions/:revision/restore`
- `GET /credentials/cloudflare`
- `GET|PUT|DELETE /credentials/cloudflare/:zone`
- `POST /credentials/cloudflare/:zone/test` (optionally tests an unsaved `{ zoneId, token }`)
- `GET /health/live` and `GET /health/ready`

Supply `Authorization: Bearer <token>` when authentication is enabled. Desired
state is stored before provider changes; preview never mutates a provider, and
apply reports each view independently.

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
