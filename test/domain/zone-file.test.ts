import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatZoneFile, parseZoneFile } from "../../src/domain/zone-file.ts";

describe("presentation-format zone files", () => {
  it("parses $ORIGIN, $TTL, comments, omitted owners and quoted TXT", () => {
    const records = parseZoneFile(`
$ORIGIN example.com.
$TTL 300
@ 60 IN A 8.8.8.8 ; apex
  60 IN TXT "v=spf1 -all"
www 120 IN A 8.8.8.9
mail IN MX 10 Mail.Example.NET.
`, "example.com");
    assert.deepEqual(records.map((record) => `${record.name} ${record.type} ${record.content} ${record.ttl}`), [
      "@ A 8.8.8.8 60",
      "@ TXT v=spf1 -all 60",
      "www A 8.8.8.9 120",
      "mail MX 10 mail.example.net 300",
    ]);
  });

  it("skips SOA and signer records so a BIND file still imports", () => {
    const records = parseZoneFile(`
$ORIGIN example.com.
@ 300 IN SOA ns.example.com. hostmaster.example.com. 1 3600 600 604800 60
@ 300 IN NS ns.example.com.
@ 300 IN RRSIG A 13 2 300 20300101000000 20200101000000 12345 example.com. YQ==
www 60 IN A 8.8.8.8
`, "example.com");
    assert.deepEqual(records.map((record) => `${record.name} ${record.type}`), ["@ NS", "www A"]);
  });

  it("round-trips through format and parse", () => {
    const original = parseZoneFile("$ORIGIN example.com.\nwww 60 IN A 8.8.8.8\n@ 60 IN TXT \"hello world\"\n", "example.com");
    const again = parseZoneFile(formatZoneFile("example.com", original), "example.com");
    assert.deepEqual(
      again.map((record) => `${record.name} ${record.type} ${record.content}`),
      original.map((record) => `${record.name} ${record.type} ${record.content}`),
    );
  });

  it("refuses an owner outside the apex", () => {
    assert.throws(() => parseZoneFile("other.example.net. 60 IN A 8.8.8.8\n", "example.com"), /outside/);
  });

  /**
   * What a real nameserver writes.
   *
   * BIND wraps anything long in parentheses -- a DNSKEY's base64, a DMARC TXT
   * split into two quoted strings -- and that is the ordinary output of
   * `dig axfr` and `named-compilezone`, not an exotic dialect. Every one of
   * these failed before, and the messages named the wrong cause: the
   * parentheses reached the RDATA content check, which refuses them as
   * zone-file structure.
   */
  describe("a file exported from a real nameserver", () => {
    it("joins a record wrapped across lines in parentheses", () => {
      const records = parseZoneFile(`$ORIGIN example.com.
$TTL 300
key     IN DNSKEY ( 257 3 13
                    mdsswUyr3DPW132mOi8V9xESWE8= )
_dmarc  IN TXT    ( "v=DMARC1; p=none;"
                    " rua=mailto:d@example.com" )
www     IN A      192.0.2.1
`, "example.com");
      assert.deepEqual(records.map((record) => `${record.name} ${record.type} ${record.content}`), [
        "key DNSKEY 257 3 13 mdsswUyr3DPW132mOi8V9xESWE8=",
        "_dmarc TXT v=DMARC1; p=none; rua=mailto:d@example.com",
        "www A 192.0.2.1",
      ]);
    });

    it("leaves parentheses inside a quoted string alone", () => {
      const [record] = parseZoneFile('@ 300 IN TXT "a (b) c"\n', "example.com");
      assert.equal(record?.content, "a (b) c");
    });

    it("refuses a parenthesis that is never closed", () => {
      assert.throws(() => parseZoneFile("key 300 IN DNSKEY ( 257 3 13\n", "example.com"), /unclosed/u);
    });

    /**
     * `validateRecordId` wants 1 to 36 characters starting with a letter or a
     * digit. The generated id used neither bound: an underscored owner began
     * with `_`, and the length was cut to 60.
     */
    it("names a record whose owner starts with an underscore", () => {
      const [record] = parseZoneFile("_acme-challenge 300 IN TXT \"token\"\n", "example.com");
      assert.equal(record?.name, "_acme-challenge");
      assert.match(record?.id ?? "", /^[a-z0-9][a-z0-9_-]{0,35}$/u);
    });

    it("names a record whose owner is longer than an id may be", () => {
      const owner = "a".repeat(60);
      const records = parseZoneFile(`${owner} 300 IN A 192.0.2.1\n${owner}2 300 IN A 192.0.2.2\n`, "example.com");
      assert.equal(records.length, 2);
      for (const record of records) assert.match(record.id, /^[a-z0-9][a-z0-9_-]{0,35}$/u);
      assert.notEqual(records[0]?.id, records[1]?.id, "two records may not share an id");
    });
  });
});
