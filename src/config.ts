import { MIN_TOKEN_BYTES, type Role, type TokenRecord } from "./security/http-authorization.ts";

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
  return {
    host: environment.HOST?.trim() || "127.0.0.1",
    port: readPort(environment.PORT),
    stateFile: environment.PARALLAX_STATE_FILE?.trim() || "data/parallax-state.json",
    providerStateFile: environment.PARALLAX_PROVIDER_STATE_FILE?.trim() || "data/provider-state.json",
    configurationFile: environment.PARALLAX_CONFIG_FILE?.trim() || "data/parallax-config.json",
    ...(environment.DATABASE_URL?.trim() ? { databaseUrl: environment.DATABASE_URL.trim() } : {}),
    ...(ownershipSecret ? { ownershipSecret } : {}),
    ...(credentialMasterKey ? { credentialMasterKey } : {}),
    bootstrapTokens: readBootstrapTokens(environment.PARALLAX_AUTH_TOKENS),
    ...(tls ? { tls } : {}),
    ...(httpRedirectPort !== undefined ? { httpRedirectPort } : {}),
  };
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
    if (Buffer.byteLength(item.token, "utf8") < MIN_TOKEN_BYTES) {
      throw new Error(`PARALLAX_AUTH_TOKENS entries must contain at least ${MIN_TOKEN_BYTES} bytes; generate one with: openssl rand -base64 32`);
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
    const mode = url.searchParams.get("sslmode");
    const ssl = url.searchParams.get("ssl");
    if (ssl === "true" || ssl === "1") return false;
    return mode === null || mode === "disable" || mode === "allow" || mode === "prefer";
  } catch {
    return false;
  }
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
