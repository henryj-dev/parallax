import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, SettingsService, parseSettings } from "../../src/application/settings.ts";
import { DomainValidationError } from "../../src/domain/dns.ts";
import type { SettingsRepository } from "../../src/application/ports.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";

class MemorySettingsRepository implements SettingsRepository {
  values: Record<string, unknown> = {};
  async read(): Promise<Record<string, unknown>> { return { ...this.values }; }
  async write(patch: Record<string, unknown>): Promise<void> { this.values = { ...this.values, ...patch }; }
}

describe("settings", () => {
  it("falls back to defaults and ignores values it does not recognize", () => {
    assert.deepEqual(parseSettings({}), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings({ somethingElse: 1 }), DEFAULT_SETTINGS);
    assert.equal(parseSettings({ revisionRetention: 5 }).revisionRetention, 5);
  });

  it("persists only the keys a patch names and leaves the rest alone", async () => {
    const repository = new MemorySettingsRepository();
    const settings = new SettingsService(repository);
    await settings.load();

    await settings.update({ revisionRetention: 7 });
    await settings.update({ allowLocalProvider: true });

    assert.deepEqual(repository.values, { revisionRetention: 7, allowLocalProvider: true });
    assert.equal(settings.current().revisionRetention, 7);
    assert.equal(settings.current().allowLocalProvider, true);
    assert.equal(settings.current().auditRetentionDays, DEFAULT_SETTINGS.auditRetentionDays);
  });

  it("rejects an unusable value before it reaches the store", async () => {
    const repository = new MemorySettingsRepository();
    const settings = new SettingsService(repository);
    await settings.load();

    for (const patch of [
      { revisionRetention: -1 },
      { revisionRetention: "many" },
      { allowLocalProvider: "yes" },
      { publicOrigin: "dns.example.com" },
      { publicOrigin: "https://dns.example.com/portal" },
      { unknownSetting: true },
    ]) {
      await assert.rejects(settings.update(patch), /must|unknown setting/, JSON.stringify(patch));
    }
    assert.deepEqual(repository.values, {});
  });

  it("notifies listeners so the process can re-wire itself without a restart", async () => {
    const settings = new SettingsService(new MemorySettingsRepository());
    await settings.load();
    const seen: Array<[boolean, boolean]> = [];
    settings.onChange((next, previous) => { seen.push([previous.allowLocalProvider, next.allowLocalProvider]); });

    await settings.update({ allowLocalProvider: true });
    await settings.update({ revisionRetention: 3 });

    assert.deepEqual(seen, [[false, true], [true, true]]);
  });

  it("round-trips through the file backend used when no database is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-settings-"));
    try {
      const path = join(directory, "configuration.json");
      const first = new SettingsService(new FileConfigurationStore(path).settings);
      await first.load();
      await first.update({ coreDnsDirectory: "/srv/coredns/zones", auditRetentionDays: 30 });

      const restarted = new SettingsService(new FileConfigurationStore(path).settings);
      assert.deepEqual(await restarted.load(), {
        ...DEFAULT_SETTINGS,
        coreDnsDirectory: "/srv/coredns/zones",
        auditRetentionDays: 30,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a setting the process could not act on, and stores nothing", async () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, (candidate) => {
      if (candidate.coreDnsDirectory) throw new DomainValidationError(["coreDnsDirectory is not writable (EROFS)"]);
    });
    await service.load();

    await assert.rejects(
      service.update({ coreDnsDirectory: "/read-only/zones" }),
      /coreDnsDirectory is not writable \(EROFS\)/,
    );
    // A refused setting must leave no trace: stored, cached, or announced.
    assert.deepEqual(repository.values, {});
    assert.equal(service.current().coreDnsDirectory, "");
  });

  it("verifies the merged result rather than the patch alone", async () => {
    const seen: string[] = [];
    const service = new SettingsService(new MemorySettingsRepository(), (candidate) => {
      seen.push(`${candidate.coreDnsDirectory}|${candidate.allowLocalProvider}`);
    });
    await service.load();
    await service.update({ coreDnsDirectory: "/srv/zones" });
    // Turning on the second setting must show the verifier the first one too,
    // or a combination that cannot work would be accepted one half at a time.
    await service.update({ allowLocalProvider: true });
    assert.deepEqual(seen, ["/srv/zones|false", "/srv/zones|true"]);
  });

  it("reports what a legal change costs instead of refusing it", async () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, undefined, (candidate) =>
      candidate.publicOrigin ? [] : ["publicOrigin is empty, so redirects assume 443"]);
    await service.load();

    const cleared = await service.update({ trustForwardedHeaders: true });
    assert.deepEqual(cleared.warnings, ["publicOrigin is empty, so redirects assume 443"]);
    // Advice is not refusal: the change landed.
    assert.equal(cleared.settings.trustForwardedHeaders, true);
    assert.equal(repository.values.trustForwardedHeaders, true);

    const set = await service.update({ publicOrigin: "https://dns.example.com" });
    assert.deepEqual(set.warnings, []);
  });

  it("says nothing when a patch changes nothing", async () => {
    let asked = 0;
    const service = new SettingsService(new MemorySettingsRepository(), undefined, () => {
      asked += 1;
      return ["never reached"];
    });
    await service.load();
    const unchanged = await service.update({});
    assert.deepEqual(unchanged.warnings, []);
    assert.equal(asked, 0);
  });
});
