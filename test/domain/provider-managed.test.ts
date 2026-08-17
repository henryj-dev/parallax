import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDesiredRecord,
  DomainValidationError,
  providerManagement,
  readManagedByService,
  recordContentLabel,
  recordTypeLabel,
} from "../../src/domain/dns.ts";

describe("provider-managed records", () => {
  it("recognizes the placeholder address the provider uses for a name it serves itself", () => {
    const v6 = providerManagement({ type: "AAAA", content: "100::" });
    assert.ok(v6, "AAAA 100:: is the documented originless placeholder");
    assert.equal(v6.originless, true, "nobody can reach it, so no view can answer it");

    const v4 = providerManagement({ type: "A", content: "192.0.2.0" });
    assert.ok(v4);
    assert.equal(v4.originless, true);
  });

  it("reads the placeholder by value, not by spelling", () => {
    // The same address, written every way a provider might write it. Matching the
    // text would recognize the first and miss the rest, and the miss is silent:
    // the record answers with an address that goes nowhere.
    for (const written of ["100::", "0100::", "100:0:0:0:0:0:0:0", "0100:0000:0000:0000:0000:0000:0000:0000"]) {
      assert.equal(providerManagement({ type: "AAAA", content: written })?.originless, true, written);
    }
  });

  it("leaves documentation addresses alone, though the placeholder sits inside one", () => {
    // `192.0.2.0/24` and `2001:db8::/32` are documentation space and turn up in
    // fixtures and example zones meaning exactly what they say. Only the two
    // addresses the provider documents for originless setups are placeholders --
    // treating the blocks as placeholders would stop answering ordinary records.
    for (const content of ["192.0.2.1", "192.0.2.2", "198.51.100.7", "203.0.113.9"]) {
      assert.equal(providerManagement({ type: "A", content }), undefined, content);
    }
    assert.equal(providerManagement({ type: "AAAA", content: "2001:db8::1" }), undefined);
    assert.equal(providerManagement({ type: "AAAA", content: "100::1" }), undefined, "inside the prefix but not the address");
  });

  it("claims a record whose value still works, and says the value still works", () => {
    const managed = providerManagement({ type: "CNAME", content: "pub-1234.r2.dev" });
    assert.ok(managed);
    assert.equal(managed.originless, false, "the target resolves, so it is served as stored");
    assert.match(managed.reason, /r2\.dev/u, "the refusal names what owns it");

    assert.equal(providerManagement({ type: "CNAME", content: "PUB-1234.R2.DEV." })?.originless, false,
      "case and the trailing dot are presentation, not identity");
    assert.equal(providerManagement({ type: "CNAME", content: "origin.example.net" }), undefined);
    assert.equal(providerManagement({ type: "CNAME", content: "notr2.dev" }), undefined, "suffix, not substring");
  });

  it("does not claim ordinary records", () => {
    assert.equal(providerManagement({ type: "A", content: "10.17.192.11" }), undefined);
    assert.equal(providerManagement({ type: "AAAA", content: "2606:4700::1" }), undefined);
    assert.equal(providerManagement({ type: "TXT", content: "100::" }), undefined, "the text is not an address here");
  });

  it("claims a record a service publishes, whatever the DNS value happens to be", () => {
    // Nothing about the content says this. A Workers custom domain and a
    // hand-written CNAME are the same record over the DNS API -- the binding is
    // the only thing that tells them apart, so it is the thing that locks.
    const worker = providerManagement({
      type: "CNAME", content: "origin.example.net",
      managedBy: { service: "worker", resource: "tinyuniverse-dashboard" },
    });
    assert.ok(worker, "the binding claims the record");
    assert.match(worker.reason, /Worker tinyuniverse-dashboard/u, "the refusal names what to go and change");
    assert.equal(worker.originless, false, "the service answers, so the name still resolves");

    assert.equal(providerManagement({ type: "CNAME", content: "origin.example.net" }), undefined,
      "the same content with no binding is an ordinary record");
  });

  it("keeps who owns a record separate from whether anyone can reach it", () => {
    // Cloudflare stores a Workers custom domain as a proxied AAAA holding the
    // placeholder -- so the label arriving must not make the address look
    // reachable. `originless` is what tells the internal resolver to relay an
    // address query, and turning it off for these names answers `100::` inside.
    const apex = providerManagement({
      type: "AAAA", content: "100::",
      managedBy: { service: "worker", resource: "tinyuniverse-dashboard" },
    });
    assert.ok(apex);
    assert.match(apex.reason, /Worker tinyuniverse-dashboard/u, "the owner is the service");
    assert.equal(apex.originless, true, "and the address is still one nobody can reach");

    // An R2 custom domain is a CNAME to a name that does resolve, so the same
    // rule reaches the opposite answer -- from the value, not from the label.
    const bucket = providerManagement({
      type: "CNAME", content: "public.r2.dev",
      managedBy: { service: "r2", resource: "tnuv-static" },
    });
    assert.equal(bucket?.originless, false);
  });

  it("shows a service record as the service, and everything else as its type", () => {
    const bucket = { id: "assets", name: "static", type: "CNAME" as const, content: "public.r2.dev", ttl: 1,
      managedBy: { service: "r2" as const, resource: "tnuv-static" } };
    assert.equal(recordTypeLabel(bucket), "R2");
    assert.equal(recordContentLabel(bucket), "tnuv-static", "the bucket, not the value it is stored as");

    const plain = { id: "web", name: "www", type: "A" as const, content: "8.8.8.10", ttl: 300 };
    assert.equal(recordTypeLabel(plain), "A");
    assert.equal(recordContentLabel(plain), "8.8.8.10");
  });

  it("refuses a binding it cannot read rather than dropping it", () => {
    // A dropped binding is a record that silently became editable, which is the
    // one failure this whole mechanism exists to prevent.
    assert.equal(readManagedByService(undefined), undefined);
    assert.deepEqual(readManagedByService({ service: "R2", resource: "tnuv-static" }),
      { service: "r2", resource: "tnuv-static" });
    for (const broken of [
      { service: "pages", resource: "site" },
      { service: "worker" },
      { service: "worker", resource: "" },
      { service: "worker", resource: "has space" },
      "worker",
      [],
    ]) {
      assert.throws(() => readManagedByService(broken), DomainValidationError, JSON.stringify(broken));
    }
  });

  it("carries a binding through the round trip that rebuilds every stored record", () => {
    // Every record read back from storage is rebuilt by this function. A field
    // it dropped would be a lock that holds until the next restart.
    const record = createDesiredRecord("dash", {
      name: "www", type: "CNAME", content: "origin.example.net", ttl: 300,
      managedBy: { service: "worker", resource: "tinyuniverse-dashboard" },
    });
    assert.deepEqual(record.managedBy, { service: "worker", resource: "tinyuniverse-dashboard" });
    assert.ok(providerManagement(record), "and it is locked on the way back out");
  });
});
