import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  MAX_MARKER_LENGTH,
  MAX_RECORD_ID_LENGTH,
  ownershipComment,
  readOwnershipComment,
} from "../../src/adapters/ownership.ts";
import { DomainValidationError, validateRecordId } from "../../src/domain/dns.ts";

const SECRET = "an-ownership-secret-of-at-least-32-bytes";

/** The version 2 marker, as it still sits in live CoreDNS zone files. */
function version2(target: string, recordId: string): string {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET).update(target).update("\0").update(recordId).digest("base64url");
  return `parallax-managed:v2:${encode(target)}:${encode(recordId)}:${signature}`;
}

describe("ownership marker", () => {
  it("stays within the provider's limit whatever the zone is called", () => {
    // Version 2 carried the target, so the marker grew with the zone's name and
    // silently crossed Cloudflare's 100-character comment limit -- every create
    // and update against `tinytools.work` failed with HTTP 400, and no local
    // test could see it because a stubbed fetch accepts any string.
    const zones = ["a.io", "tinytools.work", "bottlecollection.app", `${"a".repeat(60)}.example`];
    const lengths = new Set(zones.map((zone) => ownershipComment(`${zone}/external`, "verify", SECRET).length));
    assert.equal(lengths.size, 1, `length varied by zone: ${[...lengths].join(", ")}`);
    assert.ok([...lengths][0]! <= MAX_MARKER_LENGTH);

    for (const zone of zones) {
      assert.ok(version2(`${zone}/external`, "verify").length > MAX_MARKER_LENGTH === (zone.length > 10),
        `version 2 length assumption changed for ${zone}`);
    }
  });

  it("fits a record id of the maximum length the domain allows, and no more", () => {
    const longest = "a".repeat(MAX_RECORD_ID_LENGTH);
    assert.equal(ownershipComment("example.com/external", longest, SECRET).length, MAX_MARKER_LENGTH);
    // The domain refuses anything longer, so the marker cannot be asked to
    // exceed the limit through the only input that varies.
    assert.equal(validateRecordId(longest), longest);
    assert.throws(() => validateRecordId(`${longest}a`), DomainValidationError);
  });

  it("recognizes its own marker and refuses one written for another target", () => {
    const comment = ownershipComment("example.com/external", "www", SECRET);
    assert.deepEqual(readOwnershipComment(comment, SECRET, "example.com/external"), { recordId: "www" });
    assert.equal(readOwnershipComment(comment, SECRET, "example.com/internal"), undefined);
    assert.equal(readOwnershipComment(comment, SECRET, "other.com/external"), undefined);
    assert.equal(readOwnershipComment(comment, "a-different-secret-of-at-least-32-bytes", "example.com/external"), undefined);
  });

  it("still reads markers written before the format changed", () => {
    // Every record adopted under version 2 would otherwise become unmanaged, and
    // the next apply would try to create what is already there.
    const target = "example.com/internal";
    const legacy = version2(target, "www");
    assert.deepEqual(readOwnershipComment(legacy, SECRET, target), { recordId: "www" });
    assert.equal(readOwnershipComment(legacy, SECRET, "example.com/external"), undefined);
    assert.equal(readOwnershipComment(`${legacy.slice(0, -3)}AAA`, SECRET, target), undefined);
    // A zone file carries it after a `;`, surrounded by whitespace.
    assert.deepEqual(readOwnershipComment(` ${legacy} `, SECRET, target), { recordId: "www" });
  });

  it("writes the current format", () => {
    assert.match(ownershipComment("example.com/external", "www", SECRET), /^parallax-managed:v3:www:/);
  });

  it("refuses a secret too short to sign with", () => {
    assert.throws(() => ownershipComment("example.com/external", "www", "short"), /at least 32 bytes/);
    assert.throws(() => readOwnershipComment("anything", "short", "example.com/external"), /at least 32 bytes/);
  });
});
