import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ControlPlane } from "./application/control-plane.ts";
import { CloudflareCredentialManager } from "./application/cloudflare-credentials.ts";
import { CloudflareProviderAdapter } from "./adapters/cloudflare.ts";
import { CoreDnsFileAdapter } from "./adapters/coredns-file.ts";
import { NodeCoreDnsFileOperations } from "./adapters/node-coredns-files.ts";
import { RoutingProviderAdapter } from "./adapters/router.ts";
import { readConfig, usesPlaintextPostgres } from "./config.ts";
import { createNodeHandler } from "./http/api.ts";
import { createFileStateAdapters } from "./infrastructure/file-state.ts";
import { FileConfigurationStore } from "./infrastructure/file-settings.ts";
import { FileProviderAdapter } from "./infrastructure/file-provider.ts";
import { createPostgresAdapters, createPostgresPool } from "./infrastructure/postgres.ts";
import { authenticate } from "./security/http-authorization.ts";
import { EncryptedCredentialStore } from "./security/credential-store.ts";

const config = readConfig();
const stateFile = resolve(config.stateFile);
const persisted = config.databaseUrl
  ? createPostgresAdapters(createPostgresPool(config.databaseUrl))
  : createFileStateAdapters(stateFile);
const fallbackProvider = config.allowLocalProvider ? new FileProviderAdapter({ path: resolve(config.providerStateFile) }) : undefined;
const externalProviders = new Map(config.cloudflareZones.map((entry) => [
  entry.zone,
  new CloudflareProviderAdapter({ token: entry.token, zoneId: entry.zoneId, ownershipSecret: config.ownershipSecret! }),
]));
const internalProvider = config.coreDnsDirectory ? new CoreDnsFileAdapter({
  files: new NodeCoreDnsFileOperations({ root: resolve(config.coreDnsDirectory) }),
  pathForTarget: (target) => `${target.slice(0, target.lastIndexOf("/"))}.zone`,
  ownershipSecret: config.ownershipSecret!,
}) : undefined;
const provider = new RoutingProviderAdapter({
  external: externalProviders,
  ...(internalProvider ? { internal: internalProvider } : {}),
  ...(fallbackProvider ? { fallback: fallbackProvider } : {}),
});
const credentialManager = config.credentialFile && config.credentialMasterKey ? new CloudflareCredentialManager({
  store: new EncryptedCredentialStore({
    repository: new FileConfigurationStore(resolve(config.credentialFile)).credentials,
    masterKey: config.credentialMasterKey,
  }),
  router: provider,
  environmentAdapters: externalProviders,
  ownershipSecret: config.ownershipSecret!,
}) : undefined;
try {
  await credentialManager?.initialize();
} catch (error) {
  // A credential file that cannot be decrypted is usually a mismatched master
  // key. Fail with one actionable line instead of an unhandled rejection.
  console.error(`parallax: ${error instanceof Error ? error.message : "credential store could not be opened"}. Check PARALLAX_CREDENTIAL_MASTER_KEY matches the key that wrote ${config.credentialFile}.`);
  process.exit(1);
}
const controlPlane = new ControlPlane(persisted.zones, persisted.statuses, provider, undefined, persisted.applyLock, {
  maxRevisionsPerZone: config.revisionRetention,
  auditRetentionDays: config.auditRetentionDays,
});
const handleApi = createNodeHandler(controlPlane, config.security, credentialManager, {
  ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
  trustForwardedHeaders: config.trustForwardedHeaders,
});
const publicDirectory = resolve(import.meta.dirname, "..", "public");

const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/ttl.js", { file: "ttl.js", type: "text/javascript; charset=utf-8" }],
  ["/i18n.js", { file: "i18n.js", type: "text/javascript; charset=utf-8" }],
]);

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    console.error("request failed", error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    }
    response.end(JSON.stringify({ error: "internal_error", message: "an unexpected error occurred" }));
  });
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  setSecurityHeaders(response);
  // With authentication disabled every caller would be an administrator, so a
  // request that reached this process through a proxy is refused rather than
  // silently trusted.
  if (!config.security.enabled && pathname.startsWith("/api/") && isProxiedRequest(request)) {
    response.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({
      error: "unauthorized",
      message: "configure PARALLAX_AUTH_TOKENS before serving this control plane through a proxy",
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
      authentication: config.security.enabled ? "required" : "disabled",
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
        ? { status: "ready", service: "parallax", storage: config.databaseUrl ? "postgresql" : "file", providerMode: config.allowLocalProvider ? "local-fallback" : "configured" }
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
  response.writeHead(200, {
    "content-type": asset.type,
    "cache-control": asset.file === "index.html" ? "no-cache" : "public, max-age=300",
  });
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
  if (!config.security.enabled) return false;
  const headers = new Headers();
  for (const name of ["authorization", "cookie"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  return authenticate(new Request("http://localhost/health/ready", { headers }), config.security) !== undefined;
}

// Bound the time a client may take to send headers and a complete request so a
// slow or stalled connection cannot hold a server slot indefinitely.
server.headersTimeout = 15_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 10_000;

server.listen(config.port, config.host, () => {
  console.log(`parallax: http://${config.host}:${config.port}`);
  if (!config.security.enabled) {
    console.warn("parallax: authentication is disabled; every caller that reaches this port is an administrator. Set PARALLAX_AUTH_TOKENS before exposing it.");
  }
  if (config.allowLocalProvider) {
    console.warn("parallax: the local file provider is active as a fallback; applied changes for unconfigured targets do not reach a real DNS provider.");
  }
  if (config.databaseUrl && usesPlaintextPostgres(config.databaseUrl)) {
    console.warn("parallax: DATABASE_URL does not request TLS; zone data and audit history cross the network in cleartext. Append ?sslmode=verify-full unless PostgreSQL is reached over a trusted local socket.");
  }
});
