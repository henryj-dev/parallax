import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ZoneRepository } from "../../src/application/ports.ts";
import type { AuditEntry, Zone } from "../../src/domain/dns.ts";
import { watchingZones } from "../../src/dns/zone-changes.ts";

function zone(name = "example.com"): Zone {
  return { name, revision: 1, views: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

/** Records what was called, and lets a call be held open or made to fail. */
function repository(): { spy: ZoneRepository; calls: string[]; durable: string[] } {
  const calls: string[] = [];
  const durable: string[] = [];
  const write = async (what: string): Promise<void> => {
    calls.push(what);
    durable.push(what);
  };
  const spy: ZoneRepository = {
    list: async () => { calls.push("list"); return []; },
    get: async () => { calls.push("get"); return undefined; },
    listRevisions: async () => { calls.push("listRevisions"); return []; },
    getRevision: async () => { calls.push("getRevision"); return undefined; },
    appendAudit: async (entry) => { calls.push("appendAudit"); return { ...entry, id: 1 } as AuditEntry; },
    audit: async () => { calls.push("audit"); return []; },
    save: () => write("save"),
    saveRevision: () => write("saveRevision"),
    commitDesiredChange: () => write("commitDesiredChange"),
    commitZoneDeletion: () => write("commitZoneDeletion"),
    delete: () => write("delete"),
  };
  return { spy, calls, durable };
}

describe("zone change notification", () => {
  it("fires for every way a zone can change", async () => {
    // Named one by one rather than by wrapping whatever looks like a write: a
    // method added later that changes zones and is not listed here is a change
    // the DNS listener would not hear about until its next refresh.
    const { spy } = repository();
    const changes: string[] = [];
    const watched = watchingZones(spy, () => changes.push("changed"));

    await watched.save(zone());
    await watched.saveRevision(zone());
    await watched.commitDesiredChange({ zone: zone(), audit: { zone: "example.com" } } as never);
    await watched.commitZoneDeletion({ zone: "example.com" } as never);
    await watched.delete("example.com");
    assert.equal(changes.length, 5);
  });

  it("stays quiet for reads and for the audit trail", async () => {
    // Re-reading the whole desired state on a read would turn one query into
    // two, and an audit entry changes nothing a query can observe.
    const { spy } = repository();
    let changes = 0;
    const watched = watchingZones(spy, () => { changes += 1; });

    await watched.list();
    await watched.get("example.com");
    await watched.listRevisions("example.com");
    await watched.getRevision("example.com", 1);
    await watched.audit();
    await watched.appendAudit({ zone: "example.com" } as never);
    assert.equal(changes, 0);
  });

  it("says so only once the write is durable", async () => {
    // A snapshot taken in response must never be able to read state older than
    // the change that prompted it.
    const { spy, durable } = repository();
    const seen: string[][] = [];
    const watched = watchingZones(spy, () => seen.push([...durable]));
    await watched.save(zone());
    assert.deepEqual(seen, [["save"]]);
  });

  it("does not announce a write that failed", async () => {
    const failing: ZoneRepository = {
      ...repository().spy,
      save: async () => { throw new Error("the store is unreachable"); },
    };
    let changes = 0;
    const watched = watchingZones(failing, () => { changes += 1; });
    await assert.rejects(() => watched.save(zone()), /unreachable/);
    assert.equal(changes, 0, "nothing changed, so nothing is re-read");
  });

  it("passes reads and writes through to the repository underneath", async () => {
    const { spy, calls } = repository();
    const watched = watchingZones(spy, () => undefined);
    await watched.list();
    await watched.save(zone());
    await watched.audit();
    assert.deepEqual(calls, ["list", "save", "audit"]);
  });
});
