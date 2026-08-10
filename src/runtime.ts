import { resolve } from "node:path";
import { AccessTokenService } from "./application/access-tokens.ts";
import { CloudflareCredentialManager } from "./application/cloudflare-credentials.ts";
import { ControlPlane } from "./application/control-plane.ts";
import { SettingsService, type ParallaxSettings } from "./application/settings.ts";
import { CoreDnsFileAdapter } from "./adapters/coredns-file.ts";
import { NodeCoreDnsFileOperations } from "./adapters/node-coredns-files.ts";
import { RoutingProviderAdapter } from "./adapters/router.ts";
import type { CommandRuntime } from "./cli/commands.ts";
import type { ParallaxConfig } from "./config.ts";
import { createFileStateAdapters } from "./infrastructure/file-state.ts";
import { FileConfigurationStore } from "./infrastructure/file-settings.ts";
import { FileProviderAdapter } from "./infrastructure/file-provider.ts";
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
  close(): Promise<void>;
}

export class RuntimeStartupError extends Error {}

export async function createRuntime(config: ParallaxConfig): Promise<ParallaxRuntime> {
  // One decision picks every backend: a database when DATABASE_URL is set,
  // files otherwise. Settings, credentials and tokens follow the zones.
  const pool: CloseablePgPool | undefined = config.databaseUrl ? createPostgresPool(config.databaseUrl) : undefined;
  const fileConfiguration = pool ? undefined : new FileConfigurationStore(resolve(config.configurationFile));
  const persisted = pool ? createPostgresAdapters(pool) : createFileStateAdapters(resolve(config.stateFile));
  const settingsRepository = pool ? new PostgresSettingsRepository(pool) : fileConfiguration!.settings;
  const credentialRepository = pool ? new PostgresCredentialRepository(pool) : fileConfiguration!.credentials;
  const accessTokenRepository = pool ? new PostgresAccessTokenRepository(pool) : fileConfiguration!.accessTokens;

  const settings = new SettingsService(settingsRepository);
  const accessTokens = new AccessTokenService(accessTokenRepository, config.bootstrapTokens);
  try {
    await settings.load();
    await accessTokens.load();
  } catch (error) {
    await pool?.end().catch(() => undefined);
    throw new RuntimeStartupError(`configuration could not be read: ${message(error)}`);
  }

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
    provider.setInternal(current.coreDnsDirectory && config.ownershipSecret
      ? new CoreDnsFileAdapter({
        files: new NodeCoreDnsFileOperations({ root: resolve(current.coreDnsDirectory) }),
        pathForTarget: (target) => `${target.slice(0, target.lastIndexOf("/"))}.zone`,
        ownershipSecret: config.ownershipSecret,
      })
      : undefined);
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

  const controlPlane = new ControlPlane(persisted.zones, persisted.statuses, provider, undefined, persisted.applyLock, {
    get maxRevisionsPerZone() { return settings.current().revisionRetention; },
    get auditRetentionDays() { return settings.current().auditRetentionDays; },
  });

  return {
    controlPlane,
    settings,
    accessTokens,
    ...(credentials ? { credentials } : {}),
    provider,
    close: async () => { await pool?.end().catch(() => undefined); },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
