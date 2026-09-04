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
 * That the setting reaches the monitor, which its own tests cannot show.
 *
 * The window matters because a readiness probe can gate the endpoints of a
 * service that also carries DNS: with one replica, going unready withdraws a
 * resolver that is still answering correctly out of its last snapshot. The
 * setting exists so that deployment can choose how long that takes.
 *
 * A monitor test proves the monitor honours the number; a config test proves
 * the environment is parsed. Neither notices if nothing passes one to the
 * other -- measured: cutting the wiring left both of them green.
 */
describe("the staleness window reaches the monitor", () => {
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

  async function readiness(extra: Record<string, string>): Promise<Record<string, unknown>> {
    // 포트를 잃으면 다시 고른다 — 창을 닫을 수는 없고, 지면 다시 시도할 수는 있다.
    return onFreePort(async (port) => {
      const directory = await mkdtemp(join(tmpdir(), "parallax-staleness-"));
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
          PARALLAX_AUTH_TOKENS: JSON.stringify([{ token, subject: "staleness-test", role: "admin" }]),
          ...extra,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      running.push(child);
      let log = "";
      child.stdout?.on("data", (chunk: Buffer) => { log += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { log += chunk.toString(); });

      const deadline = Date.now() + START_TIMEOUT_MS;
      for (;;) {
        if (child.exitCode !== null) {
            // 포트를 누가 먼저 잡았다면 이 실행의 결함이 아니다 — 다른 포트로 다시 시작한다.
            if (isAddressInUse(log)) throw new AddressInUse(log);
            assert.fail(`the server exited before it served: ${log}`);
          }
        if (Date.now() > deadline) assert.fail(`no answer within ${START_TIMEOUT_MS}ms: ${log}`);
        try {
          const answer = await fetch(`http://127.0.0.1:${port}/health/ready`, {
            headers: { authorization: `Bearer ${token}` },
          });
          if (answer.ok) return await answer.json() as Record<string, unknown>;
        } catch { /* not listening yet */ }
        await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
      }
    });
  }

  it("reports the window it was configured with", async () => {
    const body = await readiness({ PARALLAX_READINESS_MAX_STALENESS_SECONDS: "45" });
    assert.deepEqual((body.desiredState as { maxMs?: number })?.maxMs, 45_000);
  });

  it("reports the built-in window when nothing is set", async () => {
    // The control: without it, a wiring that ignored the setting and always
    // reported the default would still pass the test above if the default
    // happened to match.
    const body = await readiness({});
    assert.deepEqual((body.desiredState as { maxMs?: number })?.maxMs, 10_000);
  });
});
