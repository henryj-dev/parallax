import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDesiredRecord, DomainValidationError, RECORD_TYPES } from "../../src/domain/dns.ts";

/** One valid and one invalid RDATA for every type, in presentation format. */
const SAMPLES: Record<string, { good: string; bad: string }> = {
  A: { good: "192.0.2.1", bad: "2001:db8::1" },
  AAAA: { good: "2001:db8::1", bad: "192.0.2.1" },
  CAA: { good: '0 issue "letsencrypt.org"', bad: "0 issue letsencrypt.org" },
  CERT: { good: "1 12345 8 aGVsbG8=", bad: "1 12345 8" },
  CNAME: { good: "origin.example.net", bad: "not a hostname" },
  DNAME: { good: "target.example.net", bad: "not a hostname" },
  DNSKEY: { good: "257 3 13 mdsswUyr3DPW132mOi8V9xESWE8=", bad: "257 3 13 not base64!" },
  // The bad one is well-formed except for its length: digest type 2 is SHA-256,
  // and a resolver refuses to parse an answer whose digest is not 32 bytes.
  DS: { good: "12345 8 2 abababababababababababababababababababababababababababababababab", bad: "12345 8 2 abab" },
  LOC: { good: "51 30 12.748 N 0 7 39.611 W 0.00m", bad: "51 30 12.748 0 7 39.611 0.00m" },
  HINFO: { good: '"Intel" "Linux"', bad: "Intel Linux" },
  HTTPS: { good: "1 . alpn=h2,h3", bad: "alpn=h2" },
  MX: { good: "10 mail.example.com", bad: "mail.example.com" },
  NAPTR: { good: '100 10 "s" "SIP+D2U" "" _sip._udp.example.com', bad: "100 10 s SIP+D2U" },
  NS: { good: "ns1.example.net", bad: "not a hostname" },
  OPENPGPKEY: { good: "aGVsbG8=", bad: "not base64!" },
  PTR: { good: "host.example.net", bad: "not a hostname" },
  SMIMEA: { good: "3 1 1 ab12cd34", bad: "3 1 1 zz" },
  SRV: { good: "10 5 443 host.example.net", bad: "10 5 host.example.net" },
  SSHFP: { good: "4 2 ab12cd34", bad: "4 2 nothex" },
  SVCB: { good: "1 svc.example.net", bad: "svc.example.net" },
  TLSA: { good: "3 1 1 ab12cd34", bad: "3 1 1" },
  TXT: { good: "v=spf1 -all", bad: "" },
  URI: { good: '10 1 "https://example.com/"', bad: "10 1 https://example.com/" },
};

describe("record types", () => {
  it("has a sample for every supported type, so none goes unexercised", () => {
    assert.deepEqual(Object.keys(SAMPLES).sort(), [...RECORD_TYPES].sort());
  });

  it("accepts well-formed RDATA and rejects RDATA of the wrong shape", () => {
    for (const [type, sample] of Object.entries(SAMPLES)) {
      const record = createDesiredRecord("probe", { name: "probe", type, content: sample.good, ttl: 300 });
      assert.equal(record.content, sample.good, `${type} should keep its content verbatim`);
      // Rejecting here is what stops a record being saved that only fails later,
      // at a provider, against a zone that may already be half published.
      assert.throws(
        () => createDesiredRecord("probe", { name: "probe", type, content: sample.bad, ttl: 300 }),
        (error: unknown) => error instanceof DomainValidationError,
        `${type} should reject ${JSON.stringify(sample.bad)}`,
      );
    }
  });

  it("names every type it will accept when given one it will not", () => {
    assert.throws(
      () => createDesiredRecord("probe", { name: "probe", type: "SOA", content: "x", ttl: 300 }),
      (error: DomainValidationError) => {
        // SOA and the DNSSEC records are the provider's to generate.
        assert.match(error.message, /type must be one of/);
        assert.match(error.message, /MX/);
        return true;
      },
    );
  });

  it("rejects zone-file control characters, structural tokens and directives in raw RDATA", () => {
    const vulnerable = {
      CAA: '0 issue "letsencrypt.org"',
      HINFO: '"Intel" "Linux"',
      HTTPS: "1 . alpn=h2,h3",
      NAPTR: '100 10 "s" "SIP+D2U" "" _sip._udp.example.com',
      SVCB: "1 svc.example.net alpn=h2",
      URI: '10 1 "https://example.com/"',
    } as const;
    for (const [type, content] of Object.entries(vulnerable)) {
      for (const suffix of [
        "\n@ 60 IN A 6.6.6.6",
        "\r\n$INCLUDE /etc/passwd",
        "; injected comment",
        " ($ORIGIN attacker.example)",
        "\u0000",
      ]) {
        assert.throws(
          () => createDesiredRecord("probe", { name: "probe", type, content: `${content}${suffix}`, ttl: 300 }),
          DomainValidationError,
          `${type} accepted ${JSON.stringify(suffix)}`,
        );
      }
    }

    // TXT is quoted by the CoreDNS adapter, so an ordinary semicolon remains
    // data; raw control characters are still rejected at the common boundary.
    assert.equal(createDesiredRecord("txt", {
      name: "@", type: "TXT", content: "v=DMARC1; p=none", ttl: 300,
    }).content, "v=DMARC1; p=none");
    assert.throws(() => createDesiredRecord("txt", {
      name: "@", type: "TXT", content: "first\nsecond", ttl: 300,
    }), DomainValidationError);
  });

  it("rejects presentation the wire encoder would refuse, and accepts CAA with ';' and a null MX", () => {
    assert.throws(
      () => createDesiredRecord("probe", { name: "@", type: "SVCB", content: "0 . alpn=h2", ttl: 300 }),
      DomainValidationError,
    );
    assert.throws(
      () => createDesiredRecord("probe", {
        name: "@", type: "NAPTR",
        content: '100 10 "s" "SIP+D2U" "" _sip._udp.example.com leftover',
        ttl: 300,
      }),
      DomainValidationError,
    );
    assert.equal(
      createDesiredRecord("caa", { name: "@", type: "CAA", content: '0 issue "ca.example.net; account=123"', ttl: 300 }).content,
      '0 issue "ca.example.net; account=123"',
    );
    assert.equal(
      createDesiredRecord("null-mx", { name: "@", type: "MX", content: "0 .", ttl: 300 }).content,
      "0 .",
    );
  });
});
