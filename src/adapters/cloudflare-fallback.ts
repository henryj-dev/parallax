/**
 * The provider's client-side DNS override list, as far as this control plane
 * needs it.
 *
 * Separate from the DNS adapter because it is a different thing wearing the same
 * credential: that one edits records inside a zone, this one edits a setting on
 * an account that decides which resolver a device asks. They share a token and
 * nothing else, and the permissions they need are not the same either -- which
 * is worth keeping visible rather than hiding behind one class.
 */
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FallbackDomain {
  /** Matched as a suffix: the apex stands for every name beneath it. */
  readonly suffix: string;
  /** Resolvers to ask for this suffix. Empty means the device's own. */
  readonly dnsServer?: readonly string[];
  readonly description?: string;
}

/** Raised when the credential can edit DNS but not the device settings. */
export class FallbackDomainForbiddenError extends Error {
  override readonly name = "FallbackDomainForbiddenError";
}

/**
 * Raised when the provider could not be read or written for any other reason:
 * the request did not arrive, or it did and the answer was a refusal.
 *
 * Named so the message survives the trip to an operator. Every one of these is
 * built here from a status, a set of provider error codes, or a transport
 * failure already passed through `redact`, so none of them carries the token --
 * and the alternative was the whole class arriving as "an unexpected error
 * occurred", which is the least useful sentence available on the one screen that
 * exists to explain why the overrides are not what somebody expected.
 */
export class FallbackDomainUnavailableError extends Error {
  override readonly name = "FallbackDomainUnavailableError";
}

export interface CloudflareFallbackDomainsOptions {
  readonly token: string;
  readonly accountId: string;
  /** A device settings profile, or the account default when absent. */
  readonly policyId?: string;
  readonly fetch?: Fetch;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

export class CloudflareFallbackDomains {
  readonly #token: string;
  readonly #path: string;
  readonly #fetch: Fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: CloudflareFallbackDomainsOptions) {
    if (!options.token.trim()) throw new Error("Cloudflare API token is required");
    if (!options.accountId.trim()) throw new Error("Cloudflare account id is required");
    this.#token = options.token;
    const policy = options.policyId?.trim();
    this.#path = `/accounts/${encodeURIComponent(options.accountId.trim())}/devices/policy${policy ? `/${encodeURIComponent(policy)}` : ""}/fallback_domains`;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.apiBaseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/$/u, "");
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async list(): Promise<FallbackDomain[]> {
    return readDomains(await this.#request("GET"));
  }

  /**
   * Writes the list. The whole list: the provider offers no way to add or remove
   * one entry, so every change is a replacement and a caller that has not read
   * first is about to delete everything it did not know about.
   *
   * The result is read back and checked rather than assumed, because the failure
   * this is guarding against -- entries silently missing -- looks exactly like
   * success from the status code.
   */
  async replace(domains: readonly FallbackDomain[]): Promise<FallbackDomain[]> {
    const body = domains.map((domain) => ({
      suffix: domain.suffix,
      ...(domain.dnsServer && domain.dnsServer.length > 0 ? { dns_server: [...domain.dnsServer] } : {}),
      ...(domain.description ? { description: domain.description } : {}),
    }));
    const written = readDomains(await this.#request("PUT", body));
    const missing = domains
      .map((domain) => domain.suffix.toLowerCase())
      .filter((suffix) => !written.some((domain) => domain.suffix.toLowerCase() === suffix));
    if (missing.length > 0) {
      throw new FallbackDomainUnavailableError(`Cloudflare accepted the fallback list but did not return ${missing.join(", ")}; the list may be incomplete`);
    }
    return written;
  }

  async #request(method: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${this.#path}`, {
        method,
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new FallbackDomainUnavailableError(`Cloudflare API transport failure: ${redact(error instanceof Error ? error.message : String(error), this.#token)}`);
    }
    const payload = await readJson(response);
    if (response.status === 403 || response.status === 401) {
      // The likely first answer for a credential that was made to edit DNS. Said
      // as its own kind of failure so nobody reads it as "the list is wrong".
      throw new FallbackDomainForbiddenError(
        "the stored Cloudflare token cannot read or write device settings; add Zero Trust device settings permission to it, or store a profile whose token has it",
      );
    }
    if (!response.ok || payload.success !== true) {
      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      const codes = errors.flatMap((error) => isObject(error) && (typeof error.code === "number" || typeof error.code === "string") ? [String(error.code)] : []);
      throw new FallbackDomainUnavailableError(`Cloudflare API request failed (HTTP ${response.status}${codes.length > 0 ? `; codes ${codes.join(",")}` : ""})`);
    }
    return payload;
  }
}

function readDomains(payload: Record<string, unknown>): FallbackDomain[] {
  const result = Array.isArray(payload.result) ? payload.result : [];
  return result.flatMap((entry) => {
    if (!isObject(entry) || typeof entry.suffix !== "string") return [];
    const servers = Array.isArray(entry.dns_server)
      ? entry.dns_server.filter((server): server is string => typeof server === "string")
      : [];
    return [{
      suffix: entry.suffix,
      ...(servers.length > 0 ? { dnsServer: servers } : {}),
      ...(typeof entry.description === "string" && entry.description ? { description: entry.description } : {}),
    }];
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Keeps a token out of a message built from someone else's string. */
function redact(message: string, token: string): string {
  return token ? message.split(token).join("[redacted]") : message;
}
