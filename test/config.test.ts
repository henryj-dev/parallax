import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readConfig } from "../src/config.ts";

describe("configuration", () => {
  it("uses local safe defaults with authentication explicitly disabled", () => {
    assert.deepEqual(readConfig({}), {
      host: "127.0.0.1",
      port: 3000,
      stateFile: "data/parallax-state.json",
      providerStateFile: "data/provider-state.json",
      allowLocalProvider: true,
      cloudflareZones: [],
      security: { enabled: false, tokens: [] },
      trustForwardedHeaders: false,
    });
  });

  it("parses provider configuration while redacting invalid secrets", () => {
    const source = JSON.stringify({ "Example.COM.": { zoneId: "zone-1", token: "cf-secret" } });
    assert.deepEqual(readConfig({
      PARALLAX_CLOUDFLARE_ZONES: source,
      PARALLAX_COREDNS_DIRECTORY: "/srv/coredns/zones",
      PARALLAX_OWNERSHIP_SECRET: "test-ownership-secret-that-is-at-least-32-bytes",
      DATABASE_URL: "postgres://parallax:test@db/parallax",
    }), {
      host: "127.0.0.1",
      port: 3000,
      stateFile: "data/parallax-state.json",
      providerStateFile: "data/provider-state.json",
      databaseUrl: "postgres://parallax:test@db/parallax",
      coreDnsDirectory: "/srv/coredns/zones",
      ownershipSecret: "test-ownership-secret-that-is-at-least-32-bytes",
      cloudflareZones: [{ zone: "example.com", zoneId: "zone-1", token: "cf-secret" }],
      // A configured provider turns off the local fallback so a missing adapter
      // fails loudly instead of quietly writing to a file.
      allowLocalProvider: false,
      security: { enabled: false, tokens: [] },
      trustForwardedHeaders: false,
    });
    assert.throws(
      () => readConfig({ PARALLAX_CLOUDFLARE_ZONES: '{"example.com":{"token":"do-not-echo"}}' }),
      (error: unknown) => error instanceof Error && !error.message.includes("do-not-echo"),
    );
    assert.throws(() => readConfig({ PARALLAX_CLOUDFLARE_ZONES: source }), /PARALLAX_OWNERSHIP_SECRET/);
  });

  it("parses role token records without returning them in errors", () => {
    const token = "admin-secret-00000000000000000000";
    const source = JSON.stringify([{ token, role: "admin", subject: "owner" }]);
    assert.deepEqual(readConfig({ PARALLAX_AUTH_TOKENS: source }).security, {
      enabled: true,
      tokens: [{ token, role: "admin", subject: "owner" }],
    });
    assert.throws(
      () => readConfig({ PARALLAX_AUTH_TOKENS: '[{"token":"do-not-echo"}]' }),
      (error: unknown) => error instanceof Error && !error.message.includes("do-not-echo"),
    );
    // A guessable token opens the whole control plane, so it is a startup error.
    assert.throws(
      () => readConfig({ PARALLAX_AUTH_TOKENS: '[{"token":"a","role":"admin","subject":"owner"}]' }),
      /at least 32 bytes/,
    );
    assert.throws(() => readConfig({ PARALLAX_AUTH_TOKENS: "[]" }), /at least one token record/);
  });

  it("parses encrypted credential configuration only as a complete, exact 32-byte pair", () => {
    const key = Buffer.alloc(32, 7);
    const config = readConfig({
      PARALLAX_CREDENTIAL_FILE: "data/credentials.enc",
      PARALLAX_CREDENTIAL_MASTER_KEY: key.toString("base64"),
      PARALLAX_OWNERSHIP_SECRET: "test-ownership-secret-that-is-at-least-32-bytes",
    });
    assert.equal(config.credentialFile, "data/credentials.enc");
    assert.deepEqual(config.credentialMasterKey, key);
    assert.throws(() => readConfig({ PARALLAX_CREDENTIAL_FILE: "data/credentials.enc" }), /configured together/);
    assert.throws(() => readConfig({ PARALLAX_CREDENTIAL_MASTER_KEY: Buffer.alloc(31).toString("base64") }), /exactly 32 bytes/);
    assert.throws(() => readConfig({
      PARALLAX_CREDENTIAL_FILE: "data/credentials.enc",
      PARALLAX_CREDENTIAL_MASTER_KEY: key.toString("hex"),
    }), /PARALLAX_OWNERSHIP_SECRET/);
  });

  it("rejects invalid ports", () => {
    assert.throws(() => readConfig({ PORT: "0" }), /PORT/);
    assert.throws(() => readConfig({ PORT: "abc" }), /PORT/);
  });

  it("refuses a non-loopback bind without authentication", () => {
    assert.throws(() => readConfig({ HOST: "0.0.0.0" }), /PARALLAX_AUTH_TOKENS/);
    assert.equal(readConfig({
      HOST: "0.0.0.0",
      PARALLAX_AUTH_TOKENS: '[{"token":"admin-secret-00000000000000000000","role":"admin","subject":"owner"}]',
    }).security.enabled, true);
    assert.equal(readConfig({
      HOST: "0.0.0.0",
      PARALLAX_AUTH_TOKENS: '[{"token":"admin-secret-00000000000000000000","role":"admin","subject":"owner"}]',
    }).allowLocalProvider, false);
  });

  it("requires an explicit boolean for local provider mode", () => {
    assert.equal(readConfig({ PARALLAX_ALLOW_LOCAL_PROVIDER: "false" }).allowLocalProvider, false);
    assert.throws(() => readConfig({ PARALLAX_ALLOW_LOCAL_PROVIDER: "yes" }), /true or false/);
  });

  it("reads the public origin used to prove same-origin behind a TLS-terminating proxy", () => {
    assert.equal(readConfig({ PARALLAX_PUBLIC_ORIGIN: "https://dns.example.com" }).publicOrigin, "https://dns.example.com");
    assert.equal(readConfig({ PARALLAX_PUBLIC_ORIGIN: "https://dns.example.com/" }).publicOrigin, "https://dns.example.com");
    assert.equal(readConfig({ PARALLAX_TRUST_FORWARDED_HEADERS: "true" }).trustForwardedHeaders, true);
    for (const value of ["dns.example.com", "https://dns.example.com/portal", "ftp://dns.example.com"]) {
      assert.throws(() => readConfig({ PARALLAX_PUBLIC_ORIGIN: value }), /absolute http or https origin/, value);
    }
  });
});
