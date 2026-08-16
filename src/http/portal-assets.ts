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

export const PORTAL_ASSETS: ReadonlyMap<string, PortalAsset> = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: SCRIPT }],
  ["/api-client.js", { file: "api-client.js", type: SCRIPT }],
  ["/store.js", { file: "store.js", type: SCRIPT }],
  ["/panels.js", { file: "panels.js", type: SCRIPT }],
  ["/ttl.js", { file: "ttl.js", type: SCRIPT }],
  ["/i18n.js", { file: "i18n.js", type: SCRIPT }],
]);
