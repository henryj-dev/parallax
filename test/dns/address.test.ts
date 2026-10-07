import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalAddress, isLoopbackAddress, isWildcardListener } from "../../src/dns/address.ts";

/** One spelling per address: the loop checks compare these, not what was typed. */
describe("address canonicalization", () => {
  it("compresses IPv6 and maps IPv4-mapped addresses to IPv4", () => {
    assert.equal(canonicalAddress("[2001:0DB8:0:0:0:0:0:10]"), "2001:db8::10");
    assert.equal(canonicalAddress("0:0:0:0:0:0:0:1"), "::1");
    assert.equal(canonicalAddress("::ffff:10.0.0.1"), "10.0.0.1");
    assert.equal(canonicalAddress("::ffff:a00:1"), "10.0.0.1");
  });

  /** Round-2 review: a zone id made the URL parser throw. */
  it("keeps a link-local zone id instead of throwing", () => {
    assert.equal(canonicalAddress("fe80:0:0:0:0:0:0:1%en0"), "fe80::1%en0");
  });

  it("leaves IPv4 and hostnames as they are, lowercased", () => {
    assert.equal(canonicalAddress("10.0.0.1"), "10.0.0.1");
    assert.equal(canonicalAddress("Upstream.Example"), "upstream.example");
  });

  it("knows loopback is a range and the wildcard has several spellings", () => {
    assert.equal(isLoopbackAddress("127.0.0.2"), true);
    assert.equal(isLoopbackAddress("[::1]"), true);
    assert.equal(isLoopbackAddress("10.0.0.1"), false);
    for (const host of ["0.0.0.0", "::", "[::]", "*"]) assert.equal(isWildcardListener(host), true, host);
    assert.equal(isWildcardListener("10.0.0.5"), false);
  });
});
