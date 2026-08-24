import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AccessTokenService } from "./application/access-tokens.ts";
import { CloudflareCredentialManager } from "./application/cloudflare-credentials.ts";
import { FallbackDomainService } from "./application/fallback-domains.ts";
import { ControlPlane } from "./application/control-plane.ts";
import { SettingsService, type ParallaxSettings } from "./application/settings.ts";
import { DomainValidationError } from "./domain/dns.ts";
import { watchingZones } from "./dns/zone-changes.ts";
import { OwnershipSecretError } from "./adapters/ownership.ts";
import { RoutingProviderAdapter } from "./adapters/router.ts";
import { Rfc2136ProviderAdapter } from "./adapters/rfc2136.ts";
import type { SettingsRepository } from "./application/ports.ts";
import type { BackupStores } from "./application/backup.ts";
import type { CommandRuntime } from "./cli/commands.ts";
import type { ParallaxConfig } from "./config.ts";
import { createFileStateAdapters } from "./infrastructure/file-state.ts";
import { FileConfigurationStore } from "./infrastructure/file-settings.ts";
import { FileProviderAdapter } from "./infrastructure/file-provider.ts";
import { applyMigrations, findMigrationsDirectory, type MigrationTarget } from "./infrastructure/migrations.ts";
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
  readonly fallbackDomains?: FallbackDomainService;
  readonly provider: RoutingProviderAdapter;
  /** Present only where `exposeStores` was asked for -- the command line. */
  readonly stores?: BackupStores;
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

/** A local-CLI runtime that can repair settings which prevent a full startup. */
export interface SettingsRecoveryRuntime extends CommandRuntime {
  readonly settings: SettingsService;
  close(): Promise<void>;
}

export class RuntimeStartupError extends Error {
  override readonly name = "RuntimeStartupError";
}

export interface RuntimeOptions {
  /**
   * Hand back the repositories themselves, not just the services over them.
   *
   * Off by default, and the reason is the same one that keeps `migrate` off
   * this object: the HTTP handler is given this runtime, and these reach past
   * every rule the control plane enforces -- writing revisions and audit
   * entries directly, and reading the credential store's document as stored.
   * The command line already acts with full rights against the store, so it
   * asks for them; nothing reachable over a port does.
   */
  readonly exposeStores?: boolean;
}

export async function createRuntime(config: ParallaxConfig, options: RuntimeOptions = {}): Promise<ParallaxRuntime> {
  // One decision picks every backend: a database when DATABASE_URL is set,
  // files otherwise. Settings, credentials and tokens follow the zones.
  const pool: CloseablePgPool | undefined = config.databaseUrl ? createPostgresPool(config.databaseUrl) : undefined;
  const fileConfiguration = pool ? undefined : new FileConfigurationStore(resolve(config.configurationFile));
  const persisted = pool ? createPostgresAdapters(pool) : createFileStateAdapters(resolve(config.stateFile));
  const settingsRepository = pool ? new PostgresSettingsRepository(pool) : fileConfiguration!.settings;
  const credentialRepository = pool ? new PostgresCredentialRepository(pool) : fileConfiguration!.credentials;
  const accessTokenRepository = pool ? new PostgresAccessTokenRepository(pool) : fileConfiguration!.accessTokens;

  const settings = createSettingsService(settingsRepository, config);
  const accessTokens = new AccessTokenService(accessTokenRepository, config.bootstrapTokens);
  try {
    await settings.load();
    await accessTokens.load();
  } catch (error) {
    await pool?.end().catch(() => undefined);
    throw new RuntimeStartupError(`configuration could not be read: ${message(error)}`);
  }

  // The `internal` slot, which has stood empty since the CoreDNS and PowerDNS
  // publishers were removed. A deployment that names a server to publish into
  // gets one; every other deployment is unchanged, and its internal view is
  // answered by this process's own listener as before.
  const internalUpdate = config.dns?.internalUpdate;
  const provider = new RoutingProviderAdapter(internalUpdate
    ? {
      internal: new Rfc2136ProviderAdapter({
        server: { host: internalUpdate.host, port: internalUpdate.port },
        key: internalUpdate.key,
        ownershipSecret: config.ownershipSecret ?? "",
      }),
    }
    : {});
  // One store, two services. The device-settings service speaks with the same
  // stored token as the DNS side rather than holding a second secret of its own.
  const credentialStore = config.credentialMasterKey
    ? new EncryptedCredentialStore({ repository: credentialRepository, masterKey: config.credentialMasterKey })
    : undefined;
  const credentials = credentialStore
    ? new CloudflareCredentialManager({
      store: credentialStore,
      router: provider,
      ownershipSecret: config.ownershipSecret ?? "",
    })
    : undefined;
  const fallbackDomains = credentialStore
    ? new FallbackDomainService({ secrets: credentialStore, ownershipSecret: config.ownershipSecret ?? "" })
    : undefined;

  const applyProviderSettings = (current: ParallaxSettings): void => {
    provider.setFallback(
      current.allowLocalProvider ? new FileProviderAdapter({ path: resolve(config.providerStateFile) }) : undefined,
      // Once external credentials exist, an unbound external zone must fail
      // closed instead of silently moving into the local JSON fallback. The
      // fallback remains useful for an otherwise unconfigured internal view.
      config.credentialMasterKey ? ["internal"] : ["internal", "external"],
    );
  };
  applyProviderSettings(settings.current());
  settings.onChange((current) => { applyProviderSettings(current); });

  try {
    await credentials?.initialize();
  } catch (error) {
    await pool?.end().catch(() => undefined);
    throw new RuntimeStartupError(startupHint(error));
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
  },
  // The listener answers the internal view and only that, out of the desired
  // state. Where it is running and nothing publishes that view, applying it has
  // nothing to reconcile -- so the revision being served is the desired one.
  //
  // A zone whose views cannot be composed never reaches this: `apply`
  // materializes them first and fails before any target is considered.
  (target) => config.dns !== undefined && target.endsWith("/internal") && !provider.isConfigured(target));

  return {
    controlPlane,
    settings,
    accessTokens,
    // Schema changes intentionally exist only on createMigrationRuntime(), which
    // the local CLI selects before it builds the serving runtime. Keeping the
    // capability out of this object also keeps POST /api/v1/cli from turning an
    // HTTP administrator into the database's DDL role.
    ...(credentials ? { credentials } : {}),
    ...(fallbackDomains ? { fallbackDomains } : {}),
    provider,
    ...(options.exposeStores
      ? {
        stores: {
          zones: persisted.zones,
          statuses: persisted.statuses,
          settings: settingsRepository,
          accessTokens: accessTokenRepository,
          credentials: credentialRepository,
        },
      }
      : {}),
    onZoneChange: (listener) => { zoneChangeListeners.push(listener); },
    close: async () => {
      await pool?.end().catch(() => undefined);
    },
  };
}

function createSettingsService(repository: SettingsRepository, config: ParallaxConfig): SettingsService {
  // A setting that names a directory this process has to write is checked here.
  // Whoever turns one on is the only person who can still connect it to a
  // deployment that has to make that directory writable, so the answer is given
  // to them now rather than to whoever is on call when the first apply fails.
  return new SettingsService(repository, async (candidate) => {
    const issues: string[] = [];
    if (candidate.trustForwardedHeaders && !candidate.publicOrigin) {
      issues.push("trustForwardedHeaders requires publicOrigin so forwarded Host and Proto values cannot choose cookie security or same-origin policy");
    }
    if (candidate.allowLocalProvider) {
      const failure = await writeFailure(dirname(resolve(config.providerStateFile)));
      if (failure) issues.push(`allowLocalProvider publishes to ${config.providerStateFile}, whose directory ${failure}`);
    }
    if (issues.length > 0) throw new DomainValidationError(issues);
  });
}

/**
 * Builds only the local CLI capability needed to correct a stored setting that
 * makes the serving runtime fail closed. It deliberately does not load and
 * publish the stored snapshot: `SettingsService.update()` reads the latest
 * values, merges the patch, and verifies that single repaired candidate.
 */
export function createSettingsRecoveryRuntime(config: ParallaxConfig): SettingsRecoveryRuntime {
  const pool: CloseablePgPool | undefined = config.databaseUrl ? createPostgresPool(config.databaseUrl) : undefined;
  const fileConfiguration = pool ? undefined : new FileConfigurationStore(resolve(config.configurationFile));
  const repository = pool ? new PostgresSettingsRepository(pool) : fileConfiguration!.settings;
  return {
    settings: createSettingsService(repository, config),
    close: async () => { await pool?.end().catch(() => undefined); },
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
  if (!config.databaseUrl) return { close: async () => undefined };
  const pool = createPostgresPool(config.databaseUrl);
  const directory = findMigrationsDirectory(import.meta.dirname);
  return {
    migrate: () => applyMigrations(pool, directory, target),
    close: async () => { await pool.end().catch(() => undefined); },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * Which variable to send somebody to, decided by what actually failed.
 *
 * Both of these surface from the same call, and they are not interchangeable.
 * A mismatched master key is the usual cause and the advice was written for it;
 * a missing ownership secret arrived wearing the same sentence, which sent the
 * reader at the one variable they must not regenerate -- doing so makes every
 * stored credential unreadable. So the cause is asked rather than assumed.
 */
function startupHint(error: unknown): string {
  if (error instanceof OwnershipSecretError) {
    return `${message(error)}. Set PARALLAX_OWNERSHIP_SECRET: it signs the marker that tells this control plane's provider records from everybody else's, and a Cloudflare binding cannot be used without it.`;
  }
  return `${message(error)}. Check PARALLAX_CREDENTIAL_MASTER_KEY matches the key that sealed the stored credentials.`;
}
