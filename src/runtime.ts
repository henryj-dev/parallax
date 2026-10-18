import { constants as fsConstants } from "node:fs";
import { AccountService } from "./application/accounts/service.ts";
import { AccountMailer } from "./adapters/account-mailer.ts";
import { PostgresAccountStateStore } from "./infrastructure/account-state.ts";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AccessTokenService } from "./application/access-tokens.ts";
import { CloudflareCredentialManager } from "./application/cloudflare-credentials.ts";
import { FallbackDomainService } from "./application/fallback-domains.ts";
import { ControlPlane } from "./application/control-plane.ts";
import { parseSettings, SettingsService, type ParallaxSettings } from "./application/settings.ts";
import { DomainValidationError } from "./domain/dns.ts";
import { createHealthMonitor, type HealthTransition } from "./dns/health/monitor.ts";
import { createProbeTransport } from "./dns/health/transport.ts";
import { watchingZones } from "./dns/zone-changes.ts";
import { OwnershipSecretError } from "./adapters/ownership.ts";
import { RoutingProviderAdapter } from "./adapters/router.ts";
import { Rfc2136ProviderAdapter } from "./adapters/rfc2136.ts";
import type { SettingsRepository } from "./application/ports.ts";
import type { BackupStores } from "./application/backup.ts";
import type { CommandRuntime } from "./cli/commands.ts";
import { assertSupportedAuthMode, type ParallaxConfig } from "./config.ts";
import { assertPostgresAuthStorageIsRecognized, readPostgresAuthFeatures, UnrecognizedAuthStorageError } from "./infrastructure/auth-storage.ts";
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
  readonly readAccountPassword?: () => Promise<string>;
}

export async function createRuntime(config: ParallaxConfig, options: RuntimeOptions = {}): Promise<ParallaxRuntime> {
  // 연결을 만들기 전에 거절한다. 지원하지 않는 인증 모드를 legacy 로 바꿔
  // 시작하지 않는다.
  try {
    assertSupportedAuthMode(config);
  } catch (error) {
    throw new RuntimeStartupError(message(error));
  }
  // One decision picks every backend: a database when DATABASE_URL is set,
  // files otherwise. Settings, credentials and tokens follow the zones.
  const pool: CloseablePgPool | undefined = config.databaseUrl ? createPostgresPool(config.databaseUrl) : undefined;
  const fileConfiguration = pool ? undefined : new FileConfigurationStore(resolve(config.configurationFile));
  const persisted = pool ? createPostgresAdapters(pool) : createFileStateAdapters(resolve(config.stateFile));
  const settingsRepository = pool ? new PostgresSettingsRepository(pool) : fileConfiguration!.settings;
  const credentialRepository = pool ? new PostgresCredentialRepository(pool) : fileConfiguration!.credentials;
  const accessTokenRepository = pool ? new PostgresAccessTokenRepository(pool) : fileConfiguration!.accessTokens;

  // Bound once the control plane exists. Settings are read before it does, and a
  // stored value cannot already contradict a policy: the commit refused that.
  const healthChecks: HealthCheckSettingsHooks = {};
  const settings = createSettingsService(settingsRepository, config, healthChecks);
  const accessTokens = new AccessTokenService(accessTokenRepository, config.bootstrapTokens);
  // 미래 버전이 켠 인증 기능이 저장소에 있으면 아무것도 읽기 전에 멈춘다. 읽기만
  // 한다. 파일 저장소의 표식은 설정 파일을 읽을 때마다 `parseDocument` 가 본다.
  if (pool) await refuseUnrecognizedAuthStorage(pool);
  try {
    await settings.load();
    await accessTokens.load();
  } catch (error) {
    await pool?.end().catch(() => undefined);
    throw new RuntimeStartupError(`configuration could not be read: ${message(error)}`);
  }

  const accountStore = pool ? new PostgresAccountStateStore(pool) : fileConfiguration!.accounts;
  let accountMailer: AccountMailer | undefined;
  let accounts: AccountService | undefined;
  let memberAccountsEnabled: boolean;
  try {
    accountMailer = config.authMode === "accounts" ? new AccountMailer(config.accounts!.mailer) : undefined;
    accounts = accountMailer ? await AccountService.create({ store: accountStore, policy: config.accounts!.policy,
      key: config.accounts!.key, mailer: accountMailer, publicOrigin: config.accounts!.mailer.publicOrigin }) : undefined;
    // Before 006 the PostgreSQL account tables do not exist, so the marker is read, not the state.
    memberAccountsEnabled = pool ? (await readPostgresAuthFeatures(pool)).includes("member-accounts-v1") : (await accountStore.read()).enabled;
    // Accounts mode on a database 006 has not reached would fail on the first sign-in instead of at startup.
    if (accounts && pool) {
      const tables = await pool.query<{ present: boolean }>(
        "SELECT to_regclass('parallax_account_state') IS NOT NULL AND to_regclass('parallax_account_audit') IS NOT NULL AND to_regclass('parallax_auth_features') IS NOT NULL AS present");
      if (tables.rows[0]?.present !== true) throw new Error("the database has no member account tables; run `parallax migrate` first");
    }
  } catch (error) {
    accountMailer?.close(); await pool?.end().catch(() => undefined);
    throw new RuntimeStartupError(`member accounts could not be started: ${message(error)}`);
  }
  // Activation is a separate host operation. An enabled store must never be served in legacy mode.
  if (memberAccountsEnabled && !accounts) {
    await pool?.end().catch(() => undefined); throw new RuntimeStartupError("member accounts are enabled; PARALLAX_AUTH_MODE=accounts is required");
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
  // Who answers each target. The listener answers the internal view and only
  // that, out of the desired state: where it is running and nothing publishes
  // that view, applying it has nothing to reconcile -- so the revision being
  // served is the desired one. Where neither is true the answer is `none`, and
  // saying so is what keeps a view nobody publishes from reading as a view that
  // is merely catching up.
  //
  // A configured provider takes precedence over the listener, because a view
  // being published is what makes reconciliation real: with `allowLocalProvider`
  // on, the internal view goes to a JSON file and an apply has work to do.
  //
  // A zone whose views cannot be composed never reaches this: `apply`
  // materializes them first and fails before any target is considered.
  (target) => {
    if (provider.isConfigured(target)) return "provider";
    return config.dns !== undefined && target.endsWith("/internal") ? "listener" : "none";
  },
  // The stored settings, read under the lock a settings write also takes: a
  // replica that just turned the local provider on has not told this process's
  // router yet, and an enabled policy saved now would be one nothing honours.
  { unsupported: async () => parseSettings(await settingsRepository.read()).allowLocalProvider });
  healthChecks.zones = () => controlPlane.zonesWithEnabledHealthChecks();
  healthChecks.exclusive = (operation) => controlPlane.withHealthCheckLock(operation);

  // Built on every runtime, probing on none until a listener hands it zones.
  // The command line never does, so its status reads say "not served here"
  // rather than inventing a verdict about addresses it has not looked at.
  const healthMonitor = createHealthMonitor({
    transport: createProbeTransport(),
    // Evaluated against the router, so a zone whose internal view is
    // published elsewhere is reported unsupported instead of being probed for
    // answers this process does not give.
    unsupported: (zone) => provider.isConfigured(`${zone}/internal`),
    onTransition: (transition) => { console.log(describeTransition(transition)); },
  });
  healthMonitor.configure(settings.current());
  settings.onChange((current) => { healthMonitor.configure(current); });

  return {
    controlPlane,
    settings,
    accessTokens,
    ...(accounts ? { accounts } : {}),
    ...(accounts && options.exposeStores && options.readAccountPassword ? { accountsHost: { service: accounts, store: accountStore, readPassword: options.readAccountPassword } } : {}),
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
          // A restore writes zones without passing through a commit, so it is
          // held to the same health-check rules here, under the same lock.
          healthChecks: {
            exclusive: (operation) => controlPlane.withHealthCheckLock(operation),
            unsupported: (_zone, stored) => parseSettings(stored).allowLocalProvider || internalUpdate !== undefined,
          },
          // Only where the account schema is known to exist: accounts mode needs 006, and an enabled store has it.
          ...(accounts || memberAccountsEnabled ? { accounts: accountStore } : {}),
        },
      }
      : {}),
    healthMonitor,
    onZoneChange: (listener) => { zoneChangeListeners.push(listener); },
    close: async () => {
      await healthMonitor.close();
      accountMailer?.close();
      await pool?.end().catch(() => undefined);
    },
  };
}

/** One line per status change. The failure category, never a body or a message. */
function describeTransition(transition: HealthTransition): string {
  const reason = transition.lastFailure
    ? ` (${transition.lastFailure}${transition.lastStatusCode === undefined ? "" : ` ${transition.lastStatusCode}`})`
    : "";
  return `parallax: health check ${transition.zone} ${transition.name} ${transition.type} ${transition.address}: ${transition.from} -> ${transition.to}${reason}`;
}

interface HealthCheckSettingsHooks {
  zones?: () => Promise<string[]>;
  exclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
}

function createSettingsService(
  repository: SettingsRepository,
  config: ParallaxConfig,
  healthChecks: HealthCheckSettingsHooks = {},
): SettingsService {
  // A setting that names a directory this process has to write is checked here.
  // Whoever turns one on is the only person who can still connect it to a
  // deployment that has to make that directory writable, so the answer is given
  // to them now rather than to whoever is on call when the first apply fails.
  return new SettingsService(repository, async (candidate, previous) => {
    const issues: string[] = [];
    // The local file provider would publish the internal view, and a published
    // view is answered in full by whatever serves it. An enabled health check
    // there is a promise nothing keeps, so the switch waits for the policies to
    // be disabled or removed rather than silently dropping what they filter.
    if (candidate.allowLocalProvider && !previous.allowLocalProvider && healthChecks.zones) {
      const zones = await healthChecks.zones();
      if (zones.length > 0) {
        issues.push(`allowLocalProvider would publish the internal view of ${zones.join(", ")}, whose enabled health checks only the built-in listener can honour; disable or delete them first`);
      }
    }
    if (candidate.trustForwardedHeaders && !candidate.publicOrigin) {
      issues.push("trustForwardedHeaders requires publicOrigin so forwarded Host and Proto values cannot choose cookie security or same-origin policy");
    }
    if (candidate.allowLocalProvider) {
      const failure = await writeFailure(dirname(resolve(config.providerStateFile)));
      if (failure) issues.push(`allowLocalProvider publishes to ${config.providerStateFile}, whose directory ${failure}`);
    }
    if (issues.length > 0) throw new DomainValidationError(issues);
  }, undefined,
  // A settings write and a commit keeping an enabled health check take one
  // lock, so the zones the verifier reads cannot gain a policy before the
  // value it allowed is stored.
  (operation) => healthChecks.exclusive ? healthChecks.exclusive(operation) : operation());
}

/**
 * PostgreSQL 저장소의 인증 기능 표식을 시작할 때 한 번 확인한다. 실패하면 연결을
 * 닫고 멈춘다. 저장소가 모르는 기능을 켠 경우와 확인 자체를 못 한 경우(연결,
 * 권한)는 다른 문장으로 알린다. 고칠 곳이 다르기 때문이다. 어느 쪽도 legacy 로
 * 이어서 시작하지 않는다.
 *
 * 서버 런타임과 설정 복구 런타임이 같이 쓴다. `createMigrationRuntime` 은 일부러
 * 부르지 않는다. 마이그레이션은 표식 테이블을 만드는 쪽이고, 저장소를 읽거나
 * 관리 포트를 열지 않는다.
 */
async function refuseUnrecognizedAuthStorage(pool: CloseablePgPool): Promise<void> {
  try {
    await assertPostgresAuthStorageIsRecognized(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    if (error instanceof UnrecognizedAuthStorageError) {
      throw new RuntimeStartupError(`authentication storage is not compatible with this version: ${message(error)}`);
    }
    throw new RuntimeStartupError(`authentication storage could not be checked, so this version did not start: ${message(error)}`);
  }
}

/**
 * Builds only the local CLI capability needed to correct a stored setting that
 * makes the serving runtime fail closed. It deliberately does not load and
 * publish the stored snapshot: `SettingsService.update()` reads the latest
 * values, merges the patch, and verifies that single repaired candidate.
 *
 * 쓰기 전에 서버 런타임과 같은 인증 기능 표식 검사를 거친다. 미래 버전이 켠
 * 저장소에 이 버전의 설정을 쓰지 않는다. 파일 저장소는 쓰기마다 `parseDocument`
 * 가 같은 검사를 한다.
 */
export async function createSettingsRecoveryRuntime(config: ParallaxConfig): Promise<SettingsRecoveryRuntime> {
  const pool: CloseablePgPool | undefined = config.databaseUrl ? createPostgresPool(config.databaseUrl) : undefined;
  if (pool) await refuseUnrecognizedAuthStorage(pool);
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
 *
 * 인증 기능 표식 검사도 하지 않는다. 일부러다. 표식 테이블은 그 기능을 들이는
 * 마이그레이션이 만들고, 이 런타임은 저장된 설정이나 토큰을 읽지 않으며 관리
 * 포트를 열지 않는다. 미래 버전이 켠 저장소에서 이 버전의 `migrate` 가 할 수 있는
 * 일은 이 버전이 아는 마이그레이션을 적용하는 것뿐이다.
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
