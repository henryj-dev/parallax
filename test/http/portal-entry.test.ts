import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPortalSignIn, portalRedirect, type PortalEntry } from "../../src/http/portal-entry.ts";

/** A visitor with no session asking for the page, on a deployment that requires one. */
const VISITOR: PortalEntry = {
  signIn: "idp",
  pathname: "/",
  isDocument: true,
  authenticationRequired: true,
  authenticated: false,
};

describe("what an unauthenticated visitor is offered", () => {
  it("sends them to the provider instead of drawing a token field", () => {
    assert.equal(portalRedirect(VISITOR), "/auth/login?next=%2F");
  });

  it("carries where they were going, so signing in does not lose the page", () => {
    assert.equal(portalRedirect({ ...VISITOR, pathname: "/index.html" }), "/auth/login?next=%2Findex.html");
  });

  it("leaves the page alone when the deployment offers the prompt", () => {
    assert.equal(portalRedirect({ ...VISITOR, signIn: "prompt" }), undefined);
  });

  it("does not redirect somebody who is already signed in", () => {
    assert.equal(portalRedirect({ ...VISITOR, authenticated: true }), undefined);
  });

  it("stays out of the way where nothing is required to begin with", () => {
    // Sending a visitor to prove an identity this deployment never asks for
    // would invent a wall rather than move one.
    assert.equal(portalRedirect({ ...VISITOR, authenticationRequired: false }), undefined);
  });

  it("redirects the page and not its assets", () => {
    // A script answered with somebody's login screen is a parse error, and the
    // page that would have loaded it has already been redirected anyway.
    assert.equal(portalRedirect({ ...VISITOR, pathname: "/app.js", isDocument: false }), undefined);
  });

  it("knows which values are settings and which are typos", () => {
    assert.ok(isPortalSignIn("idp"));
    assert.ok(isPortalSignIn("prompt"));
    assert.ok(!isPortalSignIn("oidc"));
    assert.ok(!isPortalSignIn(""));
  });
});
