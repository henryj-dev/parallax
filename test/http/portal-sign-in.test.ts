import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const ENTRY = join(import.meta.dirname, "../../src/index.ts");

/** Long enough for a cold start on a loaded machine, and bounded. */
const START_TIMEOUT_MS = 60_000;

/**
 * Enough of an identity provider for the setting to be accepted. Nothing here
 * is contacted: the redirect under test points at this process's own
 * `/auth/login`, and following it further is where a provider would be needed.
 */
const IDENTITY = {
  PARALLAX_OIDC_ISSUER: "https://idp.invalid",
  PARALLAX_OIDC_CLIENT_ID: "parallax",
  PARALLAX_OIDC_CLIENT_SECRET: "secret",
  PARALLAX_OIDC_REDIRECT_URI: "https://dns.invalid/auth/callback",
  PARALLAX_OIDC_SESSION_SECRET: "0".repeat(32),
};

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * The decision this proves is one function, and it is tested on its own. What
 * cannot be tested there is whether anything calls it -- so this starts the
 * real server and asks it, over a socket, the way a browser would.
 */
describe("a browser arriving without a session", () => {
  const running: ChildProcess[] = [];
  const directories: string[] = [];

  after(async () => {
    for (const child of running) child.kill("SIGKILL");
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  });

  async function start(extra: Record<string, string>): Promise<{ origin: string; token: string }> {
    const directory = await mkdtemp(join(tmpdir(), "parallax-signin-"));
    directories.push(directory);
    const port = await freePort();
    const token = randomBytes(32).toString("base64url");
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        DATABASE_URL: "",
        PARALLAX_STATE_FILE: join(directory, "state.json"),
        PARALLAX_CONFIG_FILE: join(directory, "config.json"),
        PARALLAX_PROVIDER_STATE_FILE: join(directory, "provider.json"),
        PARALLAX_AUTH_TOKENS: JSON.stringify([{ token, subject: "sign-in-test", role: "admin" }]),
        ...extra,
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
      if (child.exitCode !== null) assert.fail(`the server exited before it served: ${log}`);
      // A server that never comes up must fail rather than hold the clock.
      if (Date.now() > deadline) assert.fail(`the server did not answer within ${START_TIMEOUT_MS}ms: ${log}`);
      try {
        const alive = await fetch(`${origin}/health/live`);
        if (alive.ok) return { origin, token };
      } catch { /* not listening yet */ }
      await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
    }
  }

  it("is sent to the identity provider instead of the token field", async () => {
    const { origin, token } = await start({ ...IDENTITY, PARALLAX_PORTAL_SIGN_IN: "idp" });

    const page = await fetch(`${origin}/`, { redirect: "manual" });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/auth/login?next=%2F");

    // The API must not answer a redirect. A command-line client cannot sign in
    // at a browser, and a 302 reads to it as success.
    const api = await fetch(`${origin}/api/v1/zones`);
    assert.equal(api.status, 401);
    assert.match(api.headers.get("content-type") ?? "", /application\/json/u);

    // An asset is not a page. Answering a module with a login screen is a parse
    // error rather than a sign-in.
    const asset = await fetch(`${origin}/app.js`, { redirect: "manual" });
    assert.equal(asset.status, 200);

    // And somebody who already holds a credential is not bounced anywhere.
    const authenticated = await fetch(`${origin}/`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    assert.equal(authenticated.status, 200);
    assert.match(authenticated.headers.get("content-type") ?? "", /text\/html/u);
  });

  it("still serves the page where the setting is not turned on", async () => {
    // The control: the same server, the same lack of a session. Without this,
    // a 302 above could be something this deployment does regardless.
    const { origin } = await start(IDENTITY);
    const page = await fetch(`${origin}/`, { redirect: "manual" });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/u);
  });
});
