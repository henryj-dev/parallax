import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  assumedEndpoints, discoverEndpoints, exchangeCode, OidcError, type OidcConfig,
} from "../../src/security/oidc.ts";
import { assertSessionSecret, randomUrlSafe, readSession, signSession } from "../../src/security/session-token.ts";

/**
 * The refusals on the sign-in path, asked to actually refuse.
 *
 * `test/security/oidc-session.test.ts` covers the flow working and the flow
 * being attacked in the ways that are *about the protocol*: a rewritten role, a
 * discovery document claiming somebody else's issuer, a state cookie shadowed
 * by a second one. What it does not cover is the dumber half -- the provider,
 * or the browser, handing over something that is not shaped like an answer at
 * all. Measured before this file existed: `session-token.ts` was **70.37%
 * branch, the lowest of any module under `src/security/`**, and `oidc.ts` was
 * **75.24%**, the next lowest. Every uncovered branch in both was one of these.
 *
 * ⚠️ Two modules in one file, which is not the usual arrangement here. They are
 * the two halves of one path -- `oidc.ts` imports `randomUrlSafe` from
 * `session-token.ts` for the three values that bind a callback to the browser
 * that started it -- and the cases below are the same kind of case about both:
 * what happens when the input is garbage rather than wrong.
 */

const SECRET = "session-secret-that-is-long-enough-32";

/**
 * A value this secret really did sign, over a payload of the caller's choosing.
 *
 * Repeating the module's private `sign()` is the point rather than a shortcut:
 * `readSession` compares the signature *before* it parses, deliberately, so the
 * parser is unreachable from a value that was not signed here. Reaching it at
 * all means producing a genuine signature over a bad payload.
 */
function signedByThisSecret(payload: string, secret = SECRET): string {
  return `v1.${payload}.${createHmac("sha256", secret).update(`v1.${payload}`).digest("base64url")}`;
}

describe("the session secret this deployment was given", () => {
  /**
   * The floor, and the throw that enforces it, which **no test ever ran**.
   *
   * The cookie carries the claim itself -- subject, role, expiry -- and the
   * HMAC is the only thing between an editor and a session that says `admin`.
   * A short secret is brute-forceable offline: the attacker already holds a
   * valid signed value, because the server gave them one at sign-in, so they
   * can grind against it with no request to this deployment at all and come
   * back holding the key that mints administrators.
   *
   * That is why this refuses at configuration time rather than warning. A
   * deployment that starts with a four-character secret is a deployment nobody
   * looks at again.
   */
  it("refuses a secret short enough to grind offline", () => {
    for (const weak of ["", "secret", "0".repeat(31)]) {
      assert.throws(
        () => { assertSessionSecret(weak); },
        /session secret must contain at least 32 bytes/u,
        JSON.stringify(weak),
      );
    }
    // Exactly at the floor is allowed -- the message says "at least".
    assert.doesNotThrow(() => { assertSessionSecret("0".repeat(32)); });
  });

  /**
   * Bytes, not characters, and the difference is not academic: eleven Korean
   * characters are thirty-three bytes of entropy and a thirty-one character
   * ASCII passphrase is thirty-one. A length check on `String.length` would
   * accept the weaker of the two and refuse the stronger.
   */
  it("counts the bytes of the secret rather than its characters", () => {
    assert.doesNotThrow(() => { assertSessionSecret("가".repeat(11)); }, "33 bytes in 11 characters");
    assert.throws(() => { assertSessionSecret("가".repeat(10)); }, /at least 32 bytes/u, "30 bytes");
  });

  /**
   * The check is on the minting path too, not only wherever configuration is
   * read. A weak secret that reached `signSession` would produce a cookie that
   * verifies -- and it is the verification, not the minting, that an attacker
   * gets to attack.
   */
  it("will not sign anything with a secret it would have refused", () => {
    const claims = { subject: "someone", role: "admin", expiresAt: Math.floor(Date.now() / 1000) + 60 } as const;
    assert.throws(() => signSession(claims, "too-short"), /at least 32 bytes/u);
  });
});

describe("a session value that verifies and then makes no sense", () => {
  /**
   * `readSession` promises `undefined` for anything that is not exactly a value
   * this secret signed and that has not expired. **It must not throw**, and this
   * is the one arm where it could: `JSON.parse` on the payload runs after the
   * signature has already been accepted, so an exception there escapes into the
   * authentication layer -- turning a bad cookie into a 500, or into an
   * unhandled rejection, instead of into a sign-in page.
   *
   * Reaching it needs a real signature over an unreal payload, which is why the
   * helper above exists. In production the way here is this deployment's own
   * doing -- a format that changed, a value written by a version that spelled
   * it differently -- and "the server signed something it can no longer read"
   * is precisely the case where failing closed and quietly is the right answer.
   */
  it("returns undefined rather than throwing on a payload that is not JSON", () => {
    const notJson = Buffer.from("this was never JSON").toString("base64url");
    assert.equal(readSession(signedByThisSecret(notJson), SECRET), undefined);

    // Truncated JSON is the same answer: half an object is not an object.
    const truncated = Buffer.from('{"sub":"someone","rol').toString("base64url");
    assert.equal(readSession(signedByThisSecret(truncated), SECRET), undefined);

    // And empty, which `JSON.parse("")` also refuses.
    assert.equal(readSession(signedByThisSecret(""), SECRET), undefined);
  });

  /**
   * Valid JSON that is not an object. `typeof null === "object"` is the trap
   * this guard is written around, and a bare string or number would reach the
   * destructuring below it and read `undefined` out of every claim -- which the
   * per-claim checks would then catch, but only by accident of their order.
   */
  it("returns undefined for JSON that is not an object", () => {
    for (const payload of ["null", '"a bare string"', "42", "[]"]) {
      const encoded = Buffer.from(payload).toString("base64url");
      assert.equal(readSession(signedByThisSecret(encoded), SECRET), undefined, payload);
    }
  });

  /** The control: the same helper, over a payload that *is* one, reads back. */
  it("still reads a well-formed payload signed the same way", () => {
    const encoded = Buffer.from(JSON.stringify({
      sub: "someone", role: "viewer", exp: Math.floor(Date.now() / 1000) + 60,
    })).toString("base64url");
    assert.deepEqual(readSession(signedByThisSecret(encoded), SECRET)?.role, "viewer");
  });
});

/**
 * `randomUrlSafe` had never been named in a test, and it produces three of the
 * four values the OIDC handshake depends on: `state`, the PKCE `verifier`, and
 * `nonce`. All three travel in a URL query or a cookie and are compared for
 * exact equality at the callback.
 *
 * So the alphabet is not cosmetic. Standard base64 emits `+`, `/` and `=`; a
 * `+` in a query string decodes back as a space, which would break the
 * comparison for roughly one value in twenty -- an intermittent "sign-in
 * failed" that reproduces on nobody's machine.
 */
describe("the unguessable values the handshake is built from", () => {
  it("emits only characters that survive a URL and a cookie", () => {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      assert.match(randomUrlSafe(), /^[A-Za-z0-9_-]+$/u);
    }
  });

  it("returns the number of bytes it was asked for, and 32 by default", () => {
    // base64url of n bytes, padding stripped: ceil(n * 4 / 3).
    assert.equal(randomUrlSafe().length, 43, "32 bytes by default");
    assert.equal(randomUrlSafe(16).length, 22);
    assert.equal(randomUrlSafe(64).length, 86);
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 256 }, () => randomUrlSafe(16)));
    assert.equal(seen.size, 256, "a repeat here is a state value an attacker can predict");
  });
});

/**
 * The provider answering garbage, rather than answering wrongly.
 *
 * `oidc-session.test.ts` covers the wrong answers -- a document claiming
 * another issuer, an ID token with a substituted audience, a `roles` claim
 * where a grant should be. Those are attacks. What is here is the other
 * failure: a provider behind a captive portal, a load balancer with an HTML
 * error page, a tenant that was deleted, a token endpoint returning `{}`. None
 * of it is hostile and all of it arrives at the same code, and the requirement
 * is identical -- an `OidcError` that says what was wrong, never a `TypeError`
 * out of the middle of the sign-in handler.
 */
describe("an identity provider that answers garbage", () => {
  const ISSUER = "https://idp.example.com";
  const CONFIG: OidcConfig = {
    issuer: ISSUER,
    clientId: "parallax",
    clientSecret: "client-secret",
    redirectUri: "https://parallax.example/auth/callback",
    scopes: "openid profile email",
  };

  /** Serves one body, whatever it is, at whatever the client asks for. */
  function serving(body: string, status = 200): typeof fetch {
    return (async () => new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  }

  /**
   * A 200 that is not a discovery document.
   *
   * This is what a captive portal, a proxy error page, or a CDN's "we moved"
   * looks like from here: the status says fine and the body says nothing. The
   * refusal has to happen before `record.issuer` is read, because reading a
   * property off `null` is a `TypeError` and the caller
   * (`createEndpointResolver`) would catch it and fall back with "unknown
   * error" as the reason -- a fallback nobody can diagnose.
   */
  it("refuses a discovery document that is not an object", async () => {
    for (const [label, body] of [
      ["JSON null", "null"],
      ["a bare string", JSON.stringify(`${ISSUER}/.well-known/openid-configuration`)],
      ["a number", "42"],
      ["not JSON at all", "<html><body>Sign in to the wifi</body></html>"],
    ] as const) {
      await assert.rejects(
        () => discoverEndpoints(ISSUER, serving(body)),
        (error: unknown) => error instanceof OidcError
          && /discovery document was not an object/u.test(error.message),
        label,
      );
    }
  });

  /**
   * An endpoint that `new URL()` cannot even parse.
   *
   * The published endpoints are not required to share the issuer's origin --
   * Google really does hand its token endpoint to another host -- so what keeps
   * that safe is the same rule `PARALLAX_OIDC_ISSUER` is held to, applied to
   * whatever the document names. A value that is not a URL falls through the
   * `catch` to `false`, and reaching that arm is what proves the guard is not
   * merely a `startsWith("https://")` in disguise: `https:/single-slash` and a
   * bare sentence both have to be refused, and the message has to name the
   * field so an operator knows which line of their provider's document to look
   * at.
   */
  it("refuses an endpoint URL it cannot parse at all", async () => {
    for (const [label, value] of [
      ["a sentence", "we do not publish one"],
      ["a scheme with nothing after it", "https:"],
      ["an empty-ish path", "/oauth2/token"],
    ] as const) {
      await assert.rejects(
        () => discoverEndpoints(ISSUER, serving(JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: value,
          userinfo_endpoint: `${ISSUER}/userinfo`,
        }))),
        /the identity provider's token_endpoint is not an https URL/u,
        label,
      );
    }
  });

  const endpoints = assumedEndpoints(ISSUER);
  const exchange = async (payload: string): Promise<unknown> =>
    exchangeCode(CONFIG, endpoints, "authorization-code", "pkce-verifier", "expected-nonce", serving(payload), () => 1_000_000);

  /**
   * A token response with no usable access token.
   *
   * The access token is what `readIdentity` presents to `userinfo` to learn the
   * role. Carrying an empty string forward means sending `Authorization:
   * Bearer ` to the provider and reading whatever it says about an anonymous
   * caller -- so this has to stop here, not two calls later where the symptom
   * would be an unexplained 401 from the provider.
   */
  it("refuses a token response with no access token in it", async () => {
    for (const [label, body] of [
      ["absent", { id_token: "a.b.c", expires_in: 300 }],
      ["empty", { access_token: "", id_token: "a.b.c" }],
      ["not a string", { access_token: 12345, id_token: "a.b.c" }],
    ] as const) {
      await assert.rejects(
        () => exchange(JSON.stringify(body)),
        /the identity provider returned no access token/u,
        label,
      );
    }
  });

  /**
   * An ID token with three parts whose middle one is not a claim set.
   *
   * `oidc-session.test.ts` covers `"not-a-jwt"`, which fails on the part count
   * and never reaches the decoder. This is the arm past it: the shape is right,
   * so the code commits to base64url-decoding and `JSON.parse`-ing attacker- or
   * accident-supplied bytes. Both of the ways that can go wrong land in the
   * same `catch`, and both must come out as the same `OidcError` -- the caller
   * is a browser-facing handler and a raw `SyntaxError` there is a 500 on the
   * sign-in page.
   *
   * ⚠️ The claims are read *unverified* here -- there is no signature check on
   * the ID token, because the token came back over TLS from the endpoint
   * discovery vouched for. That is exactly why the parse has to be defensive:
   * it is the first thing this deployment does with bytes it did not make.
   */
  it("refuses an ID token whose payload is not a claim set", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const idToken = (payload: string): string =>
      `${header}.${Buffer.from(payload).toString("base64url")}.test-signature`;

    for (const [label, payload] of [
      ["not JSON", "this was never JSON"],
      ["truncated JSON", '{"sub":"someone","iss'],
      ["JSON null", "null"],
      ["a list of claims", '[{"sub":"someone"}]'],
      ["a bare string", '"someone"'],
      ["empty", ""],
    ] as const) {
      await assert.rejects(
        () => exchange(JSON.stringify({ access_token: "provider-access-token", id_token: idToken(payload) })),
        (error: unknown) => error instanceof OidcError
          && /the identity provider returned a malformed ID token/u.test(error.message),
        label,
      );
    }
  });
});
