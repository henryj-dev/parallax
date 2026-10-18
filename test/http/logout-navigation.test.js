import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createApiClient } from "../../public/api-client.js";
import { createStore } from "../../public/store.js";
import { createIdentityHandler } from "../../src/http/identity-routes.ts";

const PORTAL = "https://parallax.example";
const ISSUER = "https://idp.example";
const SETTINGS = {
  issuer: ISSUER, clientId: "parallax", clientSecret: "client-secret", redirectUri: `${PORTAL}/auth/callback`,
  scopes: "openid profile email", sessionSecret: "identity-session-secret-at-least-32-bytes", sessionMaxAgeSeconds: 3600,
};

/** A provider whose discovery document does or does not publish an end-session endpoint. */
function provider(endSession) {
  return async (input) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`, ...(endSession ? { end_session_endpoint: `${ISSUER}/logout` } : {}) });
    }
    throw new Error(`unexpected call to ${url}`);
  };
}
const logout = (handler, accept) => handler(new Request(`${PORTAL}/auth/logout`, { method: "POST", headers: { origin: PORTAL, ...(accept ? { accept } : {}) } }));

const original = globalThis.location;
afterEach(() => { globalThis.location = original; });
function browserLocation() {
  const visits = [];
  globalThis.location = { href: `${PORTAL}/`, origin: PORTAL, assign: (target) => visits.push(target) };
  return visits;
}

describe("legacy sign-out with an identity provider", () => {
  it("names a location only when the provider publishes an end-session endpoint", async () => {
    const without = await logout(createIdentityHandler({ settings: SETTINGS, fetchImpl: provider(false) }), "application/json");
    assert.equal(without.status, 200);
    assert.deepEqual(await without.json(), {}, "sending the page to / would sign it straight back in");
    const withEnd = await logout(createIdentityHandler({ settings: SETTINGS, fetchImpl: provider(true) }), "application/json");
    assert.match((await withEnd.json()).location, /^https:\/\/idp\.example\/logout\?/u);
    const form = await logout(createIdentityHandler({ settings: SETTINGS, fetchImpl: provider(false) }));
    assert.equal(form.status, 302, "a form post still gets its redirect");
  });

  async function signOutWith(body) {
    const visits = browserLocation();
    const client = createApiClient({
      fetchImpl: async (input, init = {}) => {
        if (String(input).endsWith("/auth/logout")) return Response.json(body);
        if (String(input).endsWith("/session") && init.method === "DELETE") return new Response(null, { status: 204 });
        throw new Error(`unexpected ${input}`);
      },
    });
    const store = createStore(client);
    const intents = [];
    store.onIntent((event) => intents.push(event.type ?? event));
    await store.signOut();
    return { visits, intents };
  }

  it("stays on the page and asks for sign-in when there is no provider logout", async () => {
    const { visits, intents } = await signOutWith({});
    assert.deepEqual(visits, []);
    assert.ok(intents.includes("auth-required"));
  });

  it("never follows a location on this origin, whatever the server says", async () => {
    for (const location of ["/", `${PORTAL}/`, `${PORTAL}/auth/login`, "//parallax.example/"]) {
      const { visits, intents } = await signOutWith({ location });
      assert.deepEqual(visits, [], location);
      assert.ok(intents.includes("auth-required"), location);
    }
  });

  it("goes to the provider's logout, and only there, when it exists", async () => {
    const { visits, intents } = await signOutWith({ location: `${ISSUER}/logout?post_logout_redirect_uri=x` });
    assert.deepEqual(visits, [`${ISSUER}/logout?post_logout_redirect_uri=x`]);
    assert.equal(intents.includes("auth-required"), false);
    const plain = await signOutWith({ location: "http://idp.example/logout" });
    assert.deepEqual(plain.visits, [], "a provider logout over plain HTTP is not followed");
  });
});

describe("member sign-out through the provider", () => {
  /** The store, and the listener `app.js` installs in accounts mode: `auth-required` sends the page to sign-in. */
  async function portalSignOut(body) {
    const visits = browserLocation();
    const client = createApiClient({
      fetchImpl: async (input) => {
        if (String(input) === "/health/live") return Response.json({ authentication: "required", identityProvider: "available", memberAccounts: "available" });
        if (String(input).endsWith("/account/me")) return Response.json({ user: { role: "admin" }, csrf: "c".repeat(43) });
        if (String(input).endsWith("/auth/logout")) return Response.json(body);
        throw new Error(`unexpected ${input}`);
      },
    });
    const store = createStore(client);
    await store.readAuthenticationMode();
    const intents = [];
    store.onIntent((event) => {
      intents.push(event.type ?? event);
      if ((event.type ?? event) === "auth-required" && store.getState().memberAccounts) globalThis.location.assign("/account/login");
    });
    await store.signOut();
    return { visits, intents };
  }

  it("goes to the provider's logout once, and nowhere else, when there is one", async () => {
    const { visits, intents } = await portalSignOut({ location: `${ISSUER}/logout?post_logout_redirect_uri=x` });
    assert.deepEqual(visits, [`${ISSUER}/logout?post_logout_redirect_uri=x`]);
    assert.equal(intents.includes("auth-required"), false);
  });

  it("shows sign-in when the provider has no logout", async () => {
    const { visits, intents } = await portalSignOut({});
    assert.deepEqual(visits, ["/account/login"]);
    assert.ok(intents.includes("auth-required"));
  });

  it("does not navigate when the server names no provider logout", async () => {
    const visits = browserLocation();
    const client = createApiClient({ fetchImpl: async () => Response.json({}) });
    assert.equal(await client.endMemberSession({ identityProvider: true }), false);
    assert.deepEqual(visits, []);
  });
});
