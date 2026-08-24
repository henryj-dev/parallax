import { AUDIT_ACTIONS, MANAGING_SERVICES, PROVIDER_VIEWS, RECORD_TYPES } from "../domain/dns.ts";
import { findCommand, type CommandOption } from "../cli/commands.ts";
import { MAX_BATCH_OPERATIONS } from "../application/control-plane.ts";
import { authorize, ROLES, type Role } from "../security/http-authorization.ts";

/**
 * The OpenAPI description of this control plane's HTTP surface.
 *
 * A description of the routes is a second copy of the routes, and this
 * repository has been burned by two copies that could not be compared. So as
 * little as possible is written down here twice:
 *
 * - the summary of an operation is read out of the command registry, never
 *   copied, so the API and the command line say the same sentence;
 * - the role an operation needs is *computed* from the two gates that actually
 *   enforce it -- the command's declared minimum and `authorize` -- rather than
 *   asserted here, so a spec that says `editor` cannot outlive a route that
 *   quietly became admin-only;
 * - every enumeration comes from the constant the domain already exports.
 *
 * What is left is the shape of the routes themselves, and that is what
 * `test/http/openapi.test.ts` walks: each operation carries a concrete `sample`
 * request, and the test asserts the real router resolves it to the command
 * named here. A path documented that nothing serves, or a method the router
 * does not take, fails there rather than in somebody's generated client.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type JsonSchema = Record<string, unknown>;

/**
 * Where an operation is answered, which decides what can be proven about it.
 *
 * `command` operations go through the route dispatcher, so the router can be
 * asked which command they reach. `process` operations are answered before the
 * dispatcher -- by the security layer or by the server itself -- so the only
 * thing the test can assert about them is that the dispatcher does *not* also
 * claim their path, which is what a collision would look like.
 */
export type OperationSource =
  | { readonly kind: "command"; readonly command: string }
  /**
   * `POST /cli`, which reaches whatever command its body names. There is no one
   * command to read a summary or a role out of, so both are written here -- and
   * `sampleCommand` is what the router must resolve the sample body to.
   */
  | { readonly kind: "dispatch"; readonly summary: string; readonly access: string; readonly sampleCommand: string }
  | { readonly kind: "process"; readonly summary: string; readonly access: string };

export interface DocumentedParameter {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly description: string;
  readonly required?: boolean;
  readonly schema: JsonSchema;
}

export interface DocumentedResponse {
  readonly status: number;
  readonly description: string;
  readonly schema?: JsonSchema;
  /** A non-JSON body, e.g. Prometheus text. */
  readonly mediaType?: string;
}

export interface DocumentedOperation {
  readonly method: HttpMethod;
  /** The OpenAPI path template, from the root: `/api/v1/zones/{zone}`. */
  readonly path: string;
  readonly tag: string;
  readonly source: OperationSource;
  readonly description?: string;
  /** A concrete request the router has to resolve to this operation. */
  readonly sample: { readonly path: string; readonly body?: Record<string, unknown> };
  readonly parameters?: readonly DocumentedParameter[];
  readonly requestBody?: { readonly description: string; readonly schema: JsonSchema; readonly required?: boolean };
  readonly success: DocumentedResponse;
  /** Beyond the ones every operation can answer. */
  readonly errors?: readonly number[];
}

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (schema: JsonSchema): JsonSchema => ({ type: "array", items: schema });

const ZONE_PARAM: DocumentedParameter = {
  name: "zone", in: "path", required: true, description: "Apex domain, e.g. `example.com`.", schema: { type: "string" },
};
const VIEW_PATH_PARAM: DocumentedParameter = {
  name: "view", in: "path", required: true, description: "Which horizon this record belongs to.", schema: ref("View"),
};
const VIEW_QUERY_PARAM: DocumentedParameter = {
  name: "view", in: "query", description: "Limit to one view. Both are addressed when it is absent.", schema: ref("View"),
};
const RECORD_ID_PARAM: DocumentedParameter = {
  name: "id", in: "path", required: true, description: "Record identifier, unique within its view.", schema: ref("RecordId"),
};
const IF_MATCH_PARAM: DocumentedParameter = {
  name: "If-Match",
  in: "header",
  description:
    "The zone revision this write expects, quoted: `\"7\"`. The request is refused with `409` when the zone has moved on. "
    + "Every write answers with the new revision in an `ETag`, so it can be carried straight into the next one.",
  schema: { type: "string", pattern: '^"[1-9][0-9]*"$' },
};
const PAGING_PARAMS: readonly DocumentedParameter[] = [
  { name: "limit", in: "query", description: "Entries per page, 1 to 500. Defaults to 50.", schema: { type: "integer", minimum: 1, maximum: 500, default: 50 } },
  { name: "offset", in: "query", description: "Entries to skip.", schema: { type: "integer", minimum: 0, default: 0 } },
];

const RECORD_FILTER_PARAMS: readonly DocumentedParameter[] = [
  { name: "name", in: "query", description: "Owner name exactly as stored: `@` for the apex, otherwise relative.", schema: { type: "string" } },
  { name: "type", in: "query", description: "Record type. A type the control plane does not know is refused rather than answered with an empty page.", schema: ref("RecordType") },
  { name: "content", in: "query", description: "Case-insensitive substring of the record's canonical content.", schema: { type: "string" } },
  { name: "proxied", in: "query", description: "Only records that are, or are not, proxied.", schema: { type: "boolean" } },
  { name: "search", in: "query", description: "Case-insensitive substring of either the name or the content.", schema: { type: "string" } },
];

const RECORD_FIELDS: JsonSchema = {
  name: { type: "string", description: "`@` for the apex, otherwise a relative name beneath the zone." },
  type: ref("RecordType"),
  content: { type: "string", description: "RDATA in presentation format, validated against the type's grammar." },
  ttl: { type: "integer", minimum: 1, maximum: 2_147_483_647, description: "Seconds. Forced to 1 (Cloudflare's Auto) on a proxied record." },
  proxied: { type: "boolean", description: "External view only, and only for A, AAAA and CNAME." },
  acknowledgeNonGlobalIp: {
    type: "boolean",
    description: "Required to publish a non-global address in the external view, after reviewing the exposure.",
  },
};

const SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  Error: {
    type: "object",
    required: ["error", "message"],
    properties: {
      error: { type: "string", description: "A stable machine-readable code, e.g. `validation_failed` or `conflict`." },
      message: { type: "string", description: "One sentence naming what the caller has to change. Never carries a credential." },
      issues: { ...arrayOf({ type: "string" }), description: "Present on a validation failure: every problem found, not only the first." },
    },
  },
  Role: { type: "string", enum: [...ROLES] },
  View: { type: "string", enum: [...PROVIDER_VIEWS], description: "The only two views a provider can reconcile." },
  RecordType: { type: "string", enum: [...RECORD_TYPES] },
  RecordId: {
    type: "string",
    pattern: "^[a-z0-9][a-z0-9_-]{0,35}$",
    description: "1 to 36 characters of lowercase letters, digits, `_` or `-`, starting with a letter or digit.",
  },
  ManagedByService: {
    type: "object",
    required: ["service", "resource"],
    description: "Set by adoption when a provider service owns this name. Never set by an operator, and locks the record's name, type and content.",
    properties: {
      service: { type: "string", enum: [...MANAGING_SERVICES] },
      resource: { type: "string", description: "The worker script or bucket this record stands for." },
    },
  },
  DesiredRecord: {
    type: "object",
    required: ["id", "name", "type", "content", "ttl"],
    properties: { id: ref("RecordId"), ...RECORD_FIELDS, managedBy: ref("ManagedByService") },
  },
  LocatedRecord: {
    allOf: [ref("DesiredRecord"), {
      type: "object",
      required: ["zone", "view"],
      description: "A record id is unique only within one view, so a listing that spans views says which one each came from.",
      properties: { zone: { type: "string" }, view: ref("View") },
    }],
  },
  RecordInput: {
    type: "object",
    required: ["name", "type", "content", "ttl"],
    properties: {
      id: { ...ref("RecordId"), description: "Optional. Refused with `409` when it is taken; derived from the name and type when absent." },
      ...RECORD_FIELDS,
    },
  },
  RecordPatch: {
    type: "object",
    description:
      "Only the fields named here change; every other one is left as stored. `null` removes an optional field, "
      + "which is the only way to say \"stop proxying\" -- leaving a field out means leaving it alone. `id` is not patchable.",
    properties: RECORD_FIELDS,
  },
  RecordBatch: {
    type: "object",
    description:
      `Applied in the order below as one revision, at most ${MAX_BATCH_OPERATIONS} operations. `
      + "Deletes run first, so a batch may free a name and reuse it. One refused operation leaves the zone exactly as it was.",
    properties: {
      deletes: arrayOf({ type: "object", required: ["id"], properties: { id: ref("RecordId") } }),
      patches: arrayOf({ allOf: [{ type: "object", required: ["id"], properties: { id: ref("RecordId") } }, ref("RecordPatch")] }),
      puts: arrayOf({ allOf: [{ type: "object", required: ["id"], properties: { id: ref("RecordId") } }, ref("RecordInput")] }),
      posts: arrayOf(ref("RecordInput")),
    },
  },
  DnsView: {
    type: "object",
    required: ["name", "records"],
    properties: { name: ref("View"), records: arrayOf(ref("DesiredRecord")) },
  },
  Zone: {
    type: "object",
    required: ["name", "revision", "views", "createdAt", "updatedAt"],
    properties: {
      name: { type: "string" },
      revision: { type: "integer", minimum: 1, description: "Rises by one on every committed change. Also sent as the `ETag`." },
      views: arrayOf(ref("DnsView")),
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  RecordResult: {
    type: "object",
    required: ["record", "revision"],
    properties: { record: ref("LocatedRecord"), revision: { type: "integer" } },
  },
  RecordBatchResult: {
    type: "object",
    required: ["records", "deleted", "revision"],
    properties: {
      records: { ...arrayOf(ref("LocatedRecord")), description: "Every record the batch created or changed, as it now stands." },
      deleted: arrayOf(ref("RecordId")),
      revision: { type: "integer" },
    },
  },
  RecordPage: {
    type: "object",
    required: ["records", "limit", "offset", "hasMore", "total", "revision"],
    properties: {
      records: arrayOf(ref("LocatedRecord")),
      limit: { type: "integer" },
      offset: { type: "integer" },
      hasMore: { type: "boolean" },
      total: { type: "integer", description: "Matches before paging, so a caller knows whether to ask for more." },
      revision: { type: "integer", description: "The zone revision these records were read at." },
    },
  },
  ZonePage: {
    type: "object",
    required: ["zones", "limit", "offset", "hasMore"],
    properties: { zones: arrayOf(ref("Zone")), limit: { type: "integer" }, offset: { type: "integer" }, hasMore: { type: "boolean" } },
  },
  RevisionPage: {
    type: "object",
    required: ["revisions", "limit", "offset", "hasMore"],
    properties: { revisions: arrayOf(ref("Zone")), limit: { type: "integer" }, offset: { type: "integer" }, hasMore: { type: "boolean" } },
  },
  AuditEntry: {
    type: "object",
    required: ["id", "zone", "revision", "action", "actor", "at", "detail"],
    properties: {
      id: { type: "integer" },
      zone: { type: "string" },
      revision: { type: "integer" },
      action: { type: "string", enum: [...AUDIT_ACTIONS] },
      actor: { type: "string", description: "Who the security layer said made the change. A caller cannot choose it." },
      at: { type: "string", format: "date-time" },
      detail: { type: "object", additionalProperties: true },
      added: { type: "integer", description: "Records this revision added, derived from the snapshots it carries." },
      removed: { type: "integer" },
      changed: { type: "integer" },
    },
  },
  AuditPage: {
    type: "object",
    required: ["entries", "limit", "offset", "hasMore"],
    properties: { entries: arrayOf(ref("AuditEntry")), limit: { type: "integer" }, offset: { type: "integer" }, hasMore: { type: "boolean" } },
  },
  ApplyStatus: {
    type: "object",
    required: ["zone", "view", "desiredRevision", "appliedRevision", "state"],
    properties: {
      zone: { type: "string" },
      view: { type: "string" },
      desiredRevision: { type: "integer" },
      appliedRevision: { type: "integer" },
      state: { type: "string", enum: ["pending", "applied", "failed"] },
      lastAttemptAt: { type: "string", format: "date-time" },
      error: { type: "string" },
      completedOperations: { type: "integer", description: "On a failure, how many of the plan's operations the provider had already accepted." },
      plannedOperations: { type: "integer" },
    },
  },
  ZoneStatus: {
    type: "object",
    required: ["zone", "desiredRevision", "statuses"],
    properties: { zone: { type: "string" }, desiredRevision: { type: "integer" }, statuses: arrayOf(ref("ApplyStatus")) },
  },
  StatusOverview: {
    type: "object",
    required: ["zones", "limit", "offset", "hasMore"],
    properties: {
      zones: arrayOf({
        type: "object",
        required: ["zone", "desiredRevision", "state"],
        properties: { zone: { type: "string" }, desiredRevision: { type: "integer" }, state: { type: "string" } },
      }),
      limit: { type: "integer" }, offset: { type: "integer" }, hasMore: { type: "boolean" },
    },
  },
  AccessTokenMetadata: {
    type: "object",
    required: ["id", "subject", "role", "createdAt", "managed"],
    description: "Identifies a token without revealing it. Tokens are stored only as digests.",
    properties: {
      id: { type: "string" },
      subject: { type: "string", description: "Who the token is for. Recorded as the actor of its changes." },
      role: ref("Role"),
      createdAt: { type: "string", format: "date-time" },
      managed: { type: "boolean", description: "True for a token supplied by the environment, which this API cannot revoke." },
    },
  },
  IssuedAccessToken: {
    type: "object",
    required: ["token", "metadata"],
    description: "The only time the token itself is ever returned. It cannot be read back afterwards.",
    properties: { token: { type: "string" }, metadata: ref("AccessTokenMetadata") },
  },
  ZoneFile: {
    type: "object",
    required: ["zone", "view", "text"],
    properties: { zone: { type: "string" }, view: ref("View"), text: { type: "string", description: "Presentation-format zone file." } },
  },
  /**
   * Deliberately loose. These are reported as whole objects whose shape depends
   * on the provider and the plan, and a precise-looking schema for something
   * this file has not pinned down would be a more confident lie than `object`.
   */
  Opaque: { type: "object", additionalProperties: true },
};

/** Answered by any operation; listed once rather than on each of them. */
const COMMON_ERRORS: readonly number[] = [400, 401, 403, 404, 500];

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: "The request could not be read, or the desired state it carries is not valid. `issues` names every problem found.",
  401: "No credential was presented, or it is not one this deployment knows.",
  403: "The credential is valid and its role is not allowed here.",
  404: "No such route, zone, record, revision or credential.",
  409: "The zone has moved past the revision this write expected, the identifier is taken, or a provider service owns the record.",
  413: "The request body is larger than the route allows: 8 MiB where it carries a zone file, 1 MiB elsewhere.",
  429: "Too many failed authentication attempts from this client.",
  500: "An unexpected failure. The reason is deliberately withheld; the server log carries it.",
  502: "The provider was reached, or could not be, and said something the operator can act on.",
};

const OPERATIONS: readonly DocumentedOperation[] = [
  // ---- zones -------------------------------------------------------------
  {
    method: "GET", path: "/api/v1/zones", tag: "Zones",
    source: { kind: "command", command: "zone list" },
    sample: { path: "/api/v1/zones" },
    parameters: PAGING_PARAMS,
    success: { status: 200, description: "Zones in ascending name order, with their complete desired state.", schema: ref("ZonePage") },
  },
  {
    method: "POST", path: "/api/v1/zones", tag: "Zones",
    source: { kind: "command", command: "zone create" },
    sample: { path: "/api/v1/zones", body: { name: "example.com" } },
    requestBody: {
      description: "The apex domain to start tracking.", required: true,
      schema: { type: "object", required: ["name"], properties: { name: { type: "string", examples: ["example.com"] } } },
    },
    success: { status: 201, description: "The zone at revision 1, with no views yet.", schema: ref("Zone") },
    errors: [409],
  },
  {
    method: "GET", path: "/api/v1/zones/{zone}", tag: "Zones",
    source: { kind: "command", command: "zone get" },
    sample: { path: "/api/v1/zones/example.com" },
    parameters: [ZONE_PARAM],
    success: { status: 200, description: "The zone's complete desired state.", schema: ref("Zone") },
  },
  {
    method: "PUT", path: "/api/v1/zones/{zone}", tag: "Zones",
    source: { kind: "command", command: "zone replace" },
    description: "Replaces every view at once. To change one record, prefer the record routes.",
    sample: { path: "/api/v1/zones/example.com", body: { views: [] } },
    parameters: [ZONE_PARAM, IF_MATCH_PARAM],
    requestBody: {
      description: "The complete desired state. Views may be an array of `{name, records}` or an object keyed by view name.",
      required: true,
      schema: { type: "object", required: ["views"], properties: { views: arrayOf(ref("DnsView")) } },
    },
    success: { status: 200, description: "The zone at its new revision.", schema: ref("Zone") },
    errors: [409],
  },
  {
    method: "DELETE", path: "/api/v1/zones/{zone}", tag: "Zones",
    source: { kind: "command", command: "zone delete" },
    description:
      "Withdraws every record Parallax published for the zone before removing the desired state. Withdrawal happens first: "
      + "if the provider refuses or cannot be reached the zone is kept, so the deletion can be retried rather than leaving "
      + "published records nothing tracks.",
    sample: { path: "/api/v1/zones/example.com" },
    parameters: [ZONE_PARAM, IF_MATCH_PARAM, {
      name: "abandonProviderRecords", in: "query",
      description:
        "Leave live only the provider targets that cannot be read, and report them as `abandonedProviderTargets`. "
        + "Every reachable target is still withdrawn. Use only when a provider may be gone for good.",
      schema: { type: "boolean" },
    }],
    success: {
      status: 200,
      description: "What was taken out of the provider, so the blast radius of the deletion is visible.",
      schema: {
        type: "object",
        required: ["zone", "removedProviderRecords", "abandonedProviderTargets"],
        properties: {
          zone: { type: "string" },
          removedProviderRecords: arrayOf(ref("Opaque")),
          abandonedProviderTargets: arrayOf({ type: "object", properties: { view: { type: "string" }, target: { type: "string" } } }),
        },
      },
    },
    errors: [409, 502],
  },

  // ---- records -----------------------------------------------------------
  {
    method: "GET", path: "/api/v1/zones/{zone}/records", tag: "Records",
    source: { kind: "command", command: "record list" },
    description: "Reads across every view, so a caller synchronising a zone need not know how many views it has.",
    sample: { path: "/api/v1/zones/example.com/records" },
    parameters: [ZONE_PARAM, VIEW_QUERY_PARAM, ...RECORD_FILTER_PARAMS, ...PAGING_PARAMS],
    success: { status: 200, description: "Matching records, each carrying the view it came from.", schema: ref("RecordPage") },
  },
  {
    method: "GET", path: "/api/v1/zones/{zone}/views/{view}/records", tag: "Records",
    source: { kind: "command", command: "record list" },
    description: "The same filters, scoped to one view. A `view` in the query string cannot widen it.",
    sample: { path: "/api/v1/zones/example.com/views/external/records" },
    parameters: [ZONE_PARAM, VIEW_PATH_PARAM, ...RECORD_FILTER_PARAMS, ...PAGING_PARAMS],
    success: { status: 200, description: "Matching records in that view.", schema: ref("RecordPage") },
  },
  {
    method: "POST", path: "/api/v1/zones/{zone}/views/{view}/records", tag: "Records",
    source: { kind: "command", command: "record create" },
    description:
      "Creating is not replacing: an `id` that is taken is refused rather than overwritten. Without one the id is derived "
      + "from the name and type, so `api`/`A` becomes `api-a`.",
    sample: { path: "/api/v1/zones/example.com/views/external/records", body: { name: "api", type: "A", content: "8.8.8.30", ttl: 60 } },
    parameters: [ZONE_PARAM, VIEW_PATH_PARAM, IF_MATCH_PARAM],
    requestBody: { description: "The record to add.", required: true, schema: ref("RecordInput") },
    success: { status: 201, description: "The record as stored, with the identifier it was given.", schema: ref("RecordResult") },
    errors: [409],
  },
  {
    method: "POST", path: "/api/v1/zones/{zone}/views/{view}/records/batch", tag: "Records",
    source: { kind: "command", command: "record batch" },
    description:
      "Several changes as one revision. Sending them one at a time is not the same thing: each request is its own revision "
      + "and its own provider apply, so moving a service between addresses publishes an intermediate state that was never desired.",
    sample: { path: "/api/v1/zones/example.com/views/external/records/batch", body: { deletes: [{ id: "www" }] } },
    parameters: [ZONE_PARAM, VIEW_PATH_PARAM, IF_MATCH_PARAM],
    requestBody: { description: "The operations to apply.", required: true, schema: ref("RecordBatch") },
    success: { status: 200, description: "What the batch left behind, at the new revision.", schema: ref("RecordBatchResult") },
    errors: [409],
  },
  {
    method: "GET", path: "/api/v1/zones/{zone}/views/{view}/records/{id}", tag: "Records",
    source: { kind: "command", command: "record get" },
    sample: { path: "/api/v1/zones/example.com/views/external/records/www" },
    parameters: [ZONE_PARAM, VIEW_PATH_PARAM, RECORD_ID_PARAM],
    success: { status: 200, description: "The record and the revision it was read at.", schema: ref("RecordResult") },
  },
  {
    method: "PUT", path: "/api/v1/zones/{zone}/views/{view}/records/{id}", tag: "Records",
    source: { kind: "command", command: "record set" },
    description: "Creates or replaces the record at this identifier. The body is the whole record; use `PATCH` to change part of one.",
    sample: { path: "/api/v1/zones/example.com/views/external/records/www", body: { name: "www", type: "A", content: "8.8.8.11", ttl: 300 } },
    parameters: [ZONE_PARAM, VIEW_PATH_PARAM, RECORD_ID_PARAM, IF_MATCH_PARAM],
    requestBody: { description: "The record in full.", required: true, schema: ref("RecordInput") },
    success: { status: 200, description: "The zone at its new revision.", schema: ref("Zone") },
    errors: [409],
  },
  {
    method: "PATCH", path: "/api/v1/zones/{zone}/views/{view}/records/{id}", tag: "Records",
    source: { kind: "command", command: "record patch" },
    description:
      "The merge happens under the same zone lock as the commit, so two callers editing different fields of one record "
      + "cannot overwrite each other. The merged record is then validated whole -- a patch that would make the view illegal "
      + "is refused even when the patch itself looks fine.",
    sample: { path: "/api/v1/zones/example.com/views/external/records/www", body: { ttl: 120 } },
    parameters: [ZONE_PARAM, VIEW_PATH_PARAM, RECORD_ID_PARAM, IF_MATCH_PARAM],
    requestBody: { description: "The fields to change.", required: true, schema: ref("RecordPatch") },
    success: { status: 200, description: "The record as it now stands.", schema: ref("RecordResult") },
    errors: [409],
  },
  {
    method: "DELETE", path: "/api/v1/zones/{zone}/views/{view}/records/{id}", tag: "Records",
    source: { kind: "command", command: "record delete" },
    sample: { path: "/api/v1/zones/example.com/views/external/records/www" },
    parameters: [ZONE_PARAM, VIEW_PATH_PARAM, RECORD_ID_PARAM, IF_MATCH_PARAM],
    success: { status: 200, description: "The zone at its new revision.", schema: ref("Zone") },
    errors: [409],
  },

  // ---- reconciliation ----------------------------------------------------
  {
    method: "GET", path: "/api/v1/zones/{zone}/preview", tag: "Reconciliation",
    source: { kind: "command", command: "preview" },
    description:
      "Queries the live provider on every call, so it needs write-level trust even though it changes nothing. A view whose "
      + "provider cannot be read reports why beside an empty plan, rather than being read as nothing to do.",
    sample: { path: "/api/v1/zones/example.com/preview" },
    parameters: [ZONE_PARAM, VIEW_QUERY_PARAM],
    success: { status: 200, description: "The plan per view: what would be created, updated and removed.", schema: ref("Opaque") },
    errors: [502],
  },
  {
    method: "POST", path: "/api/v1/zones/{zone}/preview", tag: "Reconciliation",
    source: { kind: "command", command: "preview" },
    description: "Previews a desired state that has not been saved, so a change can be examined before it is committed.",
    sample: { path: "/api/v1/zones/example.com/preview", body: { views: [] } },
    parameters: [ZONE_PARAM, VIEW_QUERY_PARAM],
    requestBody: { description: "A desired state to plan against instead of the stored one.", schema: { type: "object", properties: { views: arrayOf(ref("DnsView")) } } },
    success: { status: 200, description: "The plan for the supplied desired state.", schema: ref("Opaque") },
    errors: [502],
  },
  {
    method: "POST", path: "/api/v1/zones/{zone}/apply", tag: "Reconciliation",
    source: { kind: "command", command: "apply" },
    sample: { path: "/api/v1/zones/example.com/apply" },
    parameters: [ZONE_PARAM, VIEW_QUERY_PARAM, IF_MATCH_PARAM],
    success: { status: 200, description: "The zone, with each view's outcome reported independently.", schema: ref("Opaque") },
    errors: [409, 502],
  },
  {
    method: "POST", path: "/api/v1/apply", tag: "Reconciliation",
    source: { kind: "command", command: "apply pending" },
    sample: { path: "/api/v1/apply" },
    parameters: [{ name: "retryFailed", in: "query", description: "Also retry zones whose previous provider apply failed.", schema: { type: "boolean" } }],
    success: { status: 200, description: "What was applied across every zone that had pending work.", schema: ref("Opaque") },
    errors: [502],
  },
  {
    method: "POST", path: "/api/v1/zones/{zone}/adopt", tag: "Reconciliation",
    source: { kind: "command", command: "zone adopt" },
    description:
      "Brings records that already exist at the provider into the desired state. Commits the view in one step, so a record "
      + "that cannot be described stops all of them and nothing is written.",
    sample: { path: "/api/v1/zones/example.com/adopt?view=external" },
    parameters: [ZONE_PARAM, { ...VIEW_QUERY_PARAM, required: true }, IF_MATCH_PARAM, {
      name: "dryRun", in: "query", description: "Report what adopting would do, and change nothing.", schema: { type: "boolean" },
    }],
    success: { status: 200, description: "What was adopted, refreshed, and any warnings.", schema: ref("Opaque") },
    errors: [409, 502],
  },
  {
    method: "GET", path: "/api/v1/status", tag: "Reconciliation",
    source: { kind: "command", command: "status" },
    description: "One line per zone, for a list that would otherwise ask once per row.",
    sample: { path: "/api/v1/status" },
    parameters: PAGING_PARAMS,
    success: { status: 200, description: "Each zone's desired revision and overall apply state.", schema: ref("StatusOverview") },
  },
  {
    method: "GET", path: "/api/v1/zones/{zone}/status", tag: "Reconciliation",
    source: { kind: "command", command: "status" },
    sample: { path: "/api/v1/zones/example.com/status" },
    parameters: [ZONE_PARAM],
    success: { status: 200, description: "How far each of the zone's views has been applied.", schema: ref("ZoneStatus") },
  },

  // ---- zone files --------------------------------------------------------
  {
    method: "GET", path: "/api/v1/zones/{zone}/export", tag: "Zone files",
    source: { kind: "command", command: "zone export" },
    sample: { path: "/api/v1/zones/example.com/export" },
    parameters: [ZONE_PARAM, VIEW_QUERY_PARAM],
    success: { status: 200, description: "The view as a presentation-format zone file.", schema: ref("ZoneFile") },
  },
  {
    method: "POST", path: "/api/v1/zones/{zone}/import", tag: "Zone files",
    source: { kind: "command", command: "zone import" },
    sample: { path: "/api/v1/zones/example.com/import", body: { text: "@ 300 IN A 8.8.8.8\n" } },
    parameters: [ZONE_PARAM, VIEW_QUERY_PARAM, IF_MATCH_PARAM],
    requestBody: {
      description: "A zone file. `view` may be given here instead of in the query string.", required: true,
      schema: { type: "object", required: ["text"], properties: { text: { type: "string" }, view: ref("View") } },
    },
    success: { status: 200, description: "The zone at its new revision.", schema: ref("Zone") },
    errors: [409],
  },

  // ---- history -----------------------------------------------------------
  {
    method: "GET", path: "/api/v1/history", tag: "History",
    source: { kind: "command", command: "history" },
    sample: { path: "/api/v1/history" },
    parameters: PAGING_PARAMS,
    success: { status: 200, description: "The audit trail across every zone, newest first.", schema: ref("AuditPage") },
  },
  {
    method: "GET", path: "/api/v1/zones/{zone}/history", tag: "History",
    source: { kind: "command", command: "history" },
    sample: { path: "/api/v1/zones/example.com/history" },
    parameters: [ZONE_PARAM, ...PAGING_PARAMS],
    success: { status: 200, description: "One zone's audit trail, newest first.", schema: ref("AuditPage") },
  },
  {
    method: "GET", path: "/api/v1/zones/{zone}/audit", tag: "History",
    source: { kind: "command", command: "history" },
    description: "An alias of `/history`, answering exactly the same thing.",
    sample: { path: "/api/v1/zones/example.com/audit" },
    parameters: [ZONE_PARAM, ...PAGING_PARAMS],
    success: { status: 200, description: "One zone's audit trail, newest first.", schema: ref("AuditPage") },
  },
  {
    method: "GET", path: "/api/v1/zones/{zone}/revisions", tag: "History",
    source: { kind: "command", command: "revision list" },
    sample: { path: "/api/v1/zones/example.com/revisions" },
    parameters: [ZONE_PARAM, ...PAGING_PARAMS],
    success: { status: 200, description: "Immutable snapshots, the newest window in ascending order.", schema: ref("RevisionPage") },
  },
  {
    method: "GET", path: "/api/v1/zones/{zone}/revisions/{revision}", tag: "History",
    source: { kind: "command", command: "revision get" },
    sample: { path: "/api/v1/zones/example.com/revisions/1" },
    parameters: [ZONE_PARAM, { name: "revision", in: "path", required: true, description: "Revision number.", schema: { type: "integer", minimum: 1 } }],
    success: { status: 200, description: "The zone exactly as it stood at that revision.", schema: ref("Zone") },
  },
  {
    method: "POST", path: "/api/v1/zones/{zone}/revisions/{revision}/restore", tag: "History",
    source: { kind: "command", command: "revision restore" },
    description: "Restores a snapshot as a new revision. History is never rewritten.",
    sample: { path: "/api/v1/zones/example.com/revisions/1/restore" },
    parameters: [ZONE_PARAM, { name: "revision", in: "path", required: true, description: "Revision to restore.", schema: { type: "integer", minimum: 1 } }, IF_MATCH_PARAM],
    success: { status: 200, description: "The zone at the new revision carrying the old state.", schema: ref("Zone") },
    errors: [409],
  },

  // ---- settings and access ----------------------------------------------
  {
    method: "GET", path: "/api/v1/settings", tag: "Administration",
    source: { kind: "command", command: "settings get" },
    sample: { path: "/api/v1/settings" },
    success: { status: 200, description: "The operator-owned settings.", schema: ref("Opaque") },
  },
  {
    method: "PUT", path: "/api/v1/settings", tag: "Administration",
    source: { kind: "command", command: "settings set" },
    description: "Writes only the keys the body carries; every other stored setting is retained.",
    sample: { path: "/api/v1/settings", body: {} },
    requestBody: { description: "The settings to change.", required: true, schema: ref("Opaque") },
    success: { status: 200, description: "The settings after the change.", schema: ref("Opaque") },
  },
  {
    method: "GET", path: "/api/v1/tokens", tag: "Administration",
    source: { kind: "command", command: "token list" },
    sample: { path: "/api/v1/tokens" },
    success: { status: 200, description: "Every token's metadata. The tokens themselves are stored only as digests and cannot be read back.", schema: arrayOf(ref("AccessTokenMetadata")) },
  },
  {
    method: "POST", path: "/api/v1/tokens", tag: "Administration",
    source: { kind: "command", command: "token issue" },
    sample: { path: "/api/v1/tokens", body: { subject: "ipam", role: "editor" } },
    requestBody: {
      description: "Who the token is for, and what it may do.", required: true,
      schema: { type: "object", required: ["subject", "role"], properties: { subject: { type: "string" }, role: ref("Role") } },
    },
    success: { status: 201, description: "The token, returned this once and never again.", schema: ref("IssuedAccessToken") },
  },
  {
    method: "DELETE", path: "/api/v1/tokens/{id}", tag: "Administration",
    source: { kind: "command", command: "token revoke" },
    sample: { path: "/api/v1/tokens/01J0000000000000000000" },
    parameters: [{ name: "id", in: "path", required: true, description: "Token identifier from the listing.", schema: { type: "string" } }],
    success: { status: 204, description: "Revoked. A token supplied by the environment cannot be revoked here." },
  },

  // ---- provider credentials ---------------------------------------------
  {
    method: "GET", path: "/api/v1/credentials/profiles", tag: "Credentials",
    source: { kind: "command", command: "credential profile list" },
    sample: { path: "/api/v1/credentials/profiles" },
    success: { status: 200, description: "Stored credential profiles, without their secrets.", schema: ref("Opaque") },
  },
  {
    method: "GET", path: "/api/v1/credentials/profiles/{name}", tag: "Credentials",
    source: { kind: "command", command: "credential profile get" },
    sample: { path: "/api/v1/credentials/profiles/main" },
    parameters: [{ name: "name", in: "path", required: true, description: "Profile name.", schema: { type: "string" } }],
    success: { status: 200, description: "The profile, without its secret.", schema: ref("Opaque") },
  },
  {
    method: "PUT", path: "/api/v1/credentials/profiles/{name}", tag: "Credentials",
    source: { kind: "command", command: "credential profile set" },
    description: "Write-only: the token is sealed with the credential master key and can never be read back through this API.",
    sample: { path: "/api/v1/credentials/profiles/main", body: { token: "provider-api-token" } },
    parameters: [{ name: "name", in: "path", required: true, description: "Profile name.", schema: { type: "string" } }],
    requestBody: {
      description: "The provider API token, and the account it belongs to.", required: true,
      schema: { type: "object", required: ["token"], properties: { token: { type: "string" }, accountId: { type: "string" } } },
    },
    success: { status: 200, description: "The profile as stored, without its secret.", schema: ref("Opaque") },
  },
  {
    method: "DELETE", path: "/api/v1/credentials/profiles/{name}", tag: "Credentials",
    source: { kind: "command", command: "credential profile delete" },
    sample: { path: "/api/v1/credentials/profiles/main" },
    parameters: [{ name: "name", in: "path", required: true, description: "Profile name.", schema: { type: "string" } }],
    success: { status: 204, description: "Deleted. A profile still bound to a zone is refused with `409`." },
    errors: [409],
  },
  {
    method: "POST", path: "/api/v1/credentials/profiles/{name}/test", tag: "Credentials",
    source: { kind: "command", command: "credential profile test" },
    sample: { path: "/api/v1/credentials/profiles/main/test", body: { zone: "example.com" } },
    parameters: [{ name: "name", in: "path", required: true, description: "Profile name.", schema: { type: "string" } }],
    requestBody: {
      description: "A zone to read through, and optionally an unsaved token to test instead of the stored one.", required: true,
      schema: { type: "object", required: ["zone"], properties: { zone: { type: "string" }, token: { type: "string" } } },
    },
    success: { status: 200, description: "What the provider answered for that zone.", schema: ref("Opaque") },
    errors: [502],
  },
  {
    method: "GET", path: "/api/v1/credentials/cloudflare", tag: "Credentials",
    source: { kind: "command", command: "credential zone list" },
    sample: { path: "/api/v1/credentials/cloudflare" },
    success: { status: 200, description: "Which zones are bound to which profile.", schema: ref("Opaque") },
  },
  {
    method: "GET", path: "/api/v1/credentials/cloudflare/{zone}", tag: "Credentials",
    source: { kind: "command", command: "credential zone get" },
    sample: { path: "/api/v1/credentials/cloudflare/example.com" },
    parameters: [ZONE_PARAM],
    success: { status: 200, description: "The zone's provider binding, without its secret.", schema: ref("Opaque") },
  },
  {
    method: "PUT", path: "/api/v1/credentials/cloudflare/{zone}", tag: "Credentials",
    source: { kind: "command", command: "credential zone set" },
    sample: { path: "/api/v1/credentials/cloudflare/example.com", body: { profile: "main" } },
    parameters: [ZONE_PARAM],
    requestBody: {
      description: "Either a stored `profile` to reuse, or an inline `token` stored as a profile named after the zone.",
      required: true,
      schema: { type: "object", properties: { profile: { type: "string" }, token: { type: "string" }, accountId: { type: "string" } } },
    },
    success: { status: 200, description: "The binding as stored.", schema: ref("Opaque") },
  },
  {
    method: "DELETE", path: "/api/v1/credentials/cloudflare/{zone}", tag: "Credentials",
    source: { kind: "command", command: "credential zone delete" },
    sample: { path: "/api/v1/credentials/cloudflare/example.com" },
    parameters: [ZONE_PARAM],
    success: { status: 204, description: "The binding is gone. The profile it named is left alone." },
  },
  {
    method: "POST", path: "/api/v1/credentials/cloudflare/{zone}/test", tag: "Credentials",
    source: { kind: "command", command: "credential zone test" },
    description: "Tests the stored binding, or an unsaved `profile` or `token` sent in the body.",
    sample: { path: "/api/v1/credentials/cloudflare/example.com/test" },
    parameters: [ZONE_PARAM],
    requestBody: {
      description: "Optional. Names something to test instead of what is stored.",
      schema: { type: "object", properties: { profile: { type: "string" }, token: { type: "string" }, accountId: { type: "string" } } },
    },
    success: { status: 200, description: "What the provider answered.", schema: ref("Opaque") },
    errors: [502],
  },

  // ---- client-side resolver overrides ------------------------------------
  {
    method: "GET", path: "/api/v1/fallback/{profile}", tag: "Fallback domains",
    source: { kind: "command", command: "fallback list" },
    description: "The provider's client-side resolver overrides: which suffixes are sent to which internal resolvers.",
    sample: { path: "/api/v1/fallback/main" },
    parameters: [
      { name: "profile", in: "path", required: true, description: "Stored credential profile to authenticate with.", schema: { type: "string" } },
      { name: "policy", in: "query", description: "Device settings profile id. The account default when absent.", schema: { type: "string" } },
    ],
    success: { status: 200, description: "The overrides currently in place.", schema: ref("Opaque") },
    errors: [502],
  },
  {
    method: "GET", path: "/api/v1/fallback/{profile}/coverage", tag: "Fallback domains",
    source: { kind: "command", command: "fallback coverage" },
    description: "Answers from the desired state alone, so it still reports when the provider credential is the broken thing.",
    sample: { path: "/api/v1/fallback/main/coverage" },
    parameters: [{ name: "profile", in: "path", required: true, description: "Credential profile.", schema: { type: "string" } }],
    success: { status: 200, description: "Which zones are covered by an override and which are not.", schema: ref("Opaque") },
  },
  {
    method: "GET", path: "/api/v1/fallback/{profile}/preview", tag: "Fallback domains",
    source: { kind: "command", command: "fallback preview" },
    sample: { path: "/api/v1/fallback/main/preview" },
    parameters: [
      { name: "profile", in: "path", required: true, description: "Credential profile.", schema: { type: "string" } },
      { name: "policy", in: "query", description: "Device settings profile id.", schema: { type: "string" } },
    ],
    success: { status: 200, description: "What syncing would change at the provider.", schema: ref("Opaque") },
    errors: [502],
  },
  {
    method: "POST", path: "/api/v1/fallback/{profile}/sync", tag: "Fallback domains",
    source: { kind: "command", command: "fallback sync" },
    sample: { path: "/api/v1/fallback/main/sync" },
    parameters: [
      { name: "profile", in: "path", required: true, description: "Credential profile.", schema: { type: "string" } },
      { name: "policy", in: "query", description: "Device settings profile id.", schema: { type: "string" } },
    ],
    success: { status: 200, description: "What was written at the provider.", schema: ref("Opaque") },
    errors: [409, 502],
  },
  {
    method: "PUT", path: "/api/v1/fallback/{profile}/domains/{suffix}", tag: "Fallback domains",
    source: { kind: "command", command: "fallback set" },
    sample: { path: "/api/v1/fallback/main/domains/example.com", body: { "dns-server": "10.0.0.53" } },
    parameters: [
      { name: "profile", in: "path", required: true, description: "Credential profile.", schema: { type: "string" } },
      { name: "suffix", in: "path", required: true, description: "Apex domain; every name beneath it is covered.", schema: { type: "string" } },
      { name: "policy", in: "query", description: "Device settings profile id.", schema: { type: "string" } },
    ],
    requestBody: {
      description: "Where to send this suffix. `dns-server` takes one address, a comma-separated list, or an array.",
      required: true,
      schema: {
        type: "object",
        properties: {
          "dns-server": { oneOf: [{ type: "string" }, arrayOf({ type: "string" })] },
          dnsServer: { oneOf: [{ type: "string" }, arrayOf({ type: "string" })] },
          description: { type: "string", description: "Shown in the provider's client UI." },
        },
      },
    },
    success: { status: 200, description: "The override as stored.", schema: ref("Opaque") },
    errors: [409, 502],
  },
  {
    method: "DELETE", path: "/api/v1/fallback/{profile}/domains/{suffix}", tag: "Fallback domains",
    source: { kind: "command", command: "fallback delete" },
    sample: { path: "/api/v1/fallback/main/domains/example.com" },
    parameters: [
      { name: "profile", in: "path", required: true, description: "Credential profile.", schema: { type: "string" } },
      { name: "suffix", in: "path", required: true, description: "Apex domain.", schema: { type: "string" } },
      { name: "policy", in: "query", description: "Device settings profile id.", schema: { type: "string" } },
    ],
    success: { status: 200, description: "What was removed.", schema: ref("Opaque") },
    errors: [409, 502],
  },

  // ---- the dispatcher itself ---------------------------------------------
  {
    method: "POST", path: "/api/v1/cli", tag: "Meta",
    source: {
      kind: "dispatch",
      summary: "Run any serving command by its command line",
      access: "Reachable by any role. The command named then enforces its own minimum, so one gate does not have to mirror the other.",
      sampleCommand: "zone list",
    },
    description:
      "Runs any serving command by its command line, for anything without a route of its own. The command named enforces "
      + "its own minimum role. `migrate` is deliberately absent from the serving runtime, so an HTTP administrator can "
      + "never turn this process's database role into a schema-changing one.",
    sample: { path: "/api/v1/cli", body: { argv: ["zone", "list"] } },
    requestBody: {
      description: "The command line as an array of strings.", required: true,
      schema: { type: "object", required: ["argv"], properties: { argv: arrayOf({ type: "string" }) } },
    },
    success: {
      status: 200,
      description: "The command that ran and whatever it returned.",
      schema: { type: "object", required: ["command", "result"], properties: { command: { type: "string" }, result: {} } },
    },
  },
  {
    method: "GET", path: "/api/v1/openapi.json", tag: "Meta",
    source: { kind: "command", command: "openapi" },
    description: "This document. Point a Swagger UI, a Redoc, or a client generator at it.",
    sample: { path: "/api/v1/openapi.json" },
    success: { status: 200, description: "An OpenAPI 3.1 document describing every route above.", schema: ref("Opaque") },
  },

  // ---- answered before the dispatcher ------------------------------------
  {
    method: "POST", path: "/api/v1/session", tag: "Meta",
    source: {
      kind: "process",
      summary: "Exchange a bearer token for a session cookie",
      access: "Open, and rate-limited per client. This is how a caller with no credential acquires one.",
    },
    description:
      "For a browser: the reply carries an `HttpOnly; SameSite=Strict; Path=/` cookie, `Secure` over HTTPS, so the token "
      + "itself never reaches page scripts. A command-line client should send `Authorization: Bearer` instead and skip this.",
    sample: { path: "/api/v1/session", body: { token: "..." } },
    requestBody: { description: "The access token to exchange.", required: true, schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } } },
    success: { status: 204, description: "The session cookie is set." },
    errors: [429],
  },
  {
    method: "DELETE", path: "/api/v1/session", tag: "Meta",
    source: { kind: "process", summary: "Clear the session cookie", access: "Requires the session it is clearing, and proof the request came from this origin." },
    sample: { path: "/api/v1/session" },
    success: { status: 204, description: "The cookie is cleared." },
  },
  {
    method: "GET", path: "/health/live", tag: "Operations",
    source: {
      kind: "process",
      summary: "Whether this process is up, and whether it asks for credentials",
      access: "Open on purpose: it is how the portal learns whether it can offer sign-in.",
    },
    sample: { path: "/health/live" },
    success: {
      status: 200,
      description: "Always answered while the process is running.",
      schema: {
        type: "object",
        required: ["status", "service", "authentication"],
        properties: { status: { type: "string" }, service: { type: "string" }, authentication: { type: "string", enum: ["required", "disabled"] } },
      },
    },
  },
  {
    method: "GET", path: "/health/ready", tag: "Operations",
    source: {
      kind: "process",
      summary: "Whether this process would serve traffic",
      access: "Open, but the detail is not: an unauthenticated caller gets a bare verdict and nothing else.",
    },
    description: "Fails closed. A desired state that has not been read successfully for long enough reports `503` rather than a stale yes.",
    sample: { path: "/health/ready" },
    success: { status: 200, description: "Ready. `503` with the same shape when it is not.", schema: ref("Opaque") },
  },
  {
    method: "GET", path: "/metrics", tag: "Operations",
    source: {
      kind: "process",
      summary: "Prometheus metrics",
      access: "Behind the same authentication as the API. These numbers describe the deployment, so a scraper sends a bearer token like anything else.",
    },
    description:
      "Counts the failures that are otherwise only a line on stderr: a stored record the wire cannot carry, a reply that "
      + "could not be assembled, a zone left unanswered, a background refresh that failed, a certificate reload that did "
      + "not take. Each is present at zero before it ever happens, so an alert can tell \"never\" from \"no such series\". "
      + "No zone, record or client names appear.",
    sample: { path: "/metrics" },
    success: { status: 200, description: "Prometheus text exposition format.", mediaType: "text/plain" },
  },
];

export function listOperations(): readonly DocumentedOperation[] {
  return OPERATIONS;
}

/**
 * The least role that gets an operation through both gates that guard it: the
 * minimum the command declares, and what `authorize` allows on that path and
 * method. Neither is written down here, so a route that quietly becomes
 * admin-only changes this document rather than contradicting it.
 *
 * They really can differ. `authorize` lets any reader reach a `GET`, while
 * `fallback list` demands an administrator -- and the effective answer, the one
 * a caller needs, is the stricter of the two.
 */
export function minimumRole(operation: DocumentedOperation): Role | undefined {
  if (operation.source.kind !== "command") return undefined;
  const command = findCommand(operation.source.command);
  if (!command) return undefined;
  const request = new Request(`http://parallax.invalid${operation.sample.path}`, { method: operation.method });
  return ROLES.find((role) =>
    ROLES.indexOf(role) >= ROLES.indexOf(command.role) && authorize({ role, subject: "documented" }, request));
}

/** The options a command takes, for readers who reach it through `POST /cli`. */
function commandOptions(operation: DocumentedOperation): readonly CommandOption[] {
  if (operation.source.kind !== "command") return [];
  return findCommand(operation.source.command)?.options ?? [];
}

function summaryOf(operation: DocumentedOperation): string {
  if (operation.source.kind !== "command") return operation.source.summary;
  return findCommand(operation.source.command)?.summary ?? operation.source.command;
}

function responsesOf(operation: DocumentedOperation): JsonSchema {
  const responses: JsonSchema = {
    [String(operation.success.status)]: {
      description: operation.success.description,
      ...(operation.success.schema || operation.success.mediaType
        ? { content: { [operation.success.mediaType ?? "application/json"]: operation.success.schema ? { schema: operation.success.schema } : {} } }
        : {}),
    },
  };
  const statuses = [...new Set([...COMMON_ERRORS, ...(operation.errors ?? [])])].sort((left, right) => left - right);
  for (const status of statuses) {
    responses[String(status)] = {
      description: ERROR_DESCRIPTIONS[status] ?? "Refused.",
      content: { "application/json": { schema: ref("Error") } },
    };
  }
  return responses;
}

const TAG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  Zones: "The zones this control plane holds desired state for.",
  Records: "Record-level reads and writes, for a caller synchronising from its own source of truth.",
  Reconciliation: "Comparing desired state to what a provider actually holds, and closing the gap.",
  "Zone files": "Presentation-format import and export.",
  History: "The audit trail and the immutable revisions behind it.",
  Administration: "Settings and the tokens that reach this API. Administrator-only, reads included.",
  Credentials: "Provider credentials. Write-only: a stored secret can never be read back.",
  "Fallback domains": "The provider's client-side resolver overrides.",
  Meta: "The dispatcher, this document, and how a browser signs in.",
  Operations: "What a probe, a load balancer and a scraper ask for.",
};

export interface OpenApiOptions {
  /**
   * Stamped into `info.version`. Defaults to the version this API is served
   * under, which is the one that changes when these routes change -- the
   * package's version tracks the build, and a client generated from this
   * document does not care which build answered it.
   */
  readonly version?: string;
}

export function buildOpenApiDocument(options: OpenApiOptions = {}): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of OPERATIONS) {
    const role = minimumRole(operation);
    const item = paths[operation.path] ?? {};
    paths[operation.path] = item;
    const declared = commandOptions(operation);
    item[operation.method.toLowerCase()] = {
      tags: [operation.tag],
      summary: summaryOf(operation),
      ...(operation.description ? { description: operation.description } : {}),
      operationId: operationId(operation),
      ...(operation.parameters ? { parameters: operation.parameters.map((parameter) => ({ ...parameter })) } : {}),
      ...(operation.requestBody
        ? {
          requestBody: {
            description: operation.requestBody.description,
            required: operation.requestBody.required ?? false,
            content: { "application/json": { schema: operation.requestBody.schema } },
          },
        }
        : {}),
      responses: responsesOf(operation),
      // The concrete request the drift test resolves through the real router,
      // published so the reference page can show an example that is known to
      // reach something rather than one somebody typed into a docstring.
      "x-parallax-sample": { path: operation.sample.path, ...(operation.sample.body ? { body: operation.sample.body } : {}) },
      ...(operation.source.kind === "command"
        ? {
          "x-parallax-command": operation.source.command,
          ...(declared.length > 0 ? { "x-parallax-command-options": declared.map((option) => option.name) } : {}),
        }
        : { "x-parallax-served-by": operation.source.kind, "x-parallax-access": operation.source.access }),
      ...(role ? { "x-parallax-role": role } : {}),
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Parallax",
      version: options.version ?? "v1",
      summary: "A split-horizon DNS control plane and operations portal.",
      description: [
        "Parallax keeps one desired state for internal DNS and external provider DNS, previews the resulting changes, and",
        "applies only the records it manages.",
        "",
        "Every route below is one command invocation. The command layer holds the behaviour, so this API and the",
        "`parallax` command line cannot drift apart -- each operation names the command it reaches in",
        "`x-parallax-command`, and `POST /api/v1/cli` runs any of them by its command line.",
        "",
        "`x-parallax-role` is the least role that reaches the operation. It is computed from the two gates that enforce it,",
        "not asserted here, so it cannot outlive a route whose permissions changed.",
        "",
        "Writes take `If-Match` with the zone revision they expect and answer with the new one in an `ETag`. A request body",
        "may not exceed 1 MiB, except on the two routes that carry a zone file -- `POST /api/v1/zones/{zone}/import` and",
        "`POST /api/v1/cli`, which allow 8 MiB.",
      ].join("\n"),
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    // Relative, so the document describes whatever origin it was fetched from
    // and never names a host this deployment may not be reached at.
    servers: [{ url: "/", description: "This deployment." }],
    tags: [...new Set(OPERATIONS.map((operation) => operation.tag))].map((name) => ({
      name,
      ...(TAG_DESCRIPTIONS[name] ? { description: TAG_DESCRIPTIONS[name] } : {}),
    })),
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http", scheme: "bearer",
          description: "An access token, issued by `POST /api/v1/tokens` or supplied by the environment. What a machine sends.",
        },
        sessionCookie: {
          type: "apiKey", in: "cookie", name: "parallax_session",
          description: "Set by `POST /api/v1/session`, or by signing in through the identity provider. What a browser sends.",
        },
      },
      schemas: SCHEMAS,
    },
    paths,
  } satisfies JsonSchema;
}

/** A stable name for a generated client's method. */
function operationId(operation: DocumentedOperation): string {
  const segments = operation.path
    .replace(/^\/api\/v1/u, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/^\{(.+)\}$/u, "by-$1"));
  return [operation.method.toLowerCase(), ...segments].join("-").replace(/[^a-zA-Z0-9-]/gu, "-");
}
