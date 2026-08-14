import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "./http-authorization.ts";

/**
 * A browser session for someone an identity provider vouched for.
 *
 * Access tokens cannot carry this. A token is a credential the deployment
 * issued and stores the digest of; an identity provider's answer is about a
 * person, expires on its own schedule, and says which role that person has
 * *there*. Minting a token at login would freeze that role until someone
 * remembered to revoke it.
 *
 * So the cookie carries the claim itself, signed. There is no session store:
 * the value is self-contained, which means it cannot be revoked before it
 * expires -- the reason the lifetime is short and the role is re-read from the
 * provider on every login rather than cached.
 */
export interface SessionClaims {
  /** The identity provider's subject. Becomes the audit actor. */
  readonly subject: string;
  readonly role: Role;
  /** Seconds since the epoch, after which the value is refused. */
  readonly expiresAt: number;
}

const VERSION = "v1";
const MIN_SECRET_BYTES = 32;

export function assertSessionSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(`session secret must contain at least ${MIN_SECRET_BYTES} bytes`);
  }
}

/** A value only the holder of the secret can produce, and anyone can read. */
export function signSession(claims: SessionClaims, secret: string): string {
  assertSessionSecret(secret);
  const payload = base64Url(Buffer.from(JSON.stringify({
    sub: claims.subject,
    role: claims.role,
    exp: claims.expiresAt,
  }), "utf8"));
  return `${VERSION}.${payload}.${base64Url(sign(payload, secret))}`;
}

/**
 * Reads a session value back, or `undefined` for anything that is not exactly
 * one this secret signed and that has not expired.
 *
 * Every failure returns the same `undefined`: which part was wrong is not a
 * distinction a caller can use, and returning it would let one be probed.
 */
export function readSession(value: string, secret: string, now: () => number = Date.now): SessionClaims | undefined {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return undefined;
  const [, payload, signature] = parts as [string, string, string];
  const expected = sign(payload, secret);
  const presented = Buffer.from(signature, "base64url");
  // Compared before the payload is parsed: a value that was not signed here is
  // not worth reading, and parsing it first would act on unauthenticated input.
  if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) return undefined;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof claims !== "object" || claims === null) return undefined;
  const { sub, role, exp } = claims as Record<string, unknown>;
  if (typeof sub !== "string" || sub.length === 0) return undefined;
  if (role !== "admin" && role !== "editor" && role !== "viewer") return undefined;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  if (exp * 1000 <= now()) return undefined;
  return { subject: sub, role, expiresAt: exp };
}

/** For the state and PKCE values, which only have to be unguessable. */
export function randomUrlSafe(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${VERSION}.${payload}`).digest();
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}
