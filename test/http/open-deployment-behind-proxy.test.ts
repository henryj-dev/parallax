import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parallaxEnvironment } from "../support/environment.ts";
import { AddressInUse, isAddressInUse, onFreePort } from "../support/ports.ts";

const ENTRY = join(import.meta.dirname, "../../src/index.ts");
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

describe("an open deployment reached through a proxy", () => {
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

  async function start(): Promise<string> {
    // 포트를 잃으면 다시 고른다 — 창을 닫을 수는 없고, 지면 다시 시도할 수는 있다.
    return onFreePort(async (port) => {
      const directory = await mkdtemp(join(tmpdir(), "parallax-open-"));
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
