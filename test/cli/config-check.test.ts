import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { after, describe, it } from "node:test";
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

/**
 * The properties stardust's procedure now rests on.
 *
 * Their env-change script runs this inside the pod that is currently serving,
 * before writing anything -- which is only safe because it opens no store and
 * binds no port. They read the file once and saw that. Nothing made it stay
 * true, and a preflight that started connecting somewhere would change what
 * their procedure does without saying so.
 *
 * Each is asserted by making the thing it must not do fail: a database that
 * refuses, paths that cannot be read, a port already taken. If the command
 * reached for any of them it would exit non-zero here.
 */
describe("what the preflight must not touch", () => {
  const holders: (() => void)[] = [];
  after(() => { for (const release of holders) release(); });

  const HOSTILE = {
    // Nothing is listening on port 1. Connecting fails, so a preflight that
    // connected could not answer `ok`.
    DATABASE_URL: "postgres://parallax:secret@127.0.0.1:1/parallax?sslmode=verify-full",
    PARALLAX_STATE_FILE: "/nonexistent/parallax/state.json",
    PARALLAX_CONFIG_FILE: "/nonexistent/parallax/config.json",
    PARALLAX_PROVIDER_STATE_FILE: "/nonexistent/parallax/provider.json",
  };

  it("answers with a database that would refuse and paths that cannot be read", async () => {
    const { stdout } = await execFileAsync(process.execPath, [ENTRY, "config", "check"], {
      env: { ...process.env, ...HOSTILE },
      timeout: CLI_TIMEOUT_MS,
    });
    assert.match(stdout, /environment=ok/u);
    assert.match(stdout, /storage=postgresql/u, "it read the connection string without using it");
  });

  it("answers with the DNS port already taken", async () => {
    // Held on both transports, which is what the listener would want.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    const datagram = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      datagram.once("error", reject);
      datagram.bind(port, "127.0.0.1", resolve);
    });
    holders.push(() => { probe.close(); datagram.close(); });

    const { stdout } = await execFileAsync(process.execPath, [ENTRY, "config", "check"], {
      env: { ...process.env, ...HOSTILE, PARALLAX_DNS_PORT: String(port), PARALLAX_DNS_HOST: "127.0.0.1" },
      timeout: CLI_TIMEOUT_MS,
    });
    assert.match(stdout, new RegExp(`dns=127\\.0\\.0\\.1:${port}`, "u"), "it reported the listener without binding it");
  });

  it("reaches nothing but the configuration reader", async () => {
    // A tripwire ahead of the two above: an import is added long before it is
    // called, and this says so at the moment it appears rather than the moment
    // it connects.
    const source = await readFile(join(import.meta.dirname, "../../src/cli/config-check.ts"), "utf8");
    const specifiers = [
      ...source.matchAll(/^import[^"']*["']([^"']+)["']/gmu),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/gu),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/gu),
    ].map((match) => match[1] as string);
    // The control: an empty list is what a clean file gives and what a broken
    // scan gives, and the assertion below cannot tell them apart.
    assert.ok(specifiers.length > 0, "the scan must find this file's imports, or its verdict is not about them");
    const unexpected = specifiers.filter((specifier) => !specifier.startsWith("node:") && specifier !== "../config.ts");
    assert.deepEqual(unexpected, [], "this file may reach node builtins and the configuration reader only");
  });

  /**
   * The two keys, as presence and nothing else.
   *
   * `ownershipSecret` is the one worth reporting: without it a Cloudflare
   * binding fails, and it fails inside the credential store where the message
   * used to point at the other key. A preflight that cannot say which of the
   * two is missing leaves the operator to find that out at the first bind.
   */
  it("reports whether each key is present, without its value or its length", () => {
    const absent = checkConfig({});
    assert.equal(absent.credentialKey, "absent");
    assert.equal(absent.ownershipSecret, "absent");

    const set = checkConfig({
      PARALLAX_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
      PARALLAX_OWNERSHIP_SECRET: "o".repeat(40),
    });
    assert.equal(set.credentialKey, "set");
    assert.equal(set.ownershipSecret, "set");

    // The combination that starts and then cannot reach a provider.
    const half = checkConfig({ PARALLAX_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 3).toString("base64") });
    assert.equal(half.credentialKey, "set");
    assert.equal(half.ownershipSecret, "absent");

    assert.equal(JSON.stringify(set).includes("o".repeat(40)), false, "no value leaks into the report");
  });
});
