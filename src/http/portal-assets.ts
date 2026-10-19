/**
 * Every file the portal is allowed to fetch, and nothing else.
 *
 * An allowlist rather than a directory: a served directory turns any file that
 * lands beside the portal into a public URL, and what lands there is not always
 * what someone meant to publish.
 *
 * It lives in its own module because it has to agree with something else -- the
 * imports the portal's own modules declare -- and two lists that must agree and
 * cannot be compared are two lists that will disagree. Adding a portal module
 * without adding it here serves a page whose first import 404s, which does not
 * degrade: the module graph fails and nothing runs at all.
 */
export interface PortalAsset {
  readonly file: string;
  readonly type: string;
}

const SCRIPT = "text/javascript; charset=utf-8";

/** Account page paths, and the files only that page needs. Served only when member accounts are on. */
export const ACCOUNT_PAGE_PATHS: readonly string[] = ["/account", "/account/login", "/account/invite", "/account/reset", "/account/email"];
export const ACCOUNT_ONLY_ASSETS: readonly string[] = [...ACCOUNT_PAGE_PATHS, "/account.js", "/account.css"];

export const PORTAL_ASSETS: ReadonlyMap<string, PortalAsset> = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  // The API reference. A page, not a deployment fact -- what it draws it fetches
  // from `/api/v1/openapi.json`, which is behind the same authentication as the
  // rest of the API, so an unauthenticated visitor gets the frame and is told to
  // sign in rather than being handed a description of this control plane.
  ["/docs", { file: "docs.html", type: "text/html; charset=utf-8" }],
  ["/docs.html", { file: "docs.html", type: "text/html; charset=utf-8" }],
  ["/docs.js", { file: "docs.js", type: SCRIPT }],
  ["/docs.css", { file: "docs.css", type: "text/css; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: SCRIPT }],
  ["/api-client.js", { file: "api-client.js", type: SCRIPT }],
  ["/store.js", { file: "store.js", type: SCRIPT }],
  ["/panels.js", { file: "panels.js", type: SCRIPT }],
  ["/ttl.js", { file: "ttl.js", type: SCRIPT }],
  ["/i18n.js", { file: "i18n.js", type: SCRIPT }],
  // The member account page. One document for every account path, including the
  // three that invitation, reset and email-change mails link to; the server
  // answers them only in accounts mode (see `ACCOUNT_PAGE_PATHS`).
  ...ACCOUNT_PAGE_PATHS.map((path) => [path, { file: "account.html", type: "text/html; charset=utf-8" }] as const),
  ["/account.js", { file: "account.js", type: SCRIPT }],
  ["/account.css", { file: "account.css", type: "text/css; charset=utf-8" }],
]);
