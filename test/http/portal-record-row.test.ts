import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordOwnership, recordRow } from "../../public/panels.js";
import { readRecords } from "../../public/store.js";

/**
 * What the record table says, and what it offers.
 *
 * The store's tests already prove a row gets flagged as provider-owned. Nothing
 * proved the flag removed a button, because the decision lived in a template
 * string: the row could have kept its edit control through any of these changes
 * and every test would still have passed, while the page offered an action the
 * server refuses -- the exact defect shape `panels.js` was created for.
 */
const ZONE = {
  views: [
    {
      name: "external",
      records: [
        { id: "root", name: "@", type: "AAAA", content: "100::", ttl: 1, proxied: true, managedBy: { service: "worker", resource: "tinyuniverse-dashboard" } },
        { id: "apps", name: "static-apps", type: "CNAME", content: "public.r2.dev", ttl: 1, proxied: true, managedBy: { service: "r2", resource: "tnuv-static" } },
        { id: "counter", name: "counter", type: "A", content: "158.247.220.150", ttl: 300, proxied: true },
        { id: "mail", name: "@", type: "MX", content: "21 route3.mx.cloudflare.net", ttl: 1 },
      ],
    },
    { name: "internal", records: [{ id: "counter", name: "counter", type: "A", content: "10.17.192.11", ttl: 300 }] },
  ],
};

const rows = readRecords(ZONE);
const rowFor = (id: string) => {
  const record = rows.find((candidate) => candidate.id === id);
  assert.ok(record, `no row for ${id}`);
  return recordRow(record, rows);
};

describe("a row the provider owns", () => {
  it("offers nothing, because nothing here can change it", () => {
    assert.deepEqual(rowFor("root").actions, []);
    assert.deepEqual(rowFor("apps").actions, []);
    assert.equal(rowFor("root").locked, true);
  });

  it("names the service on both sides, not the value it is stored as", () => {
    const worker = rowFor("root");
    assert.equal(worker.typeLabel, "Worker");
    assert.equal(worker.inside.text, "tinyuniverse-dashboard");
    assert.equal(worker.outside.text, "tinyuniverse-dashboard");
    // `100::` is the one answer the internal resolver never gives: it relays an
    // address query for this name to the public answer. Showing it inside stated
    // something no client receives.
    assert.equal(worker.stored, "100::", "the stored value is still carried, for the hover");
    assert.notEqual(worker.inside.text, worker.stored);

    const bucket = rowFor("apps");
    assert.equal(bucket.typeLabel, "R2");
    assert.equal(bucket.inside.text, "tnuv-static");
    assert.equal(bucket.outside.text, "tnuv-static");
  });

  it("keeps the proxy badge on the side that is proxied", () => {
    // Proxying is a property of the external record. On the internal answer it
    // would be false, and the two sides showing the same text is not a reason
    // to attach it to both.
    assert.equal(rowFor("root").outside.proxied, true);
    assert.equal(Object.hasOwn(rowFor("root").inside, "proxied"), false);
  });

  it("is never marked as inheriting, since both sides say the same thing", () => {
    assert.equal(rowFor("root").inside.inherited, false);
  });
});

describe("who owns each record at the provider", () => {
  const zone = {
    views: [{
      name: "external",
      records: [
        { id: "mine", name: "www", type: "A", content: "203.0.113.1", ttl: 300 },
        { id: "theirs", name: "mail", type: "A", content: "203.0.113.2", ttl: 300 },
        { id: "new", name: "api", type: "A", content: "203.0.113.3", ttl: 300 },
        { id: "inside-only", name: "admin", type: "A", content: "", ttl: 300 },
      ],
    }],
  };
  const plan = {
    views: {
      external: {
        actual: [
          { name: "www", type: "A", content: "203.0.113.1", managed: true },
          { name: "mail", type: "A", content: "203.0.113.2", managed: false },
        ],
      },
    },
  };

  it("tells a record of ours from somebody else's that says the same thing", () => {
    // The whole reason this exists. Both produce no operation, so a plan shows
    // them identically -- and an operator may rewrite the first while touching
    // the second breaks a binding this control plane did not make.
    const owners = recordOwnership(readRecords(zone), plan);
    assert.equal(owners.get("mine"), "ours");
    assert.equal(owners.get("theirs"), "theirs");
  });

  it("says a record is not published rather than not ours", () => {
    // It will be ours, once applied. Calling it "theirs" would be backwards.
    assert.equal(recordOwnership(readRecords(zone), plan).get("new"), "absent");
  });

  it("does not call an edit against somebody else's record unpublished", () => {
    // The case that made the first version of this lie. The value no longer
    // matches what the provider holds, so there is no exact match -- but the
    // provider does hold that name, and it is not ours, so applying reports a
    // conflict and writes nothing. `not published` promised the opposite.
    const edited = readRecords({
      views: [{ name: "external", records: [{ id: "theirs", name: "mail", type: "A", content: "203.0.113.99", ttl: 300 }] }],
    });
    assert.equal(recordOwnership(edited, plan).get("theirs"), "contested");
  });

  it("calls an edit to our own record ours, because applying updates it", () => {
    // Same shape, opposite answer, decided by who holds the name: an RRset this
    // control plane owns is one it may rewrite.
    const edited = readRecords({
      views: [{ name: "external", records: [{ id: "mine", name: "www", type: "A", content: "203.0.113.98", ttl: 300 }] }],
    });
    assert.equal(recordOwnership(edited, plan).get("mine"), "ours");
  });

  it("says nothing at all until the provider has been read", () => {
    // An empty verdict must never render as "not ours": that is an invitation to
    // the exact edit the badge exists to prevent.
    assert.equal(recordOwnership(readRecords(zone), null).size, 0);
    assert.equal(recordOwnership(readRecords(zone), { views: {} }).size, 0);
    // A view whose provider could not be read carries no list, which is not the
    // same answer as a provider that holds nothing.
    assert.equal(recordOwnership(readRecords(zone), { views: { external: { error: "provider could not be read" } } }).size, 0);
    assert.equal(recordOwnership(readRecords(zone), { views: { external: { actual: [] } } }).get("mine"), "absent",
      "a provider that answered and holds nothing is a different thing, and does have a verdict");
  });

  it("passes over a row that answers nothing on this side", () => {
    // There is nothing at the provider for a row that describes nothing there.
    assert.equal(recordOwnership(readRecords(zone), plan).has("inside-only"), false);
  });
});

describe("an ordinary row", () => {
  it("keeps both actions", () => {
    assert.deepEqual(rowFor("counter").actions, ["edit", "delete"]);
    assert.deepEqual(rowFor("mail").actions, ["edit", "delete"]);
    assert.equal(rowFor("counter").locked, false);
  });

  it("shows its own internal answer where it has one", () => {
    const inside = rowFor("counter").inside;
    assert.equal(inside.text, "10.17.192.11");
    assert.equal(inside.inherited, false, "an override is the row's own answer, not an inherited one");
  });

  it("inherits the external answer where it has none, and says it is inherited", () => {
    const mail = rowFor("mail");
    assert.equal(mail.inside.text, "21 route3.mx.cloudflare.net");
    assert.equal(mail.inside.inherited, true);
    assert.equal(mail.typeLabel, "MX", "a plain record is still its DNS type");
  });

  it("reports an RRset override rather than an answer, where the name has one elsewhere", () => {
    // Two records at one name and type, one of them overridden inside: this row
    // cannot inherit, because the name's internal answer belongs to the RRset.
    const [overridden] = readRecords({
      views: [
        {
          name: "external",
          records: [
            { id: "a", name: "web", type: "A", content: "203.0.113.1", ttl: 300 },
            { id: "b", name: "web", type: "A", content: "203.0.113.2", ttl: 300 },
          ],
        },
        { name: "internal", records: [{ id: "b", name: "web", type: "A", content: "10.0.0.9", ttl: 300 }] },
      ],
    });
    assert.ok(overridden);
    const row = recordRow(overridden, readRecords({
      views: [
        { name: "external", records: [{ id: "a", name: "web", type: "A", content: "203.0.113.1", ttl: 300 }] },
        { name: "internal", records: [{ id: "b", name: "web", type: "A", content: "10.0.0.9", ttl: 300 }] },
      ],
    }));
    assert.equal(row.inside.text, "");
    assert.equal(row.inside.absent, "overridden");
  });

  it("says which message stands in when a side has no answer at all", () => {
    const [inner] = readRecords({
      views: [{ name: "internal", records: [{ id: "only", name: "inside", type: "A", content: "10.0.0.1", ttl: 60 }] }],
    });
    assert.ok(inner);
    const row = recordRow(inner, [inner]);
    assert.equal(row.outside.text, "");
    assert.equal(row.outside.absent, "noAnswer");
    assert.deepEqual(row.actions, ["edit", "delete"], "a record that exists only inside is still ours");
  });
});
