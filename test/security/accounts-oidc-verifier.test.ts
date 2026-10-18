import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { assertUserinfoSubject, mapOidcRoles, OidcVerifier, readIdpMfaEvidence, readVerifiedOidcEmail,
  type IdpMfaContract, type OidcVerificationPolicy, type VerifiedOidcIdentity } from "../../src/security/accounts/oidc-verifier.ts";

const ISSUER = "https://idp.example.com";
const NOW = 1800000000000;
const SECONDS = NOW / 1000;
const POLICY: OidcVerificationPolicy = { issuer: ISSUER, clientId: "example-client", algorithms: ["RS256"],
  timeoutMs: 1000, cooldownMs: 1000, cacheMaxAgeMs: 60000, maxTokenAgeSeconds: 300, clockToleranceSeconds: 0 };
const CONTRACT: IdpMfaContract = { supportsFreshMfa: true, issuer: ISSUER,
  assuranceSemantics: "example-provider:fresh-two-factor:v1", acceptedAcr: ["urn:example:fresh-mfa"],
  requiredAmr: ["pwd", "totp"], maxAgeSeconds: 120 };
const BASE: JWTPayload = { iss: ISSUER, aud: POLICY.clientId, sub: "example-subject", iat: SECONDS - 10,
  exp: SECONDS + 300, nonce: "example-nonce" };
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

before(async () => {
  const keyPair = await generateKeyPair("RS256");
  signingKey = keyPair.privateKey;
  publicJwk = { ...await exportJWK(keyPair.publicKey), kid: "example-key", alg: "RS256", use: "sig" };
});

function provider(discovery: unknown = { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }, jwks: unknown = { keys: [publicJwk] }): { fetchImpl: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, options) => {
    const url = String(input);
    requests.push(url);
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal);
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json(discovery);
    if (url === `${ISSUER}/jwks` || url === "https://keys.example.com/jwks") return Response.json(jwks);
    throw new Error("unexpected isolated provider request");
  };
  return { fetchImpl, requests };
}

async function token(claims: JWTPayload = BASE, options: { alg?: string; key?: typeof signingKey; kid?: string } = {}): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: options.alg ?? "RS256", kid: options.kid ?? "example-key" }).sign(options.key ?? signingKey);
}

async function withClaims(claims: JWTPayload): Promise<VerifiedOidcIdentity> {
  const verifier = await OidcVerifier.create(POLICY, provider());
  return verifier.verify(await token(claims), "example-nonce", NOW);
}

describe("signed account OIDC identity verification", () => {
  it("discovers only configured TLS issuer and JWKS, verifies actual signatures and caches keys", async () => {
    const source = provider();
    const verifier = await OidcVerifier.create(POLICY, source);
    const jwt = await token();
    const result = await verifier.verify(jwt, "example-nonce", NOW);
    assert.equal(result.subject, BASE.sub);
    assert.equal(result.issuer, ISSUER);
    assert.equal(result.issuedAt, BASE.iat);
    assert.equal(result.expiresAt, BASE.exp);
    assert.equal(Object.isFrozen(result), true);
    await verifier.verify(jwt, "example-nonce", NOW);
    assert.deepEqual(source.requests, [`${ISSUER}/.well-known/openid-configuration`, `${ISSUER}/jwks`]);
    assert.doesNotThrow(() => assertUserinfoSubject(result, { sub: "example-subject" }));
    assert.throws(() => assertUserinfoSubject(result, { sub: "different-subject" }), { code: "invalid-token" });
    assert.throws(() => assertUserinfoSubject({ ...result }, { sub: result.subject }), { code: "invalid-token" });
  });

  it("verifies explicitly approved ES256 and EdDSA signatures without widening algorithm policy", async () => {
    for (const algorithm of ["ES256", "EdDSA"] as const) {
      const keyPair = await generateKeyPair(algorithm);
      const jwk = { ...await exportJWK(keyPair.publicKey), kid: "example-key", alg: algorithm, use: "sig" };
      const source = provider(undefined, { keys: [jwk] });
      const verifier = await OidcVerifier.create({ ...POLICY, algorithms: [algorithm] }, source);
      assert.ok(await verifier.verify(await token(BASE, { alg: algorithm, key: keyPair.privateKey }), "example-nonce", NOW));
    }
  });

  it("rejects wrong signatures, algorithm, key id, issuer, audience, azp and nonce", async () => {
    const verifier = await OidcVerifier.create(POLICY, provider());
    const otherKey = (await generateKeyPair("RS256")).privateKey;
    const pssKey = (await generateKeyPair("PS256")).privateKey;
    for (const jwt of [await token(BASE, { key: otherKey }), await token(BASE, { alg: "PS256", key: pssKey }), await token(BASE, { kid: "unknown" })]) {
      await assert.rejects(verifier.verify(jwt, "example-nonce", NOW), { code: "invalid-token" });
    }
    for (const claims of [{ ...BASE, iss: "https://other.example.com" }, { ...BASE, aud: "other-client" },
      { ...BASE, azp: "other-client" }, { ...BASE, aud: [POLICY.clientId, "other-client"] },
      { ...BASE, aud: [POLICY.clientId, 7] as unknown as string[], azp: POLICY.clientId },
      { ...BASE, nonce: "wrong-nonce" }]) {
      await assert.rejects(verifier.verify(await token(claims), "example-nonce", NOW), { code: "invalid-token" });
    }
    const multiAudienceToken = await token({ ...BASE, aud: [POLICY.clientId, "other-client"], azp: POLICY.clientId });
    await assert.rejects(verifier.verify(multiAudienceToken, "example-nonce", NOW), { code: "invalid-token" });
    const explicitlyTrusted = await OidcVerifier.create({ ...POLICY, trustedAdditionalAudiences: ["other-client"] }, provider());
    assert.ok(await explicitlyTrusted.verify(multiAudienceToken, "example-nonce", NOW));
    await assert.rejects(verifier.verify("not-a-jwt", "example-nonce", NOW), { code: "invalid-token" });
  });

  it("requires integer exp/iat, bounded token age and correctly typed auth_time/acr/amr", async () => {
    const verifier = await OidcVerifier.create(POLICY, provider());
    const missingExpiry = { ...BASE }; delete missingExpiry.exp;
    const missingIssued = { ...BASE }; delete missingIssued.iat;
    for (const claims of [missingExpiry, missingIssued, { ...BASE, exp: SECONDS }, { ...BASE, exp: SECONDS + 0.5 },
      { ...BASE, iat: SECONDS - 301 }, { ...BASE, iat: SECONDS + 1 }, { ...BASE, iat: SECONDS - 0.5 },
      { ...BASE, exp: SECONDS - 20 }, { ...BASE, auth_time: "invalid" }, { ...BASE, auth_time: SECONDS + 1 },
      { ...BASE, auth_time: SECONDS - 0.5 }, { ...BASE, acr: ["mfa"] }, { ...BASE, amr: "otp" }, { ...BASE, amr: [1] }]) {
      await assert.rejects(verifier.verify(await token(claims), "example-nonce", NOW), { code: "invalid-token" });
    }
  });

  it("rejects hostile discovery, non-TLS policies, and unapproved cross-origin JWKS", async () => {
    for (const document of [null, {}, { issuer: "https://other.example.com", jwks_uri: `${ISSUER}/jwks` },
      { issuer: ISSUER, jwks_uri: "http://idp.example.com/jwks" }, { issuer: ISSUER, jwks_uri: "https://keys.example.com/jwks" },
      { issuer: ISSUER, jwks_uri: "https://user:password@idp.example.com/jwks" }]) {
      await assert.rejects(OidcVerifier.create(POLICY, provider(document)), { code: "unavailable" });
    }
    for (const policy of [{ ...POLICY, issuer: "http://idp.example.com" }, { ...POLICY, algorithms: [] },
      { ...POLICY, timeoutMs: Infinity }, { ...POLICY, clockToleranceSeconds: -1 },
      { ...POLICY, cooldownMs: 0 }, { ...POLICY, cooldownMs: 999 }]) {
      await assert.rejects(OidcVerifier.create(policy), { code: "invalid-policy" });
    }
    const verifier = await OidcVerifier.create({ ...POLICY, trustedJwksOrigins: ["https://keys.example.com"] },
      provider({ issuer: ISSUER, jwks_uri: "https://keys.example.com/jwks" }));
    assert.ok(await verifier.verify(await token(), "example-nonce", NOW));
  });

  it("caps remote JSON bodies and normalizes provider failures without response or token leakage", async () => {
    const failedFetch: typeof fetch = async () => { throw new Error("provider-private-response"); };
    await assert.rejects(OidcVerifier.create(POLICY, { fetchImpl: failedFetch }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "identity verification unavailable");
      return true;
    });
    const oversized: typeof fetch = async () => new Response("x".repeat(1024 * 1024 + 1));
    await assert.rejects(OidcVerifier.create(POLICY, { fetchImpl: oversized }), { code: "unavailable" });
    const verifier = await OidcVerifier.create(POLICY, provider(undefined, { keys: [] }));
    await assert.rejects(verifier.verify(await token(), "example-nonce", NOW), { message: "identity token rejected" });
  });

  it("reads only signed verified email claims without normalizing or trusting cloned identities", async () => {
    const identity = await withClaims({ ...BASE, email: "Person+tag@example.com", email_verified: true });
    assert.equal(readVerifiedOidcEmail(identity), "Person+tag@example.com");
    assert.equal(readVerifiedOidcEmail({ ...identity }), undefined);
    for (const claims of [{ ...BASE }, { ...BASE, email: "person@example.com", email_verified: false },
      { ...BASE, email: "person@example.com", email_verified: "true" }, { ...BASE, email_verified: true },
      { ...BASE, email: "person@example.com\n", email_verified: true },
      { ...BASE, email: `${"x".repeat(250)}@example.com`, email_verified: true },
      { ...BASE, email: "not-an-email", email_verified: true },
      { ...BASE, email: "person\u0085@example.com", email_verified: true },
      { ...BASE, email: "person\u202e@example.com", email_verified: true },
      { ...BASE, email: "person@example\u2066.com", email_verified: true },
      { ...BASE, email: "pérson@example.com", email_verified: true },
      { ...BASE, email: ".person@example.com", email_verified: true },
      { ...BASE, email: "per..son@example.com", email_verified: true }]) {
      assert.equal(readVerifiedOidcEmail(await withClaims(claims)), undefined);
    }
  });

  it("maps explicit verified role keys only and ignores roles_label and unverified clones", async () => {
    const identity = await withClaims({ ...BASE, roles: ["operators", "readers", "unmapped"], roles_label: ["admin"] });
    const mapping = { operators: "editor", readers: "viewer", admin: "admin" } as const;
    assert.deepEqual(mapOidcRoles(identity, "roles", mapping, ISSUER), ["editor", "viewer"]);
    assert.deepEqual(mapOidcRoles(identity, "roles", mapping, "https://other.example.com"), []);
    assert.deepEqual(mapOidcRoles(identity, "roles_label", mapping, ISSUER), []);
    assert.deepEqual(mapOidcRoles({ ...identity }, "roles", mapping, ISSUER), []);
    assert.deepEqual(mapOidcRoles(await withClaims({ ...BASE, roles: "operators" }), "roles", mapping, ISSUER), []);
  });
});

describe("provider-contracted fresh MFA evidence", () => {
  it("rejects even correctly signed MFA claims until a provider has a code-reviewed support contract", async () => {
    const identity = await withClaims({ ...BASE, acr: "urn:example:fresh-mfa", amr: ["pwd", "totp"], auth_time: SECONDS - 20 });
    assert.equal(readIdpMfaEvidence(identity, CONTRACT, NOW), undefined);
    assert.equal(readIdpMfaEvidence({ ...identity }, CONTRACT, NOW), undefined);
    assert.equal(readIdpMfaEvidence(identity, { ...CONTRACT, supportsFreshMfa: false }, NOW), undefined);
    assert.equal(readIdpMfaEvidence(identity, { ...CONTRACT, issuer: "https://other.example.com" }, NOW), undefined);
    assert.equal(readIdpMfaEvidence(identity, { ...CONTRACT, assuranceSemantics: "" }, NOW), undefined);
    assert.equal(readIdpMfaEvidence(identity, CONTRACT, NOW - 30000), undefined);
    assert.equal(readIdpMfaEvidence(identity, CONTRACT, NOW + 121000), undefined);
  });

  it("never substitutes refresh iat, prompt, trusted-device claims, otp or mfa strings for fresh evidence", async () => {
    for (const claims of [
      { ...BASE, acr: "urn:example:fresh-mfa", amr: ["pwd", "totp"] },
      { ...BASE, acr: "urn:example:fresh-mfa", amr: ["pwd", "totp"], auth_time: SECONDS - 121, prompt: "login" },
      { ...BASE, acr: "urn:example:fresh-mfa", amr: ["pwd", "otp"], auth_time: SECONDS - 20 },
      { ...BASE, acr: "mfa", amr: ["pwd", "totp"], auth_time: SECONDS - 20 },
      { ...BASE, acr: "urn:example:fresh-mfa", amr: ["pwd", "mfa"], auth_time: SECONDS - 20 },
    ]) assert.equal(readIdpMfaEvidence(await withClaims(claims), CONTRACT, NOW), undefined);
  });
});
