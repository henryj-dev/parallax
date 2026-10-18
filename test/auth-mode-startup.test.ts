import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { checkConfig } from "../src/cli/config-check.ts";
import { ACCOUNTS_CONFIGURATION_REQUIRED, readConfig } from "../src/config.ts";
import { createRuntime, createSettingsRecoveryRuntime, RuntimeStartupError } from "../src/runtime.ts";
import { parallaxEnvironment } from "./support/environment.ts";
import { freePort } from "./support/ports.ts";

const execFileAsync = promisify(execFile);
const SERVER = join(import.meta.dirname, "../src/index.ts");
const CLI = join(import.meta.dirname, "../cmd/parallax/main.ts");
const PROCESS_TIMEOUT_MS = 60_000;

/**
 * P0 의 기동 규칙. 이 버전에는 회원 기능이 없다.
 *
 * - `PARALLAX_AUTH_MODE=accounts` 는 읽되 시작은 거절한다. legacy 로 바꿔 시작하면
 *   운영자는 회원 모드라 믿고, 실제로는 예전 규칙이 열린다.
 * - 저장소에 이 버전이 모르는 인증 기능 표식이 있으면 리스너를 열기 전에 멈춘다.
 */

const directories: string[] = [];
after(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "parallax-auth-mode-"));
  directories.push(directory);
  return directory;
}

function fileEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "",
    PARALLAX_STATE_FILE: join(directory, "state.json"),
    PARALLAX_CONFIG_FILE: join(directory, "config.json"),
    PARALLAX_PROVIDER_STATE_FILE: join(directory, "provider.json"),
  };
}

describe("PARALLAX_AUTH_MODE", () => {
  it("is absent unless set, and refuses accounts without its explicit policy, key and SMTP settings", () => {
    assert.equal("authMode" in readConfig({}), false);
    assert.equal("authMode" in readConfig({ PARALLAX_AUTH_MODE: "  " }), false);
    assert.equal(readConfig({ PARALLAX_AUTH_MODE: "legacy" }).authMode, "legacy");
    // No numeric default stands in for a policy nobody chose.
    assert.throws(() => readConfig({ PARALLAX_AUTH_MODE: " accounts " }), { message: ACCOUNTS_CONFIGURATION_REQUIRED });
  });

  it("refuses a mode it does not know instead of falling back to legacy", () => {
    for (const value of ["Accounts", "member", "oidc", "none"]) {
      assert.throws(() => readConfig({ PARALLAX_AUTH_MODE: value }), { message: "PARALLAX_AUTH_MODE must be one of: legacy, accounts" }, value);
    }
  });

  it("fails the preflight for accounts, and passes it for legacy", () => {
    assert.throws(() => checkConfig({ DATABASE_URL: "", PARALLAX_AUTH_MODE: "accounts" }), { message: ACCOUNTS_CONFIGURATION_REQUIRED });
    assert.equal(checkConfig({ DATABASE_URL: "", PARALLAX_AUTH_MODE: "legacy" }).environment, "ok");
  });

  it("exits the preflight command with the configuration status for accounts", async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [CLI, "config", "check"], {
        env: parallaxEnvironment({ DATABASE_URL: "", PARALLAX_AUTH_MODE: "accounts" }),
        timeout: PROCESS_TIMEOUT_MS,
      }),
      (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 78);
        assert.match(error.stderr ?? "", /accounts requires PARALLAX_ACCOUNT_POLICY_FILE, PARALLAX_ACCOUNT_KEY and explicit SMTP configuration/u);
        return true;
      },
    );
  });

  it("refuses accounts before a runtime exists or the store is touched", async () => {
    const directory = await temporary();
    assert.throws(() => readConfig({ ...fileEnvironment(directory), PARALLAX_AUTH_MODE: "accounts" }), { message: ACCOUNTS_CONFIGURATION_REQUIRED });
    // A configuration object assembled by hand without the accounts section is refused by the runtime too.
    const config = { ...readConfig(fileEnvironment(directory)), authMode: "accounts" as const };
    await assert.rejects(createRuntime(config), (error: unknown) => {
      assert.ok(error instanceof RuntimeStartupError);
      assert.equal(error.message, ACCOUNTS_CONFIGURATION_REQUIRED);
      return true;
    });
    // 설정 파일을 만들지도, 읽지도 않았다.
    await assert.rejects(access(join(directory, "config.json")));
  });

  it("builds the runtime for legacy exactly as with no mode", async () => {
    const directory = await temporary();
    const runtime = await createRuntime(readConfig({ ...fileEnvironment(directory), PARALLAX_AUTH_MODE: "legacy" }));
    await runtime.close();
  });
});

describe("authentication storage written by a newer version", () => {
  async function storeWithFeatures(authFeatures: unknown): Promise<string> {
    const directory = await temporary();
    await writeFile(
      join(directory, "config.json"),
      `${JSON.stringify({ version: 1, settings: {}, accessTokens: [], authFeatures })}\n`,
      { mode: 0o600 },
    );
    return directory;
  }

  it("refuses to build a runtime and leaves the file as it was", async () => {
    const directory = await storeWithFeatures(["member-accounts"]);
    const before = await readFile(join(directory, "config.json"), "utf8");
    await assert.rejects(createRuntime(readConfig(fileEnvironment(directory))), (error: unknown) => {
      assert.ok(error instanceof RuntimeStartupError);
      assert.match(error.message, /^configuration could not be read: the configuration file records authentication features this version does not recognize: "member-accounts"\./u);
      return true;
    });
    assert.equal(await readFile(join(directory, "config.json"), "utf8"), before);
  });

  it("starts on a file whose marker list is empty", async () => {
    const directory = await storeWithFeatures([]);
    const runtime = await createRuntime(readConfig(fileEnvironment(directory)));
    await runtime.close();
  });

  it("stops the server before either listener opens", async () => {
    const directory = await storeWithFeatures(["member-accounts"]);
    const port = await freePort();
    const dnsPort = await freePort("127.0.0.1", { udp: true });
    await assert.rejects(
      execFileAsync(process.execPath, [SERVER], {
        env: parallaxEnvironment({
          ...fileEnvironment(directory),
          HOST: "127.0.0.1",
          PORT: String(port),
          PARALLAX_DNS_PORT: String(dnsPort),
        }),
        timeout: PROCESS_TIMEOUT_MS,
      }),
      (error: { code?: number; stdout?: string; stderr?: string; killed?: boolean }) => {
        // 타임아웃으로 죽었다면 서버가 떠 버린 것이다.
        assert.equal(error.killed, false, `the server started: ${error.stdout ?? ""}`);
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? "", /does not recognize: "member-accounts"/u);
        assert.doesNotMatch(error.stdout ?? "", /parallax: https?:\/\//u);
        assert.doesNotMatch(error.stdout ?? "", /parallax: dns:\/\//u);
        return true;
      },
    );
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health/live`));
  });

  it("refuses the settings recovery runtime the same way, before it writes", async () => {
    const directory = await storeWithFeatures(["member-accounts"]);
    const before = await readFile(join(directory, "config.json"), "utf8");
    const runtime = await createSettingsRecoveryRuntime(readConfig(fileEnvironment(directory)));
    try {
      await assert.rejects(runtime.settings.update({ auditRetentionDays: 7 }), /does not recognize: "member-accounts"/u);
    } finally {
      await runtime.close();
    }
    assert.equal(await readFile(join(directory, "config.json"), "utf8"), before);
  });

  it("stops the server for accounts mode the same way", async () => {
    const directory = await temporary();
    const port = await freePort();
    await assert.rejects(
      execFileAsync(process.execPath, [SERVER], {
        env: parallaxEnvironment({ ...fileEnvironment(directory), HOST: "127.0.0.1", PORT: String(port), PARALLAX_AUTH_MODE: "accounts" }),
        timeout: PROCESS_TIMEOUT_MS,
      }),
      (error: { code?: number; stdout?: string; stderr?: string; killed?: boolean }) => {
        assert.equal(error.killed, false, `the server started: ${error.stdout ?? ""}`);
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? "", /^parallax: accounts requires PARALLAX_ACCOUNT_POLICY_FILE, PARALLAX_ACCOUNT_KEY and explicit SMTP configuration$/mu);
        assert.doesNotMatch(error.stdout ?? "", /parallax: https?:\/\//u);
        return true;
      },
    );
  });
});

describe("PostgreSQL authentication storage that cannot be checked", () => {
  // 아무도 듣지 않는 루프백 포트. 연결이 거절되므로 표식을 확인할 수 없다.
  async function unreachableDatabase(): Promise<NodeJS.ProcessEnv> {
    const directory = await temporary();
    return { ...fileEnvironment(directory), DATABASE_URL: `postgres://parallax@127.0.0.1:${await freePort()}/parallax` };
  }

  it("stops the serving runtime as a failed check, not as an incompatible store", async () => {
    await assert.rejects(createRuntime(readConfig(await unreachableDatabase())), (error: unknown) => {
      assert.ok(error instanceof RuntimeStartupError);
      assert.match(error.message, /^authentication storage could not be checked, so this version did not start: the authentication feature table could not be looked up: /u);
      assert.doesNotMatch(error.message, /not compatible/u);
      return true;
    });
  });

  it("stops the settings recovery runtime before it can write", async () => {
    await assert.rejects(createSettingsRecoveryRuntime(readConfig(await unreachableDatabase())), (error: unknown) => {
      assert.ok(error instanceof RuntimeStartupError);
      assert.match(error.message, /^authentication storage could not be checked/u);
      return true;
    });
  });
});
