import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Zone } from "../../src/domain/dns.ts";
import { createReadinessMonitor, unservedTargets } from "../../src/http/readiness.ts";

function zone(name: string, views: string[]): Zone {
  return {
    name,
    revision: 1,
    views: views.map((view) => ({ name: view, records: [] })),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function zoneWithRecords(name: string, views: Zone["views"]): Zone {
  return {
    name,
    revision: 1,
    views,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const NOTHING_CONFIGURED = (): boolean => false;

describe("readiness", () => {
  it("serves a cached result without letting request volume repeat the full read", async () => {
    let reads = 0;
    const monitor = createReadinessMonitor(async () => {
      reads += 1;
      return [zone("example.com", ["internal"])];
    }, () => true, false);

    assert.equal(monitor.ready(), false, "startup is fail-closed until the first refresh");
    await monitor.refresh();
    for (let request = 0; request < 1_000; request += 1) assert.equal(monitor.ready(), true);
    assert.equal(reads, 1);
  });

  it("coalesces overlapping background refreshes and fails closed after an error", async () => {
    let finish!: (zones: readonly Zone[]) => void;
    let reads = 0;
    const monitor = createReadinessMonitor(() => {
      reads += 1;
      return new Promise<readonly Zone[]>((resolve) => { finish = resolve; });
    }, () => true, false);
    const first = monitor.refresh();
    const second = monitor.refresh();
    assert.equal(reads, 1);
    finish([]);
    await Promise.all([first, second]);
    assert.equal(monitor.ready(), true);

    const failing = createReadinessMonitor(async () => { throw new Error("offline"); }, () => true, false);
    failing.update([]);
    assert.equal(failing.ready(), true);
    await assert.rejects(() => failing.refresh(), /offline/);
    assert.equal(failing.ready(), false);
  });

  it("invalidates immediately and performs one trailing refresh after an in-flight scan", async () => {
    const finishes: Array<(zones: readonly Zone[]) => void> = [];
    let reads = 0;
    const monitor = createReadinessMonitor(() => {
      reads += 1;
      return new Promise<readonly Zone[]>((resolve) => { finishes.push(resolve); });
    }, () => true, false);

    const refresh = monitor.refresh();
    monitor.invalidate();
    assert.equal(monitor.ready(), false);
    assert.equal(monitor.refresh(), refresh, "callers share the active single flight");
    finishes[0]!([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 2, "many invalidations coalesce into one trailing scan");
    finishes[1]!([]);
    await refresh;
    assert.equal(monitor.ready(), true);
  });

  it("does not lose an invalidation in the refresh cleanup microtask", async () => {
    let finishFirst!: (zones: readonly Zone[]) => void;
    let reads = 0;
    const published: string[][] = [];
    const monitor = createReadinessMonitor(
      () => {
        reads += 1;
        if (reads === 1) return new Promise<readonly Zone[]>((resolve) => { finishFirst = resolve; });
        return Promise.resolve([zone("new.example", ["internal"])]);
      },
      () => true,
      false,
      { onZones: (zones) => published.push(zones.map((item) => item.name)) },
    );
    const refresh = monitor.refresh();
    finishFirst([zone("old.example", ["internal"])]);
    queueMicrotask(() => {
      monitor.invalidate();
      void monitor.refresh();
    });
    await refresh;

    assert.equal(reads, 2);
    assert.deepEqual(published.at(-1), ["new.example"]);
    assert.equal(monitor.ready(), true);
  });

  it("fails closed when the cached result is stale or provider routing changes", async () => {
    let time = 1_000;
    let configurationRevision = 1;
    const monitor = createReadinessMonitor(
      async () => [],
      () => true,
      false,
      { now: () => time, maxStalenessMs: 100, configurationRevision: () => configurationRevision },
    );
    await monitor.refresh();
    assert.equal(monitor.ready(), true);
    time += 101;
    assert.equal(monitor.ready(), false);

    time = 1_000;
    await monitor.refresh();
    configurationRevision += 1;
    assert.equal(monitor.ready(), false, "routing changes invalidate without storage I/O");
  });

  it("never treats the public API's first page as the complete readiness set", async () => {
    const zones = Array.from({ length: 501 }, (_, index) => zone(`zone-${index}.example`, ["external"]));
    const monitor = createReadinessMonitor(
      async () => zones,
      (target) => !target.startsWith("zone-500.example/"),
      false,
    );
    await monitor.refresh();
    assert.equal(monitor.ready(), false);
  });

  it("does not publish a scan made across a provider-configuration change", async () => {
    let revision = 1;
    const finishes: Array<(zones: readonly Zone[]) => void> = [];
    let reads = 0;
    const monitor = createReadinessMonitor(
      () => {
        reads += 1;
        return new Promise<readonly Zone[]>((resolve) => { finishes.push(resolve); });
      },
      () => true,
      false,
      { configurationRevision: () => revision },
    );
    const refresh = monitor.refresh();
    revision += 1;
    finishes[0]!([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 2);
    assert.equal(monitor.ready(), false);
    finishes[1]!([]);
    await refresh;
    assert.equal(monitor.ready(), true);
  });

  it("counts the internal view a public zone implies, even where nobody wrote one", () => {
    // Split-horizon materializes `internal` from `external`, so a zone with a
    // public view has an internal one to serve whether or not it was written.
    assert.deepEqual(
      unservedTargets([zone("example.com", ["external"])], NOTHING_CONFIGURED, false),
      ["example.com/external", "example.com/internal"],
    );
  });

  it("is satisfied by a configured provider", () => {
    const configured = (target: string): boolean => target === "example.com/internal";
    assert.deepEqual(unservedTargets([zone("example.com", ["internal"])], configured, false), []);
  });

  it("counts the built-in listener as serving the internal view", () => {
    // Without this a deployment that answers DNS itself instead of publishing
    // into CoreDNS or PowerDNS fails its readiness probe forever while
    // answering every query correctly, and is never sent traffic to prove it.
    const served = zoneWithRecords("example.com", [{
      name: "internal",
      records: [{ id: "web", name: "www", type: "A", content: "10.0.0.1", ttl: 60 }],
    }]);
    assert.deepEqual(unservedTargets([served], NOTHING_CONFIGURED, true), []);
  });

  it("does not report ready when an empty internal view is absent from the listener snapshot", async () => {
    const empty = zone("example.com", ["internal"]);
    assert.deepEqual(
      unservedTargets([empty], NOTHING_CONFIGURED, true),
      ["example.com/internal"],
    );

    const monitor = createReadinessMonitor(async () => [empty], NOTHING_CONFIGURED, true);
    await monitor.refresh();
    assert.equal(monitor.ready(), false);
  });

  it("reports an empty internal view ready when the listener can forward it", async () => {
    const empty = zone("example.com", ["internal"]);
    assert.deepEqual(
      unservedTargets([empty], NOTHING_CONFIGURED, true, true),
      [],
    );

    const monitor = createReadinessMonitor(
      async () => [empty],
      NOTHING_CONFIGURED,
      true,
      { forwardsEmptyInternalViews: true },
    );
    await monitor.refresh();
    assert.equal(monitor.ready(), true);
  });

  it("does not report ready when internal materialization fails and the listener skips the zone", async () => {
    const broken = zoneWithRecords("broken.example", [{
      name: "internal",
      records: [
        { id: "alias", name: "www", type: "CNAME", content: "target.example.net", ttl: 60 },
        { id: "address", name: "www", type: "A", content: "10.0.0.1", ttl: 60 },
      ],
    }]);
    assert.deepEqual(
      unservedTargets([broken], NOTHING_CONFIGURED, true, true),
      ["broken.example/internal"],
    );

    const monitor = createReadinessMonitor(
      async () => [broken],
      NOTHING_CONFIGURED,
      true,
      { forwardsEmptyInternalViews: true },
    );
    await monitor.refresh();
    assert.equal(monitor.ready(), false);
  });

  it("does not let the listener stand in for the external view", () => {
    // The listener answers the internal view and nothing else. A public zone
    // with no provider is still a zone nothing will publish.
    const served = zoneWithRecords("example.com", [{
      name: "external",
      records: [{ id: "web", name: "www", type: "A", content: "93.184.216.34", ttl: 300 }],
    }]);
    assert.deepEqual(
      unservedTargets([served], NOTHING_CONFIGURED, true),
      ["example.com/external"],
    );
  });

  it("reports every zone that is short, not only the first", () => {
    assert.deepEqual(
      unservedTargets(
        [zone("one.example", ["internal"]), zone("two.example", ["internal"])],
        NOTHING_CONFIGURED,
        false,
      ),
      ["one.example/internal", "two.example/internal"],
    );
  });

  it("has nothing to say about a deployment with no zones yet", () => {
    assert.deepEqual(unservedTargets([], NOTHING_CONFIGURED, false), []);
  });
});

describe("reporting how old the snapshot is", () => {
  // Freshness gates membership through `ready()`, and where one replica also
  // carries DNS that is a blunt instrument: going unready withdraws a resolver
  // that is still answering correctly. Reporting the number lets a deployment
  // alert on it instead of being withdrawn by it.
  it("says the age and the limit, and keeps saying it while ready", async () => {
    let clock = 1_000;
    const monitor = createReadinessMonitor(
      () => Promise.resolve([zone("example.com", ["external"])]),
      () => true,
      false,
      { now: () => clock, maxStalenessMs: 5_000 },
    );
    assert.deepEqual(monitor.staleness(), { ageMs: undefined, maxMs: 5_000 }, "before any read");

    await monitor.refresh();
    assert.deepEqual(monitor.staleness(), { ageMs: 0, maxMs: 5_000 });
    assert.ok(monitor.ready());

    clock += 3_000;
    assert.deepEqual(monitor.staleness(), { ageMs: 3_000, maxMs: 5_000 }, "reported while still ready");
    assert.ok(monitor.ready(), "three seconds is inside the window");

    clock += 3_000;
    assert.equal(monitor.staleness().ageMs, 6_000, "and keeps counting past the limit");
    assert.ok(!monitor.ready(), "six seconds is outside it");
  });
});

describe("the window it was handed", () => {
  /**
   * A guard nothing reached.
   *
   * `readConfig` rejects a bad value before it can arrive here, so from the
   * environment this throw is unreachable -- and coverage said so: the two lines
   * were the only ones in this file with no fixture. It still guards the direct
   * caller, which is how the tests and any future wiring construct the monitor,
   * so the answer is a fixture rather than deleting it.
   *
   * This is the mechanical half of "ask whether anything reaches that line
   * before trusting a mutation of it".
   */
  it("refuses a window that cannot mean anything", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createReadinessMonitor(() => Promise.resolve([]), () => true, false, { maxStalenessMs: bad }),
        /positive/u,
        `accepted ${String(bad)}`,
      );
    }
  });
});
