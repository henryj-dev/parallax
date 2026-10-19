import { isIP } from "node:net";
import {
  concreteDnsTtl,
  DomainValidationError,
  isValidRecordName,
  providerManagement,
  type DesiredRecord,
  type DnsView,
} from "./dns.ts";

/**
 * Health checks for the internal listener's address answers.
 *
 * A policy names one RRset -- an owner name and `A` or `AAAA` -- and says how to
 * decide whether each address in it is fit to hand out. It lives on the
 * `internal` view only, beside the records rather than inside them: a record is
 * what a provider stores and reconciles, and nothing about probing an origin is
 * something a provider could hold. Putting it on `DesiredRecord` would also
 * make it part of every external comparison, which is exactly the coupling this
 * feature must not introduce -- the public answer is never filtered.
 */

export const HEALTH_CHECK_TYPES = ["A", "AAAA"] as const;
export type HealthCheckType = (typeof HEALTH_CHECK_TYPES)[number];

export const HEALTH_CHECK_PROTOCOLS = ["tcp", "http", "https"] as const;
export type HealthCheckProtocol = (typeof HEALTH_CHECK_PROTOCOLS)[number];

/**
 * What a protected RRset is answered with when no address in it has a fresh
 * success. `servfail` holds the name back; `answer-all` hands out every address
 * rather than lose the name to a probe path that may be the only thing broken.
 */
export const HEALTH_NONE_HEALTHY_ACTIONS = ["servfail", "answer-all"] as const;
export type HealthNoneHealthyAction = (typeof HEALTH_NONE_HEALTHY_ACTIONS)[number];
export const DEFAULT_HEALTH_NONE_HEALTHY_ACTION: HealthNoneHealthyAction = "servfail";

export const DEFAULT_HEALTH_RESPONSE_TTL_SECONDS = 30;
export const MIN_HEALTH_RESPONSE_TTL_SECONDS = 5;
export const MAX_HEALTH_RESPONSE_TTL_SECONDS = 60;
export const DEFAULT_HEALTH_HTTP_PATH = "/health/ready";
export const MAX_HEALTH_PATH_LENGTH = 256;
/** Per zone. */
export const MAX_HEALTH_CHECKS_PER_ZONE = 64;
/**
 * Addresses one process probes, across every zone. With 16 probes in flight and
 * a 2 second deadline each, a full round takes at most 64 x 2 / 16 = 8 seconds,
 * inside the 10 second interval and well inside the 30 second freshness limit.
 */
export const MAX_HEALTH_CHECK_TARGETS = 64;

export type HealthCheckProbe =
  | { kind: "tcp"; port: number }
  | { kind: "http" | "https"; port: number; path: string };

export interface HealthCheckPolicy {
  /** Relative owner name, `@` for the apex, exactly as records spell it. */
  name: string;
  type: HealthCheckType;
  enabled: boolean;
  probe: HealthCheckProbe;
  responseTtlSeconds: number;
  /**
   * Absent means `servfail`. Only `answer-all` is ever stored, so a policy
   * that never opted in is written exactly as it was before the field existed.
   */
  whenNoneHealthy?: "answer-all";
}

export interface HealthCheckChanges {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}

/** The identity of a policy within a zone: one per owner name and type. */
export function healthCheckKey(policy: Pick<HealthCheckPolicy, "name" | "type">): string {
  return `${policy.name}/${policy.type}`;
}

/**
 * Reads one policy, from an operator or from the store.
 *
 * Every field is required to be well formed in both directions: unlike a
 * record's size limit there is no rule here that only new content has to meet,
 * so there is no rehydrate exemption to carry.
 */
export function createHealthCheckPolicy(input: unknown, label = "health check"): HealthCheckPolicy {
  const issues: string[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new DomainValidationError([`${label} must be an object`]);
  }
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!["name", "type", "enabled", "probe", "responseTtlSeconds", "whenNoneHealthy"].includes(key)) {
      issues.push(`${label} has an unknown field ${key}`);
    }
  }
  const name = typeof value.name === "string" ? value.name.trim().toLowerCase().replace(/\.$/u, "") : "";
  if (!isValidRecordName(name)) issues.push(`${label} name must be @ or a valid relative DNS name`);
  else if (name === "*" || name.startsWith("*.")) {
    issues.push(`${label} name must not be a wildcard; a health check protects one exact owner name`);
  }
  const type = typeof value.type === "string" ? value.type.trim().toUpperCase() : "";
  if (!HEALTH_CHECK_TYPES.some((candidate) => candidate === type)) {
    issues.push(`${label} type must be A or AAAA`);
  }
  // Only an explicit true turns a policy on; a policy left unsaid answers the RRset in full.
  const enabled = value.enabled === undefined ? false : value.enabled;
  if (typeof enabled !== "boolean") issues.push(`${label} enabled must be a boolean`);
  const ttl = value.responseTtlSeconds === undefined ? DEFAULT_HEALTH_RESPONSE_TTL_SECONDS : value.responseTtlSeconds;
  if (typeof ttl !== "number" || !Number.isInteger(ttl)
    || ttl < MIN_HEALTH_RESPONSE_TTL_SECONDS || ttl > MAX_HEALTH_RESPONSE_TTL_SECONDS) {
    issues.push(`${label} responseTtlSeconds must be an integer between ${MIN_HEALTH_RESPONSE_TTL_SECONDS} and ${MAX_HEALTH_RESPONSE_TTL_SECONDS}`);
  }
  const whenNoneHealthy = value.whenNoneHealthy === undefined
    ? DEFAULT_HEALTH_NONE_HEALTHY_ACTION
    : typeof value.whenNoneHealthy === "string" ? value.whenNoneHealthy.trim().toLowerCase() : value.whenNoneHealthy;
  if (!HEALTH_NONE_HEALTHY_ACTIONS.some((candidate) => candidate === whenNoneHealthy)) {
    issues.push(`${label} whenNoneHealthy must be servfail or answer-all`);
  }
  let probe: HealthCheckProbe | undefined;
  try {
    probe = readProbe(value.probe, label);
  } catch (error) {
    if (!(error instanceof DomainValidationError)) throw error;
    issues.push(...error.issues);
  }
  if (issues.length > 0 || probe === undefined) throw new DomainValidationError(issues);
  return {
    name,
    type: type as HealthCheckType,
    enabled: enabled as boolean,
    probe,
    responseTtlSeconds: ttl as number,
    ...(whenNoneHealthy === "answer-all" ? { whenNoneHealthy: "answer-all" as const } : {}),
  };
}

/** The action a policy takes when nothing in its RRset is healthy. */
export function noneHealthyAction(policy: Pick<HealthCheckPolicy, "whenNoneHealthy">): HealthNoneHealthyAction {
  return policy.whenNoneHealthy ?? DEFAULT_HEALTH_NONE_HEALTHY_ACTION;
}

function readProbe(input: unknown, label: string): HealthCheckProbe {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new DomainValidationError([`${label} probe must be an object`]);
  }
  const value = input as Record<string, unknown>;
  const issues: string[] = [];
  const kind = typeof value.kind === "string" ? value.kind.trim().toLowerCase() : "";
  if (!HEALTH_CHECK_PROTOCOLS.some((candidate) => candidate === kind)) {
    issues.push(`${label} probe kind must be tcp, http or https`);
  }
  const allowed = kind === "tcp" ? ["kind", "port"] : ["kind", "port", "path"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${label} probe has an unsupported field ${key}`);
  }
  const port = value.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    issues.push(`${label} probe port must be an integer between 1 and 65535`);
  }
  let path = DEFAULT_HEALTH_HTTP_PATH;
  if (kind === "http" || kind === "https") {
    if (value.path !== undefined) {
      const issue = typeof value.path === "string" ? healthCheckPathIssue(value.path) : "must be a string";
      if (issue) issues.push(`${label} probe path ${issue}`);
      else path = value.path as string;
    }
  }
  if (issues.length > 0) throw new DomainValidationError(issues);
  return kind === "tcp"
    ? { kind: "tcp", port: port as number }
    : { kind: kind as "http" | "https", port: port as number, path };
}

/**
 * Why a request path is refused, or `undefined` when it is acceptable.
 *
 * The path is the only part of the request an operator chooses, and it is sent
 * as written on a request line this process builds itself. So it is held to an
 * origin-form path and nothing else: no scheme or authority that could aim the
 * request somewhere other than the pinned address, no whitespace or control
 * byte that could split the request line, no fragment, and no malformed escape.
 */
export function healthCheckPathIssue(path: string): string | undefined {
  if (path.length === 0 || path.length > MAX_HEALTH_PATH_LENGTH) {
    return `must be 1 to ${MAX_HEALTH_PATH_LENGTH} characters`;
  }
  if (!path.startsWith("/")) return "must start with /";
  if (path.startsWith("//")) return "must not start with //, which reads as an authority";
  // Visible ASCII only: this excludes space, every control character and DEL.
  if (!/^[\x21-\x7e]+$/u.test(path)) return "must contain only visible ASCII characters";
  if (path.includes("#")) return "must not carry a fragment";
  if (path.includes("\\")) return "must not contain a backslash";
  if (/%(?![0-9a-fA-F]{2})/u.test(path)) return "must not contain a malformed percent escape";
  return undefined;
}

/**
 * Reads the `healthChecks` field of a view.
 *
 * `undefined` stays `undefined` rather than becoming an empty list, because the
 * difference is load-bearing: a full replacement that omits the field is a
 * client that does not know about it, and must not be read as "remove them".
 */
export function readHealthChecks(input: unknown, viewName: string): HealthCheckPolicy[] | undefined {
  if (input === undefined) return undefined;
  if (viewName !== "internal") {
    throw new DomainValidationError([`healthChecks are supported only on the internal view, not ${viewName}`]);
  }
  if (!Array.isArray(input)) throw new DomainValidationError(["healthChecks must be an array"]);
  if (input.length > MAX_HEALTH_CHECKS_PER_ZONE) {
    throw new DomainValidationError([`a zone may carry at most ${MAX_HEALTH_CHECKS_PER_ZONE} health checks`]);
  }
  const issues: string[] = [];
  const policies: HealthCheckPolicy[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of input.entries()) {
    try {
      const policy = createHealthCheckPolicy(entry, `healthChecks[${index}]`);
      const key = healthCheckKey(policy);
      if (seen.has(key)) {
        issues.push(`healthChecks[${index}] duplicates the policy for ${policy.name} ${policy.type}`);
        continue;
      }
      seen.add(key);
      policies.push(policy);
    } catch (error) {
      if (!(error instanceof DomainValidationError)) throw error;
      issues.push(...error.issues);
    }
  }
  if (issues.length > 0) throw new DomainValidationError(issues);
  return sortHealthChecks(policies);
}

export function sortHealthChecks(policies: readonly HealthCheckPolicy[]): HealthCheckPolicy[] {
  return [...policies].sort((left, right) => healthCheckKey(left).localeCompare(healthCheckKey(right)));
}

export function cloneHealthCheck(policy: HealthCheckPolicy): HealthCheckPolicy {
  return { ...policy, probe: { ...policy.probe } };
}

export function healthChecksOf(view: Pick<DnsView, "healthChecks"> | undefined): readonly HealthCheckPolicy[] {
  return view?.healthChecks ?? [];
}

export function hasEnabledHealthChecks(views: readonly DnsView[]): boolean {
  return healthChecksOf(views.find((view) => view.name === "internal")).some((policy) => policy.enabled);
}

/** Two policies decide the same thing the same way. */
export function sameHealthCheck(left: HealthCheckPolicy, right: HealthCheckPolicy): boolean {
  return JSON.stringify(canonicalPolicy(left)) === JSON.stringify(canonicalPolicy(right));
}

function canonicalPolicy(policy: HealthCheckPolicy): unknown {
  const probe = policy.probe.kind === "tcp"
    ? { kind: "tcp", port: policy.probe.port }
    : { kind: policy.probe.kind, port: policy.probe.port, path: policy.probe.path };
  return [policy.name, policy.type, policy.enabled, policy.responseTtlSeconds, probe, noneHealthyAction(policy)];
}

export function countHealthCheckChanges(
  before: readonly HealthCheckPolicy[],
  after: readonly HealthCheckPolicy[],
): HealthCheckChanges {
  const previous = new Map(before.map((policy) => [healthCheckKey(policy), policy]));
  const next = new Map(after.map((policy) => [healthCheckKey(policy), policy]));
  let added = 0;
  let changed = 0;
  for (const [key, policy] of next) {
    const old = previous.get(key);
    if (old === undefined) added += 1;
    else if (!sameHealthCheck(old, policy)) changed += 1;
  }
  const removed = [...previous.keys()].filter((key) => !next.has(key)).length;
  return { added, removed, changed };
}

/** The addresses a policy covers, as the listener would answer them. */
export interface ProtectedRRset {
  readonly policy: HealthCheckPolicy;
  /** Canonical literal addresses, in answer order. */
  readonly addresses: readonly string[];
  /** The one TTL every address in the answer carries. */
  readonly ttl: number;
}

/**
 * The RRset each policy refers to, read from the composed internal view.
 *
 * `composed` is the internal view after inheritance -- overrides and inherited
 * external records together -- because that is what the listener answers and
 * therefore what a policy protects. `external` is read alongside it only to
 * recognise a record a provider service owns: composition copies the address
 * but not the ownership marker, and an owned address is not one this process
 * may decide about.
 *
 * Returns every reason the set cannot be honoured. An empty list means each
 * policy names at least one literal address that may be probed.
 */
export function resolveProtectedRRsets(
  policies: readonly HealthCheckPolicy[],
  composed: readonly DesiredRecord[],
  external: readonly DesiredRecord[],
  overrides: readonly DesiredRecord[],
): { rrsets: ProtectedRRset[]; issues: string[] } {
  const issues: string[] = [];
  const rrsets: ProtectedRRset[] = [];
  const overridden = new Set(overrides.map((record) => `${record.name}/${record.type}`));
  for (const policy of policies) {
    const key = healthCheckKey(policy);
    const records = composed.filter((record) => record.name === policy.name && record.type === policy.type);
    if (records.length === 0) {
      issues.push(`health check ${policy.name} ${policy.type} has no ${policy.type} record to protect; delete the policy in the same change that removes the last address`);
      continue;
    }
    const sources = overridden.has(key)
      ? overrides.filter((record) => record.name === policy.name && record.type === policy.type)
      : external.filter((record) => record.name === policy.name && record.type === policy.type);
    const owned = [...records, ...sources].find((record) => providerManagement(record) !== undefined);
    if (owned) {
      issues.push(`health check ${policy.name} ${policy.type} protects a provider-owned or placeholder address; such an address is not one this listener can probe`);
      continue;
    }
    if (records.some((record) => isIP(record.content) === 0)) {
      issues.push(`health check ${policy.name} ${policy.type} protects content that is not a literal address`);
      continue;
    }
    const ttl = Math.min(policy.responseTtlSeconds, ...records.map((record) => concreteDnsTtl(record.ttl)));
    rrsets.push({ policy, addresses: records.map((record) => record.content), ttl });
  }
  return { rrsets, issues };
}
