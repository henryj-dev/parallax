import assert from "node:assert/strict";

/**
 * What a browser will refuse to store, checked on every Set-Cookie line.
 *
 * Chrome drops a `__Host-` cookie that is not Secure, not `Path=/`, or carries a Domain, and a
 * `__Secure-` cookie that is not Secure -- silently, so the server looks healthy while every
 * browser sign-in fails. A raw HTTP client stores anything and cannot catch it.
 */
export function assertStorableCookies(lines: readonly string[], where = "response"): void {
  for (const line of lines) {
    const [pair, ...attributes] = line.split(";").map((part) => part.trim());
    const name = pair!.slice(0, pair!.indexOf("="));
    const lower = attributes.map((attribute) => attribute.toLowerCase());
    if (name.startsWith("__Host-")) {
      assert.ok(lower.includes("secure"), `${where}: ${name} must be Secure`);
      assert.ok(lower.includes("path=/"), `${where}: ${name} must be Path=/ (${line})`);
      assert.ok(!lower.some((attribute) => attribute.startsWith("path=") && attribute !== "path=/"), `${where}: ${name} has another Path`);
      assert.ok(!lower.some((attribute) => attribute.startsWith("domain=")), `${where}: ${name} must not carry a Domain`);
    } else if (name.startsWith("__Secure-")) {
      assert.ok(lower.includes("secure"), `${where}: ${name} must be Secure`);
    }
  }
}
