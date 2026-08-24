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
 * Nothing is stored per client. The server cookie carries a version, a
 * timestamp and a keyed hash over both plus the address, so verifying it is
 * recomputing it. A client that implements none of this is unaffected: it
 * sends no cookie, gets none back, and is treated exactly as before.
 *
 * The timestamp is what stops a cookie from being a permanent key to the
 * address it names. Without one it was valid for the life of the process, so
 * anybody who had ever held a valid cookie for an address could go on spoofing
 * that address past `requireCookie` indefinitely. Every reply carries a freshly
 * stamped cookie, so a client that keeps talking never notices the window.
 */

const CLIENT_COOKIE_BYTES = 8;
/** Version, three reserved bytes, a timestamp, and eight bytes of hash. */
const SERVER_COOKIE_BYTES = 16;
const COOKIE_VERSION = 1;
const HASH_BYTES = 8;
const MIN_COOKIE_BYTES = CLIENT_COOKIE_BYTES;
const MAX_COOKIE_BYTES = CLIENT_COOKIE_BYTES + 32;

/**
 * How long a server cookie stays good, and how far ahead of us a clock may be.
 *
 * Without a timestamp a cookie was valid for the life of the process, which
 * meant that whoever obtained one for an address kept the amplification
 * defence open for that address indefinitely -- spoof the address, replay the
 * cookie, and `requireCookie` waves it through. RFC 9018 §4.3 names these
 * bounds and they are the ones used here.
 */
const MAX_COOKIE_AGE_SECONDS = 3600;
const MAX_COOKIE_SKEW_SECONDS = 300;

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
export function createDnsCookies(options: { secret?: Buffer; now?: () => number } = {}): DnsCookies {
  const secret = options.secret ?? randomBytes(32);
  const now = options.now ?? Date.now;

  /** The eight bytes that bind an address, a client cookie and a moment together. */
  const hash = (clientCookie: Buffer, clientAddress: string, preamble: Buffer): Buffer =>
    createHmac("sha256", secret)
      .update(clientAddress)
      .update("\0")
      .update(clientCookie)
      .update(preamble)
      .digest()
      .subarray(0, HASH_BYTES);

  const mint = (clientCookie: Buffer, clientAddress: string): Buffer => {
    const preamble = Buffer.alloc(SERVER_COOKIE_BYTES - HASH_BYTES);
    preamble.writeUInt8(COOKIE_VERSION, 0);
    // Three reserved bytes stay zero; RFC 9018 has them for a later use.
    preamble.writeUInt32BE(Math.floor(now() / 1000) >>> 0, 4);
    return Buffer.concat([preamble, hash(clientCookie, clientAddress, preamble)]);
  };

  /** Whether a presented cookie is one this secret minted, recently, for here. */
  const verifies = (presented: Buffer, clientCookie: Buffer, clientAddress: string): boolean => {
    if (presented.length !== SERVER_COOKIE_BYTES) return false;
    if (presented.readUInt8(0) !== COOKIE_VERSION) return false;
    const preamble = presented.subarray(0, SERVER_COOKIE_BYTES - HASH_BYTES);
    // Age first: it is the cheap check, and a cookie past its window is not
    // worth a constant-time comparison.
    const age = Math.floor(now() / 1000) - preamble.readUInt32BE(4);
    if (age > MAX_COOKIE_AGE_SECONDS || age < -MAX_COOKIE_SKEW_SECONDS) return false;
    return timingSafeEqual(presented.subarray(SERVER_COOKIE_BYTES - HASH_BYTES), hash(clientCookie, clientAddress, preamble));
  };

  return {
    evaluate(cookie, clientAddress) {
      if (cookie === undefined) return { kind: "absent" };
      if (cookie.length < MIN_COOKIE_BYTES || cookie.length > MAX_COOKIE_BYTES
        || (cookie.length > CLIENT_COOKIE_BYTES && cookie.length < CLIENT_COOKIE_BYTES + 8)) {
        return { kind: "malformed" };
      }
      const clientCookie = cookie.subarray(0, CLIENT_COOKIE_BYTES);
      // Always answered with a freshly stamped cookie, whether or not the one
      // that arrived was right: that is what lets a genuine client become
      // proven on its next query, and what lets a proven one stay proven past
      // the hour without ever being refused.
      const reply = Buffer.concat([clientCookie, mint(clientCookie, clientAddress)]);
      const presented = cookie.subarray(CLIENT_COOKIE_BYTES);
      return verifies(presented, clientCookie, clientAddress)
        ? { kind: "proven", reply }
        : { kind: "unproven", reply };
    },
  };
}
