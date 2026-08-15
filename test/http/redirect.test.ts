import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redirectLocation } from "../../src/http/redirect.ts";

describe("HTTP redirect target", () => {
  it("uses only the configured public origin", () => {
    assert.equal(
      redirectLocation("https://dns.example.com", "/records?next=https://evil.example"),
      "https://dns.example.com/records?next=https://evil.example",
    );
    assert.equal(new URL(redirectLocation("https://dns.example.com", "//evil.example/path")).host, "dns.example.com");
    assert.throws(() => redirectLocation("", "/"), /publicOrigin is required/);
  });
});
