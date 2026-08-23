# Security policy

Parallax is a DNS control plane. It holds a Cloudflare API token, answers DNS on
a network, and serves an operations portal — so a bug here is usually a bug in
something's name resolution or in who may change it. Reports are welcome and
taken seriously.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.**

Use GitHub's private reporting:
[**Report a vulnerability**](https://github.com/henryj-dev/parallax/security/advisories/new).
It opens a private thread with the maintainers, and it is the only channel with
an expectation of a response attached.

A useful report says what an attacker can reach and from where. The most helpful
things to include:

- the version or commit you tested
- how Parallax was configured — in particular what `HOST` and `PARALLAX_DNS_HOST`
  were bound to, and whether `PARALLAX_AUTH_TOKENS` was set
- what an attacker needs to already have (network position, a token, a session)
- what they get

A proof of concept is welcome but not required; a clear description of the path
is worth more than a script.

### What to expect

| | |
|---|---|
| acknowledgement | within 7 days |
| initial assessment | within 14 days |
| fix or a stated reason not to | tracked in the private advisory until it closes |

This is a small project maintained by one person. Those are honest targets, not
a contractual SLA — if a deadline passes in silence, a nudge on the advisory
thread is appropriate.

Credit is given in the advisory unless you ask otherwise.

## Supported versions

Only `main` is supported. There are no maintained release branches, and fixes
land on `main` rather than being backported.

## Scope

In scope — anything reachable in a supported configuration:

- authentication and session handling on the HTTP API and the portal
- authorization: any path where one caller reaches another's records or
  credentials
- the DNS listener's handling of untrusted queries over UDP and TCP
- credential handling: the Cloudflare token, OIDC secrets, and anything written
  to the state files
- the Cloudflare adapter changing or deleting records Parallax does not manage

Out of scope:

- anything requiring an operator's shell inside the container. The Dockerfile
  says so plainly and on purpose: the CLI reaches the store directly, so shell
  access *is* control-plane access. That is the design, not a flaw in it.
- binding a non-loopback address with no `PARALLAX_AUTH_TOKENS` — startup
  already refuses this, and forcing past it is a configuration decision
- denial of service through sheer volume against a listener you are expected to
  put behind something
- findings from an automated scanner with no described path to impact
- the agent guards under `scripts/claude-hooks/` and `scripts/git-hooks/`. They
  are hygiene, not a security boundary, and they say so: `git commit
  --no-verify` bypasses them by design and all three layers fail open.

## Published audit reports

`security-audits/` holds this project's own audit reports, in the open.

Every finding in them has been remediated. The one real DNS zone name that
appeared in the 2026-08-10 report was redacted, and that report records the
redaction; every remaining address in those files (`10.9.9.9`, `1.2.3.4`,
`6.6.6.6`) is invented.

They are published because a control plane asking to be trusted with DNS should
show its own homework. If you find something in them that is still live, that is
exactly the kind of report this policy is asking for — please send it privately
rather than opening an issue.
