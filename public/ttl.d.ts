export const CLOUDFLARE_AUTO_TTL: 1;
export const CLOUDFLARE_AUTO_TTL_SECONDS: 300;
export const CLOUDFLARE_DNS_ONLY_MIN_TTL: 60;
export const CLOUDFLARE_MAX_TTL: 86400;

export function effectiveExternalTtl(ttl: number | string, proxied: boolean): number;
export function isValidDnsOnlyTtl(ttl: number | string): boolean;
export function formatTtl(ttl: number | string): string;
