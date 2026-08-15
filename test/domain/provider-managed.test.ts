import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { providerManagement } from "../../src/domain/dns.ts";

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
});
