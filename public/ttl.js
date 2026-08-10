export const CLOUDFLARE_AUTO_TTL = 1;
export const CLOUDFLARE_AUTO_TTL_SECONDS = 300;
export const CLOUDFLARE_DNS_ONLY_MIN_TTL = 60;
export const CLOUDFLARE_MAX_TTL = 86_400;

export function effectiveExternalTtl(ttl, proxied) {
  return proxied ? CLOUDFLARE_AUTO_TTL : Number(ttl);
}

export function isValidDnsOnlyTtl(ttl) {
  const value = Number(ttl);
  return Number.isInteger(value)
    && (value === CLOUDFLARE_AUTO_TTL || (value >= CLOUDFLARE_DNS_ONLY_MIN_TTL && value <= CLOUDFLARE_MAX_TTL));
}

export function formatTtl(ttl) {
  return Number(ttl) === CLOUDFLARE_AUTO_TTL ? "Auto" : `${Number(ttl)}s`;
}
