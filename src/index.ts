import { readFileSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type RequestListener } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isLoopbackHost, readConfig, usesPlaintextPostgres } from "./config.ts";
import { createNodeHandler } from "./http/api.ts";
import { createRuntime } from "./runtime.ts";
import { authenticate } from "./security/http-authorization.ts";

const config = readConfig();

let runtime;
try {
  runtime = await createRuntime(config);
} catch (error) {
  console.error(`parallax: ${error instanceof Error ? error.message : "startup failed"}`);
  process.exit(1);
}

const { controlPlane, settings: settingsService, accessTokens, provider } = runtime;

if (!accessTokens.security().enabled && !isLoopbackHost(config.host)) {
  console.error("parallax: refusing to serve a non-loopback address with no access token. Issue one from a loopback session, or set PARALLAX_AUTH_TOKENS.");
  process.exit(1);
}

accessTokens.startRefreshing(undefined, (error) => {
  console.error(`parallax: could not refresh access tokens: ${error instanceof Error ? error.message : "unknown error"}`);
});

const handleApi = createNodeHandler(runtime, () => accessTokens.security(), {
  get publicOrigin() { return settingsService.current().publicOrigin || undefined; },
  get trustForwardedHeaders() { return settingsService.current().trustForwardedHeaders; },
  terminatesTls: config.tls !== undefined,
});

/**
 * The portal lives beside the sources when run from TypeScript and two levels
 * up from the emitted JavaScript, so it is located rather than assumed.
 */
function findPublicDirectory(): string {
  let directory = import.meta.dirname;
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = resolve(directory, "public");
    if (existsSync(candidate)) return candidate;
    directory = resolve(directory, "..");
  }
  throw new Error("the portal's public directory could not be located");
}

const publicDirectory = findPublicDirectory();

const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/api-client.js", { file: "api-client.js", type: "text/javascript; charset=utf-8" }],
  ["/store.js", { file: "store.js", type: "text/javascript; charset=utf-8" }],
  ["/ttl.js", { file: "ttl.js", type: "text/javascript; charset=utf-8" }],
  ["/i18n.js", { file: "i18n.js", type: "text/javascript; charset=utf-8" }],
]);

const handleRequest: RequestListener = (request, response) => {
  void route(request, response).catch((error: unknown) => {
    console.error("request failed", error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    }
    response.end(JSON.stringify({ error: "internal_error", message: "an unexpected error occurred" }));
  });
};

/**
 * A deployment with no proxy in front of it ends TLS here. The alternative --
 * serving plaintext on the port a browser speaks TLS to -- is an address that
 * lies about itself, so a certificate is either configured and used or absent
 * and the server is plainly HTTP.
 */
function readCertificate(tls: { certFile: string; keyFile: string }): { cert: Buffer; key: Buffer } {
  return { cert: readFileSync(tls.certFile), key: readFileSync(tls.keyFile) };
}

const tlsServer = config.tls ? createTlsServer(readCertificate(config.tls), handleRequest) : undefined;
const server = tlsServer ?? createServer(handleRequest);

if (config.tls && tlsServer) {
  // Certificates are renewed under a running process. Node reads them once when
  // the server is built, so without this the pod would keep presenting the
  // expired one until something restarted it -- a failure that arrives months
  // after the deployment that caused it.
  //
  // The directory is watched rather than the file: a Kubernetes secret mount is
  // updated by swapping a symlink, which a watch on the file itself never sees.
  const tls = config.tls;
  const reload = debounce(() => {
    try {
      tlsServer.setSecureContext(readCertificate(tls));
      console.log("parallax: reloaded the TLS certificate");
    } catch (error) {
      // A half-written pair during rotation must not take the server down; the
      // context in use stays valid and the next event tries again.
      console.error(`parallax: keeping the current certificate, the new one could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  });
  for (const directory of new Set([dirname(tls.certFile), dirname(tls.keyFile)])) {
    watch(directory, { persistent: false }, reload);
  }
}

/** Rotation touches several paths at once; one reload is enough for all of them. */
function debounce(run: () => void, delay = 250): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delay);
    timer.unref();
  };
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  setSecurityHeaders(response);
  // With no access token every caller would be an administrator, so a request
  // that reached this process through a proxy is refused rather than trusted.
  if (!accessTokens.security().enabled && pathname.startsWith("/api/") && isProxiedRequest(request)) {
    response.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({
      error: "unauthorized",
      message: "issue an access token before serving this control plane through a proxy",
    }));
    return;
  }
  if (pathname === "/health/live") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    // Whether a token is required is not a secret -- an unauthenticated request
    // already reveals it -- and the portal needs it to know if it can sign out.
    response.end(JSON.stringify({
      status: "ok",
      service: "parallax",
      authentication: accessTokens.security().enabled ? "required" : "disabled",
    }));
    return;
  }
  if (pathname === "/health/ready") {
    try {
      const zones = await controlPlane.listZones();
      const missingTargets = zones.flatMap((zone) => {
        const views = new Set(zone.views.map((view) => view.name));
        if (views.has("external")) views.add("internal");
        return [...views].map((view) => `${zone.name}/${view}`).filter((target) => !provider.isConfigured(target));
      });
      if (missingTargets.length > 0) throw new Error("provider configuration is incomplete");
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      // Backend and provider details describe the deployment, so only an
      // authenticated caller receives them.
      response.end(JSON.stringify(isAuthenticated(request)
        ? {
          status: "ready",
          service: "parallax",
          storage: config.databaseUrl ? "postgresql" : "file",
          providerMode: settingsService.current().allowLocalProvider ? "local-fallback" : "configured",
        }
        : { status: "ready", service: "parallax" }));
    } catch {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "not_ready", service: "parallax" }));
    }
    return;
  }
  if (pathname.startsWith("/api/")) {
    await handleApi(request, response);
    return;
  }
  const asset = staticFiles.get(pathname);
  if (!asset || (request.method !== "GET" && request.method !== "HEAD")) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const content = await readFile(resolve(publicDirectory, asset.file));
  // Revalidate every asset rather than caching it blind: an upgraded server
  // must not keep talking to a portal build that predates its API.
  const etag = `"${createHash("sha256").update(content).digest("base64url").slice(0, 27)}"`;
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { etag, "cache-control": "no-cache" });
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache", etag });
  response.end(request.method === "HEAD" ? undefined : content);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  // Only meaningful once a browser has already reached the portal over TLS, so
  // it is safe to send unconditionally and is ignored on plain HTTP.
  response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
}

function isProxiedRequest(request: IncomingMessage): boolean {
  return ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded"]
    .some((header) => request.headers[header] !== undefined);
}

function isAuthenticated(request: IncomingMessage): boolean {
  const security = accessTokens.security();
  if (!security.enabled) return false;
  const headers = new Headers();
  for (const name of ["authorization", "cookie"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  return authenticate(new Request("http://localhost/health/ready", { headers }), security) !== undefined;
}

// Bound the time a client may take to send headers and a complete request so a
// slow or stalled connection cannot hold a server slot indefinitely.
server.headersTimeout = 15_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 10_000;

/**
 * Answers plaintext with the address the client should have used. It carries no
 * application behaviour on purpose: this listener exists so a typed hostname
 * arrives over TLS, and anything else it could do would be reachable without
 * one.
 *
 * `publicOrigin` is the answer when an administrator set one. Without it the
 * host the client asked for is used and the port is left implied, because the
 * port this process bound is not the port the client reached it on: a Kubernetes
 * Service or a published container port maps one to the other, and that mapping
 * is invisible from in here. Naming the bound port would send clients to a port
 * nothing answers on -- in exactly the deployments this listener exists for.
 */
if (config.httpRedirectPort !== undefined) {
  const redirector = createServer((request, response) => {
    setSecurityHeaders(response);
    const configured = settingsService.current().publicOrigin;
    const host = (request.headers.host ?? "").split(":")[0] || config.host;
    const origin = configured || `https://${host}`;
    response.writeHead(308, { location: `${origin}${request.url ?? "/"}`, "cache-control": "no-store" });
    response.end();
  });
  redirector.headersTimeout = 15_000;
  redirector.requestTimeout = 15_000;
  redirector.listen(config.httpRedirectPort, config.host, () => {
    console.log(`parallax: redirecting http://${config.host}:${config.httpRedirectPort} to TLS`);
    if (!settingsService.current().publicOrigin) {
      console.warn("parallax: no publicOrigin is set, so redirects assume TLS on 443 at the requested host. Set it if clients reach this deployment at any other address.");
    }
  });
}

server.listen(config.port, config.host, () => {
  console.log(`parallax: ${config.tls ? "https" : "http"}://${config.host}:${config.port}`);
  if (!accessTokens.security().enabled) {
    console.warn("parallax: no access token exists; every caller that reaches this port is an administrator. Issue one from the portal before exposing it.");
  }
  if (settingsService.current().allowLocalProvider) {
    console.warn("parallax: the local file provider is active as a fallback; applied changes for unconfigured targets do not reach a real DNS provider.");
  }
  if (!config.credentialMasterKey) {
    console.warn("parallax: PARALLAX_CREDENTIAL_MASTER_KEY is not set, so provider credentials cannot be stored. Generate one with: openssl rand -base64 32");
  }
  if (config.databaseUrl && usesPlaintextPostgres(config.databaseUrl)) {
    console.warn("parallax: DATABASE_URL does not request TLS; zone data and audit history cross the network in cleartext. Append ?sslmode=verify-full unless PostgreSQL is reached over a trusted local socket.");
  }
});
