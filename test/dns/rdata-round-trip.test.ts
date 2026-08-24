import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeRdata, UnrepresentableRdata } from "../../src/dns/rdata-decode.ts";
import { encodeRdata } from "../../src/dns/rdata.ts";
import { RECORD_TYPES, type RecordType } from "../../src/domain/dns.ts";

/**
 * The decoder is pinned to the encoder, type by type.
 *
 * A decoder that disagrees with the encoder about one type does not fail --
 * it changes a record's content on the way in, and the next reconcile writes
 * the changed value back to the provider as though an operator had asked for
 * it. There is no error and no log line. This is the only cheap defence, and
 * it is a strong one: encode, decode, encode again, and require both the text
 * and the bytes to come back identical.
 *
 * ⚠️ `RECORD_TYPES` drives the table, so adding a type to the domain without a
 * decoder fails here rather than at the first AXFR of a zone that holds one.
 */

/** Canonical content per type: the exact text the decoder is expected to emit. */
const CANONICAL: Readonly<Record<RecordType, readonly string[]>> = {
  A: ["192.0.2.10", "255.255.255.255", "0.0.0.0"],
  AAAA: [
    "2001:db8::1",
    "::1",
    "::",
    "2001:db8:0:1:1:1:1:1",
    // Two runs of zeros, and only the longer one collapses (RFC 5952 §4.2.3):
    // `2001:0:0:1:0:0:0:1` keeps its pair written out and hides its triple.
    "2001:0:0:1::1",
    // ⚠️ Two runs of the *same* length, where the rule is that the first one
    // is shortened. A mutation check found nothing covering this -- with every
    // other sample, picking the last equal-length run gives the same answer.
    "2001::1:0:0:1:1",
    "1::2:0:0:3:4",
    "fe80::1234:5678:9abc:def0",
  ],
  CNAME: ["origin.example.net", "a.very.long.name.example.com"],
  NS: ["ns1.example.net"],
  PTR: ["host.example.net"],
  DNAME: ["target.example.net"],
  TXT: [
    "v=spf1 -all",
    "",
    // Past 255 bytes, so the encoder splits and the decoder must join.
    "d".repeat(300),
    "quotes \" and \\ backslashes",
  ],
  MX: ["10 mx.example.net", "0 ."],
  SRV: ["10 20 8443 target.example.net"],
  CAA: ['0 issue "letsencrypt.org"', '128 iodef "mailto:security@example.com"', '0 issue "ca.example.net; account=123"'],
  TLSA: ["3 1 1 0123456789abcdef"],
  SMIMEA: ["3 0 1 abcdef0123456789"],
  SSHFP: ["4 2 0123456789abcdef0123456789abcdef01234567"],
  URI: ['10 1 "https://example.com/path"'],
  CERT: ["1 2 3 aGVsbG8="],
  OPENPGPKEY: ["aGVsbG8gd29ybGQ="],
  HINFO: ['"amd64" "linux"', '"a \\"quoted\\" cpu" "os"'],
  NAPTR: ['100 10 "s" "SIP+D2U" "" _sip._udp.example.com', '100 10 "u" "E2U+sip" "!^.*$!sip:info@example.com!" .'],
  SVCB: ["1 svc.example.net alpn=h2,h3 port=8443", "0 alias.example.net", "1 . mandatory=alpn alpn=h2 no-default-alpn ipv4hint=192.0.2.1,192.0.2.2"],
  // Parameters are listed in **key order**, which is the order they go on the
  // wire whatever order they were written in -- ech(5), ipv6hint(6), dohpath(7).
  // So a decoded record is canonical even where the operator wrote it otherwise,
  // and reconciliation does not read the reordering as drift.
  HTTPS: ["1 . alpn=h2", "1 svc.example.net ech=aGVsbG8= ipv6hint=2001:db8::1 dohpath=/dns-query", "1 . key65535=opaque"],
  DS: ["12345 8 2 0123456789abcdef"],
  DNSKEY: ["257 3 8 aGVsbG8="],
  LOC: [
    "37 30 0 N 127 0 0 E 38m 1m 10000m 10m",
    "0 0 0 N 0 0 0 E 0m 1m 10000m 10m",
    "51 30 12.5 N 0 7 39.9 W 100m 10m 10000m 10m",
  ],
};

/** A record's rdata inside a message, which is where the decoder expects it. */
function framed(rdata: Buffer): { message: Buffer; start: number } {
  // Twelve bytes of header in front, so an offset of zero can never pass by
  // accident and a stray compression pointer has somewhere wrong to land.
  const message = Buffer.concat([Buffer.alloc(12), rdata]);
  return { message, start: 12 };
}

describe("presentation format survives the wire and back", () => {
  it("covers every type the domain accepts", () => {
    assert.deepEqual(
      RECORD_TYPES.filter((type) => (CANONICAL[type] ?? []).length === 0),
      [],
      "a record type has no round-trip sample, so its decoder is unproven",
    );
  });

  for (const type of RECORD_TYPES) {
    describe(type, () => {
      for (const content of CANONICAL[type]) {
        it(`round-trips ${JSON.stringify(content)}`, () => {
          const encoded = encodeRdata(type, content);
          const { message, start } = framed(encoded);
          const decoded = decodeRdata(type, message, start, encoded.length);

          assert.equal(decoded, content, "the decoder emitted different text");
          // ...and the text it emitted is text the encoder takes back to the
          // same bytes. Equal strings could still both be wrong; equal bytes
          // after a second pass is what closes that.
          assert.deepEqual(encodeRdata(type, decoded), encoded, "re-encoding the decoded text changed the bytes");
        });
      }
    });
  }

  /**
   * The lossy one, which is lossy in the format rather than in this code.
   *
   * RFC 1876 stores each size as one mantissa digit and a power of ten, so 1m
   * and 1.004m are the same byte. The round trip is therefore against what a
   * resolver reads back, not against what was written -- and this pins that
   * distinction so nobody later "fixes" the decoder to return the input.
   */
  it("LOC sizes come back as the format can express them, not as they were written", () => {
    const encoded = encodeRdata("LOC", "37 30 0 N 127 0 0 E 38m 1.004m 10000m 10m");
    const { message, start } = framed(encoded);
    assert.match(decodeRdata("LOC", message, start, encoded.length), /\s1m\s/u);
  });

  it("refuses rdata whose length does not match what the type reads", () => {
    const encoded = encodeRdata("A", "192.0.2.1");
    const { message, start } = framed(encoded);
    assert.throws(() => decodeRdata("A", message, start, 3), /ended early|runs past/u);
    // Trailing bytes are refused too: a decoder that stopped early would
    // silently drop whatever a newer type put after the part it knows.
    const padded = framed(Buffer.concat([encoded, Buffer.of(0)]));
    assert.throws(() => decodeRdata("A", padded.message, padded.start, 5), /were understood/u);
  });

  /**
   * Bytes this encoder would never have produced.
   *
   * 🔑 The round-trip table above **cannot** catch any of these, and not by
   * accident: every sample there starts life in `encodeRdata`, so the table
   * enforces exactly the assumption the decoder was making -- that the bytes
   * came from us. Each case below was a silent content change against a real
   * foreign zone, and every one of them passed the round-trip suite.
   *
   * The rule they all serve: emit only text `encodeRdata` takes back to the
   * same bytes, and where that is impossible say so rather than emit something
   * that looks like content.
   */
  describe("rdata this encoder would never have written", () => {
    const framed = (rdata: Buffer): { message: Buffer; length: number } =>
      ({ message: Buffer.concat([Buffer.alloc(12), rdata]), length: rdata.length });
    const decode = (type: RecordType, rdata: Buffer): string => {
      const { message, length } = framed(rdata);
      return decodeRdata(type, message, 12, length);
    };
    const refuses = (type: RecordType, rdata: Buffer, pattern: RegExp, what: string): void => {
      assert.throws(() => decode(type, rdata), (error: Error) => {
        assert.ok(error instanceof UnrepresentableRdata, `${what} should be unrepresentable, not malformed: ${error.name}`);
        assert.match(error.message, pattern);
        return true;
      }, what);
    };

    it("keeps two TXT strings from becoming one", () => {
      // RFC 6763 §6.1 gives each string its own meaning, so joining them read a
      // DNS-SD record's two keys as one.
      refuses("TXT", Buffer.from([3, 97, 98, 99, 3, 100, 101, 102]), /several strings/u, "two short TXT strings");
      // ...while the encoder's own 255-byte split still joins, because that is
      // one value the wire had to cut.
      const long = encodeRdata("TXT", "d".repeat(300));
      assert.equal(decode("TXT", long), "d".repeat(300));
    });

    it("refuses octets that are not text rather than replacing them", () => {
      // `toString("utf8")` turns an invalid byte into U+FFFD, and one byte into
      // three -- so the content changed and a 255-byte string grew past what
      // the encoder can write.
      refuses("TXT", Buffer.from([3, 0x61, 0xff, 0x62]), /not text/u, "a TXT with a raw octet");
      refuses("HINFO", Buffer.from([2, 0x61, 0xff, 2, 0x62, 0x63]), /not text/u, "a HINFO with a raw octet");
      refuses("URI", Buffer.from([0, 10, 0, 1, 0xff]), /not text/u, "a URI with a raw octet");
    });

    it("refuses a CAA tag that is not letters and digits", () => {
      // A tag with a space decoded to text the encoder read as two fields and
      // silently shortened by a byte.
      refuses("CAA", Buffer.concat([Buffer.of(0, 6), Buffer.from("issue "), Buffer.from("x")]), /letters and digits/u, "a CAA tag with a space");
      refuses("CAA", Buffer.concat([Buffer.of(0, 0), Buffer.from("v")]), /letters and digits/u, "an empty CAA tag");
    });

    it("refuses a comma inside one SVCB value, which would split it in two", () => {
      // RFC 9460 Appendix A.1 escapes it as `\,`; this encoder splits on commas
      // without reading escapes, so one alpn-id `h2,3` became two.
      const alpn = Buffer.concat([Buffer.of(0, 1, 0), Buffer.of(0, 1, 0, 5), Buffer.of(4, 0x68, 0x32, 0x2c, 0x33)]);
      refuses("SVCB", alpn, /comma inside/u, "an alpn-id containing a comma");
    });

    it("ignores parameters on the alias form instead of failing the transfer", () => {
      // RFC 9460 §2.4.2: "recipients MUST ignore any SvcParams that are
      // present". Refusing them failed a whole zone transfer over one record in
      // somebody else's zone.
      const alias = Buffer.concat([Buffer.of(0, 0, 0), Buffer.of(0, 1, 0, 3), Buffer.of(2, 0x68, 0x32)]);
      assert.equal(decode("SVCB", alias), "0 .");
    });

    it("writes an IPv4-mapped address the way the encoder reads it back", () => {
      // Bytes round-trip either way; text did not. An operator who wrote
      // `::ffff:192.0.2.1` read `::ffff:c000:201` off the wire, and
      // reconciliation saw drift on every cycle forever.
      const mapped = Buffer.concat([Buffer.alloc(10), Buffer.of(0xff, 0xff), Buffer.of(192, 0, 2, 1)]);
      assert.equal(decode("AAAA", mapped), "::ffff:192.0.2.1");
      assert.deepEqual(encodeRdata("AAAA", decode("AAAA", mapped)), mapped);
    });

    it("refuses a field the encoder requires and this record leaves empty", () => {
      refuses("SSHFP", Buffer.of(1, 1), /no data/u, "an SSHFP with no fingerprint");
      refuses("CERT", Buffer.of(0, 1, 0, 0, 5), /no data/u, "a CERT with no certificate");
      refuses("OPENPGPKEY", Buffer.alloc(0), /no data/u, "an empty OPENPGPKEY");
      refuses("DS", Buffer.of(0, 1, 8, 2), /no data/u, "a DS with no digest");
    });

    it("refuses a mandatory list that a receiver is entitled to reject", () => {
      const mandatory = (bytes: readonly number[]): Buffer =>
        Buffer.concat([Buffer.of(0, 1, 0), Buffer.of(0, 0, 0, bytes.length), Buffer.from(bytes)]);
      // RFC 9460 §8: sorted, distinct, and never naming `mandatory` itself.
      refuses("SVCB", mandatory([0, 3, 0, 1]), /sorted list of distinct/u, "an unsorted mandatory list");
      refuses("SVCB", mandatory([0, 1, 0, 1]), /sorted list of distinct/u, "a repeated key");
      refuses("SVCB", mandatory([0, 0]), /names itself/u, "mandatory naming itself");
      refuses("SVCB", mandatory([]), /names nothing/u, "an empty mandatory list");
    });

    it("refuses a name carrying whitespace, which would shift every field after it", () => {
      // The encoder splits on whitespace before it reads anything: loud for MX,
      // and silent for SVCB, where it moves the parameter list along by one.
      const label = Buffer.from("mail server");
      const target = Buffer.concat([Buffer.of(label.length), label, Buffer.of(7), Buffer.from("example"), Buffer.of(3), Buffer.from("com"), Buffer.of(0)]);
      refuses("MX", Buffer.concat([Buffer.of(0, 10), target]), /whitespace/u, "an MX target with a space in a label");
    });

    it("refuses LOC values outside the ranges the format defines", () => {
      const loc = (bytes: readonly number[]): Buffer => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16 - bytes.length)]);
      // RFC 1876 §2: each nibble is zero to nine. The encoder clamps the
      // mantissa at 9, so anything above came back a different size.
      refuses("LOC", loc([0, 0x1f, 0x16, 0x13]), /size outside/u, "a LOC size with a nibble above nine");
      const far = Buffer.concat([Buffer.of(0, 0x12, 0x16, 0x13), Buffer.of(0xff, 0xff, 0xff, 0xff), Buffer.alloc(8)]);
      refuses("LOC", far, /latitude outside/u, "a LOC latitude past the pole");
    });
  });

  /**
   * The rules that only fire on bytes this build did not write.
   *
   * ⚠️ Added after a mutation check found them unreachable: every sample above
   * comes from `encodeRdata`, which sorts parameters and never emits whitespace
   * in one, so deleting the guards changed nothing. A guard no test can reach
   * is a guard nobody knows is broken -- and these exist precisely for the
   * other server's bytes.
   */
  describe("what another server may send that cannot be written back", () => {
    /** SVCB rdata assembled by hand: priority, target, then raw parameters. */
    function svcb(parameters: readonly { key: number; value: Buffer }[]): { message: Buffer; length: number } {
      const head = Buffer.concat([Buffer.of(0, 1), Buffer.of(0)]);
      const encoded = parameters.map(({ key, value }) => {
        const header = Buffer.alloc(4);
        header.writeUInt16BE(key, 0);
        header.writeUInt16BE(value.length, 2);
        return Buffer.concat([header, value]);
      });
      const rdata = Buffer.concat([head, ...encoded]);
      return { message: Buffer.concat([Buffer.alloc(12), rdata]), length: rdata.length };
    }

    it("refuses parameters that are not in ascending key order", () => {
      // port(3) before alpn(1). The encoder always sorts, so this could never
      // be written back the way it arrived -- and silently reordering it would
      // make every reconcile see drift that is not there.
      const { message, length } = svcb([
        { key: 3, value: Buffer.of(0x1f, 0x90) },
        { key: 1, value: Buffer.concat([Buffer.of(2), Buffer.from("h2")]) },
      ]);
      assert.throws(() => decodeRdata("SVCB", message, 12, length), /ascending key order/u);
    });

    it("refuses a repeated key, which the encoder also refuses", () => {
      const { message, length } = svcb([
        { key: 1, value: Buffer.concat([Buffer.of(2), Buffer.from("h2")]) },
        { key: 1, value: Buffer.concat([Buffer.of(2), Buffer.from("h3")]) },
      ]);
      assert.throws(() => decodeRdata("SVCB", message, 12, length), /ascending key order/u);
    });

    it("refuses a parameter value carrying whitespace", () => {
      // `dohpath` is bytes, and the encoder splits fields on whitespace before
      // it looks at anything -- so this value cannot survive the round trip.
      const { message, length } = svcb([{ key: 7, value: Buffer.from("/dns query") }]);
      assert.throws(() => decodeRdata("SVCB", message, 12, length), /whitespace/u);
    });

    it("refuses a LOC version it does not understand", () => {
      const rdata = Buffer.alloc(16);
      rdata.writeUInt8(1, 0);
      const message = Buffer.concat([Buffer.alloc(12), rdata]);
      assert.throws(() => decodeRdata("LOC", message, 12, rdata.length), /version 1/u);
    });

    it("refuses a control character in a value that has to be quoted", () => {
      // CAA: flag, tag length, tag, then the value as raw bytes.
      const rdata = Buffer.concat([Buffer.of(0), Buffer.of(5), Buffer.from("issue"), Buffer.from("ca\u0007example")]);
      const message = Buffer.concat([Buffer.alloc(12), rdata]);
      assert.throws(() => decodeRdata("CAA", message, 12, rdata.length), /control character/u);
    });
  });

  it("follows a compression pointer in a name, which is what an AXFR sends", () => {
    // `origin.example.net` written once, then an MX whose name is a pointer to it.
    const target = Buffer.concat([
      Buffer.of(6), Buffer.from("origin"), Buffer.of(7), Buffer.from("example"), Buffer.of(3), Buffer.from("net"), Buffer.of(0),
    ]);
    const message = Buffer.concat([Buffer.alloc(12), target, Buffer.of(0, 10, 0xc0, 12)]);
    const start = 12 + target.length;
    assert.equal(decodeRdata("MX", message, start, 4), "10 origin.example.net");
  });
});
