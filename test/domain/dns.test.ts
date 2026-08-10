import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDesiredRecord, DomainValidationError, effectiveExternalTtl, isGlobalUnicastAddress, normalizeExternalRecords, normalizeZoneName, validateExternalRecords } from "../../src/domain/dns.ts";

describe("DNS desired state validation", () => {
  it("normalizes zones and accepts all MVP record types", () => {
    assert.equal(normalizeZoneName(" Example.COM. "), "example.com");
    assert.equal(createDesiredRecord("web", { name: "@", type: "A", content: "192.0.2.1", ttl: 60 }).type, "A");
    assert.equal(createDesiredRecord("v6", { name: "@", type: "AAAA", content: "2001:db8::1", ttl: 60 }).type, "AAAA");
    assert.equal(createDesiredRecord("alias", { name: "www", type: "CNAME", content: "example.com.", ttl: 300 }).type, "CNAME");
    assert.equal(createDesiredRecord("text", { name: "@", type: "TXT", content: "hello", ttl: 300 }).type, "TXT");
  });

  it("rejects invalid type-specific content, TTL and proxy settings together", () => {
    assert.throws(
      () => createDesiredRecord("bad", { name: "@", type: "TXT", content: "", ttl: 0, proxied: true }),
      (error) => error instanceof DomainValidationError
        && error.issues.some((issue) => issue.includes("TXT content"))
        && error.issues.some((issue) => issue.includes("ttl"))
        && error.issues.some((issue) => issue.includes("proxied")),
    );
  });

  it("canonicalizes host-like values and rejects proxy fields on TXT", () => {
    assert.equal(createDesiredRecord("alias", { name: "www", type: "CNAME", content: "Example.COM.", ttl: 60 }).content, "example.com");
    assert.equal(createDesiredRecord("v6", { name: "@", type: "AAAA", content: "2001:0db8:0:0:0:0:0:1", ttl: 60 }).content, "2001:db8::1");
    assert.throws(() => createDesiredRecord("txt", { name: "@", type: "TXT", content: "ok", ttl: 60, proxied: false }), /proxied/);
  });

  it("classifies private and reserved addresses as non-global and requires explicit external acknowledgement", () => {
    assert.equal(isGlobalUnicastAddress("8.8.8.8"), true);
    assert.equal(isGlobalUnicastAddress("2001:4860:4860::8888"), true);
    for (const address of ["10.0.0.1", "192.0.2.1", "127.0.0.1", "fc00::1", "2001:db8::1"]) {
      assert.equal(isGlobalUnicastAddress(address), false, address);
    }
    const unsafe = createDesiredRecord("private", { name: "app", type: "A", content: "10.0.0.1", ttl: 60 });
    assert.throws(() => validateExternalRecords([unsafe]), /acknowledgeNonGlobalIp/);
    assert.doesNotThrow(() => validateExternalRecords([
      createDesiredRecord("private", { ...unsafe, acknowledgeNonGlobalIp: true }),
    ]));
  });

  it("uses Cloudflare Auto TTL for proxied records and validates DNS-only limits", () => {
    const proxied = createDesiredRecord("web", { name: "www", type: "A", content: "8.8.8.8", ttl: 3600, proxied: true });
    assert.equal(createDesiredRecord("auto", { name: "auto", type: "CNAME", content: "example.com", ttl: 120, proxied: true }).ttl, 1);
    // Auto TTL replaces the requested value, but only after it is a TTL this
    // control plane would have accepted on its own.
    for (const ttl of [0, -5, 3.7, "300"]) {
      assert.throws(
        () => createDesiredRecord("auto", { name: "auto", type: "CNAME", content: "example.com", ttl, proxied: true }),
        /ttl must be an integer/,
        `proxied ttl ${String(ttl)}`,
      );
    }
    assert.equal(effectiveExternalTtl(proxied), 1);
    assert.equal(normalizeExternalRecords([proxied])[0]?.ttl, 1);

    for (const ttl of [1, 60, 86_400]) {
      assert.doesNotThrow(() => validateExternalRecords([
        createDesiredRecord("dns", { name: "www", type: "A", content: "8.8.8.8", ttl, proxied: false }),
      ]));
    }
    for (const ttl of [2, 59, 86_401]) {
      assert.throws(() => validateExternalRecords([
        createDesiredRecord("dns", { name: "www", type: "A", content: "8.8.8.8", ttl, proxied: false }),
      ]), /Auto.*60.*86400/);
    }
  });
});
