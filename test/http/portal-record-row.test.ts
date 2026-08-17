import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordRow } from "../../public/panels.js";
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
