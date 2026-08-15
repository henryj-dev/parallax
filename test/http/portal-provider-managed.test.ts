import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { providerManagement, type RecordType } from "../../src/domain/dns.ts";
import { providerManagedReason, readRecords } from "../../public/store.js";

/**
 * The portal decides whether to offer a delete button, and the server decides
 * whether to honour it. Those are two copies of one rule, and a rule with two
 * copies drifts: the portal offers what the server refuses, or hides what it
 * would have allowed. Neither shows up in a test of either half alone.
 *
 * So both are run over the same table. The cases are not chosen to be easy --
 * they include the spellings and near-misses that a second implementation gets
 * wrong first.
 */
const CASES: readonly { type: RecordType; content: string; managed: boolean }[] = [
  { type: "AAAA", content: "100::", managed: true },
  { type: "AAAA", content: "0100::", managed: true },
  { type: "AAAA", content: "100:0:0:0:0:0:0:0", managed: true },
  { type: "AAAA", content: "0100:0000:0000:0000:0000:0000:0000:0000", managed: true },
  { type: "AAAA", content: "100::1", managed: false },
  { type: "AAAA", content: "2001:db8::1", managed: false },
  { type: "AAAA", content: "2606:4700::1", managed: false },
  { type: "A", content: "192.0.2.0", managed: true },
  { type: "A", content: "192.0.2.1", managed: false },
  { type: "A", content: "10.17.192.11", managed: false },
  { type: "CNAME", content: "pub-1234.r2.dev", managed: true },
  { type: "CNAME", content: "PUB-1234.R2.DEV.", managed: true },
  { type: "CNAME", content: "notr2.dev", managed: false },
  { type: "CNAME", content: "origin.example.net", managed: false },
  { type: "TXT", content: "100::", managed: false },
];

describe("portal and domain agree on which records the provider owns", () => {
  it("classifies every case the same way on both sides", () => {
    for (const testCase of CASES) {
      const server = providerManagement({ type: testCase.type, content: testCase.content }) !== undefined;
      const portal = providerManagedReason({ type: testCase.type, content: testCase.content }) !== "";
      assert.equal(server, testCase.managed, `server: ${testCase.type} ${testCase.content}`);
      assert.equal(portal, testCase.managed, `portal: ${testCase.type} ${testCase.content}`);
    }
  });

  it("marks the row the portal renders, so the lock reaches the button", () => {
    const rows = readRecords({
      views: [{
        name: "external",
        records: [
          { id: "apex", name: "@", type: "AAAA", content: "100::", ttl: 300 },
          { id: "web", name: "www", type: "A", content: "8.8.8.10", ttl: 300 },
        ],
      }],
    });
    const apex = rows.find((row) => row.id === "apex");
    const web = rows.find((row) => row.id === "web");
    assert.equal(apex?.views.external.managed, "originless");
    assert.equal(web?.views.external.managed, "", "an ordinary record stays editable");
  });

  it("leaves a record that exists only inside unmarked", () => {
    // An internal override is the portal's own record, whatever it holds. The
    // flag is read off the external record, and there is none here.
    const rows = readRecords({
      views: [{ name: "internal", records: [{ id: "apex", name: "@", type: "AAAA", content: "100::", ttl: 60 }] }],
    });
    assert.equal(rows[0]?.views.external.managed, "");
  });
});
