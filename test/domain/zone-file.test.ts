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
});
