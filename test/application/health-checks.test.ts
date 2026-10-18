import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictError, ControlPlane, NotFoundError, protectedRRsetsFor } from "../../src/application/control-plane.ts";
import type { SettingsRepository, SettingsRepositoryUpdate, ZoneRepository } from "../../src/application/ports.ts";
import { DEFAULT_SETTINGS, MAX_HEALTH_CHECK_ALLOW_CIDRS, parseSettings, SettingsService } from "../../src/application/settings.ts";
import { DomainValidationError } from "../../src/domain/dns.ts";
import { MAX_HEALTH_CHECK_TARGETS } from "../../src/domain/health-checks.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";

/** The deployment health checks are for: the built-in listener answers the internal view. */
function setup(publisher: "listener" | "provider" = "listener") {
  const adapters = createInMemoryAdapters();
  const service = new ControlPlane(adapters.zones, adapters.statuses, adapters.provider,
    { now: () => new Date("2026-08-08T00:00:00.000Z") }, undefined, {},
    (target) => target.endsWith("/internal") ? publisher : "provider");
  return { service, provider: adapters.provider };
}

const tcp = { kind: "tcp", port: 443 } as const;

async function zoneWithApp(service: ControlPlane): Promise<void> {
  await service.createZone("example.com");
  await service.upsertRecord("example.com", "internal", "app-1", { name: "app", type: "A", content: "10.0.0.11", ttl: 300 });
  await service.upsertRecord("example.com", "internal", "app-2", { name: "app", type: "A", content: "10.0.0.12", ttl: 300 });
}

describe("health check writes", () => {
  it("adds, replaces, lists and deletes one policy at a time, each a revision", async () => {
    const { service } = setup();
    await zoneWithApp(service);
    const start = (await service.getZone("example.com")).revision;
    const saved = await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp }, "alice", start);
    assert.equal(saved.revision, start + 1);
    assert.deepEqual(saved.healthCheck, { name: "app", type: "A", enabled: true, probe: tcp, responseTtlSeconds: 30 });

    await assert.rejects(service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp }, "alice", start), ConflictError);
    const replaced = await service.setHealthCheck("example.com", { name: "APP.", type: "a", enabled: true, probe: { kind: "http", port: 8080 } }, "alice", start + 1);
    const listed = await service.listHealthChecks("example.com");
    assert.equal(listed.revision, replaced.revision);
    assert.deepEqual(listed.healthChecks.map((policy) => [policy.name, policy.type, policy.probe.kind]), [["app", "A", "http"]]);

    const history = await service.audit("example.com");
    assert.deepEqual(history.entries[0]?.detail.healthChecks, { added: 0, removed: 0, changed: 1 });
    assert.deepEqual(history.entries[1]?.detail.healthChecks, { added: 1, removed: 0, changed: 0 });

    await assert.rejects(service.deleteHealthCheck("example.com", "web", "A"), NotFoundError);
    const removed = await service.deleteHealthCheck("example.com", "App", "a", "alice", replaced.revision);
    assert.equal(removed.revision, replaced.revision + 1);
    assert.deepEqual((await service.listHealthChecks("example.com")).healthChecks, []);
    const internal = (await service.getZone("example.com")).views.find((view) => view.name === "internal");
    assert.equal(internal && "healthChecks" in internal, false, "the last delete leaves no empty list behind");
  });

  it("refuses a policy for an RRset that does not exist, and a record delete that would leave one", async () => {
    const { service } = setup();
    await zoneWithApp(service);
    await assert.rejects(service.setHealthCheck("example.com", { name: "web", type: "A", enabled: true, probe: tcp }), /no A record to protect/u);
    await assert.rejects(service.setHealthCheck("example.com", { name: "app", type: "AAAA", probe: tcp }), DomainValidationError);
    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp });

    // One of two addresses may go; the RRset survives.
    await service.deleteRecord("example.com", "internal", "app-2");
    await assert.rejects(service.deleteRecord("example.com", "internal", "app-1"), /no A record to protect/u);
    await service.deleteHealthCheck("example.com", "app", "A");
    await service.deleteRecord("example.com", "internal", "app-1");
  });

  it("refuses a full replacement that leaves the policies out, and removes them only when told", async () => {
    const { service } = setup();
    await zoneWithApp(service);
    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp });
    const zone = await service.getZone("example.com");
    const stripped = { views: zone.views.map((view) => ({ name: view.name, records: view.records })) };
    await assert.rejects(service.replaceDesiredState("example.com", stripped), /leaves out/u);
    assert.equal((await service.getZone("example.com")).revision, zone.revision, "nothing was committed");

    const kept = await service.replaceDesiredState("example.com", { views: zone.views });
    assert.equal((await service.listHealthChecks("example.com")).healthChecks.length, 1);
    const emptied = { views: zone.views.map((view) => ({ ...view, ...(view.name === "internal" ? { healthChecks: [] } : {}) })) };
    await service.replaceDesiredState("example.com", emptied, "system", kept.revision);
    assert.deepEqual((await service.listHealthChecks("example.com")).healthChecks, []);
  });

  it("refuses health checks on any view but the internal one", async () => {
    const { service } = setup();
    await zoneWithApp(service);
    const zone = await service.getZone("example.com");
    const views = [
      ...zone.views.filter((view) => view.name !== "external"),
      { name: "external", records: [], healthChecks: [{ name: "app", type: "A", enabled: true, probe: tcp }] },
    ];
    await assert.rejects(service.replaceDesiredState("example.com", { views }), /only on the internal view/u);
  });

  it("refuses an enabled policy where a provider publishes the internal view, and allows a disabled one", async () => {
    const { service } = setup("provider");
    await zoneWithApp(service);
    await assert.rejects(service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp }), (error: unknown) =>
      error instanceof ConflictError && /published to a provider/u.test(error.message));
    const disabled = await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: false, probe: tcp });
    assert.equal(disabled.healthCheck.enabled, false);
    assert.deepEqual(await service.zonesWithEnabledHealthChecks(), []);
  });

  it("fails closed when a process starts with a provider for a zone whose enabled policies were already stored", async () => {
    const adapters = createInMemoryAdapters();
    const clock = { now: () => new Date("2026-08-08T00:00:00.000Z") };
    const served = new ControlPlane(adapters.zones, adapters.statuses, adapters.provider, clock, undefined, {},
      (target) => target.endsWith("/internal") ? "listener" : "provider");
    await zoneWithApp(served);
    await served.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp });

    // The same stores, read by a process configured to publish the internal view.
    const restarted = new ControlPlane(adapters.zones, adapters.statuses, adapters.provider, clock, undefined, {}, () => "provider");
    await assert.rejects(restarted.preview("example.com", "internal"), (error: unknown) =>
      error instanceof ConflictError && /published to a provider/u.test(error.message));
    const applied = await restarted.apply("example.com");
    const internal = applied.statuses.find((status) => status.view === "internal");
    assert.equal(internal?.state, "failed");
    assert.match(internal?.error ?? "", /published to a provider/u);
    assert.deepEqual(await adapters.provider.list("example.com/internal"), [], "no address reached the provider");
    // A record edit that keeps the policy enabled is refused there too.
    await assert.rejects(restarted.upsertRecord("example.com", "internal", "app-3", { name: "app", type: "A", content: "10.0.0.13", ttl: 300 }),
      ConflictError);
  });

  it("holds enabled policies to the per-process address limit across every zone", async () => {
    const { service } = setup();
    await service.createZone("example.com");
    const records = Array.from({ length: MAX_HEALTH_CHECK_TARGETS }, (_, index) => ({
      id: `app-${index}`, name: "app", type: "A", content: `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`, ttl: 300,
    }));
    await service.replaceDesiredState("example.com", { views: [{ name: "external", records: [] }, { name: "internal", records }] });
    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp });

    await service.createZone("example.net");
    await service.upsertRecord("example.net", "internal", "web", { name: "web", type: "A", content: "10.0.0.11", ttl: 300 });
    await assert.rejects(service.setHealthCheck("example.net", { name: "web", type: "A", enabled: true, probe: tcp }), (error: unknown) =>
      error instanceof DomainValidationError && error.issues.some((issue) => issue.includes(`at most ${MAX_HEALTH_CHECK_TARGETS} addresses`)));
    // A disabled policy probes nothing and so takes no share of the limit.
    await service.setHealthCheck("example.net", { name: "web", type: "A", enabled: false, probe: tcp });
    assert.deepEqual(await service.zonesWithEnabledHealthChecks(), ["example.com"]);
  });

  it("keeps the policies through a record edit and a zone-file import", async () => {
    const { service } = setup();
    await zoneWithApp(service);
    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp });
    await service.upsertRecord("example.com", "internal", "app-2", { name: "app", type: "A", content: "10.0.0.13", ttl: 300 });
    assert.equal((await service.listHealthChecks("example.com")).healthChecks.length, 1);
    await service.importZoneFile("example.com", "internal", "app 300 IN A 10.0.0.11\n");
    assert.equal((await service.listHealthChecks("example.com")).healthChecks.length, 1);
    await assert.rejects(service.importZoneFile("example.com", "internal", "web 300 IN A 10.0.0.11\n"), /no A record to protect/u);
  });
});

/** Lets a test hold one repository write open while another replica runs. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

/** The zones repository, with the next commit held until the gate opens. */
function holdingNextCommit(zones: ZoneRepository, held: Promise<void>): { zones: ZoneRepository; arm: () => void; reached: Promise<void> } {
  let armed = false;
  let reach = (): void => {};
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const wrapped = new Proxy(zones, {
    get(target, property) {
      if (property === "commitDesiredChange") {
        return async (change: Parameters<ZoneRepository["commitDesiredChange"]>[0]) => {
          if (armed) {
            armed = false;
            reach();
            await held;
          }
          return target.commitDesiredChange(change);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { zones: wrapped, arm: () => { armed = true; }, reached };
}

/**
 * Settings the way the Postgres store keeps them: a write is serialized with
 * other writes, and a read outside it sees the last committed value at once
 * rather than waiting for a write in flight.
 */
class CommittedSettings implements SettingsRepository {
  #committed: Record<string, unknown> = {};
  #tail: Promise<unknown> = Promise.resolve();

  async read(): Promise<Record<string, unknown>> {
    return structuredClone(this.#committed);
  }

  async write(values: Record<string, unknown>): Promise<void> {
    await this.update(async () => ({ patch: values, result: undefined }));
  }

  update<T>(operation: (current: Record<string, unknown>) => Promise<SettingsRepositoryUpdate<T>>): Promise<T> {
    const result = this.#tail.then(async () => {
      const { patch, result: value } = await operation(structuredClone(this.#committed));
      this.#committed = { ...this.#committed, ...structuredClone(patch) };
      return value;
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function enabledAddresses(service: ControlPlane): Promise<number> {
  let total = 0;
  for (const name of await service.zonesWithEnabledHealthChecks()) {
    total += protectedRRsetsFor((await service.getZone(name)).views).rrsets
      .filter((rrset) => rrset.policy.enabled).reduce((sum, rrset) => sum + rrset.addresses.length, 0);
  }
  return total;
}

describe("health checks across replicas", () => {
  const clock = { now: () => new Date("2026-08-08T00:00:00.000Z") };
  const listener = (target: string) => target.endsWith("/internal") ? "listener" as const : "provider" as const;

  it("never stores more than the address limit when two replicas each add to a different zone", async () => {
    const shared = createInMemoryAdapters();
    const held = gate();
    const first = holdingNextCommit(shared.zones, held.wait);
    const one = new ControlPlane(first.zones, shared.statuses, shared.provider, clock, shared.applyLock, {}, listener);
    const two = new ControlPlane(shared.zones, shared.statuses, shared.provider, clock, shared.applyLock, {}, listener);

    await one.createZone("example.com");
    const records = Array.from({ length: MAX_HEALTH_CHECK_TARGETS - 1 }, (_, index) => ({
      id: `app-${index}`, name: "app", type: "A", content: `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`, ttl: 300,
    }));
    await one.replaceDesiredState("example.com", { views: [{ name: "external", records: [] }, { name: "internal", records }] });
    await one.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp });
    for (const [zone, address] of [["example.net", "10.0.0.11"], ["example.org", "10.0.0.12"]] as const) {
      await one.createZone(zone);
      await one.upsertRecord(zone, "internal", "web", { name: "web", type: "A", content: address, ttl: 300 });
    }
    assert.equal(await enabledAddresses(two), MAX_HEALTH_CHECK_TARGETS - 1);

    // Replica one has counted 63 + 1 and is about to save; replica two counts
    // while that save is still outstanding.
    first.arm();
    const added = one.setHealthCheck("example.net", { name: "web", type: "A", enabled: true, probe: tcp });
    await first.reached;
    const raced = two.setHealthCheck("example.org", { name: "web", type: "A", enabled: true, probe: tcp });
    await settle();
    held.open();
    const [kept, refused] = await Promise.allSettled([added, raced]);

    assert.equal(kept.status, "fulfilled");
    assert.equal(refused.status, "rejected");
    assert.ok(refused.status === "rejected" && refused.reason instanceof DomainValidationError
      && refused.reason.issues.some((issue) => issue.includes(`at most ${MAX_HEALTH_CHECK_TARGETS} addresses`)));
    assert.equal(await enabledAddresses(two), MAX_HEALTH_CHECK_TARGETS);
    assert.deepEqual(await two.zonesWithEnabledHealthChecks(), ["example.com", "example.net"]);
    // What was already there is untouched: the newcomer is refused, nothing evicted.
    assert.equal((await two.listHealthChecks("example.com")).healthChecks[0]?.enabled, true);
    assert.deepEqual((await two.listHealthChecks("example.org")).healthChecks, []);
  });

  it("lets a commit that leaves no enabled policy skip the shared lock", async () => {
    const shared = createInMemoryAdapters();
    const service = new ControlPlane(shared.zones, shared.statuses, shared.provider, clock, shared.applyLock, {}, listener);
    await zoneWithApp(service);
    const blocked = gate();
    const holding = service.withHealthCheckLock(() => blocked.wait);
    // A record edit and a disabled policy finish while the lock is held.
    await service.upsertRecord("example.com", "internal", "app-3", { name: "app", type: "A", content: "10.0.0.13", ttl: 300 });
    await service.setHealthCheck("example.com", { name: "app", type: "A", enabled: false, probe: tcp });
    // An enabled one waits for it.
    let enabled = false;
    const waiting = service.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp })
      .then(() => { enabled = true; });
    await settle();
    assert.equal(enabled, false);
    blocked.open();
    await holding;
    await waiting;
    assert.equal(enabled, true);
  });

  /**
   * The settings change and the policy write each read what the other is about
   * to change. Run on two replicas with nothing shared between them but the
   * stores and the lock, in both orders, and only one of them may land.
   */
  for (const order of ["settings first", "policy first"] as const) {
    it(`does not store the local provider beside an enabled policy when both race (${order})`, async () => {
      const shared = createInMemoryAdapters();
      const stored = new CommittedSettings();
      const held = gate();
      const policyZones = holdingNextCommit(shared.zones, held.wait);
      const policyReplica = new ControlPlane(policyZones.zones, shared.statuses, shared.provider, clock, shared.applyLock, {}, listener,
        { unsupported: async () => parseSettings(await stored.read()).allowLocalProvider });
      const settingsReplica = new ControlPlane(shared.zones, shared.statuses, shared.provider, clock, shared.applyLock, {}, listener,
        { unsupported: async () => parseSettings(await stored.read()).allowLocalProvider });
      let verifierRead = (): void => {};
      const verifierHasRead = new Promise<void>((resolve) => { verifierRead = resolve; });
      const settings = new SettingsService(stored, async (candidate, previous) => {
        if (candidate.allowLocalProvider && !previous.allowLocalProvider) {
          const zones = await settingsReplica.zonesWithEnabledHealthChecks();
          verifierRead();
          if (order === "settings first") await held.wait;
          if (zones.length > 0) throw new DomainValidationError([`would publish ${zones.join(", ")}`]);
        }
      }, undefined, (operation) => settingsReplica.withHealthCheckLock(operation));
      await settings.load();
      await zoneWithApp(policyReplica);

      let policy: Promise<unknown>;
      let change: Promise<unknown>;
      if (order === "settings first") {
        change = settings.update({ allowLocalProvider: true });
        await verifierHasRead;
        policyZones.arm();
        policy = policyReplica.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp });
      } else {
        policyZones.arm();
        policy = policyReplica.setHealthCheck("example.com", { name: "app", type: "A", enabled: true, probe: tcp });
        await policyZones.reached;
        change = settings.update({ allowLocalProvider: true });
      }
      await settle();
      held.open();
      const [policyResult, changeResult] = await Promise.allSettled([policy, change]);

      const local = parseSettings(await stored.read()).allowLocalProvider;
      const enabled = await settingsReplica.zonesWithEnabledHealthChecks();
      assert.equal([policyResult, changeResult].filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(local && enabled.length > 0, false, "the local provider and an enabled policy were both stored");
      if (order === "settings first") {
        assert.equal(local, true);
        assert.ok(policyResult.status === "rejected" && policyResult.reason instanceof ConflictError);
      } else {
        assert.deepEqual(enabled, ["example.com"]);
        assert.ok(changeResult.status === "rejected" && changeResult.reason instanceof DomainValidationError);
      }
    });
  }
});

describe("health check settings", () => {
  it("defaults to off with nothing allowed", () => {
    assert.equal(DEFAULT_SETTINGS.dnsHealthChecksEnabled, false);
    assert.deepEqual(DEFAULT_SETTINGS.dnsHealthCheckAllowCidrs, []);
    assert.deepEqual(DEFAULT_SETTINGS.dnsHealthCheckAllowPorts, []);
  });

  it("normalizes the allow-lists and refuses anything malformed", () => {
    const parsed = parseSettings({
      dnsHealthChecksEnabled: true,
      dnsHealthCheckAllowCidrs: [" 10.0.0.0/24", "10.0.0.0/24", "FD00::/8"],
      dnsHealthCheckAllowPorts: [8080, 443, 443],
    });
    assert.deepEqual(parsed.dnsHealthCheckAllowCidrs, ["10.0.0.0/24", "fd00::/8"]);
    assert.deepEqual(parsed.dnsHealthCheckAllowPorts, [443, 8080]);
    for (const invalid of [
      { dnsHealthChecksEnabled: "yes" },
      { dnsHealthCheckAllowCidrs: "10.0.0.0/24" },
      { dnsHealthCheckAllowCidrs: ["10.0.0.0/33"] },
      { dnsHealthCheckAllowCidrs: ["fe80::/10%en0"] },
      { dnsHealthCheckAllowCidrs: Array.from({ length: MAX_HEALTH_CHECK_ALLOW_CIDRS + 1 }, (_, index) => `10.${index}.0.0/16`) },
      { dnsHealthCheckAllowPorts: [0] },
      { dnsHealthCheckAllowPorts: [65_536] },
      { dnsHealthCheckAllowPorts: ["443"] },
    ]) {
      assert.throws(() => parseSettings(invalid), DomainValidationError, JSON.stringify(invalid).slice(0, 80));
    }
  });
});
