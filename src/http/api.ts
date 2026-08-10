import type { IncomingMessage, ServerResponse } from "node:http";
import { ControlPlane, ConflictError, DEFAULT_HISTORY_PAGE_SIZE, NotFoundError } from "../application/control-plane.ts";
import { CloudflareCredentialManager, CredentialNotFoundError, CredentialTestError } from "../application/cloudflare-credentials.ts";
import { ProviderNotConfiguredError, type PageRequest } from "../application/ports.ts";
import { DomainValidationError } from "../domain/dns.ts";
import { CredentialInUseError, CredentialValidationError } from "../security/credential-store.ts";
import { createAuthorizedHandler, type SecurityConfig } from "../security/http-authorization.ts";

const MAX_REQUEST_BODY_BYTES = 1_048_576;

export function createApiHandler(controlPlane: ControlPlane, security?: SecurityConfig, credentials?: CloudflareCredentialManager): (request: Request) => Promise<Response> {
  const handler = async (request: Request): Promise<Response> => {
    try {
      return await route(controlPlane, request, credentials);
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
}

export function createNodeHandler(
  controlPlane: ControlPlane,
  security?: SecurityConfig,
  credentials?: CloudflareCredentialManager,
  options: NodeHandlerOptions = {},
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const handler = createApiHandler(controlPlane, security, credentials);
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

/**
 * The origin a browser used to reach this server. Reconstructing it as `http://`
 * would reject every same-origin proof sent by a client behind TLS termination,
 * so an explicit public origin or trusted forwarding headers take precedence.
 */
function requestOrigin(request: IncomingMessage, options: NodeHandlerOptions): string {
  if (options.publicOrigin) return options.publicOrigin;
  const forwarded = options.trustForwardedHeaders ? forwardedOrigin(request) : undefined;
  return forwarded ?? `http://${request.headers.host ?? "localhost"}`;
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

async function route(controlPlane: ControlPlane, request: Request, credentials?: CloudflareCredentialManager): Promise<Response> {
  const url = new URL(request.url);
  const segments = decodeSegments(url.pathname);
  // HEAD must resolve exactly like GET; the body is dropped by the transport.
  const method = request.method === "HEAD" ? "GET" : request.method;
  if (segments[0] !== "api" || segments[1] !== "v1") {
    throw new NotFoundError("route was not found");
  }
  if (segments[2] === "credentials") return credentialRoute(credentials, segments, request, method);
  if (segments[2] !== "zones") throw new NotFoundError("route was not found");
  const actor = request.headers.get("x-parallax-actor") ?? "web-console";

  if (segments.length === 3 && method === "GET") {
    return json({ zones: await controlPlane.listZones() });
  }
  if (segments.length === 3 && method === "POST") {
    const body = await parseJson(request);
    return revisionJson(await controlPlane.createZone(readString(body, "name"), actor), 201);
  }

  const zone = segments[3];
  if (!zone) throw new NotFoundError("route was not found");
  if (segments.length === 4 && method === "GET") return revisionJson(await controlPlane.getZone(zone));
  if (segments.length === 4 && method === "PUT") {
    return revisionJson(await controlPlane.replaceDesiredState(zone, await parseJson(request), actor, readExpectedRevision(request)));
  }
  if (segments.length === 4 && method === "DELETE") {
    // Reports what was withdrawn from the provider, so the caller can see the
    // blast radius of a deletion instead of an empty 204.
    return json(await controlPlane.deleteZone(zone, actor, readExpectedRevision(request), {
      abandonProviderRecords: readBooleanQuery(url, "abandonProviderRecords") === true,
    }));
  }

  if (segments[4] === "preview" && segments.length === 5 && (method === "GET" || method === "POST")) {
    const candidate = method === "POST" ? await parseOptionalJson(request) : undefined;
    return json(await controlPlane.preview(zone, readViewQuery(url), candidate));
  }
  if (segments[4] === "apply" && segments.length === 5 && method === "POST") {
    return revisionJson(await controlPlane.apply(zone, readViewQuery(url), readExpectedRevision(request)));
  }
  if (segments[4] === "status" && segments.length === 5 && method === "GET") {
    return json(await controlPlane.status(zone));
  }
  if ((segments[4] === "history" || segments[4] === "audit") && segments.length === 5 && method === "GET") {
    return json(await controlPlane.audit(zone, readPageQuery(url)));
  }
  if (segments[4] === "revisions" && segments.length === 5 && method === "GET") {
    return json(await controlPlane.listRevisions(zone, readPageQuery(url)));
  }
  if (segments[4] === "revisions" && segments.length === 6 && method === "GET") {
    return json(await controlPlane.getRevision(zone, readRevision(segments[5])));
  }
  if (segments[4] === "revisions" && segments[6] === "restore" && segments.length === 7 && method === "POST") {
    return revisionJson(await controlPlane.restoreRevision(zone, readRevision(segments[5]), actor, readExpectedRevision(request)));
  }
  if (segments[4] === "views" && segments[6] === "records" && segments.length === 8) {
    const view = requireSegment(segments[5]);
    const recordId = requireSegment(segments[7]);
    if (method === "PUT") {
      return revisionJson(await controlPlane.upsertRecord(zone, view, recordId, await parseJson(request), actor, readExpectedRevision(request)));
    }
    if (method === "DELETE") {
      return revisionJson(await controlPlane.deleteRecord(zone, view, recordId, actor, readExpectedRevision(request)));
    }
  }
  throw new NotFoundError("route was not found");
}

async function credentialRoute(
  credentials: CloudflareCredentialManager | undefined,
  segments: string[],
  request: Request,
  method: string,
): Promise<Response> {
  if (!credentials) throw new NotFoundError("route was not found");
  if (segments[3] === "profiles") return profileRoute(credentials, segments, request, method);
  if (segments[3] !== "cloudflare") throw new NotFoundError("route was not found");

  if (segments.length === 4 && method === "GET") return json({ credentials: await credentials.listZones() });
  const zone = segments[4];
  if (!zone) throw new NotFoundError("route was not found");
  if (segments.length === 5 && method === "GET") {
    const binding = await credentials.getZone(zone);
    if (!binding) throw new CredentialNotFoundError();
    return json(binding);
  }
  if (segments.length === 5 && method === "PUT") {
    return json(await bindZone(credentials, zone, await parseJson(request)));
  }
  if (segments.length === 5 && method === "DELETE") {
    if (!await credentials.unbindZone(zone)) throw new CredentialNotFoundError();
    return new Response(null, { status: 204 });
  }
  if (segments.length === 6 && segments[5] === "test" && method === "POST") {
    const body = await parseOptionalJson(request);
    const credential = await credentials.test(zone, body ? readZoneTestInput(body) : undefined);
    return json({ ok: true, credential });
  }
  throw new NotFoundError("route was not found");
}

async function profileRoute(
  credentials: CloudflareCredentialManager,
  segments: string[],
  request: Request,
  method: string,
): Promise<Response> {
  if (segments.length === 4 && method === "GET") return json({ profiles: await credentials.listProfiles() });
  const name = segments[4];
  if (!name) throw new NotFoundError("route was not found");
  if (segments.length === 5 && method === "GET") {
    const profile = await credentials.getProfile(name);
    if (!profile) throw new CredentialNotFoundError();
    return json(profile);
  }
  if (segments.length === 5 && method === "PUT") {
    const body = await parseJson(request);
    return json(await credentials.upsertProfile(name, {
      token: readString(body, "token"),
      ...(body.accountId === undefined ? {} : { accountId: readString(body, "accountId") }),
    }));
  }
  if (segments.length === 5 && method === "DELETE") {
    if (!await credentials.deleteProfile(name)) throw new CredentialNotFoundError();
    return new Response(null, { status: 204 });
  }
  if (segments.length === 6 && segments[5] === "test" && method === "POST") {
    const body = await parseJson(request);
    const profile = await credentials.testProfile(
      name,
      readString(body, "zoneId"),
      body.token === undefined ? undefined : readString(body, "token"),
    );
    return json({ ok: true, profile });
  }
  throw new NotFoundError("route was not found");
}

/**
 * Accepts either a reference to a reusable profile or, for a single-zone setup,
 * an inline token that is stored as a profile named after the zone.
 */
async function bindZone(
  credentials: CloudflareCredentialManager,
  zone: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const zoneId = readString(body, "zoneId");
  if (body.profile !== undefined) {
    return credentials.bindZone(zone, { zoneId, profile: readString(body, "profile") });
  }
  const profile = zone.trim().toLowerCase().replace(/\.$/u, "").replace(/\./gu, "-");
  await credentials.upsertProfile(profile, {
    token: readString(body, "token"),
    ...(body.accountId === undefined ? {} : { accountId: readString(body, "accountId") }),
  });
  return credentials.bindZone(zone, { zoneId, profile });
}

function readZoneTestInput(body: Record<string, unknown>): { zoneId: string; token: string; accountId?: string } {
  return {
    zoneId: readString(body, "zoneId"),
    token: readString(body, "token"),
    ...(body.accountId === undefined ? {} : { accountId: readString(body, "accountId") }),
  };
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
  if (error instanceof ConflictError) return json({ error: "conflict", message: error.message }, 409);
  if (error instanceof ProviderNotConfiguredError) return json({ error: "provider_not_configured", message: error.message }, 409);
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

function readPageQuery(url: URL): PageRequest | undefined {
  const limit = readNonNegativeQuery(url, "limit");
  const offset = readNonNegativeQuery(url, "offset");
  if (limit === undefined && offset === undefined) return undefined;
  return { limit: limit ?? DEFAULT_HISTORY_PAGE_SIZE, offset: offset ?? 0 };
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
