import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLoopbackHost, readConfig, usesPlaintextPostgres } from "../src/config.ts";

describe("configuration", () => {
  it("carries only bind address, storage location, and keys", () => {
    assert.deepEqual(readConfig({}), {
      host: "127.0.0.1",
      port: 3000,
      stateFile: "data/parallax-state.json",
      providerStateFile: "data/provider-state.json",
      configurationFile: "data/parallax-config.json",
      bootstrapTokens: [],
    });
  });

  it("reads the database connection and the keys that protect stored data", () => {
    const key = Buffer.alloc(32, 7);
    const config = readConfig({
      DATABASE_URL: "postgres://parallax:test@db/parallax",
      PARALLAX_OWNERSHIP_SECRET: "test-ownership-secret-that-is-at-least-32-bytes",
      PARALLAX_CREDENTIAL_MASTER_KEY: key.toString("base64"),
    });
    assert.equal(config.databaseUrl, "postgres://parallax:test@db/parallax");
    assert.equal(config.ownershipSecret, "test-ownership-secret-that-is-at-least-32-bytes");
    assert.deepEqual(config.credentialMasterKey, key);
    assert.deepEqual(readConfig({ PARALLAX_CREDENTIAL_MASTER_KEY: key.toString("hex") }).credentialMasterKey, key);
  });

  it("rejects keys that are too short to do their job", () => {
    assert.throws(() => readConfig({ PARALLAX_OWNERSHIP_SECRET: "too-short" }), /at least 32 bytes/);
    assert.throws(
      () => readConfig({ PARALLAX_CREDENTIAL_MASTER_KEY: Buffer.alloc(31).toString("base64") }),
      /exactly 32 bytes/,
    );
  });

  it("no longer reads operational settings from the environment", () => {
    // These are stored and edited through the portal; a leftover value in the
    // environment must not quietly take effect.
    const config = readConfig({
      PARALLAX_ALLOW_LOCAL_PROVIDER: "true",
      PARALLAX_COREDNS_DIRECTORY: "/srv/coredns/zones",
      PARALLAX_PUBLIC_ORIGIN: "https://dns.example.com",
      PARALLAX_TRUST_FORWARDED_HEADERS: "true",
      PARALLAX_REVISION_RETENTION: "5",
      PARALLAX_AUDIT_RETENTION_DAYS: "5",
      PARALLAX_CLOUDFLARE_ZONES: '{"example.com":{"zoneId":"z","token":"t"}}',
      PARALLAX_CREDENTIAL_FILE: "data/credentials.enc",
    });
    assert.deepEqual(Object.keys(config).sort(), [
      "bootstrapTokens", "configurationFile", "host", "port", "providerStateFile", "stateFile",
    ]);
  });

  it("parses break-glass tokens without returning them in errors", () => {
    const token = "admin-secret-00000000000000000000";
    assert.deepEqual(readConfig({
      PARALLAX_AUTH_TOKENS: JSON.stringify([{ token, role: "admin", subject: "owner" }]),
    }).bootstrapTokens, [{ token, subject: "owner", role: "admin" }]);

    assert.throws(
      () => readConfig({ PARALLAX_AUTH_TOKENS: '[{"token":"do-not-echo"}]' }),
      (error: unknown) => error instanceof Error && !error.message.includes("do-not-echo"),
    );
    assert.throws(
      () => readConfig({ PARALLAX_AUTH_TOKENS: '[{"token":"a","role":"admin","subject":"owner"}]' }),
      /at least 32 bytes/,
    );
    assert.deepEqual(readConfig({ PARALLAX_AUTH_TOKENS: "[]" }).bootstrapTokens, []);
  });

  it("rejects invalid ports", () => {
    assert.throws(() => readConfig({ PORT: "0" }), /PORT/);
    assert.throws(() => readConfig({ PORT: "abc" }), /PORT/);
  });

  it("detects a cleartext PostgreSQL session and loopback binds", () => {
    assert.equal(usesPlaintextPostgres("postgres://u:p@db:5432/parallax"), true);
    assert.equal(usesPlaintextPostgres("postgres://u:p@db:5432/parallax?sslmode=prefer"), true);
    assert.equal(usesPlaintextPostgres("postgres://u:p@db:5432/parallax?sslmode=verify-full"), false);
    assert.equal(usesPlaintextPostgres("postgres://u:p@db:5432/parallax?ssl=true"), false);

    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
  });
});
