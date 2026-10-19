import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";

export interface OidcVerificationPolicy {
  readonly issuer: string;
  readonly clientId: string;
  readonly algorithms: readonly ("RS256" | "ES256" | "EdDSA")[];
  /** Cross-origin JWKS locations require a separate administrator-approved origin. */
  readonly trustedJwksOrigins?: readonly string[];
  readonly trustedAdditionalAudiences?: readonly string[];
  readonly timeoutMs: number;
  readonly cooldownMs: number;
  readonly cacheMaxAgeMs: number;
  readonly maxTokenAgeSeconds: number;
  readonly clockToleranceSeconds: number;
}

export interface VerifiedOidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string | readonly string[];
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly nonce: string;
  readonly authTime?: number;
  readonly acr?: string;
  readonly amr?: readonly string[];
}

export interface IdpMfaContract {
  /** False for providers whose claims cannot establish fresh MFA (including unsupported providers). */
  readonly supportsFreshMfa: boolean;
  readonly issuer: string;
  /** Explicit provider contract identifier; an otp/mfa claim alone is not a semantics contract. */
  readonly assuranceSemantics: string;
  readonly acceptedAcr: readonly string[];
  readonly requiredAmr: readonly string[];
  readonly maxAgeSeconds: number;
}

export class OidcVerificationError extends Error {
  readonly code: "invalid-policy" | "unavailable" | "invalid-token";

  constructor(code: OidcVerificationError["code"]) {
    super(code === "invalid-policy" ? "invalid OIDC verification policy"
      : code === "unavailable" ? "identity verification unavailable" : "identity token rejected");
    this.name = "OidcVerificationError";
    this.code = code;
  }
}

// Only a successful jwtVerify call can mint an object accepted by the evidence and mapping helpers.
const verifiedPayloads = new WeakMap<VerifiedOidcIdentity, JWTPayload>();

function integer(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function text(value: unknown, max = 1024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
}

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("invalid URL");
  return url;
}

function policyCopy(policy: OidcVerificationPolicy): OidcVerificationPolicy {
  try {
    policy = { ...policy, algorithms: [...policy.algorithms], trustedJwksOrigins: [...(policy.trustedJwksOrigins ?? [])],
      trustedAdditionalAudiences: [...(policy.trustedAdditionalAudiences ?? [])] };
    httpsUrl(policy.issuer);
    if (!text(policy.clientId) || policy.algorithms.length === 0 || policy.algorithms.length > 3
      || !policy.algorithms.every((algorithm) => ["RS256", "ES256", "EdDSA"].includes(algorithm))
      || !integer(policy.timeoutMs, 1, 60000) || !integer(policy.cooldownMs, 1000, 3600000)
      || !integer(policy.cacheMaxAgeMs, 1, 86400000) || !integer(policy.maxTokenAgeSeconds, 1, 86400)
      || !integer(policy.clockToleranceSeconds, 0, 300)) throw new Error("invalid policy");
    for (const origin of policy.trustedJwksOrigins ?? []) {
      if (httpsUrl(origin).origin !== origin) throw new Error("invalid origin");
    }
    if ((policy.trustedAdditionalAudiences?.length ?? 0) > 32 || !policy.trustedAdditionalAudiences?.every((value) => text(value))) throw new Error("invalid audiences");
    return Object.freeze({ ...policy, algorithms: Object.freeze([...policy.algorithms]),
      trustedJwksOrigins: Object.freeze([...(policy.trustedJwksOrigins ?? [])]),
      trustedAdditionalAudiences: Object.freeze([...(policy.trustedAdditionalAudiences ?? [])]) });
  } catch {
    throw new OidcVerificationError("invalid-policy");
  }
}

/** Bound both the network deadline and the JSON body before passing it to jose or discovery parsing. */
async function boundedResponse(fetchImpl: typeof fetch, url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error",
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline });
  if (response.status !== 200 || !response.body) throw new Error("invalid identity response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > 1024 * 1024) throw new Error("identity response too large");
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks), { status: 200, headers: { "content-type": "application/json" } });
}

export class OidcVerifier {
  readonly #policy: OidcVerificationPolicy;
  readonly #keys: ReturnType<typeof createRemoteJWKSet>;

  private constructor(policy: OidcVerificationPolicy, jwksUri: URL, fetchImpl: typeof fetch) {
    this.#policy = policy;
    this.#keys = createRemoteJWKSet(jwksUri, {
      timeoutDuration: policy.timeoutMs, cooldownDuration: policy.cooldownMs, cacheMaxAge: policy.cacheMaxAgeMs,
      [customFetch]: async (url, options) => {
        if (url !== jwksUri.href) throw new Error("untrusted key endpoint");
        return boundedResponse(fetchImpl, url, policy.timeoutMs, options.signal);
      },
    });
  }

  /** Fetch injection is for isolated tests. Production must use TLS-validated configured endpoints. */
  static async create(policy: OidcVerificationPolicy, dependencies: { readonly fetchImpl?: typeof fetch } = {}): Promise<OidcVerifier> {
    const configured = policyCopy(policy);
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    try {
      const url = `${configured.issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`;
      const response = await boundedResponse(fetchImpl, url, configured.timeoutMs);
      const document: unknown = await response.json();
      if (typeof document !== "object" || document === null) throw new Error("invalid discovery");
      const record = document as Record<string, unknown>;
      if (record.issuer !== configured.issuer || typeof record.jwks_uri !== "string") throw new Error("invalid discovery");
      const jwksUri = httpsUrl(record.jwks_uri);
      const allowed = [new URL(configured.issuer).origin, ...(configured.trustedJwksOrigins ?? [])];
      if (!allowed.includes(jwksUri.origin)) throw new Error("untrusted discovery");
      return new OidcVerifier(configured, jwksUri, fetchImpl);
    } catch {
      throw new OidcVerificationError("unavailable");
    }
  }

  async verify(idToken: string, expectedNonce: string, nowMs: number = Date.now()): Promise<VerifiedOidcIdentity> {
    if (!text(expectedNonce) || typeof idToken !== "string" || idToken.length > 32768
      || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new OidcVerificationError("invalid-token");
    try {
      const { payload } = await jwtVerify(idToken, this.#keys, {
        issuer: this.#policy.issuer, audience: this.#policy.clientId, algorithms: [...this.#policy.algorithms],
        requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nonce"], currentDate: new Date(nowMs),
        maxTokenAge: this.#policy.maxTokenAgeSeconds, clockTolerance: this.#policy.clockToleranceSeconds,
      });
      const now = Math.floor(nowMs / 1000), tolerance = this.#policy.clockToleranceSeconds;
      const nonce = typeof payload.nonce === "string" ? Buffer.from(payload.nonce, "utf8") : Buffer.alloc(0);
      const expected = Buffer.from(expectedNonce, "utf8");
      const nonceMatches = nonce.length === expected.length && timingSafeEqual(nonce, expected);
      const validAudience = typeof payload.aud === "string" ? text(payload.aud)
        : Array.isArray(payload.aud) && payload.aud.length > 0 && payload.aud.length <= 32
          && payload.aud.every((value) => text(value)
            && (value === this.#policy.clientId || this.#policy.trustedAdditionalAudiences!.includes(value)));
      if (!text(payload.sub) || !validAudience || !integer(payload.exp!, 0, Number.MAX_SAFE_INTEGER)
        || !integer(payload.iat!, 0, Number.MAX_SAFE_INTEGER) || payload.exp! <= payload.iat!
        || payload.iat! > now + tolerance || !nonceMatches
        || (payload.azp !== undefined && payload.azp !== this.#policy.clientId)
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== this.#policy.clientId)) {
        throw new Error("invalid claims");
      }
      if (payload.auth_time !== undefined && (typeof payload.auth_time !== "number"
        || !integer(payload.auth_time, 0, payload.iat! + tolerance) || payload.auth_time > now + tolerance)) throw new Error("invalid authentication time");
      if (payload.acr !== undefined && !text(payload.acr)) throw new Error("invalid assurance");
      if (payload.amr !== undefined && (!Array.isArray(payload.amr) || payload.amr.length > 32
        || !payload.amr.every((value) => text(value, 128)))) throw new Error("invalid methods");
      const identity: VerifiedOidcIdentity = Object.freeze({
        issuer: payload.iss!, subject: payload.sub, audience: Array.isArray(payload.aud) ? Object.freeze([...payload.aud]) : payload.aud!,
        expiresAt: payload.exp!, issuedAt: payload.iat!, nonce: expectedNonce,
        ...(payload.auth_time === undefined ? {} : { authTime: payload.auth_time as number }),
        ...(payload.acr === undefined ? {} : { acr: payload.acr as string }),
        ...(payload.amr === undefined ? {} : { amr: Object.freeze([...(payload.amr as string[])]) }),
      });
      verifiedPayloads.set(identity, payload);
      return identity;
    } catch {
      throw new OidcVerificationError("invalid-token");
    }
  }
}

export function assertUserinfoSubject(identity: VerifiedOidcIdentity, userinfo: unknown): void {
  if (!verifiedPayloads.has(identity) || typeof userinfo !== "object" || userinfo === null
    || (userinfo as Record<string, unknown>).sub !== identity.subject) throw new OidcVerificationError("invalid-token");
}

/** Raw signed claim only. Normalization, JIT admission and collision rejection remain caller policy. */
export function readVerifiedOidcEmail(identity: VerifiedOidcIdentity): string | undefined {
  const payload = verifiedPayloads.get(identity);
  // Same ASCII-only rule as the account mailer: rejects C0/C1 controls, bidi controls and other non-ASCII.
  if (!payload || payload.email_verified !== true || typeof payload.email !== "string" || payload.email.length > 254
    || !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(payload.email)
    || payload.email.startsWith(".") || payload.email.includes("..") || payload.email.includes(".@")) return undefined;
  return payload.email;
}

/** Only explicit role keys are mapped. Display-label claims are never an authorization source. */
export function mapOidcRoles(identity: VerifiedOidcIdentity, claim: string, mapping: Readonly<Record<string, "viewer" | "editor" | "admin">>, expectedIssuer: string): ("viewer" | "editor" | "admin")[] {
  const payload = verifiedPayloads.get(identity);
  if (!payload || identity.issuer !== expectedIssuer || !text(claim, 128) || claim === "roles_label") return [];
  const roles = payload[claim];
  if (!Array.isArray(roles) || roles.length > 256 || !roles.every((role) => typeof role === "string")) return [];
  const mapped = roles.filter((role) => Object.hasOwn(mapping, role)).map((role) => mapping[role])
    .filter((role): role is "viewer" | "editor" | "admin" => role === "viewer" || role === "editor" || role === "admin");
  return [...new Set(mapped)];
}

/**
 * No provider contract has yet passed fresh-MFA interoperability review. Configuration cannot add
 * entries: enabling a provider requires a code-reviewed registry entry and provider integration tests.
 */
const SUPPORTED_IDP_MFA_CONTRACTS: readonly IdpMfaContract[] = Object.freeze([]);

export function readIdpMfaEvidence(identity: VerifiedOidcIdentity, contract: IdpMfaContract, nowMs: number = Date.now()): { authenticatedAt: number; assuranceSemantics: string } | undefined {
  const registered = SUPPORTED_IDP_MFA_CONTRACTS.some((entry) => entry.issuer === contract.issuer
    && entry.assuranceSemantics === contract.assuranceSemantics && entry.supportsFreshMfa === contract.supportsFreshMfa
    && entry.maxAgeSeconds === contract.maxAgeSeconds
    && JSON.stringify(entry.acceptedAcr) === JSON.stringify(contract.acceptedAcr)
    && JSON.stringify(entry.requiredAmr) === JSON.stringify(contract.requiredAmr));
  if (!registered || !verifiedPayloads.has(identity) || !contract.supportsFreshMfa || contract.issuer !== identity.issuer
    || !text(contract.assuranceSemantics, 256) || !integer(contract.maxAgeSeconds, 1, 86400)
    || !Number.isSafeInteger(nowMs) || nowMs < 0 || contract.acceptedAcr.length === 0 || contract.requiredAmr.length === 0
    || !contract.acceptedAcr.every((value) => text(value, 128)) || !contract.requiredAmr.every((value) => text(value, 128))
    || identity.authTime === undefined || identity.acr === undefined || identity.amr === undefined
    || !contract.acceptedAcr.includes(identity.acr) || !contract.requiredAmr.every((method) => identity.amr!.includes(method))) return undefined;
  const now = Math.floor(nowMs / 1000);
  // No iat fallback: a refresh token's new issuance time says nothing about a new MFA ceremony.
  if (identity.expiresAt <= now || identity.authTime > now || now - identity.authTime > contract.maxAgeSeconds) return undefined;
  return { authenticatedAt: identity.authTime, assuranceSemantics: contract.assuranceSemantics };
}
