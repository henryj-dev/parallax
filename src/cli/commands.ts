import type { AccessTokenService } from "../application/access-tokens.ts";
import type { CloudflareCredentialManager } from "../application/cloudflare-credentials.ts";
import { NotFoundError, type ControlPlane } from "../application/control-plane.ts";
import type { SettingsService } from "../application/settings.ts";
import { DomainValidationError } from "../domain/dns.ts";
import { MIGRATION_TARGETS, type MigrationRun } from "../infrastructure/migrations.ts";
import type { Role } from "../security/http-authorization.ts";

/**
 * What a command may reach. A server supplies all of it; a test or a reduced
 * deployment may omit a service, and the commands that need it say so.
 */
export interface CommandRuntime {
  /** Absent only while bootstrapping a store that does not exist yet. */
  readonly controlPlane?: ControlPlane;
  readonly settings?: SettingsService;
  readonly accessTokens?: AccessTokenService;
  readonly credentials?: CloudflareCredentialManager;
  /** Present only when a database backs this process. */
  readonly migrate?: () => Promise<MigrationRun>;
}

/**
 * Every operation Parallax can perform, defined once. The command line parses
 * argv into a command and its input; the HTTP API maps a route onto the same
 * command. Neither owns behaviour, so the two can never drift apart.
 */
export interface CommandContext {
  readonly runtime: CommandRuntime;
  /** Recorded as the author of any change this command makes. */
  readonly actor: string;
  /** The caller's role; a command declares the minimum it needs. */
  readonly role: Role;
}

export type CommandValueType = "string" | "number" | "boolean" | "json";

export interface CommandOption {
  readonly name: string;
  readonly summary: string;
  readonly type?: CommandValueType;
  readonly required?: boolean;
}

export interface Command {
  /** Space-separated path, e.g. `zone list`. */
  readonly name: string;
  readonly summary: string;
  readonly role: Role;
  readonly options: readonly CommandOption[];
  run(context: CommandContext, input: CommandInput): Promise<unknown>;
}

export type CommandInput = Record<string, unknown>;

export class UnknownCommandError extends Error {}
export class CommandPermissionError extends Error {}
/** The runtime lacks the service this command needs, e.g. no credential key. */
export class CommandUnavailableError extends Error {}

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export function satisfiesRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** Resolves a command by name and runs it after checking role and input. */
export async function runCommand(context: CommandContext, name: string, input: CommandInput = {}): Promise<unknown> {
  const command = findCommand(name);
  if (!command) throw new UnknownCommandError(`unknown command: ${name}`);
  if (!satisfiesRole(context.role, command.role)) {
    throw new CommandPermissionError(`${command.name} requires the ${command.role} role`);
  }
  return command.run(context, coerceInput(command, input));
}

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function listCommands(): readonly Command[] {
  return COMMANDS;
}

/**
 * Applies each option's declared type. Values arriving from argv are strings,
 * while values arriving from an HTTP body already have a type; both end up the
 * same shape so a command never has to know where it was called from.
 */
function coerceInput(command: Command, input: CommandInput): CommandInput {
  const result: CommandInput = {};
  const issues: string[] = [];
  const known = new Set(command.options.map((option) => option.name));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) issues.push(`unknown option --${key}`);
  }
  for (const option of command.options) {
    const raw = input[option.name];
    if (raw === undefined || raw === "") {
      if (option.required) issues.push(`--${option.name} is required`);
      continue;
    }
    try {
      result[option.name] = coerceValue(raw, option.type ?? "string", option.name);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `--${option.name} is invalid`);
    }
  }
  if (issues.length > 0) throw new DomainValidationError(issues);
  return result;
}

function coerceValue(raw: unknown, type: CommandValueType, name: string): unknown {
  if (type === "string") {
    if (typeof raw !== "string") throw new Error(`--${name} must be a string`);
    return raw;
  }
  if (type === "number") {
    const value = typeof raw === "number" ? raw : Number(String(raw));
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
    return value;
  }
  if (type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`--${name} must be true or false`);
  }
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`--${name} must be valid JSON`);
  }
}

function requireCredentials(context: CommandContext): CloudflareCredentialManager {
  const credentials = context.runtime.credentials;
  if (!credentials) {
    throw new CommandUnavailableError("provider credentials are unavailable; set PARALLAX_CREDENTIAL_MASTER_KEY");
  }
  return credentials;
}

/**
 * What to probe with when the caller does not want the stored binding: a
 * profile it has not bound yet, or a token it has not saved. Neither means the
 * stored one.
 */
function unsavedCredentialFor(input: Record<string, unknown>): { profile: string } | { token: string; accountId?: string } | undefined {
  if (input.profile !== undefined) return { profile: String(input.profile) };
  if (input.token === undefined) return undefined;
  return {
    token: String(input.token),
    ...(input.accountId === undefined ? {} : { accountId: String(input.accountId) }),
  };
}

function requireControlPlane(runtime: CommandRuntime): ControlPlane {
  if (!runtime.controlPlane) throw new CommandUnavailableError("the control plane is unavailable in this process");
  return runtime.controlPlane;
}

function requireSettings(context: CommandContext): SettingsService {
  const settings = context.runtime.settings;
  if (!settings) throw new CommandUnavailableError("settings are unavailable in this process");
  return settings;
}

function requireAccessTokens(context: CommandContext): AccessTokenService {
  const accessTokens = context.runtime.accessTokens;
  if (!accessTokens) throw new CommandUnavailableError("access tokens are unavailable in this process");
  return accessTokens;
}

function page(input: CommandInput): { limit: number; offset: number } | undefined {
  if (input.limit === undefined && input.offset === undefined) return undefined;
  return { limit: Number(input.limit ?? 50), offset: Number(input.offset ?? 0) };
}

/** The optimistic-concurrency guard, distinct from the revision being acted on. */
function expectedRevisionOf(input: CommandInput): number | undefined {
  return input.expectedRevision === undefined ? undefined : Number(input.expectedRevision);
}

const ZONE = { name: "zone", summary: "Apex domain", required: true } as const;
const VIEW = { name: "view", summary: "internal or external" } as const;
const EXPECTED = { name: "expectedRevision", summary: "Fail unless the zone is at this revision", type: "number" } as const;
const PAGING = [
  { name: "limit", summary: "Maximum entries to return", type: "number" },
  { name: "offset", summary: "Entries to skip", type: "number" },
] as const;

const COMMANDS: readonly Command[] = [
  {
    name: "zone list",
    summary: "List every zone and its desired revision",
    role: "viewer",
    options: [],
    run: async ({ runtime }) => ({ zones: await requireControlPlane(runtime).listZones() }),
  },
  {
    name: "zone get",
    summary: "Show one zone's desired state",
    role: "viewer",
    options: [ZONE],
    run: ({ runtime }, input) => requireControlPlane(runtime).getZone(String(input.zone)),
  },
  {
    name: "zone create",
    summary: "Create an empty zone",
    role: "editor",
    options: [ZONE],
    run: ({ runtime, actor }, input) => requireControlPlane(runtime).createZone(String(input.zone), actor),
  },
  {
    name: "zone adopt",
    summary: "Describe records that already exist at the provider, without taking them over",
    role: "editor",
    options: [
      ZONE,
      { name: "view", summary: "internal or external", required: true },
      { name: "expectedRevision", summary: "Refuse if the zone moved on", type: "number" },
    ],
    run: async (context, input) => {
      const result = await requireControlPlane(context.runtime).adoptProviderRecords(
        String(input.zone), String(input.view), context.actor, expectedRevisionOf(input),
      );
      return { zone: result.zone.name, revision: result.zone.revision, adopted: result.adopted };
    },
  },
  {
    name: "zone delete",
    summary: "Delete a zone and withdraw the records Parallax published for it",
    role: "admin",
    options: [
      ZONE,
      EXPECTED,
      { name: "abandonProviderRecords", summary: "Leave published records at the provider", type: "boolean" },
    ],
    run: ({ runtime, actor }, input) => requireControlPlane(runtime).deleteZone(
      String(input.zone),
      actor,
      expectedRevisionOf(input),
      { abandonProviderRecords: input.abandonProviderRecords === true },
    ),
  },
  {
    name: "zone replace",
    summary: "Replace a zone's complete desired state",
    role: "editor",
    options: [ZONE, { name: "desired", summary: "Desired state as JSON", type: "json", required: true }, EXPECTED],
    run: ({ runtime, actor }, input) => requireControlPlane(runtime).replaceDesiredState(
      String(input.zone), input.desired, actor, expectedRevisionOf(input),
    ),
  },
  {
    name: "record set",
    summary: "Create or replace one record in a view",
    role: "editor",
    options: [
      ZONE,
      { ...VIEW, required: true },
      { name: "id", summary: "Record identifier", required: true },
      { name: "record", summary: "Record body as JSON", type: "json", required: true },
      EXPECTED,
    ],
    run: ({ runtime, actor }, input) => requireControlPlane(runtime).upsertRecord(
      String(input.zone), String(input.view), String(input.id), input.record, actor, expectedRevisionOf(input),
    ),
  },
  {
    name: "record delete",
    summary: "Remove one record from a view",
    role: "editor",
    options: [ZONE, { ...VIEW, required: true }, { name: "id", summary: "Record identifier", required: true }, EXPECTED],
    run: ({ runtime, actor }, input) => requireControlPlane(runtime).deleteRecord(
      String(input.zone), String(input.view), String(input.id), actor, expectedRevisionOf(input),
    ),
  },
  {
    name: "preview",
    summary: "Compare desired and actual state without changing anything",
    role: "editor",
    options: [ZONE, VIEW, { name: "desired", summary: "Preview this desired state instead", type: "json" }],
    run: ({ runtime }, input) => requireControlPlane(runtime).preview(
      String(input.zone),
      input.view === undefined ? undefined : String(input.view),
      input.desired,
    ),
  },
  {
    name: "apply",
    summary: "Reconcile a zone's providers with its desired state",
    role: "editor",
    options: [ZONE, VIEW, EXPECTED],
    run: ({ runtime }, input) => requireControlPlane(runtime).apply(
      String(input.zone),
      input.view === undefined ? undefined : String(input.view),
      expectedRevisionOf(input),
    ),
  },
  {
    name: "status",
    summary: "Show how far each view has been applied",
    role: "viewer",
    options: [ZONE],
    run: ({ runtime }, input) => requireControlPlane(runtime).status(String(input.zone)),
  },
  {
    name: "history",
    summary: "Read the audit trail, newest first",
    role: "viewer",
    options: [{ ...ZONE, required: false }, ...PAGING],
    run: ({ runtime }, input) => requireControlPlane(runtime).audit(
      input.zone === undefined ? undefined : String(input.zone),
      page(input),
    ),
  },
  {
    name: "revision list",
    summary: "List stored revision snapshots",
    role: "viewer",
    options: [ZONE, ...PAGING],
    run: ({ runtime }, input) => requireControlPlane(runtime).listRevisions(String(input.zone), page(input)),
  },
  {
    name: "revision get",
    summary: "Show one revision snapshot",
    role: "viewer",
    options: [ZONE, { name: "revision", summary: "Revision number", type: "number", required: true }],
    run: ({ runtime }, input) => requireControlPlane(runtime).getRevision(String(input.zone), Number(input.revision)),
  },
  {
    name: "revision restore",
    summary: "Restore a snapshot as a new revision",
    role: "editor",
    options: [
      ZONE,
      { name: "revision", summary: "Revision number", type: "number", required: true },
      { name: "expectedRevision", summary: "Fail unless the zone is at this revision", type: "number" },
    ],
    run: ({ runtime, actor }, input) => requireControlPlane(runtime).restoreRevision(
      String(input.zone), Number(input.revision), actor, expectedRevisionOf(input),
    ),
  },
  {
    name: "migrate",
    summary: "Apply the database schema; safe to re-run",
    role: "admin",
    options: [{ name: "target", summary: `Which database: ${MIGRATION_TARGETS.join(" or ")}` }],
    run: async (context) => {
      const migrate = context.runtime.migrate;
      if (!migrate) throw new CommandUnavailableError("this process has no database to migrate");
      return migrate();
    },
  },
  {
    name: "settings get",
    summary: "Show the stored operational settings",
    role: "admin",
    options: [],
    run: async (context) => ({ settings: requireSettings(context).current() }),
  },
  {
    name: "settings set",
    summary: "Update stored settings; only the keys given change",
    role: "admin",
    options: [{ name: "values", summary: "Settings as JSON", type: "json", required: true }],
    run: async (context, input) => requireSettings(context).update(input.values),
  },
  {
    name: "token list",
    summary: "List access tokens without revealing them",
    role: "admin",
    options: [],
    run: async (context) => ({ tokens: requireAccessTokens(context).list() }),
  },
  {
    name: "token issue",
    summary: "Issue a token, returned exactly once",
    role: "admin",
    options: [
      { name: "subject", summary: "Who the token is for", required: true },
      { name: "role", summary: "admin, editor or viewer", required: true },
    ],
    run: (context, input) => requireAccessTokens(context).issue(input.subject, input.role),
  },
  {
    name: "token revoke",
    summary: "Revoke an issued token",
    role: "admin",
    options: [{ name: "id", summary: "Token identifier", required: true }],
    run: async (context, input) => {
      if (!await requireAccessTokens(context).revoke(String(input.id))) {
        throw new NotFoundError("access token was not found");
      }
      return { revoked: input.id };
    },
  },
  {
    name: "credential profile list",
    summary: "List reusable credential profiles",
    role: "admin",
    options: [],
    run: async (context) => ({ profiles: await requireCredentials(context).listProfiles() }),
  },
  {
    name: "credential profile get",
    summary: "Show one credential profile and the domains reusing it",
    role: "admin",
    options: [{ name: "name", summary: "Profile name", required: true }],
    run: async (context, input) => {
      const profile = await requireCredentials(context).getProfile(String(input.name));
      if (!profile) throw new NotFoundError("credential profile was not found");
      return profile;
    },
  },
  {
    name: "credential profile set",
    summary: "Create or rotate a credential profile",
    role: "admin",
    options: [
      { name: "name", summary: "Profile name", required: true },
      { name: "token", summary: "Provider API token", required: true },
      { name: "accountId", summary: "Provider account identifier" },
    ],
    run: (context, input) => requireCredentials(context).upsertProfile(String(input.name), {
      token: String(input.token),
      ...(input.accountId === undefined ? {} : { accountId: String(input.accountId) }),
    }),
  },
  {
    name: "credential profile delete",
    summary: "Delete a profile no apex domain uses",
    role: "admin",
    options: [{ name: "name", summary: "Profile name", required: true }],
    run: async (context, input) => {
      if (!await requireCredentials(context).deleteProfile(String(input.name))) {
        throw new NotFoundError("credential profile was not found");
      }
      return { deleted: input.name };
    },
  },
  {
    name: "credential profile test",
    summary: "Check a profile against the live provider",
    role: "admin",
    options: [
      { name: "name", summary: "Profile name", required: true },
      { name: "zone", summary: "Apex domain to read through", required: true },
      { name: "token", summary: "Test this token instead of the stored one" },
    ],
    run: async (context, input) => ({
      ok: true,
      profile: await requireCredentials(context).testProfile(
        String(input.name),
        String(input.zone),
        input.token === undefined ? undefined : String(input.token),
      ),
    }),
  },
  {
    name: "credential zone list",
    summary: "List apex domains bound to a profile",
    role: "admin",
    options: [],
    run: async (context) => ({ credentials: await requireCredentials(context).listZones() }),
  },
  {
    name: "credential zone get",
    summary: "Show one apex domain's provider binding",
    role: "admin",
    options: [ZONE],
    run: async (context, input) => {
      const binding = await requireCredentials(context).getZone(String(input.zone));
      if (!binding) throw new NotFoundError("Cloudflare credential was not found");
      return binding;
    },
  },
  {
    name: "credential zone set",
    summary: "Bind an apex domain to a profile and zone id",
    role: "admin",
    options: [
      ZONE,
      { name: "profile", summary: "Credential profile to reuse" },
      { name: "token", summary: "Inline token, stored as a profile named after the zone" },
      { name: "accountId", summary: "Account identifier for an inline token" },
    ],
    run: async (context, input) => {
      const credentials = requireCredentials(context);
      const zone = String(input.zone);
      if (input.profile !== undefined) {
        return credentials.bindZone(zone, { profile: String(input.profile) });
      }
      if (input.token === undefined) {
        throw new DomainValidationError(["--profile or --token is required"]);
      }
      // A single-zone setup should not have to name a profile it will never
      // reuse, so an inline token becomes a profile named after the zone.
      const profile = zone.trim().toLowerCase().replace(/\.$/u, "").replace(/\./gu, "-");
      await credentials.upsertProfile(profile, {
        token: String(input.token),
        ...(input.accountId === undefined ? {} : { accountId: String(input.accountId) }),
      });
      return credentials.bindZone(zone, { profile });
    },
  },
  {
    name: "credential zone delete",
    summary: "Remove an apex domain's provider binding",
    role: "admin",
    options: [ZONE],
    run: async (context, input) => {
      if (!await requireCredentials(context).unbindZone(String(input.zone))) {
        throw new NotFoundError("Cloudflare credential was not found");
      }
      return { unbound: input.zone };
    },
  },
  {
    name: "credential zone test",
    summary: "Check an apex domain's credential against the live provider",
    role: "admin",
    options: [
      ZONE,
      { name: "profile", summary: "Test this profile before binding the domain to it" },
      { name: "token", summary: "Test this token instead of the stored one" },
      { name: "accountId", summary: "Account identifier for an unsaved credential" },
    ],
    run: async (context, input) => ({
      ok: true,
      credential: await requireCredentials(context).test(
        String(input.zone),
        unsavedCredentialFor(input),
      ),
    }),
  },
];
