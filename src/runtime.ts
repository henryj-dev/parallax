import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AccessTokenService } from "./application/access-tokens.ts";
import { CloudflareCredentialManager } from "./application/cloudflare-credentials.ts";
import { ControlPlane } from "./application/control-plane.ts";
import { SettingsService, type ParallaxSettings } from "./application/settings.ts";
import { DomainValidationError } from "./domain/dns.ts";
import { watchingZones } from "./dns/zone-changes.ts";
import { CoreDnsFileAdapter } from "./adapters/coredns-file.ts";
import { PowerDnsProviderAdapter } from "./adapters/powerdns.ts";
import { NodeCoreDnsFileOperations } from "./adapters/node-coredns-files.ts";
import { RoutingProviderAdapter } from "./adapters/router.ts";
import type { ProviderAdapter } from "./application/ports.ts";
import type { CommandRuntime } from "./cli/commands.ts";
import type { ParallaxConfig } from "./config.ts";
import { createFileStateAdapters } from "./infrastructure/file-state.ts";
import { FileConfigurationStore } from "./infrastructure/file-settings.ts";
import { FileProviderAdapter } from "./infrastructure/file-provider.ts";
import { applyMigrations, findMigrationsDirectory, type MigrationRun, type MigrationTarget } from "./infrastructure/migrations.ts";
import {
  createPostgresAdapters,
  createPostgresPool,
  PostgresAccessTokenRepository,
  PostgresCredentialRepository,
  PostgresSettingsRepository,
  type CloseablePgPool,
} from "./infrastructure/postgres.ts";
import { EncryptedCredentialStore } from "./security/credential-store.ts";

/**
 * Everything a Parallax process needs, assembled once from the environment.
 * The server and the command line share it so both reach the control plane the
 * same way and observe the same stored settings.
 */
export interface ParallaxRuntime extends CommandRuntime {
  readonly controlPlane: ControlPlane;
  readonly settings: SettingsService;
  readonly accessTokens: AccessTokenService;
  readonly credentials?: CloudflareCredentialManager;
  readonly provider: RoutingProviderAdapter;
  /**
   * Called after this process commits a zone change. Only this process's own
   * writes are seen; anything that needs to observe another instance has to
   * read the store on its own schedule.
   */
  onZoneChange(listener: () => void): void;
  close(): Promise<void>;
}

/** A runtime that has not read the store, because the store may not exist yet. */
export interface MigrationRuntime extends CommandRuntime {
  close(): Promise<void>;
}

export class RuntimeStartupError extends Error {
  override readonly name = "RuntimeStartupError";
}

export async function createRuntime(config: ParallaxConfig): Promise<ParallaxRuntime> {
  // One decision picks every backend: a database when DATABASE_URL is set,
  // files otherwise. Settings, credentials and tokens follow the zones.
  const pool: CloseablePgPool | undefined = config.databaseUrl ? createPostgresPool(config.databaseUrl) : undefined;
  const fileConfiguration = pool ? undefined : new FileConfigurationStore(resolve(config.configurationFile));
  const persisted = pool ? createPostgresAdapters(pool) : createFileStateAdapters(resolve(config.stateFile));
  const settingsRepository = pool ? new PostgresSettingsRepository(pool) : fileConfiguration!.settings;
  const credentialRepository = pool ? new PostgresCredentialRepository(pool) : fileConfiguration!.credentials;
  const accessTokenRepository = pool ? new PostgresAccessTokenRepository(pool) : fileConfiguration!.accessTokens;

  // Two settings name a directory this process has to write. Whoever turns one
  // on is the only person who can still connect it to a deployment that has to
  // make that directory writable, so the answer is given to them now rather
  // than to whoever is on call when the first apply fails.
  const settings = new SettingsService(settingsRepository, async (candidate) => {
    const issues: string[] = [];
    if (candidate.coreDnsDirectory) {
      const failure = await writeFailure(resolve(candidate.coreDnsDirectory));
      if (failure) issues.push(`coreDnsDirectory ${failure}. CoreDNS zone files cannot be written there`);
    }
    if (candidate.allowLocalProvider) {
      const failure = await writeFailure(dirname(resolve(config.providerStateFile)));
      if (failure) issues.push(`allowLocalProvider publishes to ${config.providerStateFile}, whose directory ${failure}`);
    }
    if (issues.length > 0) throw new DomainValidationError(issues);
  }, (candidate) => {
    const warnings: string[] = [];
    // Clearing this is legal and is right on 443, so it is not refused. But the
    // redirect target changes the moment it is cleared, and the only person who
    // can still connect that to an address clients use is the one clearing it.
    if (config.httpRedirectPort !== undefined && !candidate.publicOrigin) {
      warnings.push("publicOrigin is empty, so redirects from the plain-HTTP listener assume TLS on 443 at the host the client asked for. Set it if clients reach this deployment at any other address.");
    }
    return warnings;
  });
  const accessTokens = new AccessTokenService(accessTokenRepository, config.bootstrapTokens);
  try {
    await settings.load();
    await accessTokens.load();
  } catch (error) {
    await pool?.end().catch(() => undefined);
    throw new RuntimeStartupError(`configuration could not be read: ${message(error)}`);
  }

  const powerDnsPool: CloseablePgPool | undefined = config.powerDnsDatabaseUrl
    ? createPostgresPool(config.powerDnsDatabaseUrl)
    : undefined;
  const provider = new RoutingProviderAdapter();
  const credentials = config.credentialMasterKey
    ? new CloudflareCredentialManager({
      store: new EncryptedCredentialStore({ repository: credentialRepository, masterKey: config.credentialMasterKey }),
      router: provider,
      ownershipSecret: config.ownershipSecret ?? "",
    })
    : undefined;

  const applyProviderSettings = (current: ParallaxSettings): void => {
    provider.setFallback(current.allowLocalProvider
      ? new FileProviderAdapter({ path: resolve(config.providerStateFile) })
      : undefined);
    // Two ways to publish the internal view, and the deployment picks one by
    // configuring it. Both at once is refused rather than resolved by a
    // precedence rule nobody would remember when the wrong one turned out to be
    // serving.
    if (current.coreDnsDirectory && powerDnsPool) {
      throw new RuntimeStartupError("both coreDnsDirectory and PARALLAX_POWERDNS_DATABASE_URL are configured; the internal view can have only one publisher");
    }
    provider.setInternal(internalAdapter(current, config, powerDnsPool));
  };
  applyProviderSettings(settings.current());
  settings.onChange((current) => { applyProviderSettings(current); });

  try {
    await credentials?.initialize();
  } catch (error) {
    await pool?.end().catch(() => undefined);
    // A credential store that cannot be decrypted is usually a mismatched key.
    throw new RuntimeStartupError(`${message(error)}. Check PARALLAX_CREDENTIAL_MASTER_KEY matches the key that sealed the stored credentials.`);
  }

  // Wrapped rather than announced by the control plane itself: a change cannot
  // reach the store without passing through here, and nothing else has to learn
  // about an event it does not use.
  const zoneChangeListeners: (() => void)[] = [];
  const zones = watchingZones(persisted.zones, () => {
    for (const listener of zoneChangeListeners) listener();
  });

  const controlPlane = new ControlPlane(zones, persisted.statuses, provider, undefined, persisted.applyLock, {
    get maxRevisionsPerZone() { return settings.current().revisionRetention; },
    get auditRetentionDays() { return settings.current().auditRetentionDays; },
  });

  return {
    controlPlane,
    settings,
    accessTokens,
    // Only a database has a schema to apply. With the file backend the command
    // reports itself unavailable rather than pretending it did something.
    ...(pool ? { migrate: () => applyMigrations(pool, findMigrationsDirectory(import.meta.dirname)) } : {}),
    ...(credentials ? { credentials } : {}),
    provider,
    onZoneChange: (listener) => { zoneChangeListeners.push(listener); },
    close: async () => {
      await pool?.end().catch(() => undefined);
      await powerDnsPool?.end().catch(() => undefined);
    },
  };
}

/**
 * Whether a directory could be written, without creating anything: the first
 * ancestor that exists has to be writable, since everything below it would be
 * created on the way. Returns a reason, or undefined when the path is usable.
 */
async function writeFailure(path: string): Promise<string | undefined> {
  let candidate = path;
  for (;;) {
    try {
      await access(candidate, fsConstants.W_OK);
      return undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return `is not writable (${code ?? "unknown error"})`;
      const parent = dirname(candidate);
      if (parent === candidate) return "has no writable ancestor";
      candidate = parent;
    }
  }
}

/**
 * Just enough to apply the schema. `createRuntime` reads settings and tokens out
 * of the store while starting, which cannot work on a database whose tables do
 * not exist yet -- the exact situation migrating exists to resolve. This builds
 * the connection and nothing that reads through it.
 */
export function createMigrationRuntime(config: ParallaxConfig, target: MigrationTarget = "parallax"): MigrationRuntime {
  // Without a database there is no schema, and the command says so rather than
  // this function inventing a reason to fail.
  const url = target === "powerdns" ? config.powerDnsDatabaseUrl : config.databaseUrl;
  if (!url) return { close: async () => undefined };
  const pool = createPostgresPool(url);
  // PowerDNS owns its schema; Parallax only adds the table its ownership marker
  // lives in, which is why that target has a directory of its own.
  const directory = findMigrationsDirectory(import.meta.dirname, target === "powerdns" ? "powerdns" : undefined);
  return {
    migrate: () => applyMigrations(pool, directory),
    close: async () => { await pool.end().catch(() => undefined); },
  };
}

function internalAdapter(
  settings: ParallaxSettings,
  config: ParallaxConfig,
  powerDnsPool: CloseablePgPool | undefined,
): ProviderAdapter | undefined {
  // Both shapes sign the same ownership marker, so neither works without the
  // secret that signs it.
  if (!config.ownershipSecret) return undefined;
  if (powerDnsPool) return new PowerDnsProviderAdapter({ pool: powerDnsPool, ownershipSecret: config.ownershipSecret });
  if (!settings.coreDnsDirectory) return undefined;
  return new CoreDnsFileAdapter({
    files: new NodeCoreDnsFileOperations({ root: resolve(settings.coreDnsDirectory) }),
    pathForTarget: (target) => `${target.slice(0, target.lastIndexOf("/"))}.zone`,
    ownershipSecret: config.ownershipSecret,
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
