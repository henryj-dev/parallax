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
    for (const child of running) child.kill("SIGKILL");
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
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
