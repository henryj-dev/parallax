# Parallax

Parallax is a split-horizon DNS control plane by tinyuniverse.

It provides a single source of truth for internal DNS records and external
DNS records managed through providers such as Cloudflare.

## Status

The project is in its initial setup phase.

The product concept, architecture proposal, and MVP scope are documented in
[docs/product-design.md](docs/product-design.md).

To continue development in a new session, start with
[docs/handoff.md](docs/handoff.md).

## Development

Prerequisites:

- Node.js 24 or later
- pnpm 11 or later

Install dependencies:

```sh
pnpm install
```

Run the application:

```sh
pnpm dev
```

Type-check and build:

```sh
pnpm check
pnpm build
```
