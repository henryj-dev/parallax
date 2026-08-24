import { isIP } from "node:net";
import { isStrongBootstrapToken } from "./application/access-tokens.ts";
import { parseTsigKey, type TsigKey } from "./dns/tsig.ts";
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
  /**
   * Hosts that receive NOTIFY when a served zone's serial rises.
   *
   * `host`, `host:port`, or `host:port#keyname` to sign it with one of the keys
   * below.
   */
  readonly notifyTo?: readonly string[];
  /**
   * Shared secrets for zone transfer (RFC 8945). Empty leaves AXFR gated on
   * address alone.
   *
   * ⚠️ These are secrets. They are parsed into buffers here and deliberately
   * never rendered back: `config check` reports how many are configured and
   * under what names, and nothing prints the material.
   */
  readonly tsigKeys: readonly TsigKey[];
  /**
   * Publish the internal view into a server that speaks RFC 2136, instead of
   * only answering it from this process.
   *
   * The two are not exclusive and the difference matters: a listener inside
   * this process stops answering when this process stops, and a server that was
   * published to does not. That property was lost when the CoreDNS and PowerDNS
   * publishers were removed (`1db6f25`) on the grounds that nothing used them;
   * this is the way back to it for a deployment that needs it.
   */
  readonly internalUpdate?: {
    readonly host: string;
    readonly port: number;
    readonly key: TsigKey;
  };
  /**
   * What the listener will spend on one client and on the network as a whole.
   *
   * The listener has always had these; nothing reached them. They belong here
   * for the same reason the upstreams do -- they decide how much of this
   * process a stranger on the network can occupy, which is a fact about where
   * it is deployed and not a preference a portal session should be able to set.
   *
   * Absent means the listener's own default, so a deployment that sets none of
   * them behaves exactly as it did before they were reachable.
   */
  readonly limits: DnsListenerLimits;
  /**
   * What the synthesized SOA says about who is authoritative.
   *
   * Only matters where a secondary transfers these zones: MNAME is where it
   * asks for updates, and the default is derived from the zone name rather than
   * known to exist. A deployment with no secondaries can leave this alone.
   *
   * Not in `limits` -- these say what the answer contains, not what the
   * listener will spend.
   */
  readonly soaPrimary?: string;
  readonly soaMailbox?: string;
}

export interface DnsListenerLimits {
  /** Queries per second allowed from one client address. */
  readonly rateLimitPerSecond?: number;
  /** How far one client may run ahead of that rate before it is refused. */
  readonly rateLimitBurst?: number;
  /** How many client addresses the limiter tracks before refusing unknown ones. */
  readonly rateLimitMaxClients?: number;
  /**
   * Send an unproven UDP client a truncated reply so it must return over TCP.
   *
   * EDNS cookies are always offered and checked; this decides what to do with a
   * client that has not answered one. Off by default because most resolvers do
   * not implement RFC 7873 and turning it on sends all of them through TCP.
   */
  readonly requireCookie?: boolean;
  /** How long to wait for an upstream before trying the next one. */
  readonly forwardTimeoutMs?: number;
  /** Relayed queries in flight at once, across every client. */
  readonly maxConcurrentForwards?: number;
  /** Open DNS-over-TCP connections. */
  readonly maxTcpConnections?: number;
}

export interface OidcSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes: string;
  /**
   * Which claim carries a person's role here. No standard claim does, so this
   * defaults to the one the provider it was written against uses.
   */
  readonly roleClaim?: string;
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
  assertInternalUpdateIsUsable(dns, ownershipSecret);
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
 * Publishing into somebody else's server means writing ownership markers into
 * it, and there is no marker without a secret.
 *
 * Refused here rather than deep in the adapter's constructor, so `config check`
 * reports it before a rollout and the sentence names the two settings involved
 * instead of the one that happened to notice.
 */
function assertInternalUpdateIsUsable(dns: DnsListenerSettings | undefined, ownershipSecret: string | undefined): void {
  if (!dns?.internalUpdate || ownershipSecret) return;
  throw new Error(
    "PARALLAX_DNS_INTERNAL_UPDATE publishes records into another server and marks them as ours, which needs"
    + " PARALLAX_OWNERSHIP_SECRET. Generate one with: openssl rand -base64 32",
  );
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
  const soaPrimary = readDnsName(environment.PARALLAX_DNS_SOA_PRIMARY, "PARALLAX_DNS_SOA_PRIMARY");
  const soaMailbox = readDnsName(environment.PARALLAX_DNS_SOA_MAILBOX, "PARALLAX_DNS_SOA_MAILBOX");
  const tsigKeys = (environment.PARALLAX_DNS_TSIG_KEYS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseTsigKey(entry, "PARALLAX_DNS_TSIG_KEYS"));
  const duplicate = tsigKeys.find((key, index) => tsigKeys.findIndex((other) => other.name === key.name) !== index);
  if (duplicate) {
    // Two entries under one name: verification would take the first and the
    // operator would have no way to tell which secret is in force.
    throw new Error(`PARALLAX_DNS_TSIG_KEYS names ${duplicate.name} more than once`);
  }
  const internalUpdate = readInternalUpdate(environment, tsigKeys);
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
    tsigKeys,
    ...(internalUpdate ? { internalUpdate } : {}),
    limits: readDnsLimits(environment),
    ...(soaPrimary ? { soaPrimary } : {}),
    ...(soaMailbox ? { soaMailbox } : {}),
  };
}

/**
 * `host:port#keyname`, naming one of `PARALLAX_DNS_TSIG_KEYS`.
 *
 * The key is named rather than repeated: the same secret usually authorises the
 * transfer and the update, and a second copy of it in a second variable is a
 * second thing to rotate and one of them will be missed.
 */
function readInternalUpdate(
  environment: NodeJS.ProcessEnv,
  keys: readonly TsigKey[],
): { host: string; port: number; key: TsigKey } | undefined {
  const raw = environment.PARALLAX_DNS_INTERNAL_UPDATE?.trim();
  if (!raw) return undefined;
  const separator = raw.lastIndexOf("#");
  if (separator <= 0) {
    throw new Error("PARALLAX_DNS_INTERNAL_UPDATE must be host:port#keyname, naming a key from PARALLAX_DNS_TSIG_KEYS");
  }
  const keyName = raw.slice(separator + 1).trim().replace(/\.$/u, "").toLowerCase();
  const key = keys.find((candidate) => candidate.name === keyName);
  if (!key) throw new Error(`PARALLAX_DNS_INTERNAL_UPDATE names key ${keyName}, which is not in PARALLAX_DNS_TSIG_KEYS`);
  const address = raw.slice(0, separator).trim();
  const bracketed = /^\[([^\]]+)\]:(\d+)$/u.exec(address);
  const plain = /^([^:]+):(\d+)$/u.exec(address);
  const match = bracketed ?? plain;
  if (!match) throw new Error("PARALLAX_DNS_INTERNAL_UPDATE must name a host and a port, as in 10.0.0.9:53#update.key");
  const port = readPort(match[2] as string, "PARALLAX_DNS_INTERNAL_UPDATE");
  return { host: match[1] as string, port, key };
}

/**
 * Each one is optional and absent means the listener's own default, so a
 * deployment that sets none of these is unchanged by their existence.
 */
function readDnsLimits(environment: NodeJS.ProcessEnv): DnsListenerLimits {
  const bounded = (name: string, maximum: number): number | undefined => {
    const raw = environment[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be an integer between 1 and ${maximum}`);
    }
    return value;
  };
  const rateLimitPerSecond = bounded("PARALLAX_DNS_RATE_LIMIT_PER_SECOND", 1_000_000);
  const rateLimitBurst = bounded("PARALLAX_DNS_RATE_LIMIT_BURST", 1_000_000);
  // A burst below the rate is a bucket that can never fill, which refuses
  // traffic the rate says is allowed -- and the symptom is intermittent, so it
  // is worth refusing to start over.
  if (rateLimitPerSecond !== undefined && rateLimitBurst !== undefined && rateLimitBurst < rateLimitPerSecond) {
    throw new Error("PARALLAX_DNS_RATE_LIMIT_BURST must be at least PARALLAX_DNS_RATE_LIMIT_PER_SECOND");
  }
  const rateLimitMaxClients = bounded("PARALLAX_DNS_RATE_LIMIT_MAX_CLIENTS", 10_000_000);
  const forwardTimeoutMs = bounded("PARALLAX_DNS_FORWARD_TIMEOUT_MS", 60_000);
  const maxConcurrentForwards = bounded("PARALLAX_DNS_MAX_CONCURRENT_FORWARDS", 100_000);
  const maxTcpConnections = bounded("PARALLAX_DNS_MAX_TCP_CONNECTIONS", 100_000);
  const requireCookie = readOptIn(environment.PARALLAX_DNS_REQUIRE_COOKIE, "PARALLAX_DNS_REQUIRE_COOKIE");
  return {
    ...(requireCookie ? { requireCookie } : {}),
    ...(rateLimitPerSecond !== undefined ? { rateLimitPerSecond } : {}),
    ...(rateLimitBurst !== undefined ? { rateLimitBurst } : {}),
    ...(rateLimitMaxClients !== undefined ? { rateLimitMaxClients } : {}),
    ...(forwardTimeoutMs !== undefined ? { forwardTimeoutMs } : {}),
    ...(maxConcurrentForwards !== undefined ? { maxConcurrentForwards } : {}),
    ...(maxTcpConnections !== undefined ? { maxTcpConnections } : {}),
  };
}

/**
 * A name that has to survive being written to the wire.
 *
 * Checked here rather than at the first query, because the alternative is a
 * listener that starts, looks healthy, and throws while assembling every SOA --
 * and an SOA is what a negative answer carries, so the symptom would be that
 * NXDOMAIN stops working.
 */
function readDnsName(value: string | undefined, setting: string): string | undefined {
  const name = value?.trim().replace(/\.$/u, "").toLowerCase();
  if (!name) return undefined;
  const valid = name.length <= 253
    && name.includes(".")
    && name.split(".").every((label) => /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/u.test(label));
  if (!valid) throw new Error(`${setting} must be a fully-qualified domain name`);
  return name;
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
  // A claim name, not a value: it indexes the userinfo response, so it has to
  // be a plain identifier rather than anything that could reach a prototype.
  const roleClaim = environment.PARALLAX_OIDC_ROLE_CLAIM?.trim();
  if (roleClaim !== undefined && roleClaim !== "" && !/^[A-Za-z][A-Za-z0-9_:.-]{0,63}$/u.test(roleClaim)) {
    throw new Error("PARALLAX_OIDC_ROLE_CLAIM must be a claim name: a letter followed by letters, digits, _ : . or -");
  }
  return {
    issuer,
    clientId: fields.clientId as string,
    clientSecret: fields.clientSecret as string,
    redirectUri: fields.redirectUri as string,
    sessionSecret: fields.sessionSecret as string,
    scopes: environment.PARALLAX_OIDC_SCOPES?.trim() || "openid profile email",
    ...(roleClaim ? { roleClaim } : {}),
    sessionMaxAgeSeconds: readSessionMaxAge(environment.PARALLAX_OIDC_SESSION_SECONDS),
  };
}

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

/**
 * Refuses `idp` without an identity provider rather than falling back.
 *
 * The fallback would be the prompt -- the very screen this setting exists to
 * take away -- so a deployment that asked for one thing would quietly get the
 * other, and the only symptom would be a login page somebody thought they had
 * removed.
 */
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

/*
 * `ssl=true` is accepted above and `sslmode=require` is not, which reads
 * backwards until it is measured. It is not.
 *
 * `pg-connection-string` turns `ssl=true` into the boolean `true`, which
 * reaches `tls.connect` as its whole options object -- and Node's default there
 * is `rejectUnauthorized: true`, so the chain and the hostname are both checked
 * against the system CAs. That is verify-full behaviour by another spelling.
 *
 * `sslmode=require` becomes an options object, and the same library currently
 * treats `prefer`, `require` and `verify-ca` as aliases for `verify-full` while
 * warning that pg v9 will give them libpq's weaker meaning. Refusing it today
 * is stricter than that library needs and exactly right for the day it changes.
 *
 * Measured against `pg` 8.22.0 / `pg-connection-string` 2.14.0. A warning that
 * called `ssl=true` unverified was written here and removed once measured; if
 * this is revisited, measure it again rather than reasoning from the names.
 */

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
