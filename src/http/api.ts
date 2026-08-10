import type { IncomingMessage, ServerResponse } from "node:http";
import { ControlPlane, ConflictError, NotFoundError } from "../application/control-plane.ts";
import { CloudflareCredentialManager, CredentialNotFoundError, CredentialTestError } from "../application/cloudflare-credentials.ts";
import { DomainValidationError } from "../domain/dns.ts";
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
  const authorized = security ? createAuthorizedHandler(security, handler) : handler;
  return async (request) => authorized(request);
}

export function createNodeHandler(controlPlane: ControlPlane, security?: SecurityConfig, credentials?: CloudflareCredentialManager): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const handler = createApiHandler(controlPlane, security, credentials);
  return async (request, response) => {
    const origin = `http://${request.headers.host ?? "localhost"}`;
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
    response.end(Buffer.from(await result.arrayBuffer()));
  };
}

async function route(controlPlane: ControlPlane, request: Request, credentials?: CloudflareCredentialManager): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== "api" || segments[1] !== "v1") {
    throw new NotFoundError("route was not found");
  }
  if (segments[2] === "credentials") return credentialRoute(credentials, segments, request);
  if (segments[2] !== "zones") throw new NotFoundError("route was not found");
  const actor = request.headers.get("x-parallax-actor") ?? "web-console";

  if (segments.length === 3 && request.method === "GET") {
    return json({ zones: await controlPlane.listZones() });
  }
  if (segments.length === 3 && request.method === "POST") {
    const body = await parseJson(request);
    return revisionJson(await controlPlane.createZone(readString(body, "name"), actor), 201);
  }

  const zone = segments[3];
  if (!zone) throw new NotFoundError("route was not found");
  if (segments.length === 4 && request.method === "GET") return revisionJson(await controlPlane.getZone(zone));
  if (segments.length === 4 && request.method === "PUT") {
    return revisionJson(await controlPlane.replaceDesiredState(zone, await parseJson(request), actor, readExpectedRevision(request)));
  }
  if (segments.length === 4 && request.method === "DELETE") {
    await controlPlane.deleteZone(zone, actor, readExpectedRevision(request));
    return new Response(null, { status: 204 });
  }

  if (segments[4] === "preview" && segments.length === 5 && (request.method === "GET" || request.method === "POST")) {
    const candidate = request.method === "POST" ? await parseOptionalJson(request) : undefined;
    return json(await controlPlane.preview(zone, readViewQuery(url), candidate));
  }
  if (segments[4] === "apply" && segments.length === 5 && request.method === "POST") {
    return revisionJson(await controlPlane.apply(zone, readViewQuery(url), readExpectedRevision(request)));
  }
  if (segments[4] === "status" && segments.length === 5 && request.method === "GET") {
    return json(await controlPlane.status(zone));
  }
  if ((segments[4] === "history" || segments[4] === "audit") && segments.length === 5 && request.method === "GET") {
    return json({ entries: await controlPlane.audit(zone) });
  }
  if (segments[4] === "revisions" && segments.length === 5 && request.method === "GET") {
    return json({ revisions: await controlPlane.listRevisions(zone) });
  }
  if (segments[4] === "revisions" && segments.length === 6 && request.method === "GET") {
    return json(await controlPlane.getRevision(zone, readRevision(segments[5])));
  }
  if (segments[4] === "revisions" && segments[6] === "restore" && segments.length === 7 && request.method === "POST") {
    return revisionJson(await controlPlane.restoreRevision(zone, readRevision(segments[5]), actor, readExpectedRevision(request)));
  }
  if (segments[4] === "views" && segments[6] === "records" && segments.length === 8) {
    const view = requireSegment(segments[5]);
    const recordId = requireSegment(segments[7]);
    if (request.method === "PUT") {
      return revisionJson(await controlPlane.upsertRecord(zone, view, recordId, await parseJson(request), actor, readExpectedRevision(request)));
    }
    if (request.method === "DELETE") {
      return revisionJson(await controlPlane.deleteRecord(zone, view, recordId, actor, readExpectedRevision(request)));
    }
  }
  throw new NotFoundError("route was not found");
}

async function credentialRoute(
  credentials: CloudflareCredentialManager | undefined,
  segments: string[],
  request: Request,
): Promise<Response> {
  if (!credentials || segments[3] !== "cloudflare") throw new NotFoundError("route was not found");
  if (segments.length === 4 && request.method === "GET") return json({ credentials: await credentials.list() });
  const zone = segments[4];
  if (!zone) throw new NotFoundError("route was not found");
  if (segments.length === 5 && request.method === "GET") {
    const credential = await credentials.get(zone);
    if (!credential) throw new CredentialNotFoundError();
    return json(credential);
  }
  if (segments.length === 5 && request.method === "PUT") {
    return json(await credentials.update(zone, readCredentialInput(await parseJson(request))));
  }
  if (segments.length === 5 && request.method === "DELETE") {
    if (!await credentials.delete(zone)) throw new CredentialNotFoundError();
    return new Response(null, { status: 204 });
  }
  if (segments.length === 6 && segments[5] === "test" && request.method === "POST") {
    const body = await parseOptionalJson(request);
    const credential = await credentials.test(zone, body ? readCredentialInput(body) : undefined);
    return json({ ok: true, credential });
  }
  throw new NotFoundError("route was not found");
}

function readCredentialInput(body: Record<string, unknown>): { zoneId: string; token: string } {
  return { zoneId: readString(body, "zoneId"), token: readString(body, "token") };
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
  if (error instanceof TypeError) return json({ error: "validation_failed", message: "invalid provider credential" }, 400);
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
