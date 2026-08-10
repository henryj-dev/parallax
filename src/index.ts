import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ControlPlane } from "./application/control-plane.ts";
import { CloudflareCredentialManager } from "./application/cloudflare-credentials.ts";
import { CloudflareProviderAdapter } from "./adapters/cloudflare.ts";
import { CoreDnsFileAdapter } from "./adapters/coredns-file.ts";
import { NodeCoreDnsFileOperations } from "./adapters/node-coredns-files.ts";
import { RoutingProviderAdapter } from "./adapters/router.ts";
import { readConfig } from "./config.ts";
import { createNodeHandler } from "./http/api.ts";
import { createFileStateAdapters } from "./infrastructure/file-state.ts";
import { FileProviderAdapter } from "./infrastructure/file-provider.ts";
import { createPostgresAdapters, createPostgresPool } from "./infrastructure/postgres.ts";
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
  store: new EncryptedCredentialStore({ filePath: resolve(config.credentialFile), masterKey: config.credentialMasterKey }),
  router: provider,
  environmentAdapters: externalProviders,
  ownershipSecret: config.ownershipSecret!,
}) : undefined;
await credentialManager?.initialize();
const controlPlane = new ControlPlane(persisted.zones, persisted.statuses, provider, undefined, persisted.applyLock);
const handleApi = createNodeHandler(controlPlane, config.security, credentialManager);
const publicDirectory = resolve(process.cwd(), "public");

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
  if (pathname === "/health/live") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", service: "parallax" }));
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
      response.end(JSON.stringify({ status: "ready", service: "parallax", storage: config.databaseUrl ? "postgresql" : "file", providerMode: config.allowLocalProvider ? "local-fallback" : "configured" }));
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
}

server.listen(config.port, config.host, () => {
  console.log(`parallax: http://${config.host}:${config.port}`);
});
