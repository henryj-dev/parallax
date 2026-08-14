import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The marker that says a provider record belongs to Parallax, and to which of
 * its records. It is written into whatever free-text field the provider offers:
 * a comment on a Cloudflare record, a trailing comment in a CoreDNS zone file.
 *
 * Cloudflare rejects a record comment longer than 100 characters, so the marker
 * has a hard budget. Version 2 spent it badly -- it carried the target as well,
 * base64-encoded, which made the length depend on the zone's name. A zone called
 * `tinytools.work` produced 104 characters and every create and update against
 * it failed with HTTP 400. Nothing local could see this: a stubbed fetch accepts
 * any string.
 *
 * Version 3 drops the target. It was only ever compared against a target the
 * caller already knew, and the signature covers it, so a marker copied to
 * another zone still fails there. What remains is the record id -- which must
 * survive the round trip, because it is how a provider record is matched back to
 * the desired record it came from -- and the signature.
 */

const PREFIX = "parallax-managed";
const V3 = `${PREFIX}:v3`;
const V2 = `${PREFIX}:v2`;

/**
 * Cloudflare's limit on a DNS record comment.
 *
 * It lives here so the id bound can be derived from it, and it is enforced in
 * the Cloudflare adapter -- not here. A marker is also written to a PowerDNS
 * `text` column and a zone-file comment, neither of which has a length, and a
 * limit applied to every provider would stop records that the provider actually
 * asked for from being published to a provider that never had the limit.
 */
export const MAX_MARKER_LENGTH = 100;

/**
 * The longest record id whose marker still fits a Cloudflare comment, given the
 * prefix, two separators and a 43-character signature. `validateRecordId` holds
 * ids a caller supplies to this; ids Parallax derives for the internal view are
 * built to a different bound and never reach Cloudflare.
 */
export const MAX_RECORD_ID_LENGTH = MAX_MARKER_LENGTH - V3.length - 2 - 43;

export function ownershipComment(target: string, recordId: string, secret: string): string {
  assertSecret(secret);
  // Record ids are `[a-z0-9_-]`, which needs no encoding to survive the reader's
  // pattern -- and encoding it would spend a third of the budget on nothing.
  return `${V3}:${recordId}:${sign(target, recordId, secret)}`;
}

/**
 * Reads a marker written for `target`. The target is supplied rather than
 * recovered: the caller always knows which one it is asking about, and checking
 * by recomputation means the marker does not have to carry it.
 */
export function readOwnershipComment(
  comment: string | undefined,
  secret: string,
  target: string,
): { recordId: string } | undefined {
  assertSecret(secret);
  if (!comment) return undefined;
  return readVersion3(comment, secret, target) ?? readVersion2(comment, secret, target);
}

function readVersion3(comment: string, secret: string, target: string): { recordId: string } | undefined {
  const match = new RegExp(`(?:^|\\s)${V3}:([a-z0-9_-]+):([A-Za-z0-9_-]+)(?:$|\\s)`).exec(comment);
  if (!match?.[1] || !match[2]) return undefined;
  return matches(sign(target, match[1], secret), match[2]) ? { recordId: match[1] } : undefined;
}

/**
 * Version 2 records are still live wherever the marker fit -- every CoreDNS zone
 * file, and any Cloudflare zone with a short enough name. They are read but never
 * written, so a record adopted under the old format keeps its identity and is
 * rewritten as version 3 the next time it changes.
 */
function readVersion2(comment: string, secret: string, target: string): { recordId: string } | undefined {
  const match = new RegExp(`(?:^|\\s)${V2}:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)(?:$|\\s)`).exec(comment);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  try {
    const written = decode(match[1]);
    if (written !== target) return undefined;
    const recordId = decode(match[2]);
    return matches(sign(written, recordId, secret), match[3]) ? { recordId } : undefined;
  } catch {
    return undefined;
  }
}

function matches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(target: string, recordId: string, secret: string): string {
  return createHmac("sha256", secret).update(target).update("\0").update(recordId).digest("base64url");
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("ownership secret must contain at least 32 bytes");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
