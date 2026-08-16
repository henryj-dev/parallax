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
      DATABASE_URL: "postgres://parallax:test@db/parallax?sslmode=verify-full",
      PARALLAX_OWNERSHIP_SECRET: "test-ownership-secret-that-is-at-least-32-bytes",
      PARALLAX_CREDENTIAL_MASTER_KEY: key.toString("base64"),
    });
    assert.equal(config.databaseUrl, "postgres://parallax:test@db/parallax?sslmode=verify-full");
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
    const token = Buffer.alloc(32, 9).toString("base64url");
    assert.deepEqual(readConfig({
      PARALLAX_AUTH_TOKENS: JSON.stringify([{ token, role: "admin", subject: "owner" }]),
    }).bootstrapTokens, [{ token, subject: "owner", role: "admin" }]);

    assert.throws(
      () => readConfig({ PARALLAX_AUTH_TOKENS: '[{"token":"do-not-echo"}]' }),
      (error: unknown) => error instanceof Error && !error.message.includes("do-not-echo"),
    );
    assert.throws(
      () => readConfig({ PARALLAX_AUTH_TOKENS: '[{"token":"a","role":"admin","subject":"owner"}]' }),
      /32 random bytes/,
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
    assert.equal(usesPlaintextPostgres("host=db dbname=parallax"), true);

    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
  });

  it("fails closed on malformed and cleartext remote PostgreSQL configuration", () => {
    assert.throws(() => readConfig({ DATABASE_URL: "host=db dbname=parallax" }), /must be a PostgreSQL URL/);
    assert.throws(() => readConfig({ DATABASE_URL: "postgres://u:p@db/parallax" }), /must verify PostgreSQL TLS/);
    assert.equal(readConfig({ DATABASE_URL: "postgres://u:p@localhost/parallax" }).databaseUrl, "postgres://u:p@localhost/parallax");
    assert.equal(readConfig({
      DATABASE_URL: "postgres://u:p@db/parallax",
      PARALLAX_ALLOW_PLAINTEXT_POSTGRES: "true",
    }).databaseUrl, "postgres://u:p@db/parallax");
    assert.throws(
      () => readConfig({ PARALLAX_ALLOW_PLAINTEXT_POSTGRES: "yes" }),
      /must be true or false/,
    );
  });

  it("takes a certificate and key together or not at all", () => {
    const base = { PARALLAX_STATE_FILE: "data/state.json" };
    assert.equal(readConfig(base).tls, undefined);
    assert.deepEqual(
      readConfig({ ...base, PARALLAX_TLS_CERT_FILE: "/tls/cert.pem", PARALLAX_TLS_KEY_FILE: "/tls/key.pem" }).tls,
      { certFile: "/tls/cert.pem", keyFile: "/tls/key.pem" },
    );
    // Half a pair means the deployment meant to serve TLS, so answering the
    // port in plaintext would be worse than refusing to start.
    assert.throws(
      () => readConfig({ ...base, PARALLAX_TLS_CERT_FILE: "/tls/cert.pem" }),
      /must be set together/,
    );
    assert.throws(
      () => readConfig({ ...base, PARALLAX_TLS_KEY_FILE: "/tls/key.pem" }),
      /must be set together/,
    );
  });

  it("refuses a redirect listener with nothing to redirect to", () => {
    assert.throws(
      () => readConfig({ PARALLAX_HTTP_REDIRECT_PORT: "80" }),
      /only makes sense with TLS/,
    );
    assert.equal(
      readConfig({
        PARALLAX_TLS_CERT_FILE: "/tls/cert.pem",
        PARALLAX_TLS_KEY_FILE: "/tls/key.pem",
        PARALLAX_HTTP_REDIRECT_PORT: "80",
      }).httpRedirectPort,
      80,
    );
    assert.throws(
      () => readConfig({
        PARALLAX_TLS_CERT_FILE: "/tls/cert.pem",
        PARALLAX_TLS_KEY_FILE: "/tls/key.pem",
        PARALLAX_HTTP_REDIRECT_PORT: "0",
      }),
      /PARALLAX_HTTP_REDIRECT_PORT must be an integer/,
    );
  });

  it("binds the DNS listener only when a port names one", () => {
    assert.equal(readConfig({}).dns, undefined);
    assert.equal(readConfig({ PARALLAX_DNS_FORWARD_TO: "10.0.0.1" }).dns, undefined, "upstreams alone bind nothing");
    assert.deepEqual(readConfig({ PARALLAX_DNS_PORT: "5353" }).dns, {
      host: "127.0.0.1",
      port: 5353,
      forwardTo: [],
      forwardAllow: ["127.0.0.0/8", "::1/128"],
    });
  });

  it("takes the DNS listener's own host, and otherwise the portal's, rather than every address", () => {
    // A resolver that starts answering the whole network because a port was set
    // is not a default anybody should have to discover.
    assert.equal(readConfig({ PARALLAX_DNS_PORT: "53", HOST: "10.0.0.5" }).dns?.host, "10.0.0.5");
    assert.equal(readConfig({ PARALLAX_DNS_PORT: "53", HOST: "10.0.0.5", PARALLAX_DNS_HOST: "0.0.0.0" }).dns?.host, "0.0.0.0");
  });

  it("reads the upstreams it relays to, and refuses one it could not reach", () => {
    assert.deepEqual(
      readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_FORWARD_TO: " 10.0.0.1 , 10.0.0.2#5353 ," }).dns?.forwardTo,
      ["10.0.0.1", "10.0.0.2#5353"],
    );
    assert.throws(
      () => readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_FORWARD_TO: "10.0.0.1#notaport" }),
      /PARALLAX_DNS_FORWARD_TO \(10\.0\.0\.1#notaport\) must be an integer/,
    );
    assert.throws(
      () => readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_FORWARD_TO: "#53" }),
      /contains an upstream with no host/,
    );
    assert.throws(
      () => readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_FORWARD_TO: "10.0.0.1#" }),
      /contains an upstream with no port/,
    );
    assert.throws(() => readConfig({ PARALLAX_DNS_PORT: "70000" }), /PARALLAX_DNS_PORT must be an integer/);
  });

  it("requires an explicit forwarding allowlist on a non-loopback DNS listener", () => {
    assert.throws(
      () => readConfig({
        PARALLAX_DNS_PORT: "53",
        PARALLAX_DNS_HOST: "0.0.0.0",
        PARALLAX_DNS_FORWARD_TO: "1.1.1.1",
      }),
      /PARALLAX_DNS_FORWARD_ALLOW must explicitly name/,
    );
    assert.deepEqual(readConfig({
      PARALLAX_DNS_PORT: "53",
      PARALLAX_DNS_HOST: "0.0.0.0",
      PARALLAX_DNS_FORWARD_TO: "1.1.1.1",
      PARALLAX_DNS_FORWARD_ALLOW: "10.0.0.0/8, 2001:db8::/32",
    }).dns?.forwardAllow, ["10.0.0.0/8", "2001:db8::/32"]);
    assert.throws(
      () => readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_FORWARD_ALLOW: "10.0.0.0/99" }),
      /invalid prefix/,
    );
    assert.throws(
      () => readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_FORWARD_ALLOW: "10.0.0.0/" }),
      /invalid prefix/,
    );
    assert.throws(
      () => readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_FORWARD_ALLOW: "not-an-address" }),
      /invalid address/,
    );
  });
});
