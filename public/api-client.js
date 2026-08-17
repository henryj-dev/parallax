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

  return {
    /** Outside the API root: reports whether this deployment requires a token. */
    async authenticationMode() {
      const response = await fetchImpl("/health/live", { credentials: "same-origin" });
      const body = await response.json();
      return {
        mode: body?.authentication === "disabled" ? "disabled" : "required",
        identityProvider: body?.identityProvider === "available",
      };
    },

    readSession: () => request("/session"),
    createSession: (token) => request("/session", { method: "POST", body: { token } }),
    deleteSession: () => request("/session", { method: "DELETE" }),

    listZones: listAllZones,
    getZone: (zone) => request(zonePath(zone)),
    createZone: (name) => request("/zones", { method: "POST", body: { name } }),
    replaceDesired: (zone, desired, revision) =>
      request(zonePath(zone), { method: "PUT", body: desired, headers: ifMatch(revision) }),
    deleteZone: (zone, revision) => request(zonePath(zone), { method: "DELETE", headers: ifMatch(revision) }),

    zoneStatus: (zone) => request(`${zonePath(zone)}/status`),
    /** One line per zone, so a list of zones costs one request and not one each. */
    statusOverview: () => request("/status"),
    history: (zone, limit) => request(`${zonePath(zone)}/history?limit=${encodeURIComponent(limit)}`),
    preview: (zone, desired) => request(`${zonePath(zone)}/preview`, { method: "POST", body: desired }),
    apply: (zone, revision) => request(`${zonePath(zone)}/apply`, { method: "POST", headers: ifMatch(revision) }),
    adopt: (zone, revision) =>
      request(`${zonePath(zone)}/adopt?view=external`, { method: "POST", headers: ifMatch(revision) }),

    listRevisions: (zone, limit) => request(`${zonePath(zone)}/revisions?limit=${encodeURIComponent(limit)}`),
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

    getSettings: () => request("/settings"),
    saveSettings: (values) => request("/settings", { method: "PUT", body: values }),

    listTokens: () => request("/tokens"),
    issueToken: (body) => request("/tokens", { method: "POST", body }),
    revokeToken: (id) => request(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),

    /** Runs any serving command without a dedicated route; schema migration is local-CLI only. */
    runCommand: (argv) => request("/cli", { method: "POST", body: { argv } }),
  };
}
