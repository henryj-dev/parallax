import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parallaxEnvironment } from "../support/environment.ts";
import { AddressInUse, isAddressInUse, onFreePort } from "../support/ports.ts";

const ENTRY = join(import.meta.dirname, "../../src/index.ts");

/** Long enough for a cold start on a loaded machine, and bounded. */
const START_TIMEOUT_MS = 60_000;

/**
 * How long the spawned server may take to stop after SIGTERM before this test
 * stops being patient. `shutdownProcess` gives its listeners a 10s grace and
 * then cuts what is left, so anything past that is not slowness.
 */
const STOP_TIMEOUT_MS = 15_000;

/**
 * Stops a spawned server the way a pod manager does, and waits for it.
 *
 * This used to be `child.kill("SIGKILL")`, which is the one way to end a
 * process that leaves nothing behind. **V8 writes its coverage file in an exit
 * handler**, and SIGKILL runs no handler -- so `src/index.ts`, the 599-line
 * composition root these four suites are the only exercise of, was *absent from
 * the coverage table entirely*. Not low: absent. The control was in the same
 * repository the whole time -- `cmd/parallax/main.ts` is spawned and allowed to
 * exit, and measures.
 *
 * So: SIGTERM, which is the path production takes and which `stop()` in
 * `src/index.ts` handles by calling `shutdownProcess` and then `process.exit(0)`
 * -- an exit that does run the handler. SIGKILL stays as the fallback, bounded
 * by a deadline, and reaching it **fails the suite** rather than passing
 * quietly: a server that will not answer SIGTERM is the shutdown defect these
 * tests would otherwise be the last place to notice.
 *
 * ⚠️ 같은 함수가 이 디렉터리에 네 벌 있다. `test/support/ports.ts` 가 적어 둔
 * 교훈이 그대로 적용된다 — 합의해야 하는 사본은 결국 합의하지 않는다. 이건
 * `test/support/` 로 가야 하고, 그렇게 하는 변경이 이 파일들의 소유권을 넘어서
 * 아직 여기 남아 있다.
 */
async function stopGracefully(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => { child.once("exit", () => { resolve(); }); });
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => { resolve("expired"); }, STOP_TIMEOUT_MS);
  });
  try {
    if (await Promise.race([exited.then(() => "exited" as const), expired]) === "exited") return;
    child.kill("SIGKILL");
    await exited;
    assert.fail(`the server did not exit within ${STOP_TIMEOUT_MS}ms of SIGTERM; it had to be killed`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


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


/**
 * The decision this proves is one function, and it is tested on its own. What
 * cannot be tested there is whether anything calls it -- so this starts the
 * real server and asks it, over a socket, the way a browser would.
 */
describe("a browser arriving without a session", () => {
  const running: ChildProcess[] = [];
  const directories: string[] = [];

  after(async () => {
    // 실패해도 임시 디렉터리는 지운다. 정리를 건너뛰면 한 번의 시끄러운 실패가
    // 매 실행마다 조용히 쌓이는 쓰레기로 바뀐다.
    const failures: unknown[] = [];
    for (const child of running) {
      try { await stopGracefully(child); } catch (error) { failures.push(error); }
    }
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
    if (failures.length > 0) throw failures[0];
  });

  async function start(extra: Record<string, string>): Promise<{ origin: string; token: string }> {
    // 포트를 잃으면 다시 고른다 — 창을 닫을 수는 없고, 지면 다시 시도할 수는 있다.
    return onFreePort(async (port) => {
      const directory = await mkdtemp(join(tmpdir(), "parallax-signin-"));
      directories.push(directory);
      const token = randomBytes(32).toString("base64url");
      const child = spawn(process.execPath, [ENTRY], {
        env: {
          ...parallaxEnvironment(),
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
        if (child.exitCode !== null) {
            // 포트를 누가 먼저 잡았다면 이 실행의 결함이 아니다 — 다른 포트로 다시 시작한다.
            if (isAddressInUse(log)) throw new AddressInUse(log);
            assert.fail(`the server exited before it served: ${log}`);
          }
        // A server that never comes up must fail rather than hold the clock.
        if (Date.now() > deadline) assert.fail(`the server did not answer within ${START_TIMEOUT_MS}ms: ${log}`);
        try {
          const alive = await fetch(`${origin}/health/live`);
          if (alive.ok) return { origin, token };
        } catch { /* not listening yet */ }
        await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
      }
    });
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
