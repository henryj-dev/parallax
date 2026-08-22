import { readFileSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type RequestListener } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isLoopbackHost, readConfig, usesPlaintextPostgres, usesUnverifiedPostgresTls } from "./config.ts";
import { createDnsServer, type ServedZone } from "./dns/server.ts";
import { servedZones } from "./dns/snapshot.ts";
import { PORTAL_ASSETS } from "./http/portal-assets.ts";
import { portalRedirect } from "./http/portal-entry.ts";
import { createNodeHandler, requestOrigin } from "./http/api.ts";
import { createIdentityHandler, IDENTITY_PREFIX } from "./http/identity-routes.ts";
import { createReadinessMonitor } from "./http/readiness.ts";
import { redirectLocation } from "./http/redirect.ts";
import { createRuntime, type ParallaxRuntime } from "./runtime.ts";
import { authenticate, withIdentityProvider, type SecurityConfig } from "./security/http-authorization.ts";
import { shutdownProcess } from "./shutdown.ts";

const config = readConfig();

/**
 * How long a zone change made somewhere else may take to reach the DNS
 * listener. A change made through this process is served as soon as it commits.
 */
const DNS_REFRESH_MS = 5_000;

/** What the listener is answering from, and what readiness reports about it. */
let dnsSnapshot: ServedZone[] = [];
/** Serials of the last snapshot NOTIFY has already seen. */
let previousDnsSerials = new Map<string, number>();
let dnsServer: ReturnType<typeof createDnsServer> | undefined;
let redirector: ReturnType<typeof createServer> | undefined;

let runtime: ParallaxRuntime;
try {
  runtime = await createRuntime(config);
} catch (error) {
  console.error(`parallax: ${error instanceof Error ? error.message : "startup failed"}`);
  process.exit(1);
  throw error;
}

const { controlPlane, settings: settingsService, accessTokens, credentials, provider } = runtime;
const readiness = createReadinessMonitor(
  () => controlPlane.listZones(),
  (target) => provider.isConfigured(target),
  config.dns !== undefined,
  {
    configurationRevision: () => provider.configurationRevision(),
    ...(config.readinessMaxStalenessMs !== undefined
      ? { maxStalenessMs: config.readinessMaxStalenessMs }
      : {}),
    forwardsEmptyInternalViews: (config.dns?.forwardTo.length ?? 0) > 0,
    onZones: (zones) => {
      if (!config.dns) return;
      const next = servedZones(zones, (zone, reason) => {
        console.error(`parallax: not answering for ${zone}, its internal view could not be composed: ${reason}`);
      });
      const previous = previousDnsSerials;
      previousDnsSerials = new Map(next.map((zone) => [zone.name, zone.serial]));
      dnsSnapshot = next;
      void dnsServer?.notifyChanged(previous, next).catch((error: unknown) => {
        console.error(`parallax: NOTIFY failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
    },
  },
);

const securityConfig = (): SecurityConfig => {
  const tokens = accessTokens.security();
  return config.oidc ? withIdentityProvider(tokens, config.oidc.sessionSecret) : tokens;
};

if (!securityConfig().enabled && !isLoopbackHost(config.host)) {
  console.error("parallax: refusing to serve a non-loopback address with no access token. Issue one from a loopback session, or set PARALLAX_AUTH_TOKENS.");
  process.exit(1);
}

accessTokens.startRefreshing(undefined, (error) => {
  console.error(`parallax: could not refresh access tokens: ${error instanceof Error ? error.message : "unknown error"}`);
});
settingsService.startRefreshing(undefined, (error) => {
  console.error(`parallax: could not refresh settings: ${error instanceof Error ? error.message : "unknown error"}`);
});
credentials?.startRefreshing(undefined, (error) => {
  console.error(`parallax: could not refresh provider credentials: ${error instanceof Error ? error.message : "unknown error"}`);
});

const refreshDesiredState = (): void => {
  void readiness.refresh().catch((error: unknown) => {
    // DNS keeps its last known-good snapshot, while readiness fails closed.
    console.error(`parallax: desired state could not be refreshed: ${error instanceof Error ? error.message : "unknown error"}`);
  });
};
try {
  // One startup scan feeds both readiness and DNS so neither can initially
  // claim success from an empty or unchecked snapshot.
  await readiness.refresh();
} catch (error) {
  console.error(`parallax: the desired state could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
  if (config.dns) process.exit(1);
}
runtime.onZoneChange(() => {
  readiness.invalidate();
  refreshDesiredState();
});
const desiredStateTimer = setInterval(refreshDesiredState, DNS_REFRESH_MS);
desiredStateTimer.unref();

// Signing in through an identity provider, when one is configured. It sits
// ahead of the API because it is how a caller with no credential acquires one.
const handleIdentity = config.oidc ? createIdentityHandler({ settings: config.oidc }) : undefined;

const nodeHandlerOptions = {
  get publicOrigin() { return settingsService.current().publicOrigin || undefined; },
  get trustForwardedHeaders() { return settingsService.current().trustForwardedHeaders; },
  terminatesTls: config.tls !== undefined,
};

const handleApi = createNodeHandler(runtime, securityConfig, nodeHandlerOptions);

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

const staticFiles = PORTAL_ASSETS;

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
  // With nothing to authenticate against, every caller would be an administrator,
  // so a request that reached this process through a proxy is refused rather than
  // trusted.
  //
  // Asked of `securityConfig()` and not of the access tokens alone. An identity
  // provider is the second way to be a principal, and a deployment that offers
  // only that one has authentication -- callers must present a session. Reading
  // the token side here refused every proxied API request on such a deployment,
  // session or no session, which is the whole surface behind one reverse proxy.
  if (!securityConfig().enabled && pathname.startsWith("/api/") && isProxiedRequest(request)) {
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
      // `securityConfig()`, so an identity-provider-only deployment reports that
      // it authenticates. The portal draws itself from this answer, and reading
      // the token side alone told it a closed control plane was open.
      authentication: securityConfig().enabled ? "required" : "disabled",
      // Whether a sign-in button should be drawn. Its absence is what an
      // unauthenticated caller sees anyway when it presses one that is not
      // wired, so saying it here costs nothing and saves a dead button.
      identityProvider: config.oidc ? "available" : "unavailable",
    }));
    return;
  }
  if (pathname === "/health/ready") {
    try {
      const tokenReadiness = accessTokens.readiness();
      if (!tokenReadiness.ready) throw new Error("access-token cache is stale");
      if (!readiness.ready()) throw new Error("provider configuration is incomplete");
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      // Backend and provider details describe the deployment, so only an
      // authenticated caller receives them.
      response.end(JSON.stringify(isAuthenticated(request)
        ? {
          status: "ready",
          service: "parallax",
          storage: config.databaseUrl ? "postgresql" : "file",
          providerMode: settingsService.current().allowLocalProvider ? "local-fallback" : "configured",
          // How many zones the listener will answer for, which is not the same
          // as how many zones exist: one whose internal view is empty is left
          // to the forwarder. Somebody checking why a name does not resolve
          // internally needs to see that difference from outside the process.
          dns: config.dns
            ? { port: config.dns.port, zones: dnsSnapshot.length, forwarding: config.dns.forwardTo.length > 0 }
            : "disabled",
          accessTokens: tokenReadiness,
          // Reported even while ready, so a deployment can alert on a snapshot
          // going old instead of waiting to be withdrawn for it.
          desiredState: readiness.staleness(),
        }
        : { status: "ready", service: "parallax" }));
    } catch {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "not_ready", service: "parallax" }));
    }
    return;
  }
  if (handleIdentity && pathname.startsWith(`${IDENTITY_PREFIX}/`)) {
    // Built with the same origin resolution the API uses: behind a terminating
    // proxy the request arrives as http, and a cookie marked Secure by that
    // reading would never be sent back.
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    const answered = await handleIdentity(new Request(
      new URL(request.url ?? "/", requestOrigin(request, nodeHandlerOptions)),
      { method: request.method, headers },
    ));
    if (answered) {
      const out: Record<string, string | string[]> = {};
      for (const [name, value] of answered.headers) {
        out[name] = name === "set-cookie" ? answered.headers.getSetCookie() : value;
      }
      response.writeHead(answered.status, out);
      response.end(answered.body === null ? undefined : await answered.text());
      return;
    }
  }
  if (pathname.startsWith("/api/")) {
    await handleApi(request, response);
    return;
  }
  const asset = staticFiles.get(pathname);
  if (request.method === "GET" || request.method === "HEAD") {
    const location = portalRedirect({
      signIn: config.portalSignIn,
      pathname,
      isDocument: asset?.type.startsWith("text/html") ?? false,
      authenticationRequired: securityConfig().enabled,
      authenticated: isAuthenticated(request),
    });
    if (location) {
      response.writeHead(302, { location, "cache-control": "no-store" });
      response.end();
      return;
    }
  }
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
  const security = securityConfig();
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
// A request body is read into memory before the security layer sees it, so an
// unauthenticated caller can hold up to the 1 MiB body cap per connection.
// Bounding the connections is what bounds that product.
server.maxConnections = 1024;

/**
 * Answers plaintext with the address the client should have used. It carries no
 * application behaviour on purpose: this listener exists so a typed hostname
 * arrives over TLS, and anything else it could do would be reachable without
 * one.
 *
 * `publicOrigin` is mandatory for this listener. A request's Host header is
 * untrusted input and must never choose the redirect destination.
 */
if (config.httpRedirectPort !== undefined) {
  redirector = createServer((request, response) => {
    setSecurityHeaders(response);
    const origin = settingsService.current().publicOrigin;
    if (!origin) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("redirect origin unavailable\n");
      return;
    }
    response.writeHead(308, { location: redirectLocation(origin, request.url), "cache-control": "no-store" });
    response.end();
  });
  redirector.headersTimeout = 15_000;
  redirector.requestTimeout = 15_000;
  redirector.maxConnections = 1024;
  redirector.listen(config.httpRedirectPort, config.host, () => {
    console.log(`parallax: redirecting http://${config.host}:${config.httpRedirectPort} to TLS`);
  });
}

/**
 * Answers DNS for the internal view out of the desired state, when a port is
 * configured.
 *
 * A local durable commit invalidates and refreshes the snapshot immediately;
 * the timer covers another replica or CLI process. Both triggers share one
 * background scan, which also feeds the constant-time readiness cache.
 *
 * Nothing here reconciles. This listener answers from the desired state
 * directly, which is why it does not conflict with a provider that publishes
 * the internal view into a server of its own. Running both is two servers
 * answering, which is a deployment's decision about which address clients ask.
 */
if (config.dns) {
  const dnsConfig = config.dns;
  dnsServer = createDnsServer({
    zones: () => dnsSnapshot,
    forwardTo: dnsConfig.forwardTo,
    forwardAllow: dnsConfig.forwardAllow,
    transferAllow: dnsConfig.transferAllow,
    ...(dnsConfig.notifyTo ? { notifyTo: dnsConfig.notifyTo } : {}),
    // Absent values stay absent, so the listener keeps its own defaults.
    ...dnsConfig.limits,
    onUnservable: (record) => {
      // Stored content the domain accepted and the wire cannot carry. The
      // query was answered SERVFAIL, so this line is the only place it is said.
      console.error(`parallax: ${record.zone} ${record.name} ${record.type} could not be answered: ${record.reason}`);
    },
    onUnanswerable: (detail) => {
      // No record to name: every per-record guard passed and the reply still
      // could not be built. Said out loud because the query was answered
      // SERVFAIL, and this line is the only place the reason exists.
      console.error(`parallax: ${detail.zone} could not assemble a reply for ${detail.name}: ${detail.reason}`);
    },
  });
  try {
    await dnsServer.listen(dnsConfig.port, dnsConfig.host);
    console.log(`parallax: dns://${dnsConfig.host}:${dnsConfig.port} answering for ${dnsSnapshot.length} zone(s)`);
    if (dnsConfig.forwardTo.length === 0) {
      console.warn("parallax: no DNS upstream is configured, so names outside every managed zone are answered REFUSED. Set PARALLAX_DNS_FORWARD_TO if clients use this as their resolver.");
    }
  } catch (error) {
    console.error(`parallax: could not bind the DNS port: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exit(1);
  }
}

server.listen(config.port, config.host, () => {
  console.log(`parallax: ${config.tls ? "https" : "http"}://${config.host}:${config.port}`);
  // `securityConfig()`, so this is not printed on a deployment whose identity
  // provider is the way in. There, callers are not administrators by default.
  if (!securityConfig().enabled) {
    console.warn("parallax: no access token exists; every caller that reaches this port is an administrator. Issue one from the portal before exposing it.");
  }
  if (settingsService.current().allowLocalProvider) {
    console.warn("parallax: the local file provider is active as a fallback; applied changes for unconfigured targets do not reach a real DNS provider.");
  }
  if (!config.credentialMasterKey) {
    console.warn("parallax: PARALLAX_CREDENTIAL_MASTER_KEY is not set, so provider credentials cannot be stored. Generate one with: openssl rand -base64 32");
  }
  if (config.databaseUrl && usesUnverifiedPostgresTls(config.databaseUrl)) {
    console.warn("parallax: DATABASE_URL uses ssl=true, which encrypts the session without checking who is on the other end. Prefer sslmode=verify-full.");
  }
  if (config.databaseUrl && usesPlaintextPostgres(config.databaseUrl)) {
    console.warn("parallax: DATABASE_URL does not request TLS; zone data and audit history cross the network in cleartext. Append ?sslmode=verify-full unless PostgreSQL is reached over a trusted local socket.");
  }
});

let shuttingDown = false;
async function stop(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await shutdownProcess({
    dns: dnsServer,
    http: server,
    redirect: redirector,
    runtime,
    timers: [desiredStateTimer],
  });
  process.exit(0);
}
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
