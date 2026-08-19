import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RECORD_TYPES, type RecordType } from "../../src/domain/dns.ts";
import { encodeRdata, encodeSoa, rrType } from "../../src/dns/rdata.ts";
import { WireFormatError } from "../../src/dns/wire.ts";

/**
 * One record of every type the domain accepts, in the presentation format it
 * stores, beside the bytes that type puts on the wire.
 *
 * The list is checked against `RECORD_TYPES` below rather than trusted, because
 * the failure this guards against is a type being added to the domain, validated
 * and published, while the server that has to answer for it has no encoder and
 * drops the record.
 */
const SAMPLES: Record<RecordType, { content: string; wire: string }> = {
  A: { content: "192.0.2.1", wire: "c0000201" },
  AAAA: { content: "2001:db8::1", wire: "20010db8000000000000000000000001" },
  CAA: { content: '0 issue "letsencrypt.org"', wire: "000569737375656c657473656e63727970742e6f7267" },
  CERT: { content: "1 12345 8 aGVsbG8=", wire: "000130390868656c6c6f" },
  CNAME: { content: "origin.example.net", wire: "066f726967696e076578616d706c65036e657400" },
  DNAME: { content: "target.example.net", wire: "06746172676574076578616d706c65036e657400" },
  DNSKEY: { content: "257 3 13 mdsswUyr3DPW132mOi8V9xESWE8=", wire: "0101030d99db2cc14cabdc33d6d77da63a2f15f71112584f" },
  DS: { content: "12345 8 2 abababababababababababababababababababababababababababababababab", wire: "30390802abababababababababababababababababababababababababababababababab" },
  // RFC 1876's own example. The three size bytes are the defaults it names, and
  // the coordinates are unsigned offsets from the equator and the meridian.
  LOC: { content: "51 30 12.748 N 0 7 39.611 W 0.00m", wire: "001216138b0d2c8c7ff8fca500989680" },
  HINFO: { content: '"Intel" "Linux"', wire: "05496e74656c054c696e7578" },
  HTTPS: { content: "1 . alpn=h2,h3", wire: "00010000010006026832026833" },
  MX: { content: "10 mail.example.com", wire: "000a046d61696c076578616d706c6503636f6d00" },
  NAPTR: {
    content: '100 10 "s" "SIP+D2U" "" _sip._udp.example.com',
    wire: "0064000a0173075349502b44325500045f736970045f756470076578616d706c6503636f6d00",
  },
  NS: { content: "ns1.example.net", wire: "036e7331076578616d706c65036e657400" },
  OPENPGPKEY: { content: "aGVsbG8=", wire: "68656c6c6f" },
  PTR: { content: "host.example.net", wire: "04686f7374076578616d706c65036e657400" },
  SMIMEA: { content: "3 1 1 ab12cd34", wire: "030101ab12cd34" },
  SRV: { content: "10 5 443 host.example.net", wire: "000a000501bb04686f7374076578616d706c65036e657400" },
  SSHFP: { content: "4 2 ab12cd34", wire: "0402ab12cd34" },
  SVCB: { content: "1 svc.example.net", wire: "000103737663076578616d706c65036e657400" },
  TLSA: { content: "3 1 1 ab12cd34", wire: "030101ab12cd34" },
  TXT: { content: "v=spf1 -all", wire: "0b763d73706631202d616c6c" },
  URI: { content: '10 1 "https://example.com/"', wire: "000a000168747470733a2f2f6578616d706c652e636f6d2f" },
};

describe("RDATA encoding", () => {
  it("has an encoder and a sample for every type the domain accepts", () => {
    // The domain's list is the contract: a type it validates and a provider
    // publishes is a type a query can arrive for.
    assert.deepEqual(Object.keys(SAMPLES).sort(), [...RECORD_TYPES].sort());
    for (const type of RECORD_TYPES) {
      assert.ok(encodeRdata(type, SAMPLES[type].content).length > 0, `${type} encoded to nothing`);
    }
  });

  it("encodes each type to the bytes its RFC puts on the wire", () => {
    for (const type of RECORD_TYPES) {
      assert.equal(encodeRdata(type, SAMPLES[type].content).toString("hex"), SAMPLES[type].wire, type);
    }
  });

  it("encodes an IPv4-mapped AAAA the same as its hex form", () => {
    const dotted = encodeRdata("AAAA", "::ffff:192.0.2.1");
    const hexForm = encodeRdata("AAAA", "::ffff:c000:0201");
    assert.equal(dotted.toString("hex"), hexForm.toString("hex"));
    assert.equal(dotted.toString("hex"), "00000000000000000000ffffc0000201");
  });

  it("encodes a dotted IPv4 tail in an HTTPS ipv6hint", () => {
    const dotted = encodeRdata("HTTPS", "1 . ipv6hint=::ffff:192.0.2.1");
    const hexForm = encodeRdata("HTTPS", "1 . ipv6hint=::ffff:c000:0201");
    assert.equal(dotted.toString("hex"), hexForm.toString("hex"));
    assert.doesNotMatch(dotted.toString("hex"), /00000000000000000000000000000000$/u);
  });

  it("splits a TXT value longer than one character-string, as every provider does", () => {
    // A 420-byte DKIM key is the ordinary case, not the exotic one: it goes on
    // the wire as two strings and means one value.
    const encoded = encodeRdata("TXT", "a".repeat(300));
    assert.equal(encoded[0], 255);
    assert.equal(encoded[256], 45);
    assert.equal(encoded.length, 1 + 255 + 1 + 45);
  });

  it("encodes an empty TXT value as one empty character-string", () => {
    assert.equal(encodeRdata("TXT", "").toString("hex"), "00");
  });

  it("encodes SVCB parameters in ascending key order, whatever order they were written in", () => {
    // A receiver is entitled to reject them out of order, so the wire order is
    // not the order the operator typed.
    assert.equal(
      encodeRdata("HTTPS", "1 . port=8443 alpn=h2 no-default-alpn").toString("hex"),
      "0001" + "00" + "00010003026832" + "00020000" + "0003000220fb",
    );
  });

  it("encodes the SVCB alias form, which takes a target and no parameters", () => {
    assert.equal(encodeRdata("SVCB", "0 svc.example.net").toString("hex"), "000003737663076578616d706c65036e657400");
  });

  it("encodes SVCB address hints as addresses rather than as text", () => {
    assert.equal(
      encodeRdata("HTTPS", "1 . ipv4hint=192.0.2.1,192.0.2.2").toString("hex"),
      "0001" + "00" + "0004" + "0008" + "c0000201" + "c0000202",
    );
    assert.equal(
      encodeRdata("HTTPS", "1 . ipv6hint=2001:db8::1").toString("hex"),
      "0001" + "00" + "0006" + "0010" + "20010db8000000000000000000000001",
    );
  });

  it("refuses RDATA it cannot encode rather than emitting something shorter", () => {
    // Every one of these would otherwise become a record that resolves to the
    // wrong answer, which is worse than one that does not resolve.
    const rejected: [RecordType, string][] = [
      ["A", "2001:db8::1"],
      ["A", "192.0.2.300"],
      ["AAAA", "192.0.2.1"],
      ["MX", "mail.example.com"],
      ["MX", "70000 mail.example.com"],
      ["SRV", "10 5 host.example.net"],
      ["SSHFP", "4 2 nothex"],
      ["TLSA", "3 1 1 abc"],
      ["CERT", "1 12345 8 not base64!"],
      ["HINFO", "Intel Linux"],
      ["URI", "10 1 https://example.com/"],
      ["NAPTR", "100 10 s SIP+D2U"],
      ["HTTPS", "1 . port=notanumber"],
      ["HTTPS", "1 . ipv4hint=example.com"],
      ["SVCB", "notanumber ."],
    ];
    for (const [type, content] of rejected) {
      assert.throws(
        () => encodeRdata(type, content),
        (error: unknown) => error instanceof WireFormatError,
        `${type} should refuse ${JSON.stringify(content)}`,
      );
    }
  });

  it("builds the SOA from its parts, carrying the serial and the negative TTL", () => {
    const soa = encodeSoa("ns.example.com", "hostmaster.example.com", 7, 60);
    const numbers = soa.subarray(soa.length - 20);
    assert.equal(numbers.readUInt32BE(0), 7);
    assert.equal(numbers.readUInt32BE(16), 60, "the last field is how long a resolver may cache an absent name");
  });

  it("gives every domain type a wire code", () => {
    for (const type of RECORD_TYPES) {
      assert.equal(typeof rrType(type), "number", type);
    }
    assert.equal(rrType("A"), 1);
    assert.equal(rrType("HTTPS"), 65);
    assert.equal(rrType("CAA"), 257);
  });
});
