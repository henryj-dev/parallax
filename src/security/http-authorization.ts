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
}

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

  if (method === "GET" || method === "HEAD") return true;
  if (principal.role !== "editor") return false;

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
export function createAuthorizedHandler(config: SecurityConfig, next: FetchHandler): FetchHandler {
  if (!config.enabled) return next;
  const prepared = prepareConfig(config);

  return async (request) => {
    const principal = authenticateWithPreparedTokens(request, prepared);
    if (!principal) return authenticationError(401);
    if (isUnsafeMethod(request.method) && !request.headers.has("authorization") && !hasSameOrigin(request)) {
      return authenticationError(403);
    }
    if (!authorize(principal, request)) return authenticationError(403);

    const headers = new Headers(request.headers);
    // The actor is security-owned when authentication is enabled.
    headers.set("x-parallax-actor", principal.subject);
    return next(new Request(request, { headers }));
  };
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
    if (!TOKEN_PATTERN.test(record.token) || record.token.length === 0) throw invalidConfiguration();
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

function invalidConfiguration(): TypeError {
  return new TypeError("invalid security configuration");
}
