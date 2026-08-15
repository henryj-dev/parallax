/** Builds an HTTPS redirect exclusively from the trusted stored origin. */
export function redirectLocation(publicOrigin: string, requestTarget: string | undefined): string {
  if (!publicOrigin) throw new Error("publicOrigin is required for HTTP redirects");
  const path = requestTarget?.startsWith("/") ? requestTarget : "/";
  return `${publicOrigin}${path}`;
}
