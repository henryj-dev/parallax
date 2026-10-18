/**
 * The only thing in the portal that knows the server exists.
 *
 * Every method is one HTTP call and nothing else: no DOM, no shared state, no
 * side effects beyond the request. A failure becomes an ApiError carrying the
 * status, so callers decide what a 401 or a 409 means rather than having this
 * module decide for them.
 */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const DEFAULT_ROOT = "/api/v1";

export function createApiClient({ root = DEFAULT_ROOT, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  /** @type {string | undefined} */
  let csrf;
  /**
   * @param {string} path
   * @param {{ method?: string, body?: unknown, headers?: Record<string, string> }} [options]
   */
  async function request(path, { method = "GET", body, headers } = {}) {
    // The session cookie is HttpOnly, so the browser attaches it and this script
    // never reads it. `same-origin` keeps it off any cross-site request.
    const response = await fetchImpl(`${root}${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // A member session's mutations carry the token /account/me handed out.
        // Kept in memory only; a reload asks again.
        ...(csrf && method !== "GET" && method !== "HEAD" ? { "x-parallax-csrf": csrf } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const problem = await response.json();
        detail = problem.message || problem.error || detail;
      } catch {
        // A body that is not JSON leaves the status line as the best detail.
      }
      throw new ApiError(detail, response.status);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * `POST /auth/logout`, asking for the next location as JSON: a manual redirect is opaque to page
   * script, so its location could never be read and the provider's own logout never ran.
   * @param {Record<string, string>} headers
   * @returns {Promise<string | undefined>}
   */
  async function identityLogout(headers) {
    const response = await fetchImpl("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", ...headers },
    });
    if (!response.ok) throw new ApiError("sign-out failed", response.status || 503);
    const body = await response.json().catch(() => ({}));
    return typeof body?.location === "string" ? body.location : undefined;
  }
  /**
   * Follows only a provider's logout: an https location on another origin. A location on this origin is
   * never followed, because the next page could sign straight back in through the provider. Reports
   * whether it left, so the caller can show sign-in instead.
   * @param {string | undefined} location
   */
  function navigate(location) {
    if (!location || typeof globalThis.location?.assign !== "function") return false;
    let target;
    try { target = new URL(location, globalThis.location.href); } catch { return false; }
    if (target.protocol !== "https:" || target.origin === globalThis.location.origin) return false;
    globalThis.location.assign(target.href);
    return true;
  }

  const zonePath = (zone) => `/zones/${encodeURIComponent(zone)}`;
  /** Optimistic concurrency: refuse the write if the zone moved on. */
  const ifMatch = (revision) => (revision ? { "If-Match": `"${revision}"` } : {});

  async function listAllZones() {
    const zones = [];
    let offset = 0;
    for (;;) {
      const page = await request(`/zones?limit=500&offset=${offset}`);
      if (!page || !Array.isArray(page.zones)) throw new ApiError("invalid zone page", 502);
      zones.push(...page.zones);
      if (!page.hasMore) return { zones };
      // A page that claims there is more but advances nothing would otherwise
      // spin the portal forever on a malformed or mismatched server response.
      if (page.zones.length === 0) throw new ApiError("zone pagination did not advance", 502);
      offset += page.zones.length;
    }
  }

  async function listAllStatus() {
    const zones = [];
    let offset = 0;
    for (;;) {
      const page = await request(`/status?limit=500&offset=${offset}`);
      if (!page || !Array.isArray(page.zones)) throw new ApiError("invalid status page", 502);
      zones.push(...page.zones);
      if (!page.hasMore) return { zones };
      if (page.zones.length === 0) throw new ApiError("status pagination did not advance", 502);
      offset += page.zones.length;
    }
  }

  /**
   * One page, as the server offered it.
   *
   * The zone list and the status overview are drained to the end because the
   * portal genuinely needs all of both. History and revisions are not: the API
   * caps a page at 500 and the client used to defeat that cap with a loop, so
   * opening the history panel on a deployment with the default 365-day audit
   * retention pulled the whole trail into the browser -- and made the server
   * walk it with a growing `OFFSET`, which gets slower the further it goes.
   */
  async function readPage(path, key, label, { limit, offset }) {
    const join = path.includes("?") ? "&" : "?";
    const page = await request(`${path}${join}limit=${limit}&offset=${offset}`);
    if (!page || !Array.isArray(page[key])) throw new ApiError(`invalid ${label} page`, 502);
    return page;
  }

  return {
    /** Outside the API root: reports whether this deployment requires a token. */
    async authenticationMode() {
      const response = await fetchImpl("/health/live", { credentials: "same-origin" });
      const body = await response.json();
      return {
        mode: body?.authentication === "disabled" ? "disabled" : "required",
        identityProvider: body?.identityProvider === "available",
        memberAccounts: body?.memberAccounts === "available",
      };
    },

    /** The signed-in member, or an ApiError 403 when there is none. Remembers its CSRF token. */
    async readAccount() {
      const account = await request("/account/me");
      csrf = typeof account?.csrf === "string" ? account.csrf : undefined;
      return account;
    },
    /**
     * Ends a member session on the server. With an identity provider the
     * provider's own logout follows as a navigation; either way a failure is
     * reported rather than drawn as signed out.
     */
    /** Reports whether the browser is on its way to the provider's logout, so the caller does not send it elsewhere. */
    async endMemberSession({ identityProvider = false } = {}) {
      if (identityProvider) {
        const location = await identityLogout(csrf ? { "x-parallax-csrf": csrf } : {});
        csrf = undefined;
        return navigate(location);
      }
      await request("/account/logout", { method: "POST", body: {} });
      csrf = undefined;
      return false;
    },

    readSession: () => request("/session"),
    createSession: (token) => request("/session", { method: "POST", body: { token } }),
    deleteSession: () => request("/session", { method: "DELETE" }),
    /**
     * Ends the identity-provider session. Outside the API root, and a navigation
     * rather than a JSON call: the response is a redirect to the provider so it
     * can drop its own session too. `manual` keeps the Set-Cookie on this origin
     * readable; the browser is sent on only when a location is present.
     */
    /** Ends the provider session cookie here and answers where the provider's own logout is, without going there. */
    endIdentitySession: () => identityLogout({}),
    /** Follows a location `endIdentitySession` returned, once everything else is done. */
    followLocation: (location) => navigate(location),

    listZones: listAllZones,
    getZone: (zone) => request(zonePath(zone)),
    createZone: (name) => request("/zones", { method: "POST", body: { name } }),
    replaceDesired: (zone, desired, revision) =>
      request(zonePath(zone), { method: "PUT", body: desired, headers: ifMatch(revision) }),
    /** @param {string} zone @param {number | string | undefined} revision @param {{ abandonProviderRecords?: boolean }} [options] */
    deleteZone: (zone, revision, options = {}) =>
      request(
        `${zonePath(zone)}${options.abandonProviderRecords ? "?abandonProviderRecords=true" : ""}`,
        { method: "DELETE", headers: ifMatch(revision) },
      ),

    zoneStatus: (zone) => request(`${zonePath(zone)}/status`),
    listHealthChecks: (zone) => request(`${zonePath(zone)}/views/internal/health-checks`),
    setHealthCheck: (zone, name, type, policy, revision) => request(
      `${zonePath(zone)}/views/internal/health-checks/${encodeURIComponent(name)}/${encodeURIComponent(type)}`,
      { method: "PUT", body: policy, headers: ifMatch(revision) },
    ),
    deleteHealthCheck: (zone, name, type, revision) => request(
      `${zonePath(zone)}/views/internal/health-checks/${encodeURIComponent(name)}/${encodeURIComponent(type)}`,
      { method: "DELETE", headers: ifMatch(revision) },
    ),
    // Process-local: what the replica that answers makes of the addresses.
    healthCheckStatus: (zone) => request(`${zonePath(zone)}/health-check-status`),
    /** One line per zone, walked the same way as the zone list so a second page is not silently dropped. */
    statusOverview: listAllStatus,
    history: (zone, page) => readPage(`${zonePath(zone)}/history`, "entries", "history", page),
    /** Newest first, across every zone. Paged like the per-zone trail. */
    globalHistory: (page) => readPage("/history", "entries", "history", page),
    preview: (zone, desired) => request(`${zonePath(zone)}/preview`, { method: "POST", body: desired }),
    apply: (zone, revision) => request(`${zonePath(zone)}/apply`, { method: "POST", headers: ifMatch(revision) }),
    adopt: (zone, revision) =>
      request(`${zonePath(zone)}/adopt?view=external`, { method: "POST", headers: ifMatch(revision) }),

    listRevisions: (zone, page) => readPage(`${zonePath(zone)}/revisions`, "revisions", "revision", page),
    getRevision: (zone, revision) => request(`${zonePath(zone)}/revisions/${encodeURIComponent(revision)}`),
    restoreRevision: (zone, revision, expected) =>
      request(`${zonePath(zone)}/revisions/${encodeURIComponent(revision)}/restore`, {
        method: "POST",
        headers: ifMatch(expected),
      }),

    listProfiles: () => request("/credentials/profiles"),
    saveProfile: (name, body) => request(`/credentials/profiles/${encodeURIComponent(name)}`, { method: "PUT", body }),
    deleteProfile: (name) => request(`/credentials/profiles/${encodeURIComponent(name)}`, { method: "DELETE" }),
    testProfile: (name, body) =>
      request(`/credentials/profiles/${encodeURIComponent(name)}/test`, { method: "POST", body }),

    listBindings: () => request("/credentials/cloudflare"),
    saveBinding: (zone, body) => request(`/credentials/cloudflare/${encodeURIComponent(zone)}`, { method: "PUT", body }),
    deleteBinding: (zone) => request(`/credentials/cloudflare/${encodeURIComponent(zone)}`, { method: "DELETE" }),
    testBinding: (zone, body) =>
      request(`/credentials/cloudflare/${encodeURIComponent(zone)}/test`, { method: "POST", ...(body ? { body } : {}) }),

    /**
     * The client-side resolver overrides. `coverage` reaches no provider, so it
     * still answers when the credential is what is wrong -- which is the case an
     * operator is most often looking at when they ask why a zone is missing.
     */
    fallbackCoverage: (profile) => request(`/fallback/${encodeURIComponent(profile)}/coverage`),
    fallbackList: (profile) => request(`/fallback/${encodeURIComponent(profile)}`),
    fallbackPreview: (profile) => request(`/fallback/${encodeURIComponent(profile)}/preview`),
    fallbackSync: (profile) => request(`/fallback/${encodeURIComponent(profile)}/sync`, { method: "POST" }),
    setFallbackSuffix: (profile, suffix, dnsServer) =>
      request(`/fallback/${encodeURIComponent(profile)}/domains/${encodeURIComponent(suffix)}`, {
        method: "PUT",
        body: { dnsServer },
      }),
    deleteFallbackSuffix: (profile, suffix) =>
      request(`/fallback/${encodeURIComponent(profile)}/domains/${encodeURIComponent(suffix)}`, { method: "DELETE" }),

    getSettings: () => request("/settings"),
    saveSettings: (values) => request("/settings", { method: "PUT", body: values }),

    listTokens: () => request("/tokens"),
    issueToken: (body) => request("/tokens", { method: "POST", body }),
    revokeToken: (id) => request(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),

    /** Runs any serving command without a dedicated route; schema migration is local-CLI only. */
    runCommand: (argv) => request("/cli", { method: "POST", body: { argv } }),
  };
}
