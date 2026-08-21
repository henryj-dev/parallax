import type { IncomingMessage, ServerResponse } from "node:http";
import { ConflictError, NotFoundError, ProviderManagedRecordError } from "../application/control-plane.ts";
import { CredentialNotFoundError, CredentialTestError } from "../application/cloudflare-credentials.ts";
import { ZoneLookupForbiddenError, ZoneNotFoundError } from "../adapters/cloudflare.ts";
import { FallbackDomainForbiddenError, FallbackDomainUnavailableError } from "../adapters/cloudflare-fallback.ts";
import { FallbackDomainOwnershipError } from "../application/fallback-domains.ts";
import { ProviderNotConfiguredError } from "../application/ports.ts";
import { parseInvocation, UsageError } from "../cli/argv.ts";
import {
  CommandPermissionError,
  CommandUnavailableError,
  runCommand,
  UnknownCommandError,
  type CommandInput,
  type CommandRuntime,
} from "../cli/commands.ts";
import { DomainValidationError } from "../domain/dns.ts";
import { CredentialInUseError, CredentialValidationError } from "../security/credential-store.ts";
import { authenticate, createAuthorizedHandler, setTrustedClientKey, type Role, type SecurityConfig } from "../security/http-authorization.ts";

const MAX_REQUEST_BODY_BYTES = 1_048_576;

/**
 * Every route is a translation: it turns an HTTP request into one command
 * invocation and that command's result into a response. The command layer holds
 * the behaviour, so the API and the command line cannot drift apart.
 */
export function createApiHandler(
  runtime: CommandRuntime,
  security?: SecurityConfig | (() => SecurityConfig),
): (request: Request) => Promise<Response> {
  const resolveSecurity = typeof security === "function" ? security : () => security ?? { enabled: false, tokens: [] };
  const handler = async (request: Request): Promise<Response> => {
    try {
      return await route(runtime, request, resolveSecurity());
    } catch (error) {
      return errorResponse(error);
    }
  };
  // Always wrap: even with authentication disabled the security layer owns the
  // audit actor, so a client can never choose the identity of its own changes.
  const authorized = createAuthorizedHandler(security ?? { enabled: false, tokens: [] }, handler);
  return async (request) => authorized(request);
}

export interface NodeHandlerOptions {
  /** Absolute origin the portal is reached at, e.g. `https://dns.example.com`. */
  readonly publicOrigin?: string;
  /** Trust `X-Forwarded-Proto`/`X-Forwarded-Host` from a reverse proxy in front of this server. */
  readonly trustForwardedHeaders?: boolean;
  /** This listener ended the TLS connection itself, so requests on it are `https`. */
  readonly terminatesTls?: boolean;
}

export function createNodeHandler(
  runtime: CommandRuntime,
  security?: SecurityConfig | (() => SecurityConfig),
  options: NodeHandlerOptions = {},
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const handler = createApiHandler(runtime, security);
  return async (request, response) => {
    const origin = requestOrigin(request, options);
    let body: Buffer;
    try {
      body = request.method === "GET" || request.method === "HEAD" ? Buffer.alloc(0) : await readBody(request);
    } catch (error) {
      if (!(error instanceof RequestBodyTooLargeError)) throw error;
      response.writeHead(413, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "payload_too_large", message: "request body exceeds 1 MiB" }));
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    const fetchRequest = new Request(new URL(request.url ?? "/", origin), {
      method: request.method,
      headers,
      ...(body.length > 0 ? { body } : {}),
    });
    // Do not copy a client-controlled marker header into the authentication
    // layer. The transport attaches out-of-band metadata to this Request; only
    // a configured trusted proxy may supply the forwarded client address.
    setTrustedClientKey(fetchRequest, requestClientKey(request, options));
    const result = await handler(fetchRequest);
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    const payload = Buffer.from(await result.arrayBuffer());
    if (request.method === "HEAD") {
      response.setHeader("content-length", String(payload.byteLength));
      response.end();
      return;
    }
    response.end(payload);
  };
}

function requestClientKey(request: IncomingMessage, options: NodeHandlerOptions): string {
  const forwarded = options.trustForwardedHeaders
    ? lastHeaderValue(request.headers["x-forwarded-for"])
    : undefined;
  return forwarded ?? request.socket?.remoteAddress ?? "unknown-client";
}

function lastHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value.at(-1) : value;
  return raw?.split(",").at(-1)?.trim() || undefined;
}

/**
 * The origin a browser used to reach this server. Reconstructing it as `http://`
 * would reject every same-origin proof sent by a client behind TLS termination,
 * so an explicit public origin or trusted forwarding headers take precedence.
 */
export function requestOrigin(request: IncomingMessage, options: NodeHandlerOptions): string {
  if (options.publicOrigin) return options.publicOrigin;
  const forwarded = options.trustForwardedHeaders ? forwardedOrigin(request) : undefined;
  // A server that ended TLS itself knows the scheme without being told. Falling
  // back to `http` here would reject every cookie-authenticated mutation and
  // drop `Secure` from the cookie -- the same defect as reconstructing a proxied
  // request as plaintext, arrived at from the opposite direction.
  const scheme = options.terminatesTls ? "https" : "http";
  return forwarded ?? `${scheme}://${request.headers.host ?? "localhost"}`;
}

function forwardedOrigin(request: IncomingMessage): string | undefined {
  const protocol = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const host = firstHeaderValue(request.headers["x-forwarded-host"]) ?? request.headers.host;
  if (!host || (protocol !== "http" && protocol !== "https")) return undefined;
  return `${protocol}://${host}`;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

/** One HTTP request resolved to a command, its input, and how to answer. */
interface RouteMatch {
  readonly command: string;
  readonly input: CommandInput;
  readonly status?: number;
  /** Answer 204 with no body instead of serialising the result. */
  readonly empty?: boolean;
  /** Include the result's revision as an ETag. */
  readonly revisioned?: boolean;
}

async function route(runtime: CommandRuntime, request: Request, security: SecurityConfig): Promise<Response> {
  const url = new URL(request.url);
  const segments = decodeSegments(url.pathname);
  // HEAD must resolve exactly like GET; the body is dropped by the transport.
  const method = request.method === "HEAD" ? "GET" : request.method;
  if (segments[0] !== "api" || segments[1] !== "v1") throw new NotFoundError("route was not found");

  const context = {
    runtime,
    actor: request.headers.get("x-parallax-actor") ?? "web-console",
    role: roleOf(request, security),
  };

  // Serving commands, reachable over HTTP through the same dispatcher. The
  // runtime intentionally has no `migrate` capability, so an HTTP admin can
  // never turn the server's database role into a schema-changing role.
  if (segments[2] === "cli" && segments.length === 3 && method === "POST") {
    const body = await parseJson(request);
    const argv = body.argv;
    if (!Array.isArray(argv) || argv.some((token) => typeof token !== "string")) {
      throw new DomainValidationError(["argv must be an array of strings"]);
    }
    const invocation = parseInvocation(argv as string[]);
    return json({
      command: invocation.name,
      result: await runCommand(context, invocation.name, invocation.input),
    });
  }

  const match = await matchRoute(segments, method, url, request);
  const result = await runCommand(context, match.command, match.input);
  if (match.empty) return new Response(null, { status: 204 });
  if (match.revisioned) return revisionJson(result as { revision: number }, match.status ?? 200);
  return json(result, match.status ?? 200);
}

async function matchRoute(segments: string[], method: string, url: URL, request: Request): Promise<RouteMatch> {
  const area = segments[2];

  // One line per zone, for a list that would otherwise ask once per row. The
  // per-zone page keeps its own route under the zone it describes.
  if (area === "status" && segments.length === 3 && method === "GET") {
    return { command: "status", input: readPageQuery(url) };
  }

  if (area === "apply" && segments.length === 3 && method === "POST") {
    const retryFailed = readBooleanQuery(url, "retryFailed");
    return { command: "apply pending", input: retryFailed === undefined ? {} : { retryFailed } };
  }

  if (area === "history" && segments.length === 3 && method === "GET") {
    return { command: "history", input: readPageQuery(url) };
  }

  if (area === "settings" && segments.length === 3) {
    if (method === "GET") return { command: "settings get", input: {} };
    if (method === "PUT") return { command: "settings set", input: { values: await parseJson(request) } };
  }

  if (area === "tokens") {
    if (segments.length === 3 && method === "GET") return { command: "token list", input: {} };
    if (segments.length === 3 && method === "POST") {
      const body = await parseJson(request);
      return { command: "token issue", input: { subject: body.subject, role: body.role }, status: 201 };
    }
    if (segments.length === 4 && segments[3] && method === "DELETE") {
      return { command: "token revoke", input: { id: segments[3] }, empty: true };
    }
  }

  if (area === "credentials") return credentialRoute(segments, method, request);

  // The client-side resolver overrides, one profile at a time. Reachable over
  // HTTP because the portal is where an operator is when they ask why a zone is
  // not covered, and until now the only answer was a shell on the pod.
  if (area === "fallback") {
    const profile = segments[3];
    if (!profile) throw new NotFoundError("route was not found");
    const policy = url.searchParams.get("policy") ?? undefined;
    const action = segments[4];
    if (segments.length === 4 && method === "GET") {
      return { command: "fallback list", input: { profile, ...(policy ? { policy } : {}) } };
    }
    // No provider call, so it answers when the credential is the broken thing.
    if (segments.length === 5 && action === "coverage" && method === "GET") {
      return { command: "fallback coverage", input: { profile } };
    }
    if (segments.length === 5 && action === "preview" && method === "GET") {
      return { command: "fallback preview", input: { profile, ...(policy ? { policy } : {}) } };
    }
    if (segments.length === 5 && action === "sync" && method === "POST") {
      return { command: "fallback sync", input: { profile, ...(policy ? { policy } : {}) } };
    }
    if (segments.length === 6 && action === "domains" && segments[5]) {
      const suffix = segments[5];
      if (method === "PUT") {
        const body = await parseJson(request);
        const dnsServer = body["dns-server"] ?? body.dnsServer;
        const dnsServerText = Array.isArray(dnsServer) ? dnsServer.filter((part) => typeof part === "string").join(",") : dnsServer;
        return {
          command: "fallback set",
          input: {
            profile,
            suffix,
            ...(typeof dnsServerText === "string" ? { "dns-server": dnsServerText } : {}),
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(policy ? { policy } : {}),
          },
        };
      }
      if (method === "DELETE") {
        return { command: "fallback delete", input: { profile, suffix, ...(policy ? { policy } : {}) } };
      }
    }
    throw new NotFoundError("route was not found");
  }

  if (area === "zones") {
    if (segments.length === 3 && method === "GET") {
      return { command: "zone list", input: readPageQuery(url) };
    }
    if (segments.length === 3 && method === "POST") {
      const body = await parseJson(request);
      return { command: "zone create", input: { zone: readString(body, "name") }, status: 201, revisioned: true };
    }

    const zone = segments[3];
    if (!zone) throw new NotFoundError("route was not found");
    const expectedRevision = readExpectedRevision(request);

    if (segments.length === 4 && method === "GET") return { command: "zone get", input: { zone }, revisioned: true };
    if (segments.length === 4 && method === "PUT") {
      return {
        command: "zone replace",
        input: { zone, desired: await parseJson(request), expectedRevision },
        revisioned: true,
      };
    }
    if (segments.length === 4 && method === "DELETE") {
      // Reports what was withdrawn from the provider, so the caller can see the
      // blast radius of a deletion instead of an empty 204.
      return {
        command: "zone delete",
        input: { zone, expectedRevision, abandonProviderRecords: readBooleanQuery(url, "abandonProviderRecords") },
      };
    }

    const action = segments[4];
    if (action === "preview" && segments.length === 5 && (method === "GET" || method === "POST")) {
      const desired = method === "POST" ? await parseOptionalJson(request) : undefined;
      return { command: "preview", input: { zone, view: readViewQuery(url), desired } };
    }
    if (action === "apply" && segments.length === 5 && method === "POST") {
      return { command: "apply", input: { zone, view: readViewQuery(url), expectedRevision }, revisioned: true };
    }
    if (action === "export" && segments.length === 5 && method === "GET") {
      return { command: "zone export", input: { zone, view: readViewQuery(url) } };
    }
    if (action === "import" && segments.length === 5 && method === "POST") {
      const body = await parseJson(request);
      return {
        command: "zone import",
        input: { zone, view: readViewQuery(url) ?? (typeof body.view === "string" ? body.view : undefined), text: readString(body, "text"), expectedRevision },
        revisioned: true,
      };
    }
    if (action === "adopt" && segments.length === 5 && method === "POST") {
      const dryRun = readBooleanQuery(url, "dryRun");
      return {
        command: "zone adopt",
        input: { zone, view: readViewQuery(url), expectedRevision, ...(dryRun === undefined ? {} : { dryRun }) },
        revisioned: true,
      };
    }
    if (action === "status" && segments.length === 5 && method === "GET") {
      return { command: "status", input: { zone } };
    }
    if ((action === "history" || action === "audit") && segments.length === 5 && method === "GET") {
      return { command: "history", input: { zone, ...readPageQuery(url) } };
    }
    if (action === "revisions" && segments.length === 5 && method === "GET") {
      return { command: "revision list", input: { zone, ...readPageQuery(url) } };
    }
    if (action === "revisions" && segments.length === 6 && method === "GET") {
      return { command: "revision get", input: { zone, revision: readRevision(segments[5]) } };
    }
    if (action === "revisions" && segments[6] === "restore" && segments.length === 7 && method === "POST") {
      return {
        command: "revision restore",
        input: { zone, revision: readRevision(segments[5]), expectedRevision },
        revisioned: true,
      };
    }
    if (action === "views" && segments[6] === "records" && segments.length === 8) {
      const view = requireSegment(segments[5]);
      const id = requireSegment(segments[7]);
      if (method === "PUT") {
        return {
          command: "record set",
          input: { zone, view, id, record: await parseJson(request), expectedRevision },
          revisioned: true,
        };
      }
      if (method === "DELETE") {
        return { command: "record delete", input: { zone, view, id, expectedRevision }, revisioned: true };
      }
    }
  }

  throw new NotFoundError("route was not found");
}

async function credentialRoute(segments: string[], method: string, request: Request): Promise<RouteMatch> {
  if (segments[3] === "profiles") {
    if (segments.length === 4 && method === "GET") return { command: "credential profile list", input: {} };
    const name = segments[4];
    if (!name) throw new NotFoundError("route was not found");
    if (segments.length === 5 && method === "GET") {
      return { command: "credential profile get", input: { name } };
    }
    if (segments.length === 5 && method === "PUT") {
      const body = await parseJson(request);
      return {
        command: "credential profile set",
        input: { name, token: body.token, accountId: body.accountId },
      };
    }
    if (segments.length === 5 && method === "DELETE") {
      return { command: "credential profile delete", input: { name }, empty: true };
    }
    if (segments.length === 6 && segments[5] === "test" && method === "POST") {
      const body = await parseJson(request);
      return { command: "credential profile test", input: { name, zone: body.zone, token: body.token } };
    }
    throw new NotFoundError("route was not found");
  }

  if (segments[3] !== "cloudflare") throw new NotFoundError("route was not found");
  if (segments.length === 4 && method === "GET") return { command: "credential zone list", input: {} };
  const zone = segments[4];
  if (!zone) throw new NotFoundError("route was not found");
  if (segments.length === 5 && method === "GET") return { command: "credential zone get", input: { zone } };
  if (segments.length === 5 && method === "PUT") {
    const body = await parseJson(request);
    return {
      command: "credential zone set",
      input: { zone, profile: body.profile, token: body.token, accountId: body.accountId },
    };
  }
  if (segments.length === 5 && method === "DELETE") {
    return { command: "credential zone delete", input: { zone }, empty: true };
  }
  if (segments.length === 6 && segments[5] === "test" && method === "POST") {
    const body = await parseOptionalJson(request);
    return {
      command: "credential zone test",
      input: { zone, profile: body?.profile, token: body?.token, accountId: body?.accountId },
    };
  }
  throw new NotFoundError("route was not found");
}

/** The role the security layer already authenticated, or admin when it is off. */
function roleOf(request: Request, security: SecurityConfig): Role {
  if (!security.enabled) return "admin";
  return authenticate(request, security)?.role ?? "viewer";
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function revisionJson<T extends { revision: number }>(value: T, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", etag: `"${value.revision}"` },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof DomainValidationError) return json({ error: "validation_failed", message: error.message, issues: error.issues }, 400);
  if (error instanceof NotFoundError) return json({ error: "not_found", message: error.message }, 404);
  if (error instanceof CredentialNotFoundError) return json({ error: "not_found", message: error.message }, 404);
  if (error instanceof CredentialTestError) return json({ error: "provider_test_failed", message: error.message }, 502);
  // Both name what the operator has to change, and neither carries a secret --
  // one names a permission, the other a domain the caller already supplied.
  if (error instanceof ZoneLookupForbiddenError) return json({ error: "zone_lookup_forbidden", message: error.message }, 403);
  if (error instanceof ZoneNotFoundError) return json({ error: "zone_not_found", message: error.message }, 404);
  if (error instanceof ConflictError) return json({ error: "conflict", message: error.message }, 409);
  if (error instanceof FallbackDomainOwnershipError) return json({ error: "conflict", message: error.message }, 409);
  // Not a validation failure: the record is well formed and the caller may
  // read it. It is refused because something else owns it.
  if (error instanceof ProviderManagedRecordError) return json({ error: "provider_managed", message: error.message }, 409);
  // The credential is valid and the request is well formed; the token simply
  // is not allowed here, which is a different thing to tell an operator.
  if (error instanceof FallbackDomainForbiddenError) return json({ error: "provider_forbidden", message: error.message }, 403);
  // The provider was reached, or could not be, and said something an operator
  // can act on. Every one of these messages is built from a status and codes and
  // carries no secret, so it is repeated rather than replaced by "unexpected".
  if (error instanceof FallbackDomainUnavailableError) return json({ error: "provider_unavailable", message: error.message }, 502);
  if (error instanceof ProviderNotConfiguredError) return json({ error: "provider_not_configured", message: error.message }, 409);
  if (error instanceof UnknownCommandError || error instanceof UsageError) {
    return json({ error: "unknown_command", message: error.message }, 400);
  }
  if (error instanceof CommandPermissionError) return json({ error: "forbidden", message: error.message }, 403);
  if (error instanceof CommandUnavailableError) return json({ error: "not_found", message: error.message }, 404);
  if (error instanceof CredentialValidationError) return json({ error: "validation_failed", message: error.message }, 400);
  if (error instanceof CredentialInUseError) return json({ error: "conflict", message: error.message, zones: error.zones }, 409);
  if (error instanceof URIError) return json({ error: "validation_failed", message: "request path is not valid percent-encoding" }, 400);
  return json({ error: "internal_error", message: "an unexpected error occurred" }, 500);
}

async function parseJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new DomainValidationError(["request body must be a JSON object"]);
  }
}

async function parseOptionalJson(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await request.text();
  if (text.trim().length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new DomainValidationError(["request body must be a JSON object"]);
  }
}

function readString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string") throw new DomainValidationError([`${key} must be a string`]);
  return result;
}

function readViewQuery(url: URL): string | undefined {
  return url.searchParams.get("view") ?? undefined;
}

/** Percent-decodes path segments, reporting malformed escapes as a client error. */
function decodeSegments(pathname: string): string[] {
  const raw = pathname.split("/").filter(Boolean);
  return raw.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new DomainValidationError(["request path is not valid percent-encoding"]);
    }
  });
}

function readBooleanQuery(url: URL, key: string): boolean | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  if (value !== "true" && value !== "false") throw new DomainValidationError([`${key} must be true or false`]);
  return value === "true";
}

function readPageQuery(url: URL): { limit?: number; offset?: number } {
  const limit = readNonNegativeQuery(url, "limit");
  const offset = readNonNegativeQuery(url, "offset");
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
}

function readNonNegativeQuery(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new DomainValidationError([`${key} must be a non-negative integer`]);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new DomainValidationError([`${key} must be a non-negative integer`]);
  return parsed;
}

function requireSegment(value: string | undefined): string {
  if (!value) throw new NotFoundError("route was not found");
  return value;
}

function readRevision(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new DomainValidationError(["revision must be a positive integer"]);
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new DomainValidationError(["revision must be a positive integer"]);
  return revision;
}

function readExpectedRevision(request: Request): number | undefined {
  const value = request.headers.get("if-match");
  if (value === null) return undefined;
  const match = /^"([1-9]\d*)"$/.exec(value);
  if (!match) throw new DomainValidationError(['If-Match must contain one quoted positive revision, for example "2"']);
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) {
    throw new DomainValidationError(['If-Match must contain one quoted positive revision, for example "2"']);
  }
  return revision;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) throw new RequestBodyTooLargeError();
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BODY_BYTES) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

class RequestBodyTooLargeError extends Error {}
