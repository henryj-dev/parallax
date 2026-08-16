import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { SettingsService } from "../src/application/settings.ts";
import type { ParallaxConfig } from "../src/config.ts";
import { DomainValidationError } from "../src/domain/dns.ts";
import { FileConfigurationStore } from "../src/infrastructure/file-settings.ts";
import {
  createRuntime,
  RuntimeStartupError,
} from "../src/runtime.ts";

const execFileAsync = promisify(execFile);

describe("runtime filesystem policy", () => {
  it("rejects a setting this process cannot act on before the file store is changed", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "parallax-runtime-setting-"));
    try {
      const configuration = new FileConfigurationStore(join(temporary, "configuration.json"));
      const settings = new SettingsService(configuration.settings, async (candidate) => {
        if (!candidate.allowLocalProvider) return;
        throw new DomainValidationError(["allowLocalProvider publishes to a directory this process cannot write"]);
      });
      await settings.load();

      await assert.rejects(settings.update({ allowLocalProvider: true }), /allowLocalProvider publishes/);
      assert.equal(settings.current().allowLocalProvider, false);
      assert.deepEqual(await configuration.settings.read(), {}, "a refused change leaves no trace");
    } finally {
      await chmod(join(temporary, "sealed"), 0o700).catch(() => undefined);
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("keeps serving startup fail-closed but lets the local CLI repair an unusable stored setting", async () => {
    // A stored value the process cannot act on stops it from serving -- which is
    // right, and would be a trap without a way back in. The local CLI is that
    // way: it reaches the same store without standing up a serving runtime.
    const temporary = await mkdtemp(join(tmpdir(), "parallax-runtime-recovery-"));
    try {
      const privateData = join(temporary, "private");
      // Exists and cannot be written. An absent directory is not a failure --
      // it can be created -- so only this reproduces a stored setting the
      // process cannot act on.
      const sealed = join(temporary, "sealed");
      await mkdir(sealed, { mode: 0o500 });
      const config: ParallaxConfig = {
        host: "127.0.0.1",
        port: 3000,
        stateFile: join(privateData, "state.json"),
        providerStateFile: join(sealed, "provider.json"),
        configurationFile: join(privateData, "configuration.json"),
        bootstrapTokens: [],
      };
      const stored = new FileConfigurationStore(config.configurationFile);
      await stored.settings.write({ allowLocalProvider: true, revisionRetention: 7 });

      await assert.rejects(createRuntime(config), RuntimeStartupError);

      await execFileAsync(process.execPath, [
        join(import.meta.dirname, "../cmd/parallax/main.ts"),
        "settings",
        "set",
        "--values",
        JSON.stringify({ allowLocalProvider: false }),
      ], {
        env: {
          ...process.env,
          DATABASE_URL: "",
          PARALLAX_CONFIG_FILE: config.configurationFile,
          PARALLAX_STATE_FILE: config.stateFile,
          PARALLAX_PROVIDER_STATE_FILE: config.providerStateFile,
          PARALLAX_AUTH_TOKENS: "",
        },
      });

      assert.deepEqual(await stored.settings.read(), { allowLocalProvider: false, revisionRetention: 7 });
      const runtime = await createRuntime(config);
      try {
        assert.equal(runtime.settings.current().allowLocalProvider, false);
        assert.equal(runtime.settings.current().revisionRetention, 7);
      } finally {
        await runtime.close();
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
