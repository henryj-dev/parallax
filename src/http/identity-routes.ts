import type { OidcSettings } from "../config.ts";
import { hasSameOrigin, IDENTITY_COOKIE } from "../security/http-authorization.ts";
import { beginAuthorization, endSessionUrl, exchangeCode, readIdentity, OidcError, type OidcConfig } from "../security/oidc.ts";
import { randomUrlSafe, signSession } from "../security/session-token.ts";

/** Where the browser is sent to start and finish a sign-in. */
export const IDENTITY_PREFIX = "/auth";

const STATE_COOKIE = "parallax_oidc_state";
const VERIFIER_COOKIE = "parallax_oidc_verifier";
const RETURN_COOKIE = "parallax_oidc_return";
const ID_TOKEN_COOKIE = "parallax_oidc_id";
/** Long enough to sign in, short enough that an abandoned attempt is not lying around. */
const HANDSHAKE_SECONDS = 600;

export interface IdentityRoutesOptions {
  readonly settings: OidcSettings;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Signing in through an identity provider.
 *
 * These sit outside `/api/v1` and outside authentication, because they are how
 * someone who has nothing becomes someone. Everything they set is HttpOnly:
 * the page never needs to read any of it, and the parts that matter -- the
 * state, the PKCE verifier -- are exactly what an attacker would want to
 * supply.
 */
export function createIdentityHandler(options: IdentityRoutesOptions): (request: Request) => Promise<Response | undefined> {
  const { settings } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const config: OidcConfig = {
    issuer: settings.issuer,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    redirectUri: settings.redirectUri,
    scopes: settings.scopes,
  };

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/u, "");
    if (route === `${IDENTITY_PREFIX}/login` && request.method === "GET") return startLogin(url);
    if (route === `${IDENTITY_PREFIX}/callback` && request.method === "GET") return finishLogin(request, url);
    if (route === `${IDENTITY_PREFIX}/logout`) {
      if (request.method === "GET") {
        return new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        if (!hasSameOrigin(request)) {
          return Response.json(
            { error: "forbidden", message: "same-origin required" },
            { status: 403, headers: { "cache-control": "no-store" } },
          );
        }
        return logout(request, url);
      }
    }
    return undefined;
  };

  function startLogin(url: URL): Response {
    const { url: authorize, state, verifier } = beginAuthorization(config);
    const returnTo = safeReturnPath(url.searchParams.get("next"));
    return redirect(authorize, [
      handshakeCookie(STATE_COOKIE, state, url),
      handshakeCookie(VERIFIER_COOKIE, verifier, url),
      handshakeCookie(RETURN_COOKIE, returnTo, url),
    ]);
  }

  async function finishLogin(request: Request, url: URL): Promise<Response> {
    const cookies = request.headers.get("cookie");
    const expectedState = readCookie(cookies, STATE_COOKIE);
    const verifier = readCookie(cookies, VERIFIER_COOKIE);
    const returnTo = safeReturnPath(readCookie(cookies, RETURN_COOKIE));
    const cleared = [STATE_COOKIE, VERIFIER_COOKIE, RETURN_COOKIE].map((name) => clearedCookie(name, url));

    const provided = url.searchParams.get("error");
    if (provided) {
      // The code is defined by the protocol and names the decision -- consent
      // refused, scope rejected, account not permitted. Withholding it leaves
      // "refused" and no way to tell which of those happened.
      const detail = url.searchParams.get("error_description");
      return failure(`the identity provider refused the sign-in (${provided}${detail ? `: ${detail}` : ""})`, cleared, url);
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    // A callback whose state does not match the one this browser was given is
    // somebody else's callback, replayed here.
    if (!code || !state || !expectedState || !verifier || state !== expectedState) {
      return failure("this sign-in did not start here, or it took too long", cleared, url);
    }

    try {
      const tokens = await exchangeCode(config, code, verifier, fetchImpl);
      const identity = await readIdentity(config, tokens, fetchImpl);
      const expiresAt = Math.floor(now() / 1000) + settings.sessionMaxAgeSeconds;
      const session = signSession({ subject: identity.subject, role: identity.role, expiresAt }, settings.sessionSecret);
      return redirect(returnTo, [
        ...cleared,
        sessionCookie(IDENTITY_COOKIE, session, url, settings.sessionMaxAgeSeconds),
        // Kept so the provider can be told which session is ending; it is the
        // provider's own value and says nothing this deployment has to protect.
        ...(tokens.idToken ? [sessionCookie(ID_TOKEN_COOKIE, tokens.idToken, url, settings.sessionMaxAgeSeconds)] : []),
      ]);
    } catch (error) {
      // An OidcError is Parallax's sentence about Parallax's own decision --
      // most usefully "you have no role here", which is otherwise indisting-
      // uishable from the provider being broken.
      const reason = error instanceof OidcError ? error.message : "the sign-in could not be completed";
      return failure(reason, cleared, url);
    }
  }

  function logout(request: Request, url: URL): Response {
    const idToken = readCookie(request.headers.get("cookie"), ID_TOKEN_COOKIE);
    const cleared = [clearedCookie(IDENTITY_COOKIE, url), clearedCookie(ID_TOKEN_COOKIE, url)];
    const returnTo = new URL("/", url).toString();
    return redirect(endSessionUrl(config, idToken, returnTo), cleared);
  }
}

function safeReturnPath(value: string | null | undefined): string {
  // Only a path on this origin. A browser reads the backslashes in `/\evil` as
  // slashes, so they are refused rather than normalized.
  if (!value || !value.startsWith("/") || /^[/\\]{2}/u.test(value) || value.includes("\\")) return "/";
  return value;
}

function failure(reason: string, cookies: string[], url: URL): Response {
  const target = new URL("/", url);
  target.searchParams.set("signin_error", reason);
  return redirect(target.toString(), cookies);
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function handshakeCookie(name: string, value: string, url: URL): string {
  // Lax, not Strict: the provider redirects the browser here from its own site,
  // and a Strict cookie is not sent on that navigation -- the callback would
  // never see the state it is supposed to compare.
  return cookie(name, value, url, HANDSHAKE_SECONDS, "Lax");
}

function sessionCookie(name: string, value: string, url: URL, maxAgeSeconds: number): string {
  return cookie(name, value, url, maxAgeSeconds, "Lax");
}

function clearedCookie(name: string, url: URL): string {
  return cookie(name, "", url, 0, "Lax");
}

function cookie(name: string, value: string, url: URL, maxAgeSeconds: number, sameSite: string): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${maxAgeSeconds}`,
    ...(url.protocol === "https:" ? ["Secure"] : []),
  ].join("; ");
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const IDENTITY_TEST_COOKIES = { STATE_COOKIE, VERIFIER_COOKIE, RETURN_COOKIE, ID_TOKEN_COOKIE, randomUrlSafe };
