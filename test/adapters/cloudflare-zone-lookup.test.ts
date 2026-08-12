import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveZoneId, ZoneLookupForbiddenError, ZoneNotFoundError } from "../../src/adapters/cloudflare.ts";

const BASE = "https://api.example.invalid/client/v4";

function respond(status: number, body: unknown): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;
}

describe("Cloudflare zone lookup", () => {
  it("asks for the exact name and returns its id", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ success: true, result: [{ id: "abc123", name: "example.com" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    assert.equal(await resolveZoneId({ name: "Example.COM", token: "t", fetch, apiBaseUrl: BASE }), "abc123");
    assert.deepEqual(seen, [`${BASE}/zones?name=example.com&per_page=2`]);
  });

  it("separates a token that may not look zones up from a zone that is not there", async () => {
    // The operator's next step differs: grant a permission, or check which
    // account holds the domain. One message for both would answer neither.
    await assert.rejects(
      resolveZoneId({ name: "example.com", token: "t", fetch: respond(403, { success: false, errors: [{ code: 9109 }] }), apiBaseUrl: BASE }),
      (error: unknown) => error instanceof ZoneLookupForbiddenError && /Zone -> Zone -> Read/.test(error.message),
    );
    await assert.rejects(
      resolveZoneId({ name: "example.com", token: "t", fetch: respond(200, { success: true, result: [] }), apiBaseUrl: BASE }),
      ZoneNotFoundError,
    );
  });

  it("refuses a name the response only nearly matches", async () => {
    // `?name=` is a filter, not a guarantee. Binding to a zone the operator did
    // not name would point Parallax at somebody else's DNS.
    await assert.rejects(
      resolveZoneId({
        name: "example.com",
        token: "t",
        fetch: respond(200, { success: true, result: [{ id: "abc123", name: "notexample.com" }] }),
        apiBaseUrl: BASE,
      }),
      ZoneNotFoundError,
    );
  });

  it("refuses an ambiguous answer rather than taking the first", async () => {
    await assert.rejects(
      resolveZoneId({
        name: "example.com",
        token: "t",
        fetch: respond(200, { success: true, result: [{ id: "a", name: "example.com" }, { id: "b", name: "example.com" }] }),
        apiBaseUrl: BASE,
      }),
      /ambiguous/,
    );
  });

  it("keeps the token out of a transport failure", async () => {
    const fetch = (async () => { throw new Error("connect failed for Bearer super-secret-token"); }) as unknown as typeof globalThis.fetch;
    await assert.rejects(
      resolveZoneId({ name: "example.com", token: "super-secret-token", fetch, apiBaseUrl: BASE }),
      (error: unknown) => error instanceof Error
        && !error.message.includes("super-secret-token")
        && error.message.includes("[redacted]"),
    );
  });
});
