import { CloudflareFallbackDomains, type FallbackDomain } from "../adapters/cloudflare-fallback.ts";
import { ownershipComment, readOwnershipComment } from "../adapters/ownership.ts";
import { servedZones } from "../dns/snapshot.ts";
import type { Zone } from "../domain/dns.ts";
import { CredentialNotFoundError } from "./cloudflare-credentials.ts";

/**
 * Manages the provider's client-side resolver overrides with the credential
 * already stored for a profile.
 *
 * The token is the one the profile holds. Nobody types a second one, and no
 * second one is stored: a credential that already speaks for this account is the
 * credential this speaks with. What it needs beyond DNS is a permission, not
 * another secret, and the client says so plainly when it is missing.
 */
export interface ProfileSecretReader {
  getProfileSecret(name: string): Promise<{ name: string; accountId?: string; token: string } | undefined>;
}

export interface FallbackDomainServiceOptions {
  readonly secrets: ProfileSecretReader;
  /** Signs the marker that says which entries are this control plane's to change. */
  readonly ownershipSecret?: string;
  /** Overridden in tests; the real one talks to the provider. */
  readonly createClient?: (options: { token: string; accountId: string; policyId?: string }) => CloudflareFallbackDomains;
}

export interface FallbackDomainChange {
  readonly domains: FallbackDomain[];
  /** What the write did, so a no-op is never reported as a change. */
  readonly outcome: "added" | "updated" | "removed" | "unchanged";
}

export interface FallbackDomainState extends FallbackDomain {
  /** True only when the marker is valid for this exact suffix and control plane. */
  readonly owned: boolean;
}

export class FallbackDomainOwnershipError extends Error {
  override readonly name = "FallbackDomainOwnershipError";
}

/**
 * The zones one credential profile should have overrides for.
 *
 * Both the listener and this read the same rule from the same function, rather
 * than agreeing by hand: a zone whose internal view is empty is left out of the
 * listener's snapshot, so it claims no authority and the query goes upstream.
 * Pointing devices here for such a zone buys nothing and costs a dependency --
 * a mail domain would resolve through this process for no reason, and stop
 * resolving with it. A zone that stops being served stops being pointed at in
 * the same revision, with nobody remembering to do it.
 */
export function overridableZones(
  bindings: readonly { readonly zone: string; readonly profile: string }[],
  zones: readonly Zone[],
  profile: string,
): string[] {
  return fallbackCoverage(bindings, zones, profile)
    .filter((row) => row.covered)
    .map((row) => row.zone);
}

/** Why a zone is or is not among the ones a profile's overrides cover. */
export type CoverageReason = "covered" | "empty" | "invalid" | "otherProfile" | "unbound";

export interface CoverageRow {
  readonly zone: string;
  readonly covered: boolean;
  readonly reason: CoverageReason;
  /** The profile this zone is bound to, where it is bound to one. */
  readonly profile?: string;
  /** Why the views could not be composed, for `invalid` only. */
  readonly detail?: string;
}

/**
 * Every zone this control plane holds, and whether this profile's overrides
 * cover it -- with the reason when they do not.
 *
 * `overridableZones` answers what to write, which is all a sync needs and
 * nothing an operator can act on: a zone simply absent from that list looks the
 * same whether it is bound elsewhere, holds nothing to answer, or was never
 * bound at all. That question cost a live investigation -- a zone visibly full
 * of internal records was missing from the overrides and there was nowhere to
 * read why -- so the rule reports its own exclusions rather than only its
 * results, and the one list is derived from this one.
 *
 * Deliberately says nothing about the provider. Nothing here needs a token, an
 * account id or a permission, so the answer is available on the worst day: when
 * the credential is the thing that is wrong.
 */
export function fallbackCoverage(
  bindings: readonly { readonly zone: string; readonly profile: string }[],
  zones: readonly Zone[],
  profile: string,
): CoverageRow[] {
  const invalid = new Map<string, string>();
  const served = new Set(servedZones(zones, (zone, reason) => invalid.set(zone, reason)).map((zone) => zone.name));
  const boundTo = new Map(bindings.map((binding) => [binding.zone, binding.profile]));
  return zones
    .map((zone): CoverageRow => {
      const bound = boundTo.get(zone.name);
      if (bound === undefined) return { zone: zone.name, covered: false, reason: "unbound" };
      if (bound !== profile) return { zone: zone.name, covered: false, reason: "otherProfile", profile: bound };
      const failure = invalid.get(zone.name);
      if (failure !== undefined) {
        return { zone: zone.name, covered: false, reason: "invalid", profile: bound, detail: failure };
      }
      if (!served.has(zone.name)) return { zone: zone.name, covered: false, reason: "empty", profile: bound };
      return { zone: zone.name, covered: true, reason: "covered", profile: bound };
    })
    .sort((left, right) => left.zone.localeCompare(right.zone));
}

/** One suffix's place in the difference between the zones and the live list. */
export interface FallbackPlan {
  readonly add: FallbackDomain[];
  readonly update: FallbackDomain[];
  readonly remove: FallbackDomain[];
  /**
   * Entries nobody signed that already say exactly what this would say. Claimed
   * by stamping the marker on them, which changes nothing a device can observe.
   */
  readonly adopt: FallbackDomain[];
  /** Suffixes somebody else's entry already covers. Never written over. */
  readonly conflict: { suffix: string; reason: string }[];
  readonly unchanged: number;
  /** Entries in the list that are nobody's business of ours. */
  readonly untouched: number;
}

export class FallbackDomainService {
  readonly #secrets: ProfileSecretReader;
  readonly #ownershipSecret: string;
  readonly #createClient: NonNullable<FallbackDomainServiceOptions["createClient"]>;

  constructor(options: FallbackDomainServiceOptions) {
    this.#secrets = options.secrets;
    this.#ownershipSecret = options.ownershipSecret ?? "";
    this.#createClient = options.createClient
      ?? ((input) => new CloudflareFallbackDomains(input));
  }

  async list(profile: string, policyId?: string): Promise<FallbackDomainState[]> {
    return (await (await this.#client(profile, policyId)).list()).map((entry) => ({
      ...entry,
      owned: this.#owns(entry),
    }));
  }

  /**
   * Points one suffix at one or more resolvers, leaving every other entry alone.
   *
   * Read first, then write the whole list back, because the provider has no way
   * to change a single entry. Writing only what was asked for would delete the
   * defaults -- `localhost`, `internal`, `lan` and the rest -- and the symptom
   * would not be this command failing; it would be names elsewhere quietly
   * resolving somewhere else.
   */
  async set(profile: string, entry: FallbackDomain, policyId?: string): Promise<FallbackDomainChange> {
    const suffix = normalizeSuffix(entry.suffix);
    if (!suffix) throw new Error("a fallback domain needs a suffix");
    this.#requireOwnershipSecret();
    const client = await this.#client(profile, policyId);
    const current = await client.list();
    const desired: FallbackDomain = {
      suffix,
      ...(entry.dnsServer && entry.dnsServer.length > 0 ? { dnsServer: entry.dnsServer } : {}),
      description: [entry.description?.trim(), ownershipComment(`fallback/${suffix}`, "entry", this.#ownershipSecret)]
        .filter(Boolean)
        .join(" "),
    };
    const index = current.findIndex((domain) => normalizeSuffix(domain.suffix) === suffix);
    if (index >= 0 && !this.#owns(current[index] as FallbackDomain)) {
      throw new FallbackDomainOwnershipError(`fallback domain ${suffix} is not owned by this control plane`);
    }
    if (index >= 0 && sameEntry(current[index] as FallbackDomain, desired)) {
      return { domains: current, outcome: "unchanged" };
    }
    const next = [...current];
    if (index >= 0) next[index] = desired;
    else next.push(desired);
    return { domains: await client.replace(next), outcome: index >= 0 ? "updated" : "added" };
  }

  async remove(profile: string, suffix: string, policyId?: string): Promise<FallbackDomainChange> {
    const wanted = normalizeSuffix(suffix);
    this.#requireOwnershipSecret();
    const client = await this.#client(profile, policyId);
    const current = await client.list();
    const matching = current.filter((domain) => normalizeSuffix(domain.suffix) === wanted);
    if (matching.some((domain) => !this.#owns(domain))) {
      throw new FallbackDomainOwnershipError(`fallback domain ${wanted} is not owned by this control plane`);
    }
    const next = current.filter((domain) => normalizeSuffix(domain.suffix) !== wanted || !this.#owns(domain));
    // Saying "removed" about a list that never held it would read as confirmation
    // that the override is gone, when it may be spelled differently and still live.
    if (next.length === current.length) return { domains: current, outcome: "unchanged" };
    return { domains: await client.replace(next), outcome: "removed" };
  }

  /**
   * Works out what the override list would have to become for it to match the
   * zones this control plane holds, and touches nothing else.
   *
   * The list is not ours. It is one setting shared by every override an
   * organization has, and the one seen here already carried six belonging to
   * other networks. So an entry is only this control plane's to change if it
   * carries a marker signed for that exact suffix -- the same marker, the same
   * secret and the same reasoning as a published DNS record. A suffix we want
   * that somebody else already covers is a conflict, reported and left alone,
   * because overwriting it is how one team's DNS quietly becomes another's.
   */
  async plan(profile: string, zones: readonly string[], resolver: string, policyId?: string): Promise<FallbackPlan> {
    if (!this.#ownershipSecret) {
      throw new Error("PARALLAX_OWNERSHIP_SECRET is required to tell this control plane's overrides from everyone else's");
    }
    if (!resolver.trim()) {
      throw new Error("no fallbackResolver is set, so there is no address to send these zones to");
    }
    const wanted = new Map(zones.map((zone) => [normalizeSuffix(zone), normalizeSuffix(zone)]));
    const current = await (await this.#client(profile, policyId)).list();

    const add: FallbackDomain[] = [];
    const update: FallbackDomain[] = [];
    const adopt: FallbackDomain[] = [];
    const remove: FallbackDomain[] = [];
    const conflict: { suffix: string; reason: string }[] = [];
    let unchanged = 0;
    let untouched = 0;

    for (const entry of current) {
      const suffix = normalizeSuffix(entry.suffix);
      if (!this.#owns(entry)) {
        if (wanted.has(suffix)) {
          wanted.delete(suffix);
          // Claimed only when it already resolves where this would send it. The
          // write then changes nothing a device can observe -- it just records
          // whose entry it is, so the next sync can maintain it instead of
          // reporting it forever. Anything else is somebody's decision, not ours.
          const desired = this.#entry(suffix, resolver);
          if (!this.#hasOwnershipMarker(entry) && sameServers(entry, desired)) adopt.push(desired);
          else {
            conflict.push({ suffix, reason: "an entry for this suffix sends it somewhere else, and Parallax did not create it" });
          }
        } else untouched += 1;
        continue;
      }
      if (!wanted.has(suffix)) {
        // Ours, and no longer describes a zone we hold. Leaving it would send
        // devices to this resolver for a name it has stopped answering for.
        remove.push(entry);
        continue;
      }
      wanted.delete(suffix);
      const desired = this.#entry(suffix, resolver);
      if (sameEntry(entry, desired)) unchanged += 1;
      else update.push(desired);
    }
    for (const suffix of wanted.keys()) add.push(this.#entry(suffix, resolver));
    return { add, update, remove, adopt, conflict, unchanged, untouched };
  }

  /**
   * Applies a plan. Reads again rather than trusting the list the plan was built
   * from: between the two the list may have moved, and this writes all of it.
   */
  async sync(profile: string, zones: readonly string[], resolver: string, policyId?: string): Promise<{ plan: FallbackPlan; domains: FallbackDomain[] }> {
    const plan = await this.plan(profile, zones, resolver, policyId);
    if (plan.add.length === 0 && plan.update.length === 0 && plan.remove.length === 0 && plan.adopt.length === 0) {
      return { plan, domains: await this.list(profile, policyId) };
    }
    const client = await this.#client(profile, policyId);
    const current = await client.list();
    const removing = new Set(plan.remove.map((entry) => normalizeSuffix(entry.suffix)));
    const updates = new Map(plan.update.map((entry) => [normalizeSuffix(entry.suffix), entry]));
    const adoptions = new Map(plan.adopt.map((entry) => [normalizeSuffix(entry.suffix), entry]));
    const additions = new Map(plan.add.map((entry) => [normalizeSuffix(entry.suffix), entry]));
    for (const suffix of removing) {
      const matches = current.filter((entry) => normalizeSuffix(entry.suffix) === suffix);
      if (matches.length === 0 || matches.some((entry) => !this.#owns(entry))) {
        throw new FallbackDomainOwnershipError(`fallback domain ${suffix} changed ownership before removal`);
      }
    }
    for (const entry of current) {
      const suffix = normalizeSuffix(entry.suffix);
      if (updates.has(suffix) && !this.#owns(entry)) {
        throw new FallbackDomainOwnershipError(`fallback domain ${suffix} changed ownership before sync`);
      }
      const adoption = adoptions.get(suffix);
      if (adoption && (this.#hasOwnershipMarker(entry) || !sameServers(entry, adoption))) {
        throw new FallbackDomainOwnershipError(`fallback domain ${suffix} changed before adoption`);
      }
      if (additions.has(suffix)) {
        throw new FallbackDomainOwnershipError(`fallback domain ${suffix} appeared before sync`);
      }
    }
    const replacing = new Map([...updates, ...adoptions]);
    const next = current
      .filter((entry) => !(this.#owns(entry) && removing.has(normalizeSuffix(entry.suffix))))
      .map((entry) => replacing.get(normalizeSuffix(entry.suffix)) ?? entry);
    return { plan, domains: await client.replace([...next, ...additions.values()]) };
  }

  #entry(suffix: string, resolver: string): FallbackDomain {
    return {
      suffix,
      dnsServer: [resolver.trim()],
      description: ownershipComment(`fallback/${suffix}`, "entry", this.#ownershipSecret),
    };
  }

  /**
   * Whether this control plane wrote the entry. Bound to the suffix it sits on,
   * so a marker cannot be moved to a suffix it was not minted for.
   */
  #owns(entry: FallbackDomain): boolean {
    if (!this.#ownershipSecret) return false;
    return readOwnershipComment(entry.description, this.#ownershipSecret, `fallback/${normalizeSuffix(entry.suffix)}`) !== undefined;
  }

  #hasOwnershipMarker(entry: FallbackDomain): boolean {
    return /(?:^|\s)parallax-managed:v[23]:/u.test(entry.description ?? "");
  }

  #requireOwnershipSecret(): void {
    if (!this.#ownershipSecret) {
      throw new Error("PARALLAX_OWNERSHIP_SECRET is required to manage fallback domains safely");
    }
  }

  async #client(profile: string, policyId?: string): Promise<CloudflareFallbackDomains> {
    const secret = await this.#secrets.getProfileSecret(profile);
    if (!secret) throw new CredentialNotFoundError();
    if (!secret.accountId?.trim()) {
      // The DNS side never needed it, so a profile that works for records can
      // still be missing it, and the request would fail as a bad URL instead.
      throw new Error(`profile ${profile} has no account id; device settings are account-scoped, so set one with \`credential profile set\``);
    }
    return this.#createClient({
      token: secret.token,
      accountId: secret.accountId,
      ...(policyId ? { policyId } : {}),
    });
  }
}

/** Case, a trailing dot and a leading dot are spelling, not identity. */
function normalizeSuffix(suffix: string): string {
  return suffix.trim().toLowerCase().replace(/^\.+/u, "").replace(/\.+$/u, "");
}

/** The part a device acts on: where the name goes. */
function sameServers(left: FallbackDomain, right: FallbackDomain): boolean {
  return [...(left.dnsServer ?? [])].join(",") === [...(right.dnsServer ?? [])].join(",");
}

function sameEntry(left: FallbackDomain, right: FallbackDomain): boolean {
  return normalizeSuffix(left.suffix) === normalizeSuffix(right.suffix)
    && (left.description ?? "") === (right.description ?? "")
    && [...(left.dnsServer ?? [])].join(",") === [...(right.dnsServer ?? [])].join(",");
}
