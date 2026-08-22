/**
 * Reading one cookie out of a request, in the one way this codebase does it.
 *
 * There were two of these, and they disagreed about the case that matters. The
 * authentication side refused a name that appeared twice; the identity side
 * took the first one it saw. A cookie can be set for a parent domain by
 * anything under it, and the browser sends both -- so "first wins" lets a
 * sibling host choose the value. On the OIDC handshake cookies that is a login
 * CSRF: the victim's browser completes the attacker's authorization code and
 * the session that results is the attacker's account.
 *
 * The two differed in a second way as well, and that is why this takes a
 * validator instead of applying one. The authentication side required the value
 * to look like a token, which is right for a credential and wrong for
 * `parallax_oidc_return` -- that one holds a path, and the portal builds it
 * from `location.search` and `location.hash`. A `?` is not in the token
 * alphabet, so sharing that rule would have silently sent everyone who signed
 * in from a filtered page back to the root instead.
 *
 * So: the duplicate rule is shared, because it is a fact about how browsers
 * send cookies. What a particular value may look like stays with whoever knows.
 */
export function readCookie(
  header: string | null,
  name: string,
  isAcceptable: (value: string) => boolean = () => true,
): string | undefined {
  if (!header) return undefined;
  let candidate: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    // `< 1` and not `< 0`: an entry with an empty name is not this cookie.
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    // A second one means somebody else is also setting this name. Which of them
    // the browser puts first is not something to decide by; refuse both.
    if (candidate !== undefined) return undefined;
    try {
      const decoded = decodeURIComponent(part.slice(separator + 1).trim());
      if (decoded.length === 0 || !isAcceptable(decoded)) return undefined;
      candidate = decoded;
    } catch {
      return undefined;
    }
  }
  return candidate;
}
