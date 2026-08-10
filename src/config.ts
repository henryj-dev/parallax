import type { Role, SecurityConfig, TokenRecord } from "./security/http-authorization.ts";

export interface ParallaxConfig {
  host: string;
  port: number;
  stateFile: string;
  providerStateFile: string;
  databaseUrl?: string;
  coreDnsDirectory?: string;
  ownershipSecret?: string;
  credentialFile?: string;
  credentialMasterKey?: Buffer;
  allowLocalProvider: boolean;
  cloudflareZones: Array<{ zone: string; zoneId: string; token: string }>;
  security: SecurityConfig;
}

export function readConfig(environment: NodeJS.ProcessEnv = process.env): ParallaxConfig {
  const host = environment.HOST?.trim() || "127.0.0.1";
  const security = readSecurity(environment.PARALLAX_AUTH_TOKENS);
  if (!security.enabled && !isLoopbackHost(host)) {
    throw new Error("PARALLAX_AUTH_TOKENS is required when HOST is not loopback");
  }
  const cloudflareZones = readCloudflareZones(environment.PARALLAX_CLOUDFLARE_ZONES);
  const coreDnsDirectory = environment.PARALLAX_COREDNS_DIRECTORY?.trim();
  const ownershipSecret = environment.PARALLAX_OWNERSHIP_SECRET;
  const credentialFile = environment.PARALLAX_CREDENTIAL_FILE?.trim();
  const credentialMasterKey = readCredentialMasterKey(environment.PARALLAX_CREDENTIAL_MASTER_KEY);
  const allowLocalProvider = readBoolean(environment.PARALLAX_ALLOW_LOCAL_PROVIDER, isLoopbackHost(host));
  if (Boolean(credentialFile) !== Boolean(credentialMasterKey)) {
    throw new Error("PARALLAX_CREDENTIAL_FILE and PARALLAX_CREDENTIAL_MASTER_KEY must be configured together");
  }
  if ((cloudflareZones.length > 0 || coreDnsDirectory || credentialFile) && Buffer.byteLength(ownershipSecret ?? "", "utf8") < 32) {
    throw new Error("PARALLAX_OWNERSHIP_SECRET must contain at least 32 bytes when an external provider is configured");
  }
  return {
    host,
    port: readPort(environment.PORT),
    stateFile: environment.PARALLAX_STATE_FILE?.trim() || "data/parallax-state.json",
    providerStateFile: environment.PARALLAX_PROVIDER_STATE_FILE?.trim() || "data/provider-state.json",
    ...(environment.DATABASE_URL?.trim() ? { databaseUrl: environment.DATABASE_URL.trim() } : {}),
    ...(coreDnsDirectory ? { coreDnsDirectory } : {}),
    ...(ownershipSecret ? { ownershipSecret } : {}),
    ...(credentialFile ? { credentialFile } : {}),
    ...(credentialMasterKey ? { credentialMasterKey } : {}),
    allowLocalProvider,
    cloudflareZones,
    security,
  };
}

function readBoolean(source: string | undefined, defaultValue: boolean): boolean {
  if (source === undefined || source.trim() === "") return defaultValue;
  if (source === "true") return true;
  if (source === "false") return false;
  throw new Error("PARALLAX_ALLOW_LOCAL_PROVIDER must be true or false");
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

function readCloudflareZones(source: string | undefined): ParallaxConfig["cloudflareZones"] {
  if (source === undefined || source.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("PARALLAX_CLOUDFLARE_ZONES must be a valid JSON object");
  }
  if (!isObject(parsed)) throw new Error("PARALLAX_CLOUDFLARE_ZONES must be a valid JSON object");
  return Object.entries(parsed).map(([rawZone, value]) => {
    const zone = rawZone.trim().toLowerCase().replace(/\.$/, "");
    if (!isValidZone(zone) || !isObject(value) || typeof value.zoneId !== "string" || !value.zoneId.trim() || typeof value.token !== "string" || !value.token.trim()) {
      throw new Error("PARALLAX_CLOUDFLARE_ZONES contains an invalid zone configuration");
    }
    return { zone, zoneId: value.zoneId.trim(), token: value.token };
  });
}

function readSecurity(source: string | undefined): SecurityConfig {
  if (source === undefined || source.trim() === "") return { enabled: false, tokens: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("PARALLAX_AUTH_TOKENS must be a valid JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("PARALLAX_AUTH_TOKENS must be a valid JSON array");
  const tokens: TokenRecord[] = parsed.map((item) => {
    if (!isObject(item) || typeof item.token !== "string" || typeof item.subject !== "string" || !isRole(item.role)) {
      throw new Error("PARALLAX_AUTH_TOKENS contains an invalid token record");
    }
    return { token: item.token, subject: item.subject, role: item.role };
  });
  return { enabled: true, tokens };
}

function readPort(value: string | undefined): number {
  if (!value) return 3000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRole(value: unknown): value is Role {
  return value === "admin" || value === "editor" || value === "viewer";
}

function isValidZone(value: string): boolean {
  return value.length <= 253 && value.includes(".") && value.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label));
}

function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}
