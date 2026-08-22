import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * EDNS COOKIEs (RFC 7873), which are how a UDP server tells a client that
 * really is at the address it claims from one that is not.
 *
 * The problem they solve here is measured: an authoritative answer is much
 * larger than the question that asked for it -- 44 bytes in, 3944 out for one
 * name in this control plane's own zones -- and UDP source addresses are free
 * to forge. Without a cookie the only defence is a per-address rate limit, and
 * a rate limit keyed on a forged address is a budget the victim pays.
 *
 * A client sends 8 bytes of its own. The server answers with those 8 plus its
 * own 8, derived from the client's address and a secret this process holds. On
 * the next query the client sends both back, and a server cookie that verifies
 * proves the client received an answer at that address -- which a spoofer never
 * does.
 *
 * Nothing is stored per client. The server cookie is a keyed hash of the
 * address and the client cookie, so verifying it is recomputing it. A client
 * that implements none of this is unaffected: it sends no cookie, gets none
 * back, and is treated exactly as before.
 */

const CLIENT_COOKIE_BYTES = 8;
const SERVER_COOKIE_BYTES = 8;
const MIN_COOKIE_BYTES = CLIENT_COOKIE_BYTES;
const MAX_COOKIE_BYTES = CLIENT_COOKIE_BYTES + 32;

export type CookieVerdict =
  /** The client sent no cookie. Nothing to prove either way. */
  | { kind: "absent" }
  /** Malformed. RFC 7873 says answer FORMERR rather than guess. */
  | { kind: "malformed" }
  /** A client cookie with no server half, or one this secret did not make. */
  | { kind: "unproven"; reply: Buffer }
  /** The client returned a server cookie that verifies for this address. */
  | { kind: "proven"; reply: Buffer };

export interface DnsCookies {
  evaluate(cookie: Buffer | undefined, clientAddress: string): CookieVerdict;
}

/**
 * The secret lives for the life of the process and is never configured.
 *
 * A cookie is worth exactly one round trip, so losing them on restart costs a
 * client one extra exchange -- and making it configurable would add a value an
 * operator has to rotate, protect and get wrong, for nothing this needs.
 */
export function createDnsCookies(options: { secret?: Buffer } = {}): DnsCookies {
  const secret = options.secret ?? randomBytes(32);

  const serverCookieFor = (clientCookie: Buffer, clientAddress: string): Buffer =>
    createHmac("sha256", secret)
      .update(clientAddress)
      .update("\0")
      .update(clientCookie)
      .digest()
      .subarray(0, SERVER_COOKIE_BYTES);

  return {
    evaluate(cookie, clientAddress) {
      if (cookie === undefined) return { kind: "absent" };
      if (cookie.length < MIN_COOKIE_BYTES || cookie.length > MAX_COOKIE_BYTES
        || (cookie.length > CLIENT_COOKIE_BYTES && cookie.length < CLIENT_COOKIE_BYTES + 8)) {
        return { kind: "malformed" };
      }
      const clientCookie = cookie.subarray(0, CLIENT_COOKIE_BYTES);
      const expected = serverCookieFor(clientCookie, clientAddress);
      // Always answered with a fresh server cookie, whether or not the one that
      // arrived was right: that is what lets a genuine client become proven on
      // its next query instead of staying refused forever.
      const reply = Buffer.concat([clientCookie, expected]);
      const presented = cookie.subarray(CLIENT_COOKIE_BYTES);
      if (presented.length !== SERVER_COOKIE_BYTES) return { kind: "unproven", reply };
      return timingSafeEqual(presented, expected)
        ? { kind: "proven", reply }
        : { kind: "unproven", reply };
    },
  };
}
