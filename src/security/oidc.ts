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
}

export interface OidcTokens {
  readonly accessToken: string;
  readonly idToken?: string;
  readonly expiresIn: number;
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
export function beginAuthorization(config: OidcConfig): { url: string; state: string; verifier: string } {
  const state = randomUrlSafe(16);
  const verifier = randomUrlSafe(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const parameters = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { url: `${config.issuer}/oidc/authorize?${parameters}`, state, verifier };
}

export async function exchangeCode(
  config: OidcConfig,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcTokens> {
  const response = await fetchImpl(`${config.issuer}/oidc/token`, {
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
  return {
    accessToken,
    ...(typeof idToken === "string" ? { idToken } : {}),
    expiresIn: typeof expiresIn === "number" ? expiresIn : 3600,
  };
}

/**
 * Reads who this is, and what they may do here.
 *
 * The role comes from the provider's answer for *this client*, so a person's
 * standing in Parallax is administered where every other service's is. A
 * provider that says nothing about roles has not granted this person anything,
 * and that is refused rather than defaulted -- a default would make an account
 * anywhere in the directory into an account here.
 */
export async function readIdentity(
  config: OidcConfig,
  tokens: OidcTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcIdentity> {
  const response = await fetchImpl(`${config.issuer}/oidc/userinfo`, {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!response.ok) throw new OidcError(`the identity provider would not describe the account (${response.status})`);
  const claims: unknown = await response.json().catch(() => undefined);
  if (typeof claims !== "object" || claims === null) throw new OidcError("the identity provider returned no account");
  const record = claims as Record<string, unknown>;
  const subject = typeof record.sub === "string" ? record.sub : "";
  if (subject.length === 0) throw new OidcError("the identity provider returned an account with no subject");

  const role = readRole(record.roles);
  if (!role) {
    throw new OidcError(
      "this account has no role for Parallax at the identity provider. An administrator assigns one there, using the key admin, editor or viewer.",
    );
  }
  const label = typeof record.preferred_username === "string" ? record.preferred_username
    : typeof record.email === "string" ? record.email
    : undefined;
  return { subject, role, ...(label ? { label } : {}) };
}

/**
 * The provider sends roles as a list because a person can hold several. Here
 * they are ranked rather than rejected as ambiguous: refusing the login of
 * someone granted both `admin` and `viewer` would be a puzzle with no way to
 * act on it, and the highest is what every other reading of "may they" means.
 */
function readRole(value: unknown): Role | undefined {
  const keys = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const held = new Set(keys.filter((key): key is string => typeof key === "string").map((key) => key.toLowerCase()));
  for (const role of ["admin", "editor", "viewer"] as const) if (held.has(role)) return role;
  return undefined;
}

/** Where to send the browser so the provider ends its own session too. */
export function endSessionUrl(config: OidcConfig, idToken: string | undefined, returnTo: string): string {
  const parameters = new URLSearchParams({ post_logout_redirect_uri: returnTo });
  if (idToken) parameters.set("id_token_hint", idToken);
  return `${config.issuer}/oidc/end-session?${parameters}`;
}
