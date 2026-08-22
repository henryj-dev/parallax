import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const ENTRY = join(import.meta.dirname, "../../src/index.ts");
const START_TIMEOUT_MS = 60_000;

/**
 * A deployment with nothing to authenticate against, reached through a proxy.
 *
 * Permitted only on loopback -- binding anything else without a credential is
 * refused at startup -- but a proxy in front of a loopback process is exactly
 * how that protection gets bypassed, so a request carrying forwarded headers is
 * refused rather than trusted.
 *
 * The combination had no test, and the cost of that showed: `/metrics` was
 * added and served zone counts and staleness to anyone through the proxy for
 * one commit, because the guard named `/api/` and nothing else.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("an open deployment reached through a proxy", () => {
  const running: ChildProcess[] = [];
  const directories: string[] = [];

  after(async () => {
    for (const child of running) child.kill("SIGKILL");
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  });

  async function start(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "parallax-open-"));
    directories.push(directory);
    const port = await freePort();
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        DATABASE_URL: "",
        PARALLAX_STATE_FILE: join(directory, "state.json"),
        PARALLAX_CONFIG_FILE: join(directory, "config.json"),
        PARALLAX_PROVIDER_STATE_FILE: join(directory, "provider.json"),
        // No tokens and no identity provider: nothing authenticates here.
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
      if (Date.now() > deadline) assert.fail(`the server did not answer within ${START_TIMEOUT_MS}ms: ${log}`);
      try {
        const alive = await fetch(`${origin}/health/live`);
        if (alive.ok) return origin;
      } catch { /* not listening yet */ }
      await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
    }
  }

  const proxied = { "x-forwarded-for": "203.0.113.7" };

  it("refuses everything that describes the deployment", async () => {
    const origin = await start();
    for (const path of ["/api/v1/zones", "/metrics"]) {
      const answered = await fetch(`${origin}${path}`, { headers: proxied });
      assert.equal(answered.status, 401, path);
    }
  });

  it("still answers the two routes that are open on purpose", async () => {
    const origin = await start();

    // The portal reads this to decide whether to offer sign-in at all, so it
    // has to answer before anyone can have a credential.
    const live = await fetch(`${origin}/health/live`, { headers: proxied });
    assert.equal(live.status, 200);

    // A bare verdict and no detail, which is what an unauthenticated caller
    // gets whether or not a proxy is involved.
    const ready = await fetch(`${origin}/health/ready`, { headers: proxied });
    assert.ok(ready.status === 200 || ready.status === 503);
    const body = await ready.json() as Record<string, unknown>;
    assert.equal(body.dns, undefined, "readiness detail is not for an anonymous caller");
    assert.equal(body.storage, undefined);
  });

  it("answers the same routes directly, since nothing is in front of it", async () => {
    const origin = await start();
    // Without forwarded headers this is the loopback session the deployment
    // was permitted for. Refusing here would make an open deployment useless.
    for (const path of ["/api/v1/zones", "/metrics"]) {
      const answered = await fetch(`${origin}${path}`);
      assert.equal(answered.status, 200, path);
    }
  });
});
