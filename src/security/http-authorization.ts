import { createHash, timingSafeEqual } from "node:crypto";

export type Role = "admin" | "editor" | "viewer";

export interface TokenRecord {
  readonly token: string;
  readonly role: Role;
  readonly subject: string;
}

export interface SecurityConfig {
  /** Authentication is bypassed only when this is explicitly false. */
  readonly enabled: boolean;
  readonly tokens: readonly TokenRecord[];
  readonly cookieName?: string;
  /** Failed attempts allowed from one client before it is refused. Defaults to 10. */
  readonly maxFailedAttempts?: number;
  /** How long a lockout lasts, in milliseconds. Defaults to one minute. */
  readonly lockoutMs?: number;
}

/** Tokens open the whole control plane, so they get the same floor as the other secrets. */
export const MIN_TOKEN_BYTES = 32;
const DEFAULT_MAX_FAILED_ATTEMPTS = 10;
const DEFAULT_LOCKOUT_MS = 60_000;

export interface Principal {
  readonly role: Role;
  readonly subject: string;
}

export type FetchHandler = (request: Request) => Response | Promise<Response>;

interface PreparedToken {
  readonly digest: Buffer;
  readonly principal: Principal;
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

  // Credential management is admin-only, including reads, when introduced.
  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "credentials") return false;

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

/** Adds optional RBAC in front of any Fetch-style API handler. */
export function createAuthorizedHandler(config: SecurityConfig, next: FetchHandler, now: () => number = Date.now): FetchHandler {
  if (!config.enabled) {
    // The actor is security-owned in both modes; a client must never be able to
    // choose the identity that its changes are recorded under.
    return (request) => next(withActor(request, "authentication-disabled"));
  }
  const prepared = prepareConfig(config);
  const throttle = new FailureThrottle(
    config.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS,
    config.lockoutMs ?? DEFAULT_LOCKOUT_MS,
    now,
  );

  return async (request) => {
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

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function prepareConfig(config: SecurityConfig): { cookieName: string; tokens: readonly PreparedToken[] } {
  const cookieName = config.cookieName ?? "parallax_session";
  if (!COOKIE_NAME_PATTERN.test(cookieName)) throw invalidConfiguration();

  const prepared: PreparedToken[] = [];
  for (const record of config.tokens) {
    if (!TOKEN_PATTERN.test(record.token) || Buffer.byteLength(record.token, "utf8") < MIN_TOKEN_BYTES) {
      throw invalidConfiguration();
    }
    if (record.role !== "admin" && record.role !== "editor" && record.role !== "viewer") throw invalidConfiguration();
    if (!SUBJECT_PATTERN.test(record.subject) || record.subject.trim().length === 0) throw invalidConfiguration();
    const recordDigest = digest(record.token);
    for (const existing of prepared) {
      if (timingSafeEqual(recordDigest, existing.digest)) throw invalidConfiguration();
    }
    prepared.push({
      digest: recordDigest,
      principal: { role: record.role, subject: record.subject },
    });
  }
  return { cookieName, tokens: prepared };
}

function authenticateWithPreparedTokens(
  request: Request,
  prepared: { cookieName: string; tokens: readonly PreparedToken[] },
): Principal | undefined {
  const candidate = readCandidate(request, prepared.cookieName);
  if (candidate === undefined) return undefined;

  const candidateDigest = digest(candidate);
  let match: Principal | undefined;
  // Compare every configured digest so the matching record's position is not observable.
  for (const record of prepared.tokens) {
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

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
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
