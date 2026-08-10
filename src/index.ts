import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AccessTokenService } from "./application/access-tokens.ts";
import { ControlPlane } from "./application/control-plane.ts";
import { CloudflareCredentialManager } from "./application/cloudflare-credentials.ts";
import { SettingsService, type ParallaxSettings } from "./application/settings.ts";
import { CoreDnsFileAdapter } from "./adapters/coredns-file.ts";
import { NodeCoreDnsFileOperations } from "./adapters/node-coredns-files.ts";
import { RoutingProviderAdapter } from "./adapters/router.ts";
import { isLoopbackHost, readConfig, usesPlaintextPostgres } from "./config.ts";
import { createNodeHandler } from "./http/api.ts";
import { createFileStateAdapters } from "./infrastructure/file-state.ts";
import { FileConfigurationStore } from "./infrastructure/file-settings.ts";
import { FileProviderAdapter } from "./infrastructure/file-provider.ts";
import {
  createPostgresAdapters,
  createPostgresPool,
  PostgresAccessTokenRepository,
  PostgresCredentialRepository,
  PostgresSettingsRepository,
} from "./infrastructure/postgres.ts";
import { EncryptedCredentialStore } from "./security/credential-store.ts";
import { authenticate } from "./security/http-authorization.ts";

const config = readConfig();

// One decision picks every backend: a database when DATABASE_URL is set, files
// otherwise. Settings, credentials and tokens follow the zones.
const pool = config.databaseUrl ? createPostgresPool(config.databaseUrl) : undefined;
const fileConfiguration = pool ? undefined : new FileConfigurationStore(resolve(config.configurationFile));
const persisted = pool ? createPostgresAdapters(pool) : createFileStateAdapters(resolve(config.stateFile));
const settingsRepository = pool ? new PostgresSettingsRepository(pool) : fileConfiguration!.settings;
const credentialRepository = pool ? new PostgresCredentialRepository(pool) : fileConfiguration!.credentials;
const accessTokenRepository = pool ? new PostgresAccessTokenRepository(pool) : fileConfiguration!.accessTokens;

const settingsService = new SettingsService(settingsRepository);
const accessTokens = new AccessTokenService(accessTokenRepository, config.bootstrapTokens);
try {
  await settingsService.load();
  await accessTokens.load();
} catch (error) {
  console.error(`parallax: configuration could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}

if (!accessTokens.security().enabled && !isLoopbackHost(config.host)) {
  console.error("parallax: refusing to serve a non-loopback address with no access token. Issue one from a loopback session, or set PARALLAX_AUTH_TOKENS.");
  process.exit(1);
}

const provider = new RoutingProviderAdapter();
const credentialManager = config.credentialMasterKey
  ? new CloudflareCredentialManager({
    store: new EncryptedCredentialStore({ repository: credentialRepository, masterKey: config.credentialMasterKey }),
    router: provider,
    ownershipSecret: config.ownershipSecret ?? "",
  })
  : undefined;

/** Rebuilds the provider wiring that settings control, without a restart. */
function applyProviderSettings(settings: ParallaxSettings): void {
  provider.setFallback(settings.allowLocalProvider
    ? new FileProviderAdapter({ path: resolve(config.providerStateFile) })
    : undefined);
  provider.setInternal(settings.coreDnsDirectory && config.ownershipSecret
    ? new CoreDnsFileAdapter({
      files: new NodeCoreDnsFileOperations({ root: resolve(settings.coreDnsDirectory) }),
      pathForTarget: (target) => `${target.slice(0, target.lastIndexOf("/"))}.zone`,
      ownershipSecret: config.ownershipSecret,
    })
    : undefined);
}

applyProviderSettings(settingsService.current());
settingsService.onChange((settings) => { applyProviderSettings(settings); });

try {
  await credentialManager?.initialize();
} catch (error) {
  // A credential store that cannot be decrypted is usually a mismatched master
  // key. Fail with one actionable line instead of an unhandled rejection.
  console.error(`parallax: ${error instanceof Error ? error.message : "credential store could not be opened"}. Check PARALLAX_CREDENTIAL_MASTER_KEY matches the key that sealed the stored credentials.`);
  process.exit(1);
}

const controlPlane = new ControlPlane(persisted.zones, persisted.statuses, provider, undefined, persisted.applyLock, {
  get maxRevisionsPerZone() { return settingsService.current().revisionRetention; },
  get auditRetentionDays() { return settingsService.current().auditRetentionDays; },
});
const handleApi = createNodeHandler(controlPlane, () => accessTokens.security(), credentialManager, {
  get publicOrigin() { return settingsService.current().publicOrigin || undefined; },
  get trustForwardedHeaders() { return settingsService.current().trustForwardedHeaders; },
}, { settings: settingsService, accessTokens });
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

server.listen(config.port, config.host, () => {
  console.log(`parallax: http://${config.host}:${config.port}`);
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
