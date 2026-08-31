import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { signSession } from "../../src/security/session-token.ts";
import { parallaxEnvironment } from "../support/environment.ts";
import { AddressInUse, isAddressInUse, onFreePort } from "../support/ports.ts";

const ENTRY = join(import.meta.dirname, "../../src/index.ts");
const START_TIMEOUT_MS = 60_000;
const SESSION_SECRET = "0".repeat(32);

/**
 * A deployment where the identity provider is the only way in.
 *
 * This combination -- an identity provider configured and *no access token at
 * all* -- had no test, which is why nothing noticed that the proxy guard asked
 * the access tokens whether authentication was on. It is not a corner: it is
 * what a deployment looks like when people sign in with their directory account
 * and a token is a machine's credential rather than a person's.
 *
 * The identity provider itself is never contacted. A session here is minted the
 * same way `/auth/callback` mints one, because what is under test is what the
 * server does with a session, not how the browser got it.
 */
const IDENTITY = {
  PARALLAX_OIDC_ISSUER: "https://idp.invalid",
  PARALLAX_OIDC_CLIENT_ID: "parallax",
  PARALLAX_OIDC_CLIENT_SECRET: "secret",
  PARALLAX_OIDC_REDIRECT_URI: "https://dns.invalid/auth/callback",
  PARALLAX_OIDC_SESSION_SECRET: SESSION_SECRET,
};


describe("a deployment whose only credential is an identity provider", () => {
  const running: ChildProcess[] = [];
  const directories: string[] = [];

  after(async () => {
    for (const child of running) child.kill("SIGKILL");
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  });

  async function start(): Promise<string> {
    // 포트를 잃으면 다시 고른다 — 창을 닫을 수는 없고, 지면 다시 시도할 수는 있다.
    return onFreePort(async (port) => {
      const directory = await mkdtemp(join(tmpdir(), "parallax-identity-only-"));
      directories.push(directory);
      const child = spawn(process.execPath, [ENTRY], {
        env: {
          ...parallaxEnvironment(),
          HOST: "127.0.0.1",
          PORT: String(port),
          DATABASE_URL: "",
          PARALLAX_STATE_FILE: join(directory, "state.json"),
          PARALLAX_CONFIG_FILE: join(directory, "config.json"),
          PARALLAX_PROVIDER_STATE_FILE: join(directory, "provider.json"),
          // Deliberately absent: PARALLAX_AUTH_TOKENS. That absence is the point.
          ...IDENTITY,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      running.push(child);
      let log = "";
      child.stdout?.on("data", (chunk: Buffer) => { log += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { log += chunk.toString(); });

      const origin = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + START_TIMEOUT_MS;
      for (;;) {
        if (child.exitCode !== null) {
            // 포트를 누가 먼저 잡았다면 이 실행의 결함이 아니다 — 다른 포트로 다시 시작한다.
            if (isAddressInUse(log)) throw new AddressInUse(log);
            assert.fail(`the server exited before it served: ${log}`);
          }
        if (Date.now() > deadline) assert.fail(`the server did not answer within ${START_TIMEOUT_MS}ms: ${log}`);
        try {
          const alive = await fetch(`${origin}/health/live`);
          if (alive.ok) return origin;
        } catch { /* not listening yet */ }
        await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
      }
    });
  }

  function session(role: "admin" | "editor" | "viewer"): string {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    return signSession({ subject: "someone@example.com", role, expiresAt }, SESSION_SECRET);
  }

  it("serves a session-authenticated API request that arrived through a proxy", async () => {
    const origin = await start();

    // The header is what marks the request as proxied. Its mere presence used
    // to be enough to refuse, because the guard asked the wrong question.
    const answered = await fetch(`${origin}/api/v1/zones`, {
      headers: {
        "x-forwarded-proto": "https",
        cookie: `parallax_identity=${encodeURIComponent(session("admin"))}`,
      },
    });
    assert.equal(answered.status, 200);
    const body = await answered.json() as { zones: unknown[] };
    assert.ok(Array.isArray(body.zones));
  });

  it("still refuses a proxied API request that carries no session", async () => {
    const origin = await start();

    // The guard did not go away. Without it, an unauthenticated deployment
    // behind a proxy would hand out administrator rights.
    const refused = await fetch(`${origin}/api/v1/zones`, {
      headers: { "x-forwarded-proto": "https" },
    });
    assert.equal(refused.status, 401);
  });

  /**
   * `/metrics` describes the deployment -- how many zones it answers for, how
   * stale its view is -- so it sits behind the same rule `/health/ready` uses
   * for its detail. A scraper sends a bearer token the way it does anywhere.
   */
  it("keeps the metrics behind the same authentication as the rest", async () => {
    const origin = await start();

    const anonymous = await fetch(`${origin}/metrics`);
    assert.equal(anonymous.status, 401);

    const authenticated = await fetch(`${origin}/metrics`, {
      headers: { cookie: `parallax_identity=${encodeURIComponent(session("viewer"))}` },
    });
    assert.equal(authenticated.status, 200);
    assert.match(authenticated.headers.get("content-type") ?? "", /text\/plain/u);
    const body = await authenticated.text();
    // The counter this endpoint exists for: zero, and present at zero, so an
    // alert written against it can tell "never happened" from "no such series".
    assert.match(body, /^parallax_dns_unservable_records_total 0$/mu);
    assert.match(body, /^parallax_ready [01]$/mu);
    // No listener in this deployment, so the zone count is absent rather than 0.
    assert.doesNotMatch(body, /parallax_dns_served_zones/u);
  });

  it("reports that it authenticates, so the portal does not draw itself as open", async () => {
    const origin = await start();

    const alive = await fetch(`${origin}/health/live`);
    const body = await alive.json() as { authentication: string; identityProvider: string };
    // The portal reads exactly these two and decides whether to offer sign-in
    // and sign-out. `disabled` here told it a closed control plane was open.
    assert.equal(body.authentication, "required");
    assert.equal(body.identityProvider, "available");
  });
});
