import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { effectiveExternalTtl, formatTtl, isValidDnsOnlyTtl } from "../../public/ttl.js";

describe("portal Cloudflare TTL controls", () => {
  it("forces proxied records to Auto while preserving valid DNS-only values", () => {
    assert.equal(effectiveExternalTtl(3600, true), 1);
    assert.equal(effectiveExternalTtl(3600, false), 3600);
    assert.equal(formatTtl(1), "Auto");
    assert.equal(formatTtl(300), "300s");
    assert.equal(isValidDnsOnlyTtl(1), true);
    assert.equal(isValidDnsOnlyTtl(59), false);
    assert.equal(isValidDnsOnlyTtl(60), true);
    assert.equal(isValidDnsOnlyTtl(86_400), true);
    assert.equal(isValidDnsOnlyTtl(86_401), false);
  });
});
