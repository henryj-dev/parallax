import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { join } from "node:path";
import { checkConfig } from "../../src/cli/config-check.ts";

const execFileAsync = promisify(execFile);
const ENTRY = join(import.meta.dirname, "../../cmd/parallax/main.ts");
const CLI_TIMEOUT_MS = 60_000;

/** Enough of an identity provider for `idp` to be allowed. */
const IDENTITY = {
  PARALLAX_OIDC_ISSUER: "https://idp.example.com",
  PARALLAX_OIDC_CLIENT_ID: "parallax",
  PARALLAX_OIDC_CLIENT_SECRET: "secret",
  PARALLAX_OIDC_REDIRECT_URI: "https://dns.example.com/auth/callback",
  PARALLAX_OIDC_SESSION_SECRET: "0".repeat(32),
};

/**
 * What a rollout can ask before it replaces the pod.
 *
 * Startup validation is fail-closed, which on a deployment whose pod is a
 * resolver's only upstream means the whole network stops resolving and the pod
 * that used to answer is already gone. The refusal is still right; what was
 * missing was a way to meet it a minute earlier.
 */
describe("the preflight", () => {
  it("reports what would stop the process, and does not open the store", async () => {
    const checked = checkConfig({
      ...IDENTITY,
      DATABASE_URL: "",
      PARALLAX_PORTAL_SIGN_IN: "idp",
      PARALLAX_DNS_PORT: "5353",
      PARALLAX_DNS_FORWARD_TO: "1.1.1.1,1.0.0.1",
      PARALLAX_STATE_FILE: "/nonexistent/state.json",
    });
    assert.equal(checked.environment, "ok");
    assert.equal(checked.portalSignIn, "idp");
    assert.equal(checked.identityProvider, "configured");
    assert.match(checked.dns, /:5353 forward=2/u);
    // The state file above does not exist. A preflight that opened it would
    // have failed here, and this must answer about the environment alone.
  });

  it("says nothing that is a secret", () => {
    const checked = checkConfig({
      ...IDENTITY,
      DATABASE_URL: "postgres://parallax:hunter2@db/parallax?sslmode=verify-full",
      PARALLAX_AUTH_TOKENS: JSON.stringify([{ token: "A".repeat(43), subject: "s", role: "admin" }]),
    });
    const printed = JSON.stringify(checked);
    assert.ok(!printed.includes("hunter2"), "no password");
    assert.ok(!printed.includes("secret"), "no client secret");
    assert.ok(!printed.includes("A".repeat(8)), "no token material");
    assert.equal(checked.storage, "postgresql");
  });

  it("refuses `idp` with no provider, the way the server would", async () => {
    await assert.rejects(
      () => execFileAsync(process.execPath, [ENTRY, "config", "check"], {
        env: { ...process.env, DATABASE_URL: "", PARALLAX_PORTAL_SIGN_IN: "idp" },
        timeout: CLI_TIMEOUT_MS,
      }),
      (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 78, "the same class of exit the server uses for a configuration it cannot act on");
        assert.match(error.stderr ?? "", /PARALLAX_OIDC_ISSUER/u);
        return true;
      },
    );
  });

  it("passes when the provider is configured", async () => {
    // The control. Without it the refusal above could be something this command
    // does to every environment.
    const { stdout } = await execFileAsync(process.execPath, [ENTRY, "config", "check"], {
      env: { ...process.env, DATABASE_URL: "", PARALLAX_PORTAL_SIGN_IN: "idp", ...IDENTITY },
      timeout: CLI_TIMEOUT_MS,
    });
    assert.match(stdout, /environment=ok/u);
    assert.match(stdout, /portalSignIn=idp/u);
    assert.match(stdout, /identityProvider=configured/u);
  });

  it("is listed where somebody would look for it", async () => {
    // A preflight nobody knows about is not a preflight.
    const { stdout } = await execFileAsync(process.execPath, [ENTRY, "--help"], { timeout: CLI_TIMEOUT_MS });
    assert.match(stdout, /config check/u);
  });
});
