import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { SettingsService } from "../src/application/settings.ts";
import type { ParallaxConfig } from "../src/config.ts";
import { DomainValidationError } from "../src/domain/dns.ts";
import { FileConfigurationStore } from "../src/infrastructure/file-settings.ts";
import {
  coreDnsDirectoryFailure,
  createRuntime,
  RuntimeStartupError,
} from "../src/runtime.ts";

const execFileAsync = promisify(execFile);

describe("runtime filesystem policy", () => {
  it("confines CoreDNS publishing beneath a real deployment-owned root", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "parallax-runtime-root-"));
    try {
      const root = join(temporary, "allowed");
      const outside = join(temporary, "outside");
      await mkdir(root);
      await mkdir(outside);

      assert.equal(await coreDnsDirectoryFailure(join(root, "zones"), root), undefined);
      assert.match(await coreDnsDirectoryFailure(outside, root) ?? "", /outside PARALLAX_COREDNS_ROOT/);
      assert.match(await coreDnsDirectoryFailure(join(root, "zones"), undefined) ?? "", /requires PARALLAX_COREDNS_ROOT/);

      const rootLink = join(temporary, "root-link");
      await symlink(root, rootLink);
      assert.match(await coreDnsDirectoryFailure(join(rootLink, "zones"), rootLink) ?? "", /symbolic link/);

      const escape = join(root, "escape");
      await symlink(outside, escape);
      assert.match(await coreDnsDirectoryFailure(join(escape, "zones"), root) ?? "", /resolves outside/);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects an out-of-root setting before the file store is changed", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "parallax-runtime-setting-"));
    try {
      const root = join(temporary, "allowed");
      await mkdir(root);
      const configuration = new FileConfigurationStore(join(temporary, "configuration.json"));
      const settings = new SettingsService(configuration.settings, async (candidate) => {
        if (!candidate.coreDnsDirectory) return;
        const failure = await coreDnsDirectoryFailure(candidate.coreDnsDirectory, root);
        if (failure) throw new DomainValidationError([`coreDnsDirectory ${failure}`]);
      });
      await settings.load();

      await assert.rejects(
        settings.update({ coreDnsDirectory: join(temporary, "outside") }),
        /outside PARALLAX_COREDNS_ROOT/,
      );
      assert.equal(settings.current().coreDnsDirectory, "");
      assert.deepEqual(await configuration.settings.read(), {});
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("keeps serving startup fail-closed but lets the local CLI repair an unusable stored setting", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "parallax-runtime-recovery-"));
    try {
      const root = join(temporary, "allowed");
      const privateData = join(temporary, "private");
      await mkdir(root);
      const config: ParallaxConfig = {
        host: "127.0.0.1",
        port: 3000,
        stateFile: join(privateData, "state.json"),
        providerStateFile: join(privateData, "provider.json"),
        configurationFile: join(privateData, "configuration.json"),
        coreDnsRoot: root,
        bootstrapTokens: [],
      };
      const stored = new FileConfigurationStore(config.configurationFile);
      await stored.settings.write({
        coreDnsDirectory: join(temporary, "outside"),
        revisionRetention: 7,
      });

      await assert.rejects(createRuntime(config), RuntimeStartupError);

      await execFileAsync(process.execPath, [
        join(import.meta.dirname, "../cmd/parallax/main.ts"),
        "settings",
        "set",
        "--values",
        JSON.stringify({ coreDnsDirectory: "" }),
      ], {
        env: {
          ...process.env,
          DATABASE_URL: "",
          PARALLAX_POWERDNS_DATABASE_URL: "",
          PARALLAX_CONFIG_FILE: config.configurationFile,
          PARALLAX_STATE_FILE: config.stateFile,
          PARALLAX_PROVIDER_STATE_FILE: config.providerStateFile,
          PARALLAX_COREDNS_ROOT: root,
          PARALLAX_AUTH_TOKENS: "",
        },
      });

      assert.deepEqual(await stored.settings.read(), {
        coreDnsDirectory: "",
        revisionRetention: 7,
      });
      const runtime = await createRuntime(config);
      try {
        assert.equal(runtime.settings.current().coreDnsDirectory, "");
        assert.equal(runtime.settings.current().revisionRetention, 7);
      } finally {
        await runtime.close();
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
