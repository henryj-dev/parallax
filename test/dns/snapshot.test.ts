import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Zone } from "../../src/domain/dns.ts";
import { servedZones } from "../../src/dns/snapshot.ts";

function zone(views: Zone["views"], name = "example.com", revision = 4): Zone {
  return { name, revision, views, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

describe("served zone snapshot", () => {
  it("serves the internal view, composed from the external baseline", () => {
    const served = servedZones([zone([
      {
        name: "external",
        records: [
          { id: "web", name: "www", type: "A", content: "93.184.216.34", ttl: 300 },
          { id: "mail", name: "@", type: "MX", content: "10 mx.example.net", ttl: 300 },
        ],
      },
      { name: "internal", records: [{ id: "web-internal", name: "www", type: "A", content: "10.0.0.5", ttl: 60 }] },
    ])]);

    assert.equal(served.length, 1);
    assert.equal(served[0]?.name, "example.com");
    assert.equal(served[0]?.serial, 4, "the revision is the serial");
    const records = served[0]?.records ?? [];
    // The override replaces the public address, and everything not overridden
    // is still answered for -- that is what split horizon means here.
    assert.deepEqual(records.filter((record) => record.name === "www").map((record) => record.content), ["10.0.0.5"]);
    assert.deepEqual(records.filter((record) => record.type === "MX").map((record) => record.content), ["10 mx.example.net"]);
  });

  it("leaves out a zone whose internal view is empty, rather than answering NXDOMAIN for all of it", () => {
    // An empty internal view is the normal state right after adopting a zone.
    // Claiming authority for it would take the whole zone down internally at
    // the moment somebody added it.
    assert.deepEqual(servedZones([zone([{ name: "external", records: [] }, { name: "internal", records: [] }])]), []);
    assert.deepEqual(servedZones([zone([])]), []);
  });

  it("answers with the external baseline for a name no internal override replaces", () => {
    // A zone with no overrides at all still resolves internally to what the
    // public view says, which is what makes an override a change to one name
    // rather than a second zone somebody has to keep in step.
    const served = servedZones([zone([
      { name: "external", records: [{ id: "web", name: "www", type: "A", content: "93.184.216.34", ttl: 300 }] },
    ])]);
    assert.deepEqual(served[0]?.records.map((record) => record.content), ["93.184.216.34"]);
  });

  it("leaves out a zone it cannot compose, and says which one", () => {
    const skipped: string[] = [];
    const broken = zone([
      {
        name: "internal",
        records: [
          { id: "a", name: "www", type: "CNAME", content: "one.example.net", ttl: 60 },
          { id: "b", name: "www", type: "A", content: "10.0.0.1", ttl: 60 },
        ],
      },
    ]);
    // A CNAME cannot share a name with another record, so this zone has no
    // answer. Refusing the whole zone sends its names to the forwarder; making
    // one up would be this server disagreeing with the state it was given.
    assert.deepEqual(servedZones([broken], (name) => skipped.push(name)), []);
    assert.deepEqual(skipped, ["example.com"]);
  });

  it("keeps the zones it can serve when another one is broken", () => {
    const good = zone([{ name: "internal", records: [{ id: "a", name: "www", type: "A", content: "10.0.0.1", ttl: 60 }] }], "good.example");
    const bad = zone([{
      name: "internal",
      records: [
        { id: "a", name: "www", type: "CNAME", content: "one.example.net", ttl: 60 },
        { id: "b", name: "www", type: "A", content: "10.0.0.1", ttl: 60 },
      ],
    }], "bad.example");
    assert.deepEqual(servedZones([bad, good]).map((served) => served.name), ["good.example"]);
  });
});
