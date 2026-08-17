import { IDENTITY_PREFIX } from "./identity-routes.ts";

/**
 * How the portal asks an unauthenticated visitor to identify themselves.
 *
 * `prompt` serves the page and lets it offer both ways in. `idp` sends the
 * visitor straight to the identity provider without drawing the token field --
 * for a deployment where accounts are administered in the directory and an
 * access token is a machine's credential, not a person's.
 */
export const PORTAL_SIGN_IN = ["prompt", "idp"] as const;

export type PortalSignIn = (typeof PORTAL_SIGN_IN)[number];

export function isPortalSignIn(value: string): value is PortalSignIn {
  return (PORTAL_SIGN_IN as readonly string[]).includes(value);
}

export interface PortalEntry {
  /** What this deployment does with an unauthenticated visitor. */
  readonly signIn: PortalSignIn;
  /** The path being asked for. */
  readonly pathname: string;
  /** Whether that path is the portal page itself, rather than one of its assets. */
  readonly isDocument: boolean;
  /** Whether this deployment refuses unauthenticated callers at all. */
  readonly authenticationRequired: boolean;
  /** Whether this particular request carries a session or a token. */
  readonly authenticated: boolean;
}

/**
 * Where to send this request instead of answering it, if anywhere.
 *
 * Only the document redirects. An asset does not: the page is what a person
 * navigates to, and bouncing a stylesheet to an authorization endpoint answers
 * a fetch with somebody's login screen. Nothing else about the deployment
 * changes -- the API still refuses with 401 rather than a redirect, because a
 * command-line client cannot sign in at a browser and a 302 would read to it as
 * success.
 *
 * With authentication switched off entirely there is nothing to sign in to, so
 * this stays out of the way rather than sending a visitor to prove an identity
 * this deployment does not ask for.
 */
export function portalRedirect(entry: PortalEntry): string | undefined {
  if (entry.signIn !== "idp") return undefined;
  if (!entry.isDocument) return undefined;
  if (!entry.authenticationRequired) return undefined;
  if (entry.authenticated) return undefined;
  return `${IDENTITY_PREFIX}/login?next=${encodeURIComponent(entry.pathname)}`;
}
