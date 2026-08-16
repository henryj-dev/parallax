import { CloudflareFallbackDomains, type FallbackDomain } from "../adapters/cloudflare-fallback.ts";
import { ownershipComment, readOwnershipComment } from "../adapters/ownership.ts";
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

  async list(profile: string, policyId?: string): Promise<FallbackDomain[]> {
    return (await this.#client(profile, policyId)).list();
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
    const client = await this.#client(profile, policyId);
    const current = await client.list();
    const desired: FallbackDomain = {
      suffix,
      ...(entry.dnsServer && entry.dnsServer.length > 0 ? { dnsServer: entry.dnsServer } : {}),
      ...(entry.description ? { description: entry.description } : {}),
    };
    const index = current.findIndex((domain) => normalizeSuffix(domain.suffix) === suffix);
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
    const client = await this.#client(profile, policyId);
    const current = await client.list();
    const next = current.filter((domain) => normalizeSuffix(domain.suffix) !== wanted);
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
          if (sameServers(entry, desired)) adopt.push(desired);
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
    const replacing = new Map([...plan.update, ...plan.adopt].map((entry) => [normalizeSuffix(entry.suffix), entry]));
    const next = current
      .filter((entry) => !(this.#owns(entry) && removing.has(normalizeSuffix(entry.suffix))))
      .map((entry) => replacing.get(normalizeSuffix(entry.suffix)) ?? entry);
    return { plan, domains: await client.replace([...next, ...plan.add]) };
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
