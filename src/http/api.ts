import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
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
import { httpAnswered, httpSeconds } from "../observability/signals.ts";
import { CredentialInUseError, CredentialValidationError } from "../security/credential-store.ts";
import { authenticate, createAuthorizedHandler, resolvedPrincipal, setTrustedClientKey, type Role, type SecurityConfig } from "../security/http-authorization.ts";

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

/**
 * A name for one request, so a line in a log and an entry in the audit trail
 * can be tied to the same call.
 *
 * A caller may supply its own -- a proxy or a client that already correlates
 * across services -- and it is echoed rather than replaced, because the point
 * is to agree with whatever is upstream. It is also untrusted input that ends
 * up in a log line and a response header, so it is accepted only in a shape
 * that can do neither of those any harm, and generated otherwise.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

function requestIdFor(request: IncomingMessage): string {
  const supplied = request.headers["x-request-id"];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  return value !== undefined && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
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
    const requestId = requestIdFor(request);
    const startedAt = performance.now();
    const result = await handler(fetchRequest);
    const seconds = (performance.now() - startedAt) / 1000;
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.setHeader("x-request-id", requestId);
    httpAnswered({ status: String(result.status) });
    httpSeconds(seconds);
    // One line per request, on stdout, as JSON.
    //
    // The audit trail records who changed what, and until now there was no way
    // to get from an entry back to the call that produced it -- or to see a
    // call that changed nothing at all. The actor is the principal the security
    // layer proved, never the header a client can send -- that one arrives on
    // the way in and would let a caller write anybody's name into this log.
    //
    // Only the path: a query string can carry a filter somebody typed, and this
    // line is going to a log aggregator.
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      requestId,
      method: request.method ?? "",
      path: new URL(fetchRequest.url).pathname,
      status: result.status,
      durationMs: Math.round(seconds * 1000),
      actor: resolvedPrincipal(fetchRequest)?.subject,
    }));
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
export interface RouteMatch {
  readonly command: string;
  readonly input: CommandInput;
  readonly status?: number;
  /** Answer 204 with no body instead of serialising the result. */
  readonly empty?: boolean;
  /** Include the result's revision as an ETag. */
  readonly revisioned?: boolean;
  /** `POST /cli` reports which command it ran alongside the result. */
  readonly envelope?: "cli";
}

/**
 * Which command a method and path reach, without running it.
 *
 * Exported because the OpenAPI document is a second description of these routes,
 * and a second description that cannot be compared with the first is one that
 * will disagree with it. `test/http/openapi.test.ts` walks every documented
 * operation through here and checks it lands on the command the document names.
 */
export async function resolveRoute(method: string, path: string, body?: unknown): Promise<RouteMatch> {
  const url = new URL(path, "http://parallax.invalid");
  const request = new Request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  const segments = decodeSegments(url.pathname);
  if (segments[0] !== "api" || segments[1] !== "v1") throw new NotFoundError("route was not found");
  return matchRoute(segments, method === "HEAD" ? "GET" : method, url, request);
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

  const match = await matchRoute(segments, method, url, request);
  const result = await runCommand(context, match.command, match.input);
  if (match.envelope === "cli") return json({ command: match.command, result });
  if (match.empty) return new Response(null, { status: 204 });
  if (match.revisioned) return revisionJson(result as { revision: number }, match.status ?? 200);
  return json(result, match.status ?? 200);
}

async function matchRoute(segments: string[], method: string, url: URL, request: Request): Promise<RouteMatch> {
  const area = segments[2];

  // Serving commands, reachable over HTTP through the same dispatcher. The
  // runtime intentionally has no `migrate` capability, so an HTTP admin can
  // never turn the server's database role into a schema-changing role.
  //
  // Resolved here rather than ahead of this function so that every route has
  // one place that says which command it reaches -- which is the thing the
  // OpenAPI document is checked against.
  if (area === "cli" && segments.length === 3 && method === "POST") {
    const body = await parseJson(request);
    const argv = body.argv;
    if (!Array.isArray(argv) || argv.some((token) => typeof token !== "string")) {
      throw new DomainValidationError(["argv must be an array of strings"]);
    }
    const invocation = parseInvocation(argv as string[]);
    return { command: invocation.name, input: invocation.input, envelope: "cli" };
  }

  // Its own route rather than a file on disk: the description is derived from
  // the command registry and the security layer at the moment it is asked for,
  // so it cannot describe a build that is no longer running.
  if (area === "openapi.json" && segments.length === 3 && method === "GET") {
    return { command: "openapi", input: {} };
  }

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
      return {
        command: "token issue",
        input: { subject: body.subject, role: body.role, ...(body.expiresIn === undefined ? {} : { expiresIn: body.expiresIn }) },
        status: 201,
      };
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
    // Every record in the zone, across its views. The per-view listing below
    // takes the same filters; this one exists because a caller synchronising a
    // zone does not want to know how many views it has before it can ask.
    if (action === "records" && segments.length === 5 && method === "GET") {
      return { command: "record list", input: { zone, ...readRecordQuery(url), ...readPageQuery(url) }, revisioned: true };
    }

    if (action === "views" && segments[6] === "records") {
      const view = requireSegment(segments[5]);
      if (segments.length === 7 && method === "GET") {
        // The path names the view, so a `?view=` in the query string cannot
        // widen or redirect the listing away from the one that was asked for.
        return {
          command: "record list",
          input: { zone, ...readRecordQuery(url), view, ...readPageQuery(url) },
          revisioned: true,
        };
      }
      if (segments.length === 7 && method === "POST") {
        return {
          command: "record create",
          input: { zone, view, record: await parseJson(request), expectedRevision },
          status: 201,
          revisioned: true,
        };
      }
      // Before the `{id}` routes, and unambiguous despite `batch` being a legal
      // record id: no method posts to a single record, so nothing else claims
      // this path. A record whose id is `batch` is still reachable by the rest.
      if (segments.length === 8 && segments[7] === "batch" && method === "POST") {
        return {
          command: "record batch",
          input: { zone, view, operations: await parseJson(request), expectedRevision },
          revisioned: true,
        };
      }
      if (segments.length === 8) {
        const id = requireSegment(segments[7]);
        if (method === "GET") return { command: "record get", input: { zone, view, id }, revisioned: true };
        if (method === "PUT") {
          return {
            command: "record set",
            input: { zone, view, id, record: await parseJson(request), expectedRevision },
            revisioned: true,
          };
        }
        if (method === "PATCH") {
          return {
            command: "record patch",
            input: { zone, view, id, record: await parseJson(request), expectedRevision },
            revisioned: true,
          };
        }
        if (method === "DELETE") {
          return { command: "record delete", input: { zone, view, id, expectedRevision }, revisioned: true };
        }
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

/**
 * The role the security layer already authenticated, or admin when it is off.
 *
 * It really did already authenticate it, so the answer is carried through
 * rather than recomputed. Asking again meant a second `prepareConfig` on every
 * request -- re-hashing every configured token to learn a role that had just
 * been established -- and the fallback below is what that second pass would
 * have degraded to anyway.
 */
function roleOf(request: Request, security: SecurityConfig): Role {
  if (!security.enabled) return "admin";
  const resolved = resolvedPrincipal(request);
  if (resolved) return resolved.role;
  // `createApiHandler` is the only production path and always goes through the
  // authorization layer. A caller that builds this handler differently -- a
  // test, an embedding -- still gets an answer rather than a wrong one.
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

/**
 * The record filters, taken from the query string. Each is left out entirely
 * when absent, so the command layer sees the same input a CLI invocation
 * without the flag would produce.
 */
function readRecordQuery(url: URL): Record<string, string | boolean> {
  const filters: Record<string, string | boolean> = {};
  for (const key of ["view", "name", "type", "content", "search"]) {
    const value = url.searchParams.get(key);
    if (value !== null) filters[key] = value;
  }
  const proxied = readBooleanQuery(url, "proxied");
  if (proxied !== undefined) filters.proxied = proxied;
  return filters;
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
