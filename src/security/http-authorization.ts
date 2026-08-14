import { readSession, assertSessionSecret } from "./session-token.ts";
import { createHash, timingSafeEqual } from "node:crypto";

export type Role = "admin" | "editor" | "viewer";

export interface TokenRecord {
  readonly token: string;
  readonly role: Role;
  readonly subject: string;
}

/** A token that was hashed elsewhere, so storage never holds a usable value. */
export interface TokenDigestRecord {
  /** Base64url SHA-256 of the token. */
  readonly digest: string;
  readonly role: Role;
  readonly subject: string;
}

export interface SecurityConfig {
  /** Authentication is bypassed only when this is explicitly false. */
  readonly enabled: boolean;
  readonly tokens: readonly TokenRecord[];
  /** Pre-hashed tokens, used by backends that never store the token itself. */
  readonly digests?: readonly TokenDigestRecord[];
  readonly cookieName?: string;
  /** Failed attempts allowed from one client before it is refused. Defaults to 10. */
  readonly maxFailedAttempts?: number;
  /** How long a lockout lasts, in milliseconds. Defaults to one minute. */
  readonly lockoutMs?: number;
  /** Lifetime of an issued session cookie in seconds. Defaults to 12 hours. */
  readonly sessionMaxAgeSeconds?: number;
  /**
   * Signs the cookie an identity provider login leaves behind. Absent means no
   * such login is offered, and only tokens authenticate.
   */
  readonly identitySessionSecret?: string;
}

/** Tokens open the whole control plane, so they get the same floor as the other secrets. */
export const MIN_TOKEN_BYTES = 32;
const DEFAULT_MAX_FAILED_ATTEMPTS = 10;
const DEFAULT_LOCKOUT_MS = 60_000;
const DEFAULT_SESSION_MAX_AGE_SECONDS = 43_200;
export const SESSION_PATH = "/api/v1/session";
/**
 * Kept apart from the token cookie rather than reusing it. That one holds a
 * credential the deployment issued and can revoke; this one holds a claim about
 * a person that expires on its own. Reading both from one name would mean one
 * of them being tried as the other on every request.
 */
export const IDENTITY_COOKIE = "parallax_identity";

export interface Principal {
  readonly role: Role;
  readonly subject: string;
}

export type FetchHandler = (request: Request) => Response | Promise<Response>;

interface PreparedToken {
  readonly digest: Buffer;
  readonly principal: Principal;
}

interface PreparedConfig {
  readonly cookieName: string;
  readonly tokens: readonly PreparedToken[];
  readonly identitySessionSecret?: string;
}

// RFC 6750 b64token syntax; excluding whitespace and header/cookie delimiters also
// makes credential extraction unambiguous.
const TOKEN_PATTERN = /^[A-Za-z0-9._~+\/-]+=*$/u;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const SUBJECT_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;

/**
 * Authenticates one request against application-provided token records.
 * Token values are never included in the returned principal or an error.
 */
export function authenticate(request: Request, config: SecurityConfig): Principal | undefined {
  if (!config.enabled) return { role: "admin", subject: "authentication-disabled" };
  return authenticateWithPreparedTokens(request, prepareConfig(config));
}

/** Returns whether the principal may invoke the request's route and method. */
export function authorize(principal: Principal, request: Request): boolean {
  if (principal.role === "admin") return true;

  const method = request.method.toUpperCase();
  const segments = pathnameSegments(request);
  if (!segments) return false;

  // Credentials, settings and access tokens are administration surfaces:
  // admin-only including reads, since each one exposes or changes who can act.
  const administration = new Set(["credentials", "settings", "tokens"]);
  if (segments[0] === "api" && segments[1] === "v1" && administration.has(segments[2] ?? "")) return false;

  // The command endpoint is reachable by any role; the command it names then
  // enforces its own minimum, so one gate does not have to mirror the other.
  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "cli") return method === "POST";

  // Preview queries the live provider on every call, so it needs write-level
  // trust even though it mutates nothing.
  const previewsProvider = segments[0] === "api" && segments[1] === "v1" && segments[2] === "zones"
    && segments.length === 5 && segments[4] === "preview";
  if ((method === "GET" || method === "HEAD") && !previewsProvider) return true;
  if (principal.role !== "editor") return false;
  if (previewsProvider) return method === "GET" || method === "HEAD" || method === "POST";

  if (segments[0] !== "api" || segments[1] !== "v1" || segments[2] !== "zones") return false;

  // Creating zones and replacing a zone's complete desired state.
  if (segments.length === 3 && method === "POST") return true;
  if (segments.length === 4 && method === "PUT") return true;

  // Deleting an entire zone remains admin-only.
  if (segments.length === 4 && method === "DELETE") return false;

  if (segments.length === 5 && segments[4] === "preview" && method === "POST") return true;
  if (segments.length === 5 && segments[4] === "apply" && method === "POST") return true;
  if (segments.length === 7 && segments[4] === "revisions" && segments[6] === "restore" && method === "POST") return true;

  // Individual record mutations are desired-state editing, not zone deletion.
  return segments.length === 8
    && segments[4] === "views"
    && segments[6] === "records"
    && (method === "PUT" || method === "DELETE");
}

/**
 * Adds optional RBAC in front of any Fetch-style API handler. Accepts a
 * provider so tokens managed at runtime take effect without a restart; the
 * prepared digests are reused until the provider returns a different object.
 */
export function createAuthorizedHandler(
  source: SecurityConfig | (() => SecurityConfig),
  next: FetchHandler,
  now: () => number = Date.now,
): FetchHandler {
  const resolve = typeof source === "function" ? source : () => source;
  const initial = resolve();
  const throttle = new FailureThrottle(
    initial.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS,
    initial.lockoutMs ?? DEFAULT_LOCKOUT_MS,
    now,
  );
  let cachedConfig: SecurityConfig | undefined;
  let cachedPrepared: PreparedConfig | undefined;
  const preparedFor = (config: SecurityConfig): PreparedConfig => {
    if (cachedConfig !== config || !cachedPrepared) {
      cachedPrepared = prepareConfig(config);
      cachedConfig = config;
    }
    return cachedPrepared;
  };
  // Fail fast on a configuration that could never authenticate anyone.
  if (initial.enabled) preparedFor(initial);

  return async (request) => {
    const config = resolve();
    if (!config.enabled) {
      // The actor is security-owned in both modes; a client must never be able
      // to choose the identity that its changes are recorded under.
      return next(withActor(request, "authentication-disabled"));
    }
    const prepared = preparedFor(config);
    const sessionMaxAge = config.sessionMaxAgeSeconds ?? DEFAULT_SESSION_MAX_AGE_SECONDS;
    if (isSessionRoute(request)) return handleSession(request, prepared, throttle, sessionMaxAge);

    const principal = authenticateWithPreparedTokens(request, prepared);
    if (!principal) {
      const retryAfterMs = throttle.recordFailure();
      return retryAfterMs === undefined ? authenticationError(401) : tooManyAttempts(retryAfterMs);
    }
    throttle.recordSuccess();
    if (isUnsafeMethod(request.method) && !request.headers.has("authorization") && !hasSameOrigin(request)) {
      return authenticationError(403);
    }
    if (!authorize(principal, request)) return authenticationError(403);
    return next(withActor(request, principal.subject));
  };
}

function isSessionRoute(request: Request): boolean {
  try {
    return new URL(request.url).pathname.replace(/\/+$/, "") === SESSION_PATH;
  } catch {
    return false;
  }
}

/**
 * Exchanges a bearer token for an HttpOnly session cookie, so a browser never
 * has to keep the credential anywhere script can read it. The token arrives in
 * the body because a cross-site page can neither read a response nor forge the
 * same-origin proof this route demands.
 */
async function handleSession(
  request: Request,
  prepared: PreparedConfig,
  throttle: FailureThrottle,
  maxAgeSeconds: number,
): Promise<Response> {
  if (request.method === "GET") {
    // Who the caller currently is. The portal draws itself from this: an
    // administration control it cannot use is worse than one it cannot see,
    // because pressing it is the only way to find out.
    const principal = authenticateWithPreparedTokens(request, prepared);
    return principal
      ? Response.json({ role: principal.role, subject: principal.subject }, { headers: { "cache-control": "no-store" } })
      : authenticationError(401);
  }
  if (request.method !== "POST" && request.method !== "DELETE") {
    return Response.json({ error: "not_found", message: "route was not found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (!hasSameOrigin(request)) return authenticationError(403);
  if (request.method === "DELETE") {
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store", "set-cookie": clearedCookieValue(prepared.cookieName, request) },
    });
  }

  let candidate: unknown;
  try {
    const body: unknown = await request.json();
    candidate = isRecord(body) ? body.token : undefined;
  } catch {
    candidate = undefined;
  }
  const principal = typeof candidate === "string" ? matchToken(candidate, prepared.tokens) : undefined;
  if (!principal) {
    const retryAfterMs = throttle.recordFailure();
    return retryAfterMs === undefined ? authenticationError(401) : tooManyAttempts(retryAfterMs);
  }
  throttle.recordSuccess();
  return Response.json(
    { role: principal.role, subject: principal.subject, expiresIn: maxAgeSeconds },
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "set-cookie": sessionCookieValue(prepared.cookieName, candidate as string, request, maxAgeSeconds),
      },
    },
  );
}

function sessionCookieValue(name: string, token: string, request: Request, maxAgeSeconds: number): string {
  return [
    `${name}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(isSecureRequest(request) ? ["Secure"] : []),
  ].join("; ");
}

function clearedCookieValue(name: string, request: Request): string {
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(isSecureRequest(request) ? ["Secure"] : []),
  ].join("; ");
}

/** `Secure` would make the cookie unusable on a plain-HTTP loopback deployment. */
function isSecureRequest(request: Request): boolean {
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withActor(request: Request, subject: string): Request {
  const headers = new Headers(request.headers);
  headers.set("x-parallax-actor", subject);
  return new Request(request, { headers });
}

/**
 * Bounds online guessing without letting an attacker lock anyone out: only
 * requests that fail authentication are counted, so a valid token is always
 * accepted immediately no matter how much noise precedes it.
 */
class FailureThrottle {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #failures = 0;
  #windowStartedAt = 0;

  constructor(limit: number, windowMs: number, now: () => number) {
    this.#limit = Math.max(1, Math.trunc(limit));
    this.#windowMs = Math.max(1, Math.trunc(windowMs));
    this.#now = now;
  }

  /** Returns the retry-after delay in milliseconds once the window's budget is spent. */
  recordFailure(): number | undefined {
    const now = this.#now();
    if (this.#failures === 0 || now - this.#windowStartedAt >= this.#windowMs) {
      this.#windowStartedAt = now;
      this.#failures = 0;
    }
    this.#failures += 1;
    if (this.#failures <= this.#limit) return undefined;
    return Math.max(1, this.#windowStartedAt + this.#windowMs - now);
  }

  recordSuccess(): void {
    this.#failures = 0;
  }
}

function isUnsafeMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/**
 * Both signals are set by the browser and cannot be forged by page script, so
 * either one is proof the request did not come from another site. `Sec-Fetch-Site`
 * is the fallback for clients that omit `Origin` on same-origin requests.
 */
function hasSameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function prepareConfig(config: SecurityConfig): PreparedConfig {
  const cookieName = config.cookieName ?? "parallax_session";
  if (!COOKIE_NAME_PATTERN.test(cookieName)) throw invalidConfiguration();
  if (config.identitySessionSecret !== undefined) assertSessionSecret(config.identitySessionSecret);

  const prepared: PreparedToken[] = [];
  const add = (recordDigest: Buffer, role: Role, subject: string): void => {
    if (role !== "admin" && role !== "editor" && role !== "viewer") throw invalidConfiguration();
    if (!SUBJECT_PATTERN.test(subject) || subject.trim().length === 0) throw invalidConfiguration();
    for (const existing of prepared) {
      if (timingSafeEqual(recordDigest, existing.digest)) throw invalidConfiguration();
    }
    prepared.push({ digest: recordDigest, principal: { role, subject } });
  };

  for (const record of config.tokens) {
    if (!TOKEN_PATTERN.test(record.token) || Buffer.byteLength(record.token, "utf8") < MIN_TOKEN_BYTES) {
      throw invalidConfiguration();
    }
    add(digest(record.token), record.role, record.subject);
  }
  for (const record of config.digests ?? []) {
    const decoded = Buffer.from(record.digest, "base64url");
    if (decoded.byteLength !== DIGEST_BYTES) throw invalidConfiguration();
    add(decoded, record.role, record.subject);
  }
  return { cookieName, tokens: prepared, ...(config.identitySessionSecret === undefined ? {} : { identitySessionSecret: config.identitySessionSecret }) };
}

function authenticateWithPreparedTokens(request: Request, prepared: PreparedConfig): Principal | undefined {
  const candidate = readCandidate(request, prepared.cookieName);
  const byToken = candidate === undefined ? undefined : matchToken(candidate, prepared.tokens);
  if (byToken) return byToken;
  // Second, not first: a request that presented a token meant to act as that
  // token, and answering it as whoever the browser happens to be signed in as
  // would attribute the change to the wrong actor.
  return prepared.identitySessionSecret === undefined
    ? undefined
    : matchIdentitySession(request, prepared.identitySessionSecret);
}

function matchIdentitySession(request: Request, secret: string): Principal | undefined {
  const value = readCookie(request.headers.get("cookie"), IDENTITY_COOKIE);
  if (value === undefined) return undefined;
  const claims = readSession(value, secret);
  return claims === undefined ? undefined : { role: claims.role, subject: claims.subject };
}

function matchToken(candidate: string, tokens: readonly PreparedToken[]): Principal | undefined {
  if (!TOKEN_PATTERN.test(candidate)) return undefined;
  const candidateDigest = digest(candidate);
  let match: Principal | undefined;
  // Compare every configured digest so the matching record's position is not observable.
  for (const record of tokens) {
    const equal = timingSafeEqual(candidateDigest, record.digest);
    if (equal) match = record.principal;
  }
  return match;
}

function readCandidate(request: Request, cookieName: string): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
    return match?.[1];
  }
  return readCookie(request.headers.get("cookie"), cookieName);
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  let candidate: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name || candidate !== undefined) {
      if (key === name) return undefined;
      continue;
    }
    try {
      const decoded = decodeURIComponent(part.slice(separator + 1).trim());
      if (!TOKEN_PATTERN.test(decoded) || decoded.length === 0) return undefined;
      candidate = decoded;
    } catch {
      return undefined;
    }
  }
  return candidate;
}

const DIGEST_BYTES = 32;

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** The stored form of a token: verifiable, but never reversible to the token. */
export function tokenDigest(token: string): string {
  return digest(token).toString("base64url");
}

function pathnameSegments(request: Request): string[] | undefined {
  try {
    return new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

function authenticationError(status: 401 | 403): Response {
  const unauthorized = status === 401;
  return Response.json(
    unauthorized
      ? { error: "unauthorized", message: "authentication required" }
      : { error: "forbidden", message: "insufficient permissions" },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(unauthorized ? { "www-authenticate": "Bearer" } : {}),
      },
    },
  );
}

function tooManyAttempts(retryAfterMs: number): Response {
  return Response.json(
    { error: "too_many_attempts", message: "too many failed authentication attempts" },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(Math.ceil(retryAfterMs / 1000)),
      },
    },
  );
}

function invalidConfiguration(): TypeError {
  return new TypeError("invalid security configuration");
}
