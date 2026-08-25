import { createHash } from "node:crypto";
import type { Role } from "./http-authorization.ts";
import { randomUrlSafe } from "./session-token.ts";

/**
 * An OpenID Connect client, written against the protocol rather than a library:
 * the flow is one redirect, one form post and one authenticated GET, and a
 * dependency here would be one more thing with access to the secret.
 */
export interface OidcConfig {
  /** Base URL of the provider. Endpoints hang off it; no trailing slash. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Where the provider sends the browser back. Must match what is registered. */
  readonly redirectUri: string;
  readonly scopes: string;
  /**
   * Which claim carries this person's standing in Parallax.
   *
   * There is no standard one. `entitlements` is what the provider this was
   * written against uses, and it stays the default so an existing deployment is
   * unchanged -- but every directory spells it differently, and a name that
   * cannot be configured is a name that only works in one place.
   */
  readonly roleClaim?: string;
}

/**
 * Where the four requests actually go.
 *
 * These used to be `${issuer}/oidc/...`, which is one provider's layout and
 * nobody else's: Keycloak, Google, Okta and Entra all differ, so configuring
 * any of them produced a 404 at the first redirect. OpenID Connect Discovery
 * exists to answer exactly this, and the answer comes from the issuer itself.
 */
export interface OidcEndpoints {
  readonly authorization: string;
  readonly token: string;
  readonly userinfo: string;
  /** Optional in the specification, and genuinely absent at some providers. */
  readonly endSession?: string;
}

/** The layout this client assumed before it learned to ask. */
export function assumedEndpoints(issuer: string): OidcEndpoints {
  return {
    authorization: `${issuer}/oidc/authorize`,
    token: `${issuer}/oidc/token`,
    userinfo: `${issuer}/oidc/userinfo`,
    endSession: `${issuer}/oidc/end-session`,
  };
}

/**
 * Reads the provider's own description of itself.
 *
 * The document is served by the issuer over TLS, so it is authoritative for
 * that issuer -- which is why the endpoints it names are not required to share
 * the issuer's origin. Google is the everyday example: it issues as
 * `accounts.google.com` and hands its token endpoint to `oauth2.googleapis.com`.
 * What is required is that each one is an absolute URL this client would have
 * been willing to talk to anyway, which is the same rule `PARALLAX_OIDC_ISSUER`
 * is held to.
 */
export async function discoverEndpoints(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OidcEndpoints> {
  let response: Response;
  try {
    response = await fetchImpl(`${issuer}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new OidcError(`the identity provider's discovery document could not be fetched: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (!response.ok) throw new OidcError(`the identity provider has no discovery document (${response.status})`);
  const document: unknown = await response.json().catch(() => undefined);
  if (typeof document !== "object" || document === null) {
    throw new OidcError("the identity provider's discovery document was not an object");
  }
  const record = document as Record<string, unknown>;
  // OpenID Connect Discovery §4.3: the document must claim the issuer it was
  // asked about. This is what makes the cross-origin endpoints below safe --
  // Google's really do live on another host -- and without it an open redirect
  // under the issuer, or a takeover of one path on it, was enough. `fetch`
  // follows redirects and `response.ok` is still true afterwards, so the
  // document could come from anywhere.
  //
  // The failure it prevented is total: `exchangeCode` POSTs this deployment's
  // `client_secret` and the authorization code to `token_endpoint`, and
  // `readIdentity` takes the subject and the role claim from `userinfo`. An
  // attacker choosing those three returns `{"entitlements":["admin"]}` and
  // Parallax mints a signed session for them.
  //
  // A throw here falls back to `assumedEndpoints(issuer)`, which stays on the
  // configured issuer's own origin -- so this fails in the safe direction.
  if (record.issuer !== issuer) {
    throw new OidcError(
      `the discovery document claims issuer ${JSON.stringify(record.issuer)}, not ${issuer}.`
      + " Confirm PARALLAX_OIDC_ISSUER names the issuer exactly as the provider spells it.",
    );
  }
  const endpoint = (name: string, required: boolean): string | undefined => {
    const value = record[name];
    if (typeof value !== "string" || value.length === 0) {
      if (required) throw new OidcError(`the identity provider's discovery document has no ${name}`);
      return undefined;
    }
    if (!isReachableEndpoint(value)) {
      throw new OidcError(`the identity provider's ${name} is not an https URL: ${value}`);
    }
    return value;
  };
  const endSession = endpoint("end_session_endpoint", false);
  return {
    authorization: endpoint("authorization_endpoint", true) as string,
    token: endpoint("token_endpoint", true) as string,
    userinfo: endpoint("userinfo_endpoint", true) as string,
    ...(endSession ? { endSession } : {}),
  };
}

/** The same rule `PARALLAX_OIDC_ISSUER` is held to, applied to what it points at. */
function isReachableEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/**
 * Discovery, asked once and remembered.
 *
 * ⚠️ A provider that serves no discovery document falls back to the layout this
 * client used to assume. That is not a shim for a hypothetical: it is the
 * layout the deployment running today is configured against, and taking it away
 * in the same change that adds discovery would turn a compatibility fix into an
 * outage. The fallback reports itself so the deployment can be corrected rather
 * than left on it.
 *
 * The failure is not cached -- a provider that was briefly unreachable should
 * be asked again on the next sign-in rather than assumed wrong until restart.
 */
export function createEndpointResolver(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
  onFallback: (reason: string) => void = () => {},
): () => Promise<OidcEndpoints> {
  let discovered: OidcEndpoints | undefined;
  return async () => {
    if (discovered) return discovered;
    try {
      discovered = await discoverEndpoints(issuer, fetchImpl);
      return discovered;
    } catch (error) {
      onFallback(error instanceof Error ? error.message : "unknown error");
      return assumedEndpoints(issuer);
    }
  };
}

export interface OidcTokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly idTokenClaims: IdTokenClaims;
  readonly expiresIn: number;
}

export interface IdTokenClaims {
  readonly subject: string;
  readonly issuer: string;
  readonly audience: string | readonly string[];
  readonly expiresAt: number;
  readonly nonce: string;
}

/** What the provider says about the person, reduced to what Parallax uses. */
export interface OidcIdentity {
  readonly subject: string;
  readonly role: Role;
  /** Readable name for the audit trail, when the provider offers one. */
  readonly label?: string;
}

export class OidcError extends Error {
  override readonly name = "OidcError";
}

/** The authorization request, and the two values the callback has to match. */
export function beginAuthorization(config: OidcConfig, endpoints: OidcEndpoints): { url: string; state: string; verifier: string; nonce: string } {
  const state = randomUrlSafe(16);
  const verifier = randomUrlSafe(32);
  const nonce = randomUrlSafe(16);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const parameters = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const separator = endpoints.authorization.includes("?") ? "&" : "?";
  return { url: `${endpoints.authorization}${separator}${parameters}`, state, verifier, nonce };
}

export async function exchangeCode(
  config: OidcConfig,
  endpoints: OidcEndpoints,
  code: string,
  verifier: string,
  expectedNonce: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<OidcTokens> {
  const response = await fetchImpl(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: verifier,
    }),
  });
  // The provider's body can quote the request, which carried the client secret.
  if (!response.ok) throw new OidcError(`the identity provider refused the authorization code (${response.status})`);
  const payload: unknown = await response.json().catch(() => undefined);
  if (typeof payload !== "object" || payload === null) throw new OidcError("the identity provider returned no tokens");
  const { access_token: accessToken, id_token: idToken, expires_in: expiresIn } = payload as Record<string, unknown>;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OidcError("the identity provider returned no access token");
  }
  if (typeof idToken !== "string" || idToken.length === 0) {
    throw new OidcError("the identity provider returned no ID token");
  }
  const idTokenClaims = validateIdToken(idToken, config, expectedNonce, now);
  return { accessToken, idToken, idTokenClaims, expiresIn: typeof expiresIn === "number" ? expiresIn : 3600 };
}

function validateIdToken(value: string, config: OidcConfig, expectedNonce: string, now: () => number): IdTokenClaims {
  const parts = value.split(".");
  if (parts.length !== 3) throw new OidcError("the identity provider returned a malformed ID token");
  let claims: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    claims = parsed as Record<string, unknown>;
  } catch {
    throw new OidcError("the identity provider returned a malformed ID token");
  }
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  const issuer = typeof claims.iss === "string" ? claims.iss : "";
  const audience = typeof claims.aud === "string" || (Array.isArray(claims.aud) && claims.aud.every((item) => typeof item === "string"))
    ? claims.aud as string | readonly string[] : undefined;
  const expiresAt = typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : undefined;
  const nonce = typeof claims.nonce === "string" ? claims.nonce : "";
  const audiences = audience === undefined ? [] : Array.isArray(audience) ? audience : [audience];
  if (!subject || issuer !== config.issuer || audience === undefined || !audiences.includes(config.clientId)
    || expiresAt === undefined || expiresAt <= Math.floor(now() / 1000) || nonce !== expectedNonce) {
    throw new OidcError("the identity provider returned an ID token with invalid claims");
  }
  return { subject, issuer, audience, expiresAt, nonce };
}

/**
 * Reads who this is, and what they may do here.
 *
 * The grant comes from the provider's answer for *this client*, so a person's
 * standing in Parallax is administered where every other service's is. A
 * provider that grants this person nothing has said so, and that is refused
 * rather than defaulted -- a default would make an account anywhere in the
 * directory into an account here.
 */
export async function readIdentity(
  config: OidcConfig,
  endpoints: OidcEndpoints,
  tokens: OidcTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcIdentity> {
  const response = await fetchImpl(endpoints.userinfo, {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!response.ok) throw new OidcError(`the identity provider would not describe the account (${response.status})`);
  const claims: unknown = await response.json().catch(() => undefined);
  if (typeof claims !== "object" || claims === null) throw new OidcError("the identity provider returned no account");
  const record = claims as Record<string, unknown>;
  const subject = typeof record.sub === "string" ? record.sub : "";
  if (subject.length === 0) throw new OidcError("the identity provider returned an account with no subject");
  if (subject !== tokens.idTokenClaims.subject) throw new OidcError("the identity provider returned an account for a different subject");

  // One named claim, and by default `entitlements` rather than `roles`. The
  // provider this was written against draws that line itself: `roles` says what
  // a person is and is meant for display, `groups` is where they sit in the
  // organization, and neither is a grant. Reading either one by default would
  // turn a label into permission -- so a deployment that keeps its grants
  // elsewhere has to say so rather than have it guessed.
  const claim = config.roleClaim ?? DEFAULT_ROLE_CLAIM;
  const role = readRole(record[claim]);
  if (!role) {
    throw new OidcError(
      `this account has no \`${claim}\` granting it a role in Parallax. An administrator grants one at the identity provider,`
      + " using the value admin, editor or viewer. Set PARALLAX_OIDC_ROLE_CLAIM if that directory carries it under another name.",
    );
  }
  const label = typeof record.preferred_username === "string" ? record.preferred_username
    : typeof record.email === "string" ? record.email
    : undefined;
  return { subject, role, ...(label ? { label } : {}) };
}

/**
 * The provider sends entitlements as a list because a person can hold several.
 * They are ranked rather than rejected as ambiguous: refusing the login of
 * someone granted both `admin` and `viewer` would be a puzzle with no way to
 * act on it, and the highest is what every other reading of "may they" means.
 * Keys Parallax does not know are ignored -- a service may grant more than this
 * one understands.
 */
/** No standard claim carries this, so one provider's name is the default. */
const DEFAULT_ROLE_CLAIM = "entitlements";

function readRole(value: unknown): Role | undefined {
  const keys = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const held = new Set(keys.filter((key): key is string => typeof key === "string").map((key) => key.toLowerCase()));
  for (const role of ["admin", "editor", "viewer"] as const) if (held.has(role)) return role;
  return undefined;
}

/** Where to send the browser so the provider ends its own session too. */
export function endSessionUrl(endpoints: OidcEndpoints, idToken: string | undefined, returnTo: string): string {
  // A provider that publishes no end-session endpoint cannot be asked to end
  // its own session. Sending the browser back is the honest answer -- better
  // than a 404 on the way out of a logout that did clear the local cookie.
  if (!endpoints.endSession) return returnTo;
  const parameters = new URLSearchParams({ post_logout_redirect_uri: returnTo });
  if (idToken) parameters.set("id_token_hint", idToken);
  const separator = endpoints.endSession.includes("?") ? "&" : "?";
  return `${endpoints.endSession}${separator}${parameters}`;
}
