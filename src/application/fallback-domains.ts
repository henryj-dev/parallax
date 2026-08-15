import { CloudflareFallbackDomains, type FallbackDomain } from "../adapters/cloudflare-fallback.ts";
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
  /** Overridden in tests; the real one talks to the provider. */
  readonly createClient?: (options: { token: string; accountId: string; policyId?: string }) => CloudflareFallbackDomains;
}

export interface FallbackDomainChange {
  readonly domains: FallbackDomain[];
  /** What the write did, so a no-op is never reported as a change. */
  readonly outcome: "added" | "updated" | "removed" | "unchanged";
}

export class FallbackDomainService {
  readonly #secrets: ProfileSecretReader;
  readonly #createClient: NonNullable<FallbackDomainServiceOptions["createClient"]>;

  constructor(options: FallbackDomainServiceOptions) {
    this.#secrets = options.secrets;
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

function sameEntry(left: FallbackDomain, right: FallbackDomain): boolean {
  return normalizeSuffix(left.suffix) === normalizeSuffix(right.suffix)
    && (left.description ?? "") === (right.description ?? "")
    && [...(left.dnsServer ?? [])].join(",") === [...(right.dnsServer ?? [])].join(",");
}
