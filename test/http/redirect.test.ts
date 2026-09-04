import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redirectLocation } from "../../src/http/redirect.ts";

/**
 * The plaintext listener's only job is to say "go to HTTPS", and the address it
 * names is the whole of that job's security. A request line is attacker
 * controlled -- anybody can open a socket on port 80 and write whatever they
 * like into it -- so the origin half of the answer is never taken from it.
 *
 * The module is six lines and one `?:`, which is why the arms below are worth
 * naming individually: three of the four ways through it are refusals, and a
 * refusal nothing ever exercises is a refusal nobody has seen work.
 */
describe("HTTP redirect target", () => {
  it("uses only the configured public origin", () => {
    assert.equal(
      redirectLocation("https://dns.example.com", "/records?next=https://evil.example"),
      "https://dns.example.com/records?next=https://evil.example",
    );
    assert.equal(new URL(redirectLocation("https://dns.example.com", "//evil.example/path")).host, "dns.example.com");
    assert.throws(() => redirectLocation("", "/"), /publicOrigin is required/);
  });

  /**
   * `//evil.example/path` above is the famous one, and it is not the only one.
   *
   * A target that does not begin with `/` is not a path at all, and an absolute
   * URL is the everyday way to hand one over. It lands on the fallback arm,
   * which was uncovered -- so the second half of this guard had never been
   * observed doing anything. Concatenating instead of falling back gives
   * `https://dns.example.comhttps://evil.example`: a host nobody owns, from a
   * `Location` header this deployment signed its name to.
   */
  it("falls back to the root for anything that is not a path", () => {
    for (const [label, target] of [
      ["an absolute URL", "https://evil.example"],
      ["an absolute URL with a path on it", "http://evil.example/records"],
      ["a bare word", "evil.example"],
    ] as const) {
      const location = redirectLocation("https://dns.example.com", target);
      assert.equal(location, "https://dns.example.com/", label);
      assert.equal(new URL(location).host, "dns.example.com", label);
    }
  });

  /**
   * `IncomingMessage.url` is typed `string | undefined`, and that is not a
   * formality the caller can reason away: the listener hands whatever it was
   * given straight through. The optional chain is the only thing between an
   * absent target and a `Location` header reading `.../undefined` -- a 404 that
   * gets filed against the redirect rather than against whatever dropped the
   * request line. Nothing called it that way until now.
   */
  it("falls back to the root when the request carried no target at all", () => {
    assert.equal(redirectLocation("https://dns.example.com", undefined), "https://dns.example.com/");
  });
});
