import { isIP } from "node:net";
import { isStrongBootstrapToken } from "./application/access-tokens.ts";
import { isPortalSignIn, PORTAL_SIGN_IN, type PortalSignIn } from "./http/portal-entry.ts";
import type { Role, TokenRecord } from "./security/http-authorization.ts";

/**
 * The environment carries only what cannot be read out of the store: where to
 * bind, how to reach the store, and the keys that protect what is stored.
 * Everything an administrator tunes -- provider wiring, retention, proxy
 * origin, access tokens, credentials -- lives in the store and is managed
 * through the portal.
 */
export interface ParallaxConfig {
  host: string;
  port: number;
  /** Durable zone state file used when no database is configured. */
  stateFile: string;
  /** Local provider state file, used only when the local provider is enabled. */
  providerStateFile: string;
  /** Settings, credentials and tokens file used when no database is configured. */
  configurationFile: string;
  databaseUrl?: string;
  /** Signs managed-record ownership markers. Rotating it orphans existing records. */
  ownershipSecret?: string;
  /** Encrypts stored provider credentials. Without it, credentials cannot be used. */
  credentialMasterKey?: Buffer;
  /** Optional break-glass tokens; normal tokens are issued through the portal. */
  bootstrapTokens: TokenRecord[];
  /** Certificate and key that let this process end TLS itself, instead of a proxy. */
  tls?: { certFile: string; keyFile: string };
  /** Port answering plain HTTP with a redirect to the TLS origin; unset disables it. */
  httpRedirectPort?: number;
  /** Signs in through an identity provider. Unset leaves only access tokens. */
  oidc?: OidcSettings;
  /** What the portal offers a visitor who has not signed in. Defaults to the prompt. */
  portalSignIn: PortalSignIn;
  /**
   * How long a desired-state read may be stale before readiness reports 503.
   *
   * This is in the environment rather than the store because it is a fact about
   * the topology, not about DNS: it only matters through whatever consumes the
   * probe. Where a readiness probe gates the endpoints of a service that also
   * carries DNS, and there is one replica, going unready takes the resolver out
   * -- so how long a stale-but-correct snapshot should keep serving is a
   * question only the deployment can answer.
   */
  readinessMaxStalenessMs?: number;
  /** Answers DNS for the internal view directly. Unset leaves the port unbound. */
  dns?: DnsListenerSettings;
}

/**
 * Where the DNS listener binds and where it sends what it is not authoritative
 * for.
 *
 * These stay in the environment rather than the store with the rest of the
 * operational settings, and the upstreams are the reason. Everything this
 * process is not authoritative for is relayed to them, so whoever can change
 * them can silently answer for every name in the network that is not in a
 * managed zone. That is not a tuning knob; it is the same kind of value as the
 * keys, and it belongs where a deployment sets it and a portal session cannot.
 */
export interface DnsListenerSettings {
  readonly host: string;
  readonly port: number;
  /** Upstreams, `host` or `host#port`. Empty answers REFUSED instead of relaying. */
  readonly forwardTo: readonly string[];
  /** Client networks allowed to use those upstreams. */
  readonly forwardAllow: readonly string[];
  /** Client networks allowed to transfer a complete zone over TCP. Empty denies all transfers. */
  readonly transferAllow: readonly string[];
  /** Hosts that receive NOTIFY when a served zone's serial rises. `host` or `host:port`. */
  readonly notifyTo?: readonly string[];
}

export interface OidcSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes: string;
  /** Signs the browser session. Rotating it ends every session and nothing else. */
  readonly sessionSecret: string;
  readonly sessionMaxAgeSeconds: number;
}

export function readConfig(environment: NodeJS.ProcessEnv = process.env): ParallaxConfig {
  const ownershipSecret = environment.PARALLAX_OWNERSHIP_SECRET?.trim() || undefined;
  if (ownershipSecret !== undefined && Buffer.byteLength(ownershipSecret, "utf8") < 32) {
    throw new Error("PARALLAX_OWNERSHIP_SECRET must contain at least 32 bytes");
  }
  const credentialMasterKey = readCredentialMasterKey(environment.PARALLAX_CREDENTIAL_MASTER_KEY);
  const tls = readTls(environment);
  const redirect = environment.PARALLAX_HTTP_REDIRECT_PORT?.trim();
  const httpRedirectPort = redirect ? readPort(redirect, "PARALLAX_HTTP_REDIRECT_PORT") : undefined;
  if (httpRedirectPort !== undefined && !tls) {
    throw new Error("PARALLAX_HTTP_REDIRECT_PORT only makes sense with TLS configured on the main port");
  }
  const oidc = readOidc(environment);
  const portalSignIn = readPortalSignIn(environment, oidc !== undefined);
  const readinessMaxStalenessMs = readStaleness(environment.PARALLAX_READINESS_MAX_STALENESS_SECONDS);
  const dns = readDnsListener(environment);
  const allowPlaintextPostgres = readOptIn(
    environment.PARALLAX_ALLOW_PLAINTEXT_POSTGRES,
    "PARALLAX_ALLOW_PLAINTEXT_POSTGRES",
  );
  const databaseUrl = readPostgresConnection(
    environment.DATABASE_URL,
    "DATABASE_URL",
    allowPlaintextPostgres,
  );
  return {
    host: environment.HOST?.trim() || "127.0.0.1",
    port: readPort(environment.PORT),
    stateFile: environment.PARALLAX_STATE_FILE?.trim() || "data/parallax-state.json",
    providerStateFile: environment.PARALLAX_PROVIDER_STATE_FILE?.trim() || "data/provider-state.json",
    configurationFile: environment.PARALLAX_CONFIG_FILE?.trim() || "data/parallax-config.json",
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(ownershipSecret ? { ownershipSecret } : {}),
    ...(credentialMasterKey ? { credentialMasterKey } : {}),
    bootstrapTokens: readBootstrapTokens(environment.PARALLAX_AUTH_TOKENS),
    ...(tls ? { tls } : {}),
    ...(httpRedirectPort !== undefined ? { httpRedirectPort } : {}),
    ...(oidc ? { oidc } : {}),
    portalSignIn,
    ...(readinessMaxStalenessMs !== undefined ? { readinessMaxStalenessMs } : {}),
    ...(dns ? { dns } : {}),
  };
}

/**
 * The listener binds only when a port is named. Its own host defaults to the
 * portal's, which is loopback unless a deployment said otherwise -- a resolver
 * that starts answering the whole network because a port was set is not a
 * default anybody should have to discover.
 */
function readDnsListener(environment: NodeJS.ProcessEnv): DnsListenerSettings | undefined {
  const port = environment.PARALLAX_DNS_PORT?.trim();
  if (!port) return undefined;
  const host = environment.PARALLAX_DNS_HOST?.trim() || environment.HOST?.trim() || "127.0.0.1";
  const forwardTo = (environment.PARALLAX_DNS_FORWARD_TO ?? "")
    .split(",")
    .map((upstream) => upstream.trim())
    .filter((upstream) => upstream.length > 0);
  for (const upstream of forwardTo) {
    const [host, upstreamPort] = upstream.split("#") as [string, string | undefined];
    if (!host) throw new Error(`PARALLAX_DNS_FORWARD_TO contains an upstream with no host: ${upstream}`);
    if (upstreamPort !== undefined) {
      if (!upstreamPort) throw new Error(`PARALLAX_DNS_FORWARD_TO contains an upstream with no port: ${upstream}`);
      readPort(upstreamPort, `PARALLAX_DNS_FORWARD_TO (${upstream})`);
    }
  }
  const explicitForwardAllow = environment.PARALLAX_DNS_FORWARD_ALLOW?.trim();
  if (forwardTo.length > 0 && !isLoopbackHost(host) && !explicitForwardAllow) {
    throw new Error("PARALLAX_DNS_FORWARD_ALLOW must explicitly name the client CIDRs allowed to recurse when the DNS listener is not loopback");
  }
  const forwardAllow = readDnsClientCidrs(
    explicitForwardAllow || "127.0.0.0/8,::1/128",
    "PARALLAX_DNS_FORWARD_ALLOW",
  );
  const transferAllow = readDnsClientCidrs(
    environment.PARALLAX_DNS_TRANSFER_ALLOW ?? "",
    "PARALLAX_DNS_TRANSFER_ALLOW",
  );
  const notifyTo = (environment.PARALLAX_DNS_NOTIFY_TO ?? "")
    .split(",")
    .map((destination) => destination.trim())
    .filter((destination) => destination.length > 0);
  return {
    host,
    port: readPort(port, "PARALLAX_DNS_PORT"),
    forwardTo,
    forwardAllow,
    transferAllow,
    ...(notifyTo.length > 0 ? { notifyTo } : {}),
  };
}

function readDnsClientCidrs(source: string, setting: string): string[] {
  return source.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const slash = entry.lastIndexOf("/");
    const address = slash < 0 ? entry : entry.slice(0, slash);
    const family = isIP(address);
    if (family === 0) throw new Error(`${setting} contains an invalid address: ${entry}`);
    if (slash >= 0) {
      const prefixText = entry.slice(slash + 1);
      if (!/^\d{1,3}$/u.test(prefixText)) {
        throw new Error(`${setting} contains an invalid prefix: ${entry}`);
      }
      const prefix = Number(prefixText);
      const bits = family === 4 ? 32 : 128;
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
        throw new Error(`${setting} contains an invalid prefix: ${entry}`);
      }
    }
    return entry;
  });
}

/**
 * All of it or none of it. A deployment that set four of the five values meant
 * to offer this login, and starting without it would leave a sign-in button
 * that fails only when somebody presses it.
 */
function readOidc(environment: NodeJS.ProcessEnv): OidcSettings | undefined {
  const fields = {
    issuer: environment.PARALLAX_OIDC_ISSUER?.trim(),
    clientId: environment.PARALLAX_OIDC_CLIENT_ID?.trim(),
    clientSecret: environment.PARALLAX_OIDC_CLIENT_SECRET?.trim(),
    redirectUri: environment.PARALLAX_OIDC_REDIRECT_URI?.trim(),
    sessionSecret: environment.PARALLAX_OIDC_SESSION_SECRET?.trim(),
  };
  const missing = Object.entries(fields).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length === Object.keys(fields).length) return undefined;
  if (missing.length > 0) {
    throw new Error(`OIDC is partly configured; also set ${missing.map(environmentNameFor).join(", ")}`);
  }
  const issuer = (fields.issuer as string).replace(/\/+$/, "");
  if (!/^https:\/\//u.test(issuer) && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/u.test(issuer)) {
    throw new Error("PARALLAX_OIDC_ISSUER must be an https URL; the authorization code and the account are read over it");
  }
  if (Buffer.byteLength(fields.sessionSecret as string, "utf8") < 32) {
    throw new Error("PARALLAX_OIDC_SESSION_SECRET must contain at least 32 bytes");
  }
  return {
    issuer,
    clientId: fields.clientId as string,
    clientSecret: fields.clientSecret as string,
    redirectUri: fields.redirectUri as string,
    sessionSecret: fields.sessionSecret as string,
    scopes: environment.PARALLAX_OIDC_SCOPES?.trim() || "openid profile email",
    sessionMaxAgeSeconds: readSessionMaxAge(environment.PARALLAX_OIDC_SESSION_SECONDS),
  };
}

/**
 * Refuses `idp` without an identity provider rather than falling back.
 *
 * The fallback would be the prompt -- the very screen this setting exists to
 * take away -- so a deployment that asked for one thing would quietly get the
 * other, and the only symptom would be a login page somebody thought they had
 * removed.
 */
/**
 * Seconds, because the operator thinking about this is reading a probe's
 * `periodSeconds` and `failureThreshold` beside it.
 */
function readStaleness(value: string | undefined): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) {
    throw new Error("PARALLAX_READINESS_MAX_STALENESS_SECONDS must be an integer between 1 and 86400");
  }
  return seconds * 1000;
}

function readPortalSignIn(environment: NodeJS.ProcessEnv, hasIdentityProvider: boolean): PortalSignIn {
  const value = environment.PARALLAX_PORTAL_SIGN_IN?.trim();
  if (!value) return "prompt";
  if (!isPortalSignIn(value)) {
    throw new Error(`PARALLAX_PORTAL_SIGN_IN must be one of: ${PORTAL_SIGN_IN.join(", ")}`);
  }
  if (value === "idp" && !hasIdentityProvider) {
    throw new Error("PARALLAX_PORTAL_SIGN_IN=idp sends every visitor to an identity provider; configure PARALLAX_OIDC_ISSUER and the rest of PARALLAX_OIDC_* first");
  }
  return value;
}

function environmentNameFor(field: string): string {
  return `PARALLAX_OIDC_${field.replace(/[A-Z]/gu, (letter) => `_${letter}`).toUpperCase()}`;
}

function readSessionMaxAge(value: string | undefined): number {
  if (!value) return 43_200;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 604_800) {
    throw new Error("PARALLAX_OIDC_SESSION_SECONDS must be an integer between 60 and 604800");
  }
  return seconds;
}

/**
 * Both halves or neither. A certificate with no key -- or the reverse -- is a
 * deployment that meant to serve TLS, so starting in plaintext on the port a
 * client will speak TLS to would be worse than refusing.
 */
function readTls(environment: NodeJS.ProcessEnv): ParallaxConfig["tls"] {
  const certFile = environment.PARALLAX_TLS_CERT_FILE?.trim();
  const keyFile = environment.PARALLAX_TLS_KEY_FILE?.trim();
  if (!certFile && !keyFile) return undefined;
  if (!certFile || !keyFile) {
    throw new Error("PARALLAX_TLS_CERT_FILE and PARALLAX_TLS_KEY_FILE must be set together");
  }
  return { certFile, keyFile };
}

function readCredentialMasterKey(source: string | undefined): Buffer | undefined {
  if (source === undefined || source.trim() === "") return undefined;
  const value = source.trim();
  let key: Buffer;
  if (/^[a-f0-9]{64}$/iu.test(value)) key = Buffer.from(value, "hex");
  else {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
      throw new Error("PARALLAX_CREDENTIAL_MASTER_KEY must encode exactly 32 bytes as base64 or hexadecimal");
    }
    key = Buffer.from(value, "base64");
  }
  if (key.byteLength !== 32) throw new Error("PARALLAX_CREDENTIAL_MASTER_KEY must encode exactly 32 bytes as base64 or hexadecimal");
  return key;
}

function readBootstrapTokens(source: string | undefined): TokenRecord[] {
  if (source === undefined || source.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("PARALLAX_AUTH_TOKENS must be a valid JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("PARALLAX_AUTH_TOKENS must be a valid JSON array");
  return parsed.map((item) => {
    if (!isObject(item) || typeof item.token !== "string" || typeof item.subject !== "string" || !isRole(item.role)) {
      throw new Error("PARALLAX_AUTH_TOKENS contains an invalid token record");
    }
    if (!isStrongBootstrapToken(item.token)) {
      throw new Error("PARALLAX_AUTH_TOKENS entries must be 32 random bytes in canonical base64url form; generate one with: openssl rand -base64 32 | tr '+/' '-_' | tr -d '='");
    }
    return { token: item.token, subject: item.subject, role: item.role };
  });
}

function readPort(value: string | undefined, name = "PORT"): number {
  if (!value) return 3000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

/**
 * Reports whether a PostgreSQL connection string leaves the session in
 * cleartext. `pg` reads `sslmode` from the URL, but defaults to no TLS.
 */
export function usesPlaintextPostgres(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return true;
    const mode = url.searchParams.get("sslmode");
    const ssl = url.searchParams.get("ssl");
    if (ssl === "true" || ssl === "1") return false;
    return mode !== "verify-ca" && mode !== "verify-full";
  } catch {
    return true;
  }
}

function readPostgresConnection(
  source: string | undefined,
  name: string,
  allowPlaintext: boolean,
): string | undefined {
  const connectionString = source?.trim();
  if (!connectionString) return undefined;
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL, not a libpq keyword connection string`);
  }
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || !url.hostname) {
    throw new Error(`${name} must be a PostgreSQL URL with a host`);
  }
  if (usesPlaintextPostgres(connectionString) && !isLoopbackHost(url.hostname) && !allowPlaintext) {
    throw new Error(`${name} must verify PostgreSQL TLS with sslmode=verify-full (or verify-ca); set PARALLAX_ALLOW_PLAINTEXT_POSTGRES=true only for a separately protected network`);
  }
  return connectionString;
}

function readOptIn(source: string | undefined, name: string): boolean {
  if (source === undefined || source.trim() === "") return false;
  if (source.trim() === "true") return true;
  if (source.trim() === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRole(value: unknown): value is Role {
  return value === "admin" || value === "editor" || value === "viewer";
}
