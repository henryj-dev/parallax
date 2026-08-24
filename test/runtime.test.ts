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

/**
 * Which key the operator is sent to when the credential store will not open.
 *
 * Two very different causes arrive from the same call. The advice was written
 * for one of them and given for both, and the one it was wrong for is the
 * dangerous direction: regenerating `PARALLAX_CREDENTIAL_MASTER_KEY` makes
 * every stored credential unreadable, so an operator who followed the sentence
 * would have destroyed what they were trying to reach.
 */
describe("what startup says when the credential store will not open", () => {
  const MASTER_KEY = Buffer.alloc(32, 7);

  async function configuredAt(directory: string, ownershipSecret: string): Promise<ParallaxConfig> {
    const { readConfig } = await import("../src/config.ts");
    return readConfig({
      PARALLAX_CREDENTIAL_MASTER_KEY: MASTER_KEY.toString("base64"),
      PARALLAX_OWNERSHIP_SECRET: ownershipSecret,
      PARALLAX_STATE_FILE: join(directory, "state.json"),
      PARALLAX_CONFIG_FILE: join(directory, "configuration.json"),
      PARALLAX_PROVIDER_STATE_FILE: join(directory, "provider.json"),
    });
  }

  it("names the ownership secret, and not the master key, when that is what is missing", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "parallax-ownership-hint-"));
    try {
      // A binding is what makes a provider adapter get built, which is where
      // the ownership secret is first required.
      const { EncryptedCredentialStore } = await import("../src/security/credential-store.ts");
      const files = new FileConfigurationStore(join(temporary, "configuration.json"));
      const store = new EncryptedCredentialStore({ repository: files.credentials, masterKey: MASTER_KEY });
      await store.upsertProfile("cloudflare", { token: "t".repeat(40) });
      await store.bindZone("example.com", { zoneId: "zone-1", profile: "cloudflare" });

      await assert.rejects(
        createRuntime(await configuredAt(temporary, "")),
        (error: unknown) => {
          assert.ok(error instanceof RuntimeStartupError);
          assert.match(error.message, /PARALLAX_OWNERSHIP_SECRET/u);
          assert.doesNotMatch(error.message, /PARALLAX_CREDENTIAL_MASTER_KEY/u,
            "the key that must not be regenerated is not the one to name here");
          return true;
        },
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("still starts with a master key and no ownership secret while nothing is bound", async () => {
    // The plan for this item proposed refusing the combination outright. It is
    // wrong: this is the documented setup order -- set the key, then add
    // credentials through the portal -- and refusing would break it. The
    // warning at startup is what covers the gap, so this pins the decision.
    const temporary = await mkdtemp(join(tmpdir(), "parallax-ownership-allowed-"));
    try {
      const runtime = await createRuntime(await configuredAt(temporary, ""));
      await runtime.controlPlane.createZone("example.com", "test");
      await runtime.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

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
        portalSignIn: "prompt",
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
        // Bounded for the same reason as everywhere else a child is awaited: a
        // process that never exits must fail rather than stop the clock.
        timeout: 60_000,
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
