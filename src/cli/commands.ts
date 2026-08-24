import { TOKEN_REFRESH_INTERVAL_MS, type AccessTokenService } from "../application/access-tokens.ts";
import { exportBackup, importBackup, readBackupDocument, type BackupStores } from "../application/backup.ts";
import type { CloudflareCredentialManager } from "../application/cloudflare-credentials.ts";
import { fallbackCoverage, overridableZones, type FallbackDomainService } from "../application/fallback-domains.ts";
import { NotFoundError, type ControlPlane, type RecordQuery } from "../application/control-plane.ts";
import type { SettingsService } from "../application/settings.ts";
import { DomainValidationError } from "../domain/dns.ts";
import { buildOpenApiDocument } from "../http/openapi.ts";
import { MIGRATION_TARGETS, type MigrationRun } from "../infrastructure/migrations.ts";
import { ROLES, type Role } from "../security/http-authorization.ts";

/**
 * What a command may reach. A server supplies all of it; a test or a reduced
 * deployment may omit a service, and the commands that need it say so.
 */
export interface CommandRuntime {
  /** Absent only while bootstrapping a store that does not exist yet. */
  readonly controlPlane?: ControlPlane;
  /** Present only on a runtime the command line built. See `requireStores`. */
  readonly stores?: BackupStores;
  readonly settings?: SettingsService;
  readonly accessTokens?: AccessTokenService;
  readonly credentials?: CloudflareCredentialManager;
  readonly fallbackDomains?: FallbackDomainService;
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

export class UnknownCommandError extends Error {
  override readonly name = "UnknownCommandError";
}
export class CommandPermissionError extends Error {
  override readonly name = "CommandPermissionError";
}
/** The runtime lacks the service this command needs, e.g. no credential key. */
export class CommandUnavailableError extends Error {
  override readonly name = "CommandUnavailableError";
}

export function satisfiesRole(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
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

/** An option the caller may omit entirely, distinguished from one left empty. */
function optionalText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? undefined : text;
}

/** A comma-separated option, with the empty case meaning "none given". */
function splitList(value: unknown): string[] {
  return typeof value === "string"
    ? value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")
    : [];
}

/**
 * The apexes bound to one credential profile that this process actually answers
 * for -- which is what its overrides must cover, and nothing more.
 *
 * The listener leaves a zone with an empty internal view out of its snapshot, so
 * it claims no authority for it and the query goes upstream. Sending devices
 * here for such a zone buys nothing and costs a dependency: their mail domain
 * would resolve through this process for no reason, and stop resolving with it.
 *
 * So both sides read the same rule from the same function rather than agreeing
 * by hand. A zone that stops being served stops being pointed at, in the same
 * revision, without anybody remembering to do it.
 */
async function profileZones(context: CommandContext, profile: string): Promise<string[]> {
  const bindings = await requireCredentials(context).listZones();
  return overridableZones(bindings, await requireControlPlane(context.runtime).listZones(), profile);
}

function requireFallbackDomains(context: CommandContext): FallbackDomainService {
  const service = context.runtime.fallbackDomains;
  if (!service) {
    throw new CommandUnavailableError("provider credentials are unavailable; set PARALLAX_CREDENTIAL_MASTER_KEY");
  }
  return service;
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

/**
 * The repositories, which only the command line is given.
 *
 * `createRuntime` withholds them unless asked, so this is not a role check that
 * could be got round -- over HTTP the field is simply not there.
 */
function requireStores(runtime: CommandRuntime): BackupStores {
  if (!runtime.stores) {
    throw new CommandUnavailableError(
      "backup and restore run on the command line only; they reach the store directly, past every rule the API enforces",
    );
  }
  return runtime.stores;
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

/** The listing filters, left out entirely when the caller named none of them. */
function recordQuery(input: CommandInput): RecordQuery {
  return {
    ...(input.view === undefined ? {} : { view: String(input.view) }),
    ...(input.name === undefined ? {} : { name: String(input.name) }),
    ...(input.type === undefined ? {} : { type: String(input.type) }),
    ...(input.content === undefined ? {} : { content: String(input.content) }),
    ...(input.proxied === undefined ? {} : { proxied: input.proxied === true }),
    ...(input.search === undefined ? {} : { search: String(input.search) }),
  };
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
    summary: "List zones and their desired revisions",
    role: "viewer",
    options: PAGING,
    run: ({ runtime }, input) => requireControlPlane(runtime).listZonePage(page(input)),
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
      { name: "dryRun", summary: "Report what adopting would do, and change nothing", type: "boolean" },
    ],
    run: async (context, input) => {
      const result = await requireControlPlane(context.runtime).adoptProviderRecords(
        String(input.zone), String(input.view), context.actor, expectedRevisionOf(input), input.dryRun === true,
      );
      // Everything the operation decided, not a subset of it. `refreshed` and
      // `warnings` were dropped here, so a locked record brought back into line
      // was reported nowhere and adoption's effect on what this process answers
      // for could not reach a terminal at all.
      return {
        zone: result.zone.name,
        revision: result.zone.revision,
        seen: result.seen,
        adopted: result.adopted,
        refreshed: result.refreshed,
        warnings: result.warnings,
      };
    },
  },
  {
    name: "zone delete",
    summary: "Delete a zone and withdraw the records Parallax published for it",
    role: "admin",
    options: [
      ZONE,
      EXPECTED,
      { name: "abandonProviderRecords", summary: "Abandon only provider targets that cannot be read; withdraw every reachable target", type: "boolean" },
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
    name: "record list",
    summary: "List a zone's records, narrowed by view, name, type or content",
    role: "viewer",
    options: [
      ZONE,
      VIEW,
      { name: "name", summary: "Owner name exactly, @ for the apex" },
      { name: "type", summary: "Record type, e.g. A or TXT" },
      { name: "content", summary: "Substring of the record's content" },
      { name: "proxied", summary: "Only records that are, or are not, proxied", type: "boolean" },
      { name: "search", summary: "Substring of either the name or the content" },
      ...PAGING,
    ],
    run: ({ runtime }, input) => requireControlPlane(runtime).listRecords(
      String(input.zone), recordQuery(input), page(input),
    ),
  },
  {
    name: "record get",
    summary: "Read one record",
    role: "viewer",
    options: [ZONE, { ...VIEW, required: true }, { name: "id", summary: "Record identifier", required: true }],
    run: ({ runtime }, input) => requireControlPlane(runtime).getRecord(
      String(input.zone), String(input.view), String(input.id),
    ),
  },
  {
    name: "record create",
    summary: "Add one record, deriving an identifier when none is given",
    role: "editor",
    options: [
      ZONE,
      { ...VIEW, required: true },
      { name: "record", summary: "Record body as JSON; may carry its own id", type: "json", required: true },
      EXPECTED,
    ],
    run: ({ runtime, actor }, input) => requireControlPlane(runtime).createRecord(
      String(input.zone), String(input.view), input.record, actor, expectedRevisionOf(input),
    ),
  },
  {
    name: "record patch",
    summary: "Change only the named fields of one record",
    role: "editor",
    options: [
      ZONE,
      { ...VIEW, required: true },
      { name: "id", summary: "Record identifier", required: true },
      { name: "record", summary: "Fields to change as JSON; null removes an optional one", type: "json", required: true },
      EXPECTED,
    ],
    run: ({ runtime, actor }, input) => requireControlPlane(runtime).patchRecord(
      String(input.zone), String(input.view), String(input.id), input.record, actor, expectedRevisionOf(input),
    ),
  },
  {
    name: "record batch",
    summary: "Apply deletes, patches, puts and posts to one view as a single revision",
    role: "editor",
    options: [
      ZONE,
      { ...VIEW, required: true },
      { name: "operations", summary: "{deletes,patches,puts,posts} as JSON", type: "json", required: true },
      EXPECTED,
    ],
    run: ({ runtime, actor }, input) => requireControlPlane(runtime).batchRecords(
      String(input.zone), String(input.view), input.operations, actor, expectedRevisionOf(input),
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
    run: ({ runtime, actor }, input) => requireControlPlane(runtime).apply(
      String(input.zone),
      input.view === undefined ? undefined : String(input.view),
      expectedRevisionOf(input),
      actor,
    ),
  },
  {
    name: "apply pending",
    summary: "Apply every pending zone; use --retryFailed to explicitly retry failed zones",
    role: "editor",
    options: [{ name: "retryFailed", summary: "Also retry zones whose previous provider apply failed", type: "boolean" }],
    run: ({ runtime, actor }, input) => requireControlPlane(runtime).applyPending(actor, input.retryFailed === true),
  },
  {
    name: "zone export",
    summary: "Write a view as a presentation-format zone file",
    role: "viewer",
    options: [ZONE, VIEW],
    run: async ({ runtime }, input) => ({
      zone: String(input.zone),
      view: input.view === undefined ? "external" : String(input.view),
      text: await requireControlPlane(runtime).exportZoneFile(
        String(input.zone),
        input.view === undefined ? "external" : String(input.view),
      ),
    }),
  },
  {
    name: "zone import",
    summary: "Replace one view from a presentation-format zone file",
    role: "editor",
    options: [
      ZONE,
      VIEW,
      EXPECTED,
      { name: "text", summary: "Zone file contents", required: true },
    ],
    run: ({ runtime, actor }, input) => requireControlPlane(runtime).importZoneFile(
      String(input.zone),
      input.view === undefined ? "external" : String(input.view),
      String(input.text),
      actor,
      expectedRevisionOf(input),
    ),
  },
  {
    name: "status",
    summary: "Show how far each view has been applied; without a zone, one line per zone",
    role: "viewer",
    // Optional like `history`'s, and for the same reason: a list wants one
    // request, not one per row.
    options: [{ ...ZONE, required: false }, ...PAGING],
    run: ({ runtime }, input) => input.zone === undefined
      ? requireControlPlane(runtime).statusOverview(page(input))
      : requireControlPlane(runtime).status(String(input.zone)),
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
    name: "openapi",
    summary: "Print the OpenAPI description of this control plane's HTTP API",
    role: "viewer",
    // Needs no runtime at all: the description is built out of this registry and
    // the security layer. So it answers from a checkout with nothing configured,
    // which is what a pipeline diffing the spec against a committed copy has.
    options: [],
    run: async () => buildOpenApiDocument(),
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
      { name: "expiresIn", summary: "Seconds until it stops working; omitted means never", type: "number" },
    ],
    run: async (context, input) => {
      const issued = await requireAccessTokens(context).issue(input.subject, input.role, input.expiresIn);
      // A server that is already running loaded its tokens at startup and
      // refreshes on an interval, so this one does not work the instant the
      // command returns. Saying so here is cheaper than reading a 401 as a
      // wrong token, which is what it looks like.
      return { ...issued, note: `A running server accepts this within ${TOKEN_REFRESH_INTERVAL_MS / 1000} seconds.` };
    },
  },
  {
    name: "token revoke",
    summary: "Revoke an issued token; a running server stops accepting it within seconds",
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
    name: "fallback list",
    summary: "Show the provider's client-side resolver overrides",
    role: "admin",
    options: [
      { name: "profile", summary: "Stored credential profile to authenticate with", required: true },
      { name: "policy", summary: "Device settings profile id; the account default when absent" },
    ],
    run: async (context, input) => ({
      domains: await requireFallbackDomains(context).list(String(input.profile), optionalText(input.policy)),
    }),
  },
  {
    name: "fallback set",
    summary: "Point one suffix at a resolver, leaving the rest of the list alone",
    role: "admin",
    options: [
      { name: "profile", summary: "Stored credential profile to authenticate with", required: true },
      { name: "suffix", summary: "Apex domain; every name beneath it is covered", required: true },
      { name: "dns-server", summary: "Comma-separated resolver addresses" },
      { name: "description", summary: "Shown in the provider's client UI" },
      { name: "policy", summary: "Device settings profile id; the account default when absent" },
    ],
    run: async (context, input) => await requireFallbackDomains(context).set(String(input.profile), {
      suffix: String(input.suffix),
      dnsServer: splitList(input["dns-server"]),
      ...(optionalText(input.description) ? { description: String(input.description) } : {}),
    }, optionalText(input.policy)),
  },
  {
    name: "fallback coverage",
    summary: "Say, for every zone held here, whether this profile's overrides cover it and why not",
    role: "admin",
    options: [
      { name: "profile", summary: "Stored credential profile to report against", required: true },
    ],
    // Reaches no provider on purpose. A zone missing from the overrides has
    // several possible reasons and they need different repairs, and the day an
    // operator asks is often the day the credential is the broken thing -- so
    // this answers without a token, an account id or a permission.
    run: async (context, input) => ({
      profile: String(input.profile),
      zones: fallbackCoverage(
        await requireCredentials(context).listZones(),
        await requireControlPlane(context.runtime).listZones(),
        String(input.profile),
      ),
    }),
  },
  {
    name: "fallback preview",
    summary: "Show what syncing the overrides with this profile's zones would change",
    role: "admin",
    options: [
      { name: "profile", summary: "Stored credential profile to authenticate with", required: true },
      { name: "policy", summary: "Device settings profile id; the account default when absent" },
    ],
    run: async (context, input) => await requireFallbackDomains(context)
      .plan(String(input.profile), await profileZones(context, String(input.profile)),
        requireSettings(context).current().fallbackResolver, optionalText(input.policy)),
  },
  {
    name: "fallback sync",
    summary: "Make the overrides match this profile's zones, touching nothing else",
    role: "admin",
    options: [
      { name: "profile", summary: "Stored credential profile to authenticate with", required: true },
      { name: "policy", summary: "Device settings profile id; the account default when absent" },
    ],
    run: async (context, input) => await requireFallbackDomains(context)
      .sync(String(input.profile), await profileZones(context, String(input.profile)),
        requireSettings(context).current().fallbackResolver, optionalText(input.policy)),
  },
  {
    name: "fallback delete",
    summary: "Remove one suffix from the override list",
    role: "admin",
    options: [
      { name: "profile", summary: "Stored credential profile to authenticate with", required: true },
      { name: "suffix", summary: "Apex domain to stop overriding", required: true },
      { name: "policy", summary: "Device settings profile id; the account default when absent" },
    ],
    run: async (context, input) => await requireFallbackDomains(context)
      .remove(String(input.profile), String(input.suffix), optionalText(input.policy)),
  },
  {
    name: "backup",
    summary: "Write everything this store holds as one document",
    role: "admin",
    options: [],
    run: ({ runtime }) => exportBackup(requireStores(runtime)),
  },
  {
    name: "restore",
    summary: "Load a backup document into an empty store, from another backend or the same one",
    role: "admin",
    options: [{
      name: "document",
      summary: "The backup document as JSON. Omit on the command line to read it from stdin",
      type: "json",
      required: true,
    }],
    run: ({ runtime }, input) => importBackup(requireStores(runtime), readBackupDocument(input.document)),
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
