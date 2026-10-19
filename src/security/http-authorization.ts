import { readSession, assertSessionSecret, randomUrlSafe, signSession } from "./session-token.ts";
import { cookieNameForRequest, readCookie as readCookieValue } from "./cookies.ts";
import { createHash, timingSafeEqual } from "node:crypto";

export type Role = "admin" | "editor" | "viewer";

/**
 * Every role, least to most.
 *
 * Beside the type rather than beside the one comparison that used to hold the
 * order, because two other places need to walk it now: `satisfiesRole`, and the
 * OpenAPI document, which works out the least role that reaches each route by
 * trying them in this order.
 */
export const ROLES: readonly Role[] = ["viewer", "editor", "admin"];

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
  /** Which stored token this is, so a use can be attributed to it. */
  readonly id?: string;
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
  /** Signs browser sessions exchanged from bearer tokens. */
  readonly tokenSessionSecret?: string;
  /**
   * Signs the cookie an identity provider login leaves behind. Absent means no
   * such login is offered, and only tokens authenticate.
   */
  readonly identitySessionSecret?: string;
  /**
   * Told which stored token authenticated a request.
   *
   * Out here rather than written where it is observed: the request path must
   * not wait on a store. Whoever supplies this buffers and flushes on its own
   * schedule, so "last used" lags rather than costing a write per call.
   */
  readonly onTokenUse?: (id: string) => void;
  /**
   * 공유 저장소에 둔 불투명(opaque) 회원 세션을 확인하는 접점.
   *
   * accounts 모드에서는 회원 서비스(`AccountService`)가 이것을 맡고, legacy 모드에서는
   * 주지 않는다. 확인이 비동기여야 하는 이유는 이렇다. 세션을
   * 철회하거나 역할을 내리면 다음 요청부터 바로 반영돼야 하고, 그러려면 요청마다
   * 저장소에 물어야 한다. 서명만 확인하는 쿠키로는 그렇게 할 수 없다.
   *
   * 없으면 회원 세션 쿠키는 자격 증명으로 받지 않는다. 그 쿠키를 보낸 요청은
   * 다른 쿠키로 넘어가지 않고 인증 실패로 끝난다. 남은 쿠키는 명시적인 로그인
   * 성공(토큰 세션 POST, OIDC 콜백)과 로그아웃(DELETE, OIDC 로그아웃)이 지운다.
   */
  readonly accountSessions?: AccountSessionResolver;
  readonly disableTokenExchange?: boolean;
}

/**
 * 회원 세션 쿠키 값 하나를 저장소에서 확인한다.
 *
 * - 유효한 세션이면 `{ status: "active", role, subject }` 를 돌려준다.
 * - 없거나 만료됐거나 철회된 세션이면 `{ status: "rejected" }` 를 돌려준다.
 * - 저장소가 답하지 못하면 예외를 던진다. 이 경우는 401 이 아니라 503 이 된다.
 *   "모르겠다"를 "없다"로 읽으면 장애가 로그아웃처럼 보이고, 다른 자격 증명으로
 *   넘어가는 길이 생기기 때문이다.
 *
 * 두 메서드 모두 `ACCOUNT_SESSION_DEADLINE_MS` 안에 끝나야 한다. 넘으면 이 계층이
 * `signal` 을 중단시키고 503 으로 답한다. 쿠키 값이 `MAX_ACCOUNT_SESSION_COOKIE_BYTES`
 * 를 넘으면 장치를 부르지 않는다.
 */
export interface AccountSessionResolver {
  /**
   * 요청은 넘기지 않고 쿠키 값만 넘긴다. 확인하는 쪽이 본문을 읽어 버리면 뒤의
   * 처리기가 받을 본문이 사라진다.
   */
  resolve(value: string, signal: AbortSignal): Promise<AccountSessionResolution>;
  /**
   * 로그아웃(`DELETE /api/v1/session`)에서 그 세션을 저장소에서 끊는다. 끝까지
   * 끊었을 때만 성공으로 돌아와야 한다. 이 계층은 이 답을 받은 뒤에만 204 를
   * 보낸다. 실패하거나 시간을 넘기면 503 이고, 쿠키도 지우지 않는다. 지우기만 하면
   * 브라우저는 로그아웃된 줄 알지만 그 값을 가진 다른 사람은 계속 쓸 수 있다.
   * 이미 없는 세션을 끊는 것은 성공이다.
   */
  revoke(value: string, signal: AbortSignal): Promise<void>;
}

export type AccountSessionResolution =
  /** `recentVerification`: the member's own session entered a second-factor code within the policy window. */
  | { readonly status: "active"; readonly role: Role; readonly subject: string; readonly recentVerification?: boolean }
  | { readonly status: "rejected" };

/**
 * 요청 하나를 확인한 결과.
 *
 * `unavailable` 은 자격 증명을 판단할 저장소가 답하지 못했다는 뜻이다. 호출자는
 * 이것을 인증 실패(401)나 익명으로 바꾸지 않고 503 으로 답해야 한다.
 */
export type Authentication =
  | { readonly status: "authenticated"; readonly principal: Principal }
  | { readonly status: "unauthenticated" }
  | { readonly status: "unavailable" };

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
/**
 * 회원 세션 쿠키 이름. 토큰 세션·신원 쿠키와 따로 둔다. 한 이름을 같이 쓰면 한
 * 종류가 다른 종류로 해석되는 일이 매 요청 생긴다(`IDENTITY_COOKIE` 와 같은 이유).
 */
export const ACCOUNT_SESSION_COOKIE = "parallax_account";
/**
 * 회원 세션 쿠키 값의 상한(바이트). 넘는 값은 저장소에 묻지 않고 인증 실패다.
 * 저장소 조회 하나에 임의 길이의 값을 싣지 않으려는 안전 장치다.
 */
export const MAX_ACCOUNT_SESSION_COOKIE_BYTES = 512;
/**
 * 회원 세션 저장소에 한 번 묻고(확인·철회) 기다리는 상한(밀리초). 세션 수명
 * 정책이 아니다. 저장소가 멈췄을 때 요청이 같이 멈추지 않게 하는 안전 장치다.
 */
export const ACCOUNT_SESSION_DEADLINE_MS = 3_000;

/**
 * 어떤 자격 증명으로 확인된 주체인지.
 *
 * 선택 필드다. 역할과 이름만 보던 기존 호출자는 그대로 동작한다.
 */
export type PrincipalKind =
  | "access-token"
  | "token-session"
  | "identity-session"
  | "account-session"
  | "authentication-disabled";

export interface Principal {
  readonly role: Role;
  readonly subject: string;
  readonly kind?: PrincipalKind;
  /** Account sessions only: a code was entered recently enough for administration writes. */
  readonly recentVerification?: boolean;
}

export type FetchHandler = (request: Request) => Response | Promise<Response>;

interface PreparedToken {
  readonly digest: Buffer;
  readonly principal: Principal;
  readonly id?: string;
}

interface PreparedConfig {
  readonly cookieName: string;
  readonly tokens: readonly PreparedToken[];
  readonly identitySessionSecret?: string;
  readonly tokenSessionSecret?: string;
  readonly onTokenUse?: (id: string) => void;
  readonly accountSessions?: AccountSessionResolver;
  readonly disableTokenExchange?: boolean;
}

type RevokedSessions = Map<string, number>;

const trustedClientKeys = new WeakMap<Request, string>();
export function trustedClientKey(request: Request): string { return trustedClientKeys.get(request) ?? "direct-fetch-client"; }
/**
 * The principal this layer already established, so the routing layer does not
 * authenticate the same request a second time to learn its role.
 */
  const resolvedPrincipals = new WeakMap<Request, Principal>();

/** The principal `createAuthorizedHandler` proved, when this request came through it. */
export function resolvedPrincipal(request: Request): Principal | undefined {
  return resolvedPrincipals.get(request);
}

/** Transport-only metadata used for per-client throttling; never read from an HTTP header. */
export function setTrustedClientKey(request: Request, key: string): void {
  const normalized = key.trim();
  trustedClientKeys.set(request, normalized.length > 0 ? normalized : "unknown-client");
}

// RFC 6750 b64token syntax; excluding whitespace and header/cookie delimiters also
// makes credential extraction unambiguous.
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/u;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const SUBJECT_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;

/**
 * Authenticates one request against application-provided token records.
 * Token values are never included in the returned principal or an error.
 *
 * 동기 API 는 회원 세션을 확인할 수 없다. 그래서 `accountSessions` 가 있는
 * 설정은 받지 않고 TypeError 로 거절한다. 조용히 회원 세션을 건너뛰고 다른
 * 쿠키로 답하는 동기 경로가 남지 않게 하려는 것이다. 그런 설정에는
 * `authenticateRequest` 를 쓴다.
 */
export function authenticate(request: Request, config: SecurityConfig): Principal | undefined {
  if (config.accountSessions !== undefined) throw new TypeError("account sessions can only be checked by authenticateRequest");
  if (!config.enabled) return DISABLED_PRINCIPAL;
  const presented = presentedCredential(request, prepareConfig(config));
  return presented.kind === "settled" ? presented.principal : undefined;
}

/**
 * 요청 하나를 확인한다. 회원 세션까지 기다려서 확인하는 비동기 판이다.
 *
 * 결과는 세 가지다. 저장소가 답하지 못한 경우(`unavailable`)를 인증 실패와
 * 구분해서 돌려준다. 호출자가 그것을 401 이나 익명으로 바꾸지 않게 하려는 것이다.
 */
export async function authenticateRequest(request: Request, config: SecurityConfig): Promise<Authentication> {
  assertAccountSessionsNeedAuthentication(config);
  if (!config.enabled) return { status: "authenticated", principal: DISABLED_PRINCIPAL };
  return authenticateWithPreparedTokens(request, prepareConfig(config));
}

const DISABLED_PRINCIPAL: Principal = { role: "admin", subject: "authentication-disabled", kind: "authentication-disabled" };

/**
 * 회원 세션 확인 장치가 있는데 인증이 꺼져 있는 설정은 모순이다. 그대로 두면
 * 저장소에 회원이 있어도 모든 호출자가 관리자가 된다. 회원 0명이나 저장소
 * 장애를 익명 관리로 바꾸는 추론을 막기 위해 설정 단계에서 거절한다.
 *
 * API 처리기, `authenticateRequest`, API 밖의 관리 경로(지표, 준비 상태, 포털 진입)가
 * 모두 이 하나로 확인한다.
 */
export function assertAccountSessionsNeedAuthentication(config: SecurityConfig): void {
  if (!config.enabled && config.accountSessions !== undefined) throw invalidConfiguration();
}

/**
 * An identity provider is a second way to be a principal. Once it is
 * configured, unauthenticated callers are not treated as the
 * `authentication-disabled` administrator — they have to present a session.
 */
const identityConfigs = new WeakMap<SecurityConfig, { secret: string; result: SecurityConfig }>();

export function withIdentityProvider(config: SecurityConfig, identitySessionSecret: string): SecurityConfig {
  // The same inputs give back the same object, because the handler's prepared
  // digests are cached by object identity. `accessTokens.security()` already
  // returns a stable object while nothing changes; this used to wrap it in a
  // fresh one on every request, so with an identity provider configured the
  // cache never hit once and every request re-hashed every token.
  const cached = identityConfigs.get(config);
  if (cached && cached.secret === identitySessionSecret) return cached.result;
  const result: SecurityConfig = { ...config, enabled: true, identitySessionSecret };
  identityConfigs.set(config, { secret: identitySessionSecret, result });
  return result;
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
  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "apply" && segments.length === 3) {
    return method === "POST";
  }

  if (segments[0] !== "api" || segments[1] !== "v1" || segments[2] !== "zones") return false;

  // Creating zones and replacing a zone's complete desired state.
  if (segments.length === 3 && method === "POST") return true;
  if (segments.length === 4 && method === "PUT") return true;

  // Deleting an entire zone remains admin-only.
  if (segments.length === 4 && method === "DELETE") return false;

  if (segments.length === 5 && segments[4] === "preview" && method === "POST") return true;
  if (segments.length === 5 && segments[4] === "apply" && method === "POST") return true;
  if (segments.length === 5 && segments[4] === "import" && method === "POST") return true;
  if (segments.length === 5 && segments[4] === "adopt" && method === "POST") return true;
  if (segments.length === 7 && segments[4] === "revisions" && segments[6] === "restore" && method === "POST") return true;

  // A health check is the internal view's desired state, written one policy
  // at a time the way a record is -- the same lock, revision and audit -- so it
  // takes the role a record edit takes. Only the exact policy path qualifies.
  if (segments.length === 9 && segments[4] === "views" && segments[5] === "internal" && segments[6] === "health-checks") {
    return method === "PUT" || method === "DELETE";
  }

  // Individual record mutations are desired-state editing, not zone deletion.
  if (segments[4] !== "views" || segments[6] !== "records") return false;
  // Adding a record the caller did not name an id for.
  if (segments.length === 7) return method === "POST";
  if (segments.length !== 8) return false;
  // A batch is several record edits committed as one revision. Every operation
  // in it is one this role may already make on its own, so the grouping is what
  // changes, not the permission.
  if (segments[7] === "batch" && method === "POST") return true;
  return method === "PUT" || method === "PATCH" || method === "DELETE";
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
  const revokedSessions: RevokedSessions = new Map();
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

  assertAccountSessionsNeedAuthentication(initial);
  return async (request) => {
    const clientKey = trustedClientKeys.get(request) ?? "direct-fetch-client";
    const config = resolve();
    assertAccountSessionsNeedAuthentication(config);
    if (!config.enabled) {
      // The actor is security-owned in both modes; a client must never be able
      // to choose the identity that its changes are recorded under.
      return next(withActor(request, "authentication-disabled"));
    }
    const prepared = preparedFor(config);
    const sessionMaxAge = config.sessionMaxAgeSeconds ?? DEFAULT_SESSION_MAX_AGE_SECONDS;
    if (isSessionRoute(request)) return handleSession(request, prepared, throttle, sessionMaxAge, clientKey, now, revokedSessions);

    const authentication = await authenticateWithPreparedTokens(request, prepared, revokedSessions, now);
    // 저장소가 답하지 못한 것은 잘못된 자격 증명이 아니다. 실패로 세지 않고,
    // 다시 로그인하라는 401 도 보내지 않는다.
    if (authentication.status === "unavailable") return authenticationUnavailable();
    if (authentication.status === "unauthenticated") {
      const retryAfterMs = throttle.recordFailure(clientKey);
      return retryAfterMs === undefined ? authenticationError(401) : tooManyAttempts(retryAfterMs);
    }
    const principal = authentication.principal;
    if (isUnsafeMethod(request.method) && !request.headers.has("authorization") && !hasSameOrigin(request)) {
      return authenticationError(403);
    }
    if (!authorize(principal, request)) return authenticationError(403);
    // A member administrator writes tokens, credentials, settings or runs a command only with a fresh code.
    // Decided on the router's own reading of the path, so `//`, `%74` or a trailing `/` cannot slip past it.
    if (principal.kind === "account-session" && principal.role === "admin" && isUnsafeMethod(request.method)) {
      const surface = isStepUpSurface(request);
      if (surface === undefined) return Response.json({ error: "invalid_path" }, { status: 400, headers: { "cache-control": "no-store" } });
      if (surface && !principal.recentVerification) return Response.json({ error: "reauthentication_required" }, { status: 403, headers: { "cache-control": "no-store" } });
    }
    // Recorded against the request the transport still holds, as well as the
    // one handed onward. The transport needs it to name the actor in its access
    // log, and the header it would otherwise read is client-supplied on the way
    // in -- reading that would let a caller write anybody's name into the log.
    resolvedPrincipals.set(request, principal);
    return next(withActor(request, principal.subject, principal));
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
  clientKey: string,
  now: () => number,
  revokedSessions: RevokedSessions,
): Promise<Response> {
  if (request.method === "GET") {
    // Who the caller currently is. The portal draws itself from this: an
    // administration control it cannot use is worse than one it cannot see,
    // because pressing it is the only way to find out.
    const authentication = await authenticateWithPreparedTokens(request, prepared, revokedSessions, now);
    if (authentication.status === "unavailable") return authenticationUnavailable();
    return authentication.status === "authenticated"
      ? Response.json(
        { role: authentication.principal.role, subject: authentication.principal.subject },
        { headers: { "cache-control": "no-store" } },
      )
      : authenticationError(401);
  }
  if (request.method !== "POST" && request.method !== "DELETE") {
    return Response.json({ error: "not_found", message: "route was not found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (!hasSameOrigin(request)) return authenticationError(403);
  if (request.method === "DELETE") {
    // 회원 세션은 저장소에서 먼저 끊는다. 끊었다는 답을 받기 전에는 204 를 보내지
    // 않는다. 쿠키만 지우고 성공이라 답하면 그 값은 저장소에 살아 있다.
    const accountSessions = prepared.accountSessions;
    if (accountSessions !== undefined) {
      const values = presentedAccountSessionValues(request);
      if (values.length > 0) {
        try {
          await withAccountSessionDeadline((signal) => Promise.all(values.map((value) => accountSessions.revoke(value, signal))));
        } catch {
          return authenticationUnavailable();
        }
      }
    }
    revokeTokenSession(request, prepared, revokedSessions, now);
    // 확인 장치가 없는 배포에서는 회원 쿠키가 쓸모없는 값이다. 남아 있으면 다른
    // 로그인을 모두 막으므로, 로그아웃이 같이 지운다.
    const headers = new Headers({ "cache-control": "no-store" });
    headers.append("set-cookie", clearedCookieValue(prepared.cookieName, request));
    headers.append("set-cookie", clearedAccountSessionCookie(request));
    return new Response(null, { status: 204, headers });
  }

  if (prepared.disableTokenExchange) return Response.json({ error: "human_login_required" }, { status: 403, headers: { "cache-control": "no-store" } });
  let candidate: unknown;
  try {
    const body: unknown = await request.json();
    candidate = isRecord(body) ? body.token : undefined;
  } catch {
    candidate = undefined;
  }
  const principal = typeof candidate === "string" ? matchToken(candidate, prepared) : undefined;
  if (!principal) {
    const retryAfterMs = throttle.recordFailure(clientKey);
    return retryAfterMs === undefined ? authenticationError(401) : tooManyAttempts(retryAfterMs);
  }
  if (prepared.tokenSessionSecret === undefined) {
    return Response.json(
      { error: "session_unavailable", message: "a session signing secret is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const session = signSession({
    subject: principal.subject,
    role: principal.role,
    expiresAt: Math.floor(now() / 1000) + maxAgeSeconds,
    id: randomUrlSafe(18),
  }, prepared.tokenSessionSecret);
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", sessionCookieValue(prepared.cookieName, session, request, maxAgeSeconds));
  // 명시적인 로그인이 성공했을 때만 남은 회원 쿠키를 지운다. 확인 장치가 없는
  // 배포에서 그 쿠키는 이 새 세션을 가린다(회원 쿠키가 있으면 그것으로만 판단한다).
  // 평소 요청에서는 지우지도, 건너뛰지도 않는다. 실패한 로그인도 지우지 않는다.
  // 확인 장치가 있으면 그 쿠키는 살아 있는 회원 세션일 수 있으므로 손대지 않는다.
  if (prepared.accountSessions === undefined) headers.append("set-cookie", clearedAccountSessionCookie(request));
  return Response.json(
    { role: principal.role, subject: principal.subject, expiresIn: maxAgeSeconds },
    { status: 200, headers },
  );
}

/**
 * 회원 세션 쿠키를 지우는 Set-Cookie 값. 회원 쿠키의 속성 계약과 같아야 지워진다.
 * 계약: `Path=/`, `HttpOnly`, `SameSite=Strict`, Domain 없음, https 에서는 `Secure`
 * 와 `__Host-` 이름. OIDC 경로도 이것을 쓴다.
 */
export function clearedAccountSessionCookie(requestOrUrl: Request | URL): string {
  return clearedCookieValue(ACCOUNT_SESSION_COOKIE, requestOrUrl);
}

function sessionCookieValue(name: string, token: string, request: Request, maxAgeSeconds: number): string {
  const cookieName = cookieNameForRequest(name, request);
  return [
    `${cookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(isSecureRequest(request) ? ["Secure"] : []),
  ].join("; ");
}

function clearedCookieValue(name: string, requestOrUrl: Request | URL): string {
  const url = requestOrUrl instanceof URL ? requestOrUrl : new URL(requestOrUrl.url);
  return [
    `${cookieNameForRequest(name, url)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(url.protocol === "https:" ? ["Secure"] : []),
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

function withActor(request: Request, subject: string, principal?: Principal): Request {
  const headers = new Headers(request.headers);
  headers.set("x-parallax-actor", subject);
  const next = new Request(request, { headers });
  // Carried out of band rather than in a header: a header is client-supplied
  // input everywhere else, and the role decides what the caller may do.
  if (principal) resolvedPrincipals.set(next, principal);
  return next;
}

/**
 * Tells a client that is failing to authenticate to back off, without letting
 * it lock anybody out.
 *
 * Only failures are counted, and the count is taken *after* the credential has
 * been checked -- so a valid token is accepted immediately however much noise
 * precedes it, including from the same address. That is the property being
 * bought, and it is the reason the check is not moved in front: a client key is
 * an address, many real clients share one behind a proxy or a NAT, and refusing
 * before checking would turn one attacker into an outage for everyone beside
 * them.
 *
 * The cost of that choice, said plainly because it was once described as
 * something else: this does **not** slow an attacker down. Every guess is still
 * evaluated, and the answer still distinguishes a right token from a wrong one
 * -- 429 rather than 401 is the only difference once the budget is spent. What
 * makes guessing hopeless is the size of the secret, not this: `MIN_TOKEN_BYTES`
 * is 32, issued tokens are 32 random bytes, and `isStrongBootstrapToken`
 * refuses anything else.
 */
class FailureThrottle {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #clients = new Map<string, { failures: number; windowStartedAt: number }>();

  constructor(limit: number, windowMs: number, now: () => number) {
    this.#limit = Math.max(1, Math.trunc(limit));
    this.#windowMs = Math.max(1, Math.trunc(windowMs));
    this.#now = now;
  }

  /** Returns the retry-after delay in milliseconds once the window's budget is spent. */
  recordFailure(clientKey: string): number | undefined {
    const now = this.#now();
    let client = this.#clients.get(clientKey);
    if (!client || now - client.windowStartedAt >= this.#windowMs) {
      client = { failures: 0, windowStartedAt: now };
    }
    client.failures += 1;
    // Refresh insertion order so the bounded map evicts an actually idle key,
    // never the client whose current attempt is being counted.
    this.#clients.delete(clientKey);
    this.#clients.set(clientKey, client);
    // A trusted proxy can still have many real clients. Bound idle bookkeeping
    // without ever turning one client's failures into another's lockout.
    if (this.#clients.size > 10_000) this.#clients.delete(this.#clients.keys().next().value as string);
    if (client.failures <= this.#limit) return undefined;
    return Math.max(1, client.windowStartedAt + this.#windowMs - now);
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
export function hasSameOrigin(request: Request): boolean {
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
  // 토큰 쿠키가 회원 세션 쿠키 이름을 쓰면 토큰 세션이 회원 세션으로 읽힌다.
  if (cookieName.replace(/^__Host-/u, "") === ACCOUNT_SESSION_COOKIE) throw invalidConfiguration();
  if (config.identitySessionSecret !== undefined) assertSessionSecret(config.identitySessionSecret);
  if (config.tokenSessionSecret !== undefined) assertSessionSecret(config.tokenSessionSecret);

  const prepared: PreparedToken[] = [];
  // A `Set` rather than a scan of every digest prepared so far. The scan was
  // O(n²) and used `timingSafeEqual`, which is the wrong tool twice over: this
  // loop validates *configuration*, it does not authenticate anybody, and what
  // it compares are already-hashed digests rather than secrets. The constant
  // time that does matter is in `matchToken`, which is untouched.
  //
  // Measured through this handler at 1000 tokens: 18.36 ms per request before.
  const seen = new Set<string>();
  const add = (recordDigest: Buffer, role: Role, subject: string, id?: string): void => {
    if (role !== "admin" && role !== "editor" && role !== "viewer") throw invalidConfiguration();
    if (!SUBJECT_PATTERN.test(subject) || subject.trim().length === 0) throw invalidConfiguration();
    const key = recordDigest.toString("base64url");
    if (seen.has(key)) throw invalidConfiguration();
    seen.add(key);
    prepared.push({ digest: recordDigest, principal: { role, subject, kind: "access-token" }, ...(id === undefined ? {} : { id }) });
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
    add(decoded, record.role, record.subject, record.id);
  }
  return {
    cookieName,
    tokens: prepared,
    ...(config.identitySessionSecret === undefined ? {} : { identitySessionSecret: config.identitySessionSecret }),
    ...(config.tokenSessionSecret === undefined ? {} : { tokenSessionSecret: config.tokenSessionSecret }),
    ...(config.onTokenUse === undefined ? {} : { onTokenUse: config.onTokenUse }),
    ...(config.accountSessions === undefined ? {} : { accountSessions: config.accountSessions }),
    ...(config.disableTokenExchange ? { disableTokenExchange: true } : {}),
  };
}

/**
 * 요청이 내민 자격 증명. 동기로 끝나는 것은 여기서 판정하고(`settled`), 회원
 * 세션만 저장소에 물어야 하므로 값을 들고 나간다. 동기·비동기 판이 우선순위를
 * 이 한 곳에서 같이 쓴다.
 */
type PresentedCredential =
  | { readonly kind: "settled"; readonly principal: Principal | undefined }
  | { readonly kind: "account-session"; readonly value: string; readonly resolver: AccountSessionResolver };

async function authenticateWithPreparedTokens(
  request: Request,
  prepared: PreparedConfig,
  revokedSessions: RevokedSessions = new Map(),
  now: () => number = Date.now,
): Promise<Authentication> {
  const presented = presentedCredential(request, prepared, revokedSessions, now);
  if (presented.kind === "settled") {
    return presented.principal === undefined
      ? { status: "unauthenticated" }
      : { status: "authenticated", principal: presented.principal };
  }
  let resolution: unknown;
  try {
    resolution = await withAccountSessionDeadline((signal) => presented.resolver.resolve(presented.value, signal));
  } catch {
    // 던졌거나 시간을 넘겼다. 어느 쪽도 "없음"이 아니다.
    return { status: "unavailable" };
  }
  return accountSessionOutcome(resolution);
}

/**
 * 회원 세션 저장소에 묻는 일 하나를 `ACCOUNT_SESSION_DEADLINE_MS` 안으로 묶는다.
 * 넘으면 `signal` 을 중단시키고 거절한다. 장치가 signal 을 무시해도 이 요청은
 * 기다리지 않는다.
 */
async function withAccountSessionDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("account session store did not answer in time");
      controller.abort(error);
      reject(error);
    }, ACCOUNT_SESSION_DEADLINE_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** 상한 안의 회원 쿠키 값인지. 넘는 값은 저장소에 묻지 않는다. */
function isAccountSessionValue(value: string): boolean {
  return TOKEN_PATTERN.test(value) && Buffer.byteLength(value, "utf8") <= MAX_ACCOUNT_SESSION_COOKIE_BYTES;
}

/**
 * 로그아웃이 끊을 회원 세션 값. 인증은 두 번 온 쿠키를 어느 쪽도 믿지 않지만,
 * 철회는 권한을 줄이기만 하므로 받은 값을 모두 끊는다. 모양이 틀리거나 상한을
 * 넘는 값은 어떤 세션도 가리킬 수 없으므로 뺀다.
 */
function presentedAccountSessionValues(request: Request): string[] {
  const name = cookieNameForRequest(ACCOUNT_SESSION_COOKIE, request);
  const values = new Set<string>();
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      continue;
    }
    if (isAccountSessionValue(value)) values.add(value);
  }
  return [...values];
}

function presentedCredential(
  request: Request,
  prepared: PreparedConfig,
  revokedSessions: RevokedSessions = new Map(),
  now: () => number = Date.now,
): PresentedCredential {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
    // Explicit credentials are authoritative. A malformed or invalid Bearer
    // value must not silently inherit the browser's OIDC identity cookie.
    return settled(match?.[1] === undefined ? undefined : matchToken(match[1], prepared));
  }
  const cookies = request.headers.get("cookie");
  // 회원 세션 쿠키를 보낸 요청은 그 쿠키로만 판단한다. 값이 망가졌거나 두 번
  // 왔거나, 상한을 넘거나, 확인할 장치가 없으면 인증 실패다. 옆의 토큰 세션·신원
  // 쿠키로 넘어가면, 철회된 회원 세션을 든 브라우저가 다른 신분으로 계속 행동하게
  // 된다. 남은 쿠키는 명시적인 로그인 성공이나 로그아웃이 지운다.
  const accountCookie = cookieNameForRequest(ACCOUNT_SESSION_COOKIE, request);
  if (hasCookie(cookies, accountCookie)) {
    const value = readCookie(cookies, accountCookie);
    return value === undefined || !isAccountSessionValue(value) || prepared.accountSessions === undefined
      ? settled(undefined)
      : { kind: "account-session", value, resolver: prepared.accountSessions };
  }
  const candidate = readCookie(cookies, cookieNameForRequest(prepared.cookieName, request));
  if (prepared.tokenSessionSecret !== undefined) {
    return settled(candidate === undefined ? undefined : matchTokenSession(candidate, prepared.tokenSessionSecret, revokedSessions, now));
  }
  // A token-shaped cookie is never accepted without the separate signing
  // secret. This also retires raw bearer cookies left by an older deployment.
  if (candidate !== undefined) return settled(undefined);
  // Second, not first: a request that presented a token meant to act as that
  // token, and answering it as whoever the browser happens to be signed in as
  // would attribute the change to the wrong actor.
  return settled(prepared.identitySessionSecret === undefined
    ? undefined
    : matchIdentitySession(request, prepared.identitySessionSecret));
}

function settled(principal: Principal | undefined): PresentedCredential {
  return { kind: "settled", principal };
}

/**
 * 확인 장치의 답을 그대로 믿지 않는다. 모양이 틀린 답은 "거절"이 아니라
 * "답하지 못함"으로 본다. 알 수 없는 역할을 가장 낮은 역할로 바꿔 들이는 일도
 * 하지 않는다.
 */
function accountSessionOutcome(resolution: unknown): Authentication {
  if (!isRecord(resolution)) return { status: "unavailable" };
  if (resolution.status === "rejected") return { status: "unauthenticated" };
  const { role, subject } = resolution;
  if (resolution.status !== "active"
    || !ROLES.includes(role as Role)
    || typeof subject !== "string"
    || !SUBJECT_PATTERN.test(subject)
    || subject.trim().length === 0) {
    return { status: "unavailable" };
  }
  return { status: "authenticated", principal: { role: role as Role, subject, kind: "account-session", ...(resolution.recentVerification === true ? { recentVerification: true } : {}) } };
}

/** 값이 어떻든 그 이름의 쿠키가 하나라도 왔는지. */
function hasCookie(header: string | null, name: string): boolean {
  if (!header) return false;
  return header.split(";").some((part) => {
    const separator = part.indexOf("=");
    return separator >= 1 && part.slice(0, separator).trim() === name;
  });
}

function matchTokenSession(value: string, secret: string, revokedSessions: RevokedSessions, now: () => number): Principal | undefined {
  const claims = readSession(value, secret, now);
  if (claims === undefined || claims.id === undefined) return undefined;
  if (revokedSessions.has(claims.id)) return undefined;
  return { role: claims.role, subject: claims.subject, kind: "token-session" };
}

function revokeTokenSession(request: Request, prepared: PreparedConfig, revokedSessions: RevokedSessions, now: () => number): void {
  if (prepared.tokenSessionSecret === undefined) return;
  const value = readCookie(request.headers.get("cookie"), cookieNameForRequest(prepared.cookieName, request));
  if (value === undefined) return;
  const claims = readSession(value, prepared.tokenSessionSecret, now);
  if (claims?.id === undefined) return;
  revokedSessions.set(claims.id, claims.expiresAt);
  for (const [id, expiresAt] of revokedSessions) {
    if (expiresAt <= Math.floor(now() / 1000) || revokedSessions.size > 10_000) revokedSessions.delete(id);
  }
}

function matchIdentitySession(request: Request, secret: string): Principal | undefined {
  const value = readCookie(request.headers.get("cookie"), cookieNameForRequest(IDENTITY_COOKIE, request));
  if (value === undefined) return undefined;
  const claims = readSession(value, secret);
  return claims === undefined ? undefined : { role: claims.role, subject: claims.subject, kind: "identity-session" };
}

function matchToken(candidate: string, prepared: PreparedConfig): Principal | undefined {
  if (!TOKEN_PATTERN.test(candidate)) return undefined;
  const candidateDigest = digest(candidate);
  let match: PreparedToken | undefined;
  // Compare every configured digest so the matching record's position is not observable.
  for (const record of prepared.tokens) {
    const equal = timingSafeEqual(candidateDigest, record.digest);
    if (equal) match = record;
  }
  // Reported after the scan, so telling anybody costs nothing observable.
  if (match?.id !== undefined) prepared.onTokenUse?.(match.id);
  return match?.principal;
}

/** A credential, so the value has to look like one as well as be unshadowed. */
function readCookie(header: string | null, name: string): string | undefined {
  return readCookieValue(header, name, (value) => TOKEN_PATTERN.test(value));
}

const DIGEST_BYTES = 32;

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** The stored form of a token: verifiable, but never reversible to the token. */
export function tokenDigest(token: string): string {
  return digest(token).toString("base64url");
}

/**
 * Whether a request reaches an administration surface that needs a fresh code: tokens, credentials,
 * settings, or the command route. Segments are read exactly as the API router reads them -- empty ones
 * dropped, each percent-decoded -- and compared without regard to case. `undefined` is a path that
 * cannot be decoded, which is refused rather than guessed at.
 */
export function isStepUpSurface(request: Request): boolean | undefined {
  const segments = pathnameSegments(request);
  if (!segments) return undefined;
  const [api, version, area] = segments.map((segment) => segment.toLowerCase());
  return api === "api" && version === "v1" && ["tokens", "credentials", "settings", "cli"].includes(area ?? "");
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

/**
 * 자격 증명을 판단할 저장소가 답하지 못했다. 401 을 보내면 클라이언트는
 * 로그아웃된 줄 알고, 익명으로 넘기면 장애가 권한 상승이 된다. 그래서 따로 답한다.
 * `www-authenticate` 는 붙이지 않는다. 다른 자격 증명을 내라는 뜻이 아니다.
 */
function authenticationUnavailable(): Response {
  return Response.json(
    { error: "authentication_unavailable", message: "credentials could not be checked right now" },
    { status: 503, headers: { "cache-control": "no-store" } },
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
