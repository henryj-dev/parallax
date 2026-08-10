import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "parallax-managed:v2";

export function ownershipComment(target: string, recordId: string, secret: string): string {
  assertSecret(secret);
  return `${PREFIX}:${encode(target)}:${encode(recordId)}:${sign(target, recordId, secret)}`;
}

export function readOwnershipComment(comment: string | undefined, secret: string): { target: string; recordId: string } | undefined {
  assertSecret(secret);
  if (!comment) return undefined;
  const match = new RegExp(`(?:^|\\s)${PREFIX}:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)(?:$|\\s)`).exec(comment);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  try {
    const target = decode(match[1]);
    const recordId = decode(match[2]);
    const expected = Buffer.from(sign(target, recordId, secret));
    const actual = Buffer.from(match[3]);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    return { target, recordId };
  } catch {
    return undefined;
  }
}

function sign(target: string, recordId: string, secret: string): string {
  return createHmac("sha256", secret).update(target).update("\0").update(recordId).digest("base64url");
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("ownership secret must contain at least 32 bytes");
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
