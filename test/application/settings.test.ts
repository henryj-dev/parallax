import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, SettingsService, parseSettings } from "../../src/application/settings.ts";
import { DomainValidationError } from "../../src/domain/dns.ts";
import type { SettingsRepository } from "../../src/application/ports.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";
import { InMemorySettingsRepository } from "../../src/infrastructure/in-memory.ts";

class MemorySettingsRepository implements SettingsRepository {
  values: Record<string, unknown> = {};
  #tail: Promise<void> = Promise.resolve();
  async read(): Promise<Record<string, unknown>> {
    await this.#tail;
    return { ...this.values };
  }
  async write(patch: Record<string, unknown>): Promise<void> { this.values = { ...this.values, ...patch }; }
  update<T>(
    operation: (current: Record<string, unknown>) => Promise<{ patch: Record<string, unknown>; result: T }>,
  ): Promise<T> {
    const result = this.#tail.then(async () => {
      const replacement = await operation({ ...this.values });
      await this.write(replacement.patch);
      return replacement.result;
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
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
      { publicOrigin: "http://dns.example.com" },
      { revisionRetention: Number.MAX_SAFE_INTEGER },
      { auditRetentionDays: Number.MAX_SAFE_INTEGER },
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

  it("does not persist a setting when runtime re-wiring rejects it", async () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository);
    await service.load();
    const seen: boolean[] = [];
    service.onChange((candidate) => {
      seen.push(candidate.allowLocalProvider);
      if (candidate.allowLocalProvider) throw new Error("publisher combination is unavailable");
    });

    await assert.rejects(service.update({ allowLocalProvider: true }), /publisher combination is unavailable/);
    assert.equal(service.current().allowLocalProvider, false);
    assert.deepEqual(repository.values, {});
    assert.deepEqual(seen, [true]);
  });

  it("rolls runtime wiring back when persistence fails", async () => {
    const repository = new MemorySettingsRepository();
    repository.write = async () => { throw new Error("store unavailable"); };
    const service = new SettingsService(repository);
    await service.load();
    const seen: boolean[] = [];
    service.onChange((candidate) => { seen.push(candidate.allowLocalProvider); });

    await assert.rejects(service.update({ allowLocalProvider: true }), /store unavailable/);
    assert.equal(service.current().allowLocalProvider, false);
    assert.deepEqual(seen, [true, false]);
  });

  it("re-reads external changes and runs the same verifier and listeners", async () => {
    const repository = new MemorySettingsRepository();
    const verified: boolean[] = [];
    const rewired: boolean[] = [];
    const service = new SettingsService(repository, (candidate) => {
      verified.push(candidate.allowLocalProvider);
    });
    await service.load();
    service.onChange((candidate) => { rewired.push(candidate.allowLocalProvider); });
    repository.values = { allowLocalProvider: true };

    await service.refresh();
    await service.refresh();
    assert.equal(service.current().allowLocalProvider, true);
    assert.deepEqual(rewired, [true], "an unchanged poll must not repeatedly re-wire providers");
    assert.deepEqual(verified, [false, true]);
  });

  it("merges another process's file setting before applying a local patch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-settings-replicas-"));
    try {
      const path = join(directory, "private", "configuration.json");
      const left = new SettingsService(new FileConfigurationStore(path).settings);
      const right = new SettingsService(new FileConfigurationStore(path).settings);
      await Promise.all([left.load(), right.load()]);
      await left.update({ allowLocalProvider: true });
      await right.update({ revisionRetention: 7 });
      await left.refresh();

      assert.equal(left.current().allowLocalProvider, true);
      assert.equal(left.current().revisionRetention, 7);
      assert.equal(right.current().allowLocalProvider, true);
      assert.equal(right.current().revisionRetention, 7);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the previous runtime wiring when an external value is unusable here", async () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, (candidate) => {
      if (candidate.publicOrigin) throw new Error("publisher root unavailable");
    });
    await service.load();
    repository.values = { publicOrigin: "https://another.example" };

    await assert.rejects(service.refresh(), /publisher root unavailable/);
    assert.equal(service.current().publicOrigin, "");
  });

  it("repairs an unusable external value without publishing it over the last good settings", async () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, (candidate) => {
      if (candidate.publicOrigin) throw new Error("publisher root unavailable");
    });
    await service.load();
    const rewired: Array<[string, number]> = [];
    service.onChange((candidate) => {
      rewired.push([candidate.publicOrigin, candidate.revisionRetention]);
    });
    repository.values = { publicOrigin: "https://another.example", revisionRetention: 7 };

    await assert.rejects(
      service.update({ auditRetentionDays: 30 }),
      /publisher root unavailable/,
      "an unrelated patch must not leave the durable snapshot unusable",
    );
    assert.deepEqual(repository.values, {
      publicOrigin: "https://another.example",
      revisionRetention: 7,
    });
    assert.deepEqual(rewired, [], "the unusable external snapshot must never reach a listener");

    const repaired = await service.update({ publicOrigin: "" });
    assert.equal(repaired.settings.publicOrigin, "");
    assert.equal(repaired.settings.revisionRetention, 7);
    assert.deepEqual(repository.values, { publicOrigin: "", revisionRetention: 7 });
    assert.deepEqual(rewired, [["", 7]], "listeners see only the verified repaired snapshot");
  });

  it("rolls repaired runtime wiring back when the corrective write fails", async () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, (candidate) => {
      if (candidate.publicOrigin) throw new Error("publisher root unavailable");
    });
    await service.load();
    repository.values = { publicOrigin: "https://another.example", revisionRetention: 7 };
    repository.write = async () => { throw new Error("store unavailable"); };
    const rewired: Array<[number, number]> = [];
    service.onChange((candidate, previous) => {
      rewired.push([candidate.revisionRetention, previous.revisionRetention]);
    });

    await assert.rejects(service.update({ publicOrigin: "" }), /store unavailable/);

    assert.deepEqual(rewired, [
      [7, DEFAULT_SETTINGS.revisionRetention],
      [DEFAULT_SETTINGS.revisionRetention, 7],
    ], "rollback receives the attempted candidate as its previous value");
    assert.deepEqual(service.current(), DEFAULT_SETTINGS);
    assert.deepEqual(repository.values, {
      publicOrigin: "https://another.example",
      revisionRetention: 7,
    });
  });

  it("round-trips through the file backend used when no database is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-settings-"));
    try {
      const path = join(directory, "configuration.json");
      const first = new SettingsService(new FileConfigurationStore(path).settings);
      await first.load();
      await first.update({ publicOrigin: "https://srv.example", auditRetentionDays: 30 });

      const restarted = new SettingsService(new FileConfigurationStore(path).settings);
      assert.deepEqual(await restarted.load(), {
        ...DEFAULT_SETTINGS,
        publicOrigin: "https://srv.example",
        auditRetentionDays: 30,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes invariant-coupled updates across independent file-backed replicas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-settings-invariant-"));
    try {
      const path = join(directory, "private", "configuration.json");
      const seed = new FileConfigurationStore(path);
      await seed.settings.write({
        publicOrigin: "https://portal.example",
        trustForwardedHeaders: false,
      });
      await assertConcurrentProxyInvariant(
        new FileConfigurationStore(path).settings,
        new FileConfigurationStore(path).settings,
      );
      assert.deepEqual(await seed.settings.read(), {
        publicOrigin: "https://portal.example",
        trustForwardedHeaders: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes invariant-coupled updates in the in-memory repository", async () => {
    const repository = new InMemorySettingsRepository({
      publicOrigin: "https://portal.example",
      trustForwardedHeaders: false,
    });

    await assertConcurrentProxyInvariant(repository, repository);

    assert.deepEqual(await repository.read(), {
      publicOrigin: "https://portal.example",
      trustForwardedHeaders: true,
    });
  });

  it("refuses a setting the process could not act on, and stores nothing", async () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, (candidate) => {
      if (candidate.publicOrigin) throw new DomainValidationError(["publicOrigin is not writable (EROFS)"]);
    });
    await service.load();

    await assert.rejects(
      service.update({ publicOrigin: "https://read-only.example" }),
      /publicOrigin is not writable \(EROFS\)/,
    );
    // A refused setting must leave no trace: stored, cached, or announced.
    assert.deepEqual(repository.values, {});
    assert.equal(service.current().publicOrigin, "");
  });

  it("verifies the merged result rather than the patch alone", async () => {
    const seen: string[] = [];
    const service = new SettingsService(new MemorySettingsRepository(), (candidate) => {
      seen.push(`${candidate.publicOrigin}|${candidate.allowLocalProvider}`);
    });
    await service.load();
    await service.update({ publicOrigin: "https://srv2.example" });
    // Turning on the second setting must show the verifier the first one too,
    // or a combination that cannot work would be accepted one half at a time.
    await service.update({ allowLocalProvider: true });
    assert.deepEqual(seen, ["|false", "https://srv2.example|false", "https://srv2.example|true"]);
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

async function assertConcurrentProxyInvariant(
  leftRepository: SettingsRepository,
  rightRepository: SettingsRepository,
): Promise<void> {
  let announceLeftEntered = (): void => {};
  const leftEntered = new Promise<void>((resolve) => { announceLeftEntered = resolve; });
  let releaseLeft = (): void => {};
  const leftGate = new Promise<void>((resolve) => { releaseLeft = resolve; });
  let rightVerifierEntered = false;
  const invariant = (candidate: { publicOrigin: string; trustForwardedHeaders: boolean }): void => {
    if (candidate.trustForwardedHeaders && !candidate.publicOrigin) {
      throw new Error("trustForwardedHeaders requires publicOrigin");
    }
  };
  const left = new SettingsService(leftRepository, async (candidate) => {
    if (candidate.trustForwardedHeaders) {
      announceLeftEntered();
      await leftGate;
    }
    invariant(candidate);
  });
  const right = new SettingsService(rightRepository, (candidate) => {
    if (!candidate.publicOrigin) rightVerifierEntered = true;
    invariant(candidate);
  });
  await Promise.all([left.load(), right.load()]);

  const leftUpdate = left.update({ trustForwardedHeaders: true });
  await leftEntered;
  const rightUpdate = right.update({ publicOrigin: "" });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(rightVerifierEntered, false, "the second replica must not derive while the first holds the lock");
  } finally {
    releaseLeft();
  }

  const settled = await Promise.allSettled([leftUpdate, rightUpdate]);
  assert.deepEqual(settled.map((result) => result.status), ["fulfilled", "rejected"]);
  assert.match((settled[1] as PromiseRejectedResult).reason.message, /requires publicOrigin/);
}
