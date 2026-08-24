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
      portalSignIn: "prompt",
    });
  });

  describe("how long a stale snapshot may still be called ready", () => {
    // stardust's probe gates the endpoints of a service that also carries DNS,
    // with one replica -- so going unready removes a resolver that is still
    // answering correctly. How long that should take is a fact about their
    // topology, and this is the lever for it.
    it("stays at ten seconds when nothing says otherwise", () => {
      assert.equal(readConfig({}).readinessMaxStalenessMs, undefined, "unset means the monitor's own default");
    });

    it("takes seconds, because that is what a probe is written in", () => {
      assert.equal(readConfig({ PARALLAX_READINESS_MAX_STALENESS_SECONDS: "45" }).readinessMaxStalenessMs, 45_000);
    });

    it("refuses a value that is not a whole number of seconds in range", () => {
      for (const bad of ["0", "-1", "1.5", "abc", "86401"]) {
        assert.throws(() => readConfig({ PARALLAX_READINESS_MAX_STALENESS_SECONDS: bad }),
          /between 1 and 86400/u, `accepted ${bad}`);
      }
    });
  });

  describe("what the portal offers a visitor who has not signed in", () => {
    /** Enough of an identity provider for the setting to be allowed. */
    const IDENTITY = {
      PARALLAX_OIDC_ISSUER: "https://idp.example.com",
      PARALLAX_OIDC_CLIENT_ID: "parallax",
      PARALLAX_OIDC_CLIENT_SECRET: "secret",
      PARALLAX_OIDC_REDIRECT_URI: "https://dns.example.com/auth/callback",
      PARALLAX_OIDC_SESSION_SECRET: "0".repeat(32),
    };

    it("sends them to the provider when asked to", () => {
      assert.equal(readConfig({ ...IDENTITY, PARALLAX_PORTAL_SIGN_IN: "idp" }).portalSignIn, "idp");
    });

    it("refuses `idp` with no provider to send them to", () => {
      // Falling back would leave the prompt this setting exists to remove, and
      // the only symptom would be a login page somebody thought they had taken
      // away.
      assert.throws(() => readConfig({ PARALLAX_PORTAL_SIGN_IN: "idp" }), /PARALLAX_OIDC_ISSUER/u);
    });

    it("refuses a value it does not know rather than guessing which was meant", () => {
      assert.throws(() => readConfig({ ...IDENTITY, PARALLAX_PORTAL_SIGN_IN: "oidc" }), /must be one of/u);
    });

    it("keeps the prompt when nothing is set, provider or not", () => {
      assert.equal(readConfig(IDENTITY).portalSignIn, "prompt");
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
    // `portalSignIn` belongs with `oidc` rather than with these: it names which
    // identity source this deployment uses, and editing it through the portal
    // would be the one setting able to lock the editor out of the portal.
    assert.deepEqual(Object.keys(config).sort(), [
      "bootstrapTokens", "configurationFile", "host", "port", "portalSignIn", "providerStateFile", "stateFile",
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

  /**
   * `ssl=true` is accepted and `sslmode=require` is not, which reads backwards
   * until it is measured against the driver actually in use.
   *
   * `pg-connection-string` 2.14.0 turns `ssl=true` into the boolean `true`,
   * which reaches `tls.connect` as its whole options object -- and Node's
   * default there is `rejectUnauthorized: true`. Chain and hostname are both
   * checked. This pins the reading so the next person does not undo it from
   * the names alone, as this audit briefly did.
   */
  it("accepts the ssl form that verifies and refuses the one that need not", () => {
    assert.equal(usesPlaintextPostgres("postgres://u:p@db:5432/parallax?ssl=true"), false);
    assert.equal(usesPlaintextPostgres("postgres://u:p@db:5432/parallax?sslmode=require"), true);
    assert.throws(
      () => readConfig({ DATABASE_URL: "postgres://u:p@db:5432/parallax?sslmode=require" }),
      /verify-full/u,
    );
    assert.equal(
      readConfig({ DATABASE_URL: "postgres://u:p@db:5432/parallax?ssl=true" }).databaseUrl,
      "postgres://u:p@db:5432/parallax?ssl=true",
    );
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
      transferAllow: [],
      tsigKeys: [],
      limits: {},
    });
  });

  /**
   * The listener has always had these; nothing reached them, so an operator
   * could not lower a single one without editing the source. An absent value
   * must stay absent, or exposing them would change what an existing
   * deployment does.
   */
  it("reads the listener's limits, and leaves them to the listener when unset", () => {
    assert.deepEqual(readConfig({ PARALLAX_DNS_PORT: "53" }).dns?.limits, {});
    assert.deepEqual(
      readConfig({
        PARALLAX_DNS_PORT: "53",
        PARALLAX_DNS_RATE_LIMIT_PER_SECOND: "20",
        PARALLAX_DNS_RATE_LIMIT_BURST: "40",
        PARALLAX_DNS_RATE_LIMIT_MAX_CLIENTS: "50000",
        PARALLAX_DNS_FORWARD_TIMEOUT_MS: "2000",
        PARALLAX_DNS_MAX_CONCURRENT_FORWARDS: "64",
        PARALLAX_DNS_MAX_TCP_CONNECTIONS: "128",
      }).dns?.limits,
      {
        rateLimitPerSecond: 20,
        rateLimitBurst: 40,
        rateLimitMaxClients: 50_000,
        forwardTimeoutMs: 2000,
        maxConcurrentForwards: 64,
        maxTcpConnections: 128,
      },
    );
    for (const bad of ["0", "-1", "1.5", "many"]) {
      assert.throws(
        () => readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_RATE_LIMIT_PER_SECOND: bad }),
        /PARALLAX_DNS_RATE_LIMIT_PER_SECOND must be an integer/u,
      );
    }
    // A bucket that can never fill refuses traffic the rate says is allowed,
    // and the symptom is intermittent -- worth refusing to start over.
    assert.throws(
      () => readConfig({
        PARALLAX_DNS_PORT: "53",
        PARALLAX_DNS_RATE_LIMIT_PER_SECOND: "100",
        PARALLAX_DNS_RATE_LIMIT_BURST: "50",
      }),
      /BURST must be at least/u,
    );
  });

  it("takes the DNS listener's own host, and otherwise the portal's, rather than every address", () => {
    // A resolver that starts answering the whole network because a port was set
    // is not a default anybody should have to discover.
    assert.equal(readConfig({ PARALLAX_DNS_PORT: "53", HOST: "10.0.0.5" }).dns?.host, "10.0.0.5");
    assert.equal(readConfig({ PARALLAX_DNS_PORT: "53", HOST: "10.0.0.5", PARALLAX_DNS_HOST: "0.0.0.0" }).dns?.host, "0.0.0.0");
  });

  /**
   * Checked at startup rather than at the first query. A name that will not
   * encode makes every SOA throw while it is being assembled -- and an SOA is
   * what a negative answer carries, so the symptom would be that NXDOMAIN
   * stops working on a listener that looks healthy.
   */
  it("validates the SOA names, and derives them when unset", () => {
    assert.equal(readConfig({ PARALLAX_DNS_PORT: "53" }).dns?.soaPrimary, undefined);
    assert.equal(
      readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_SOA_PRIMARY: "NS1.Real.Example." }).dns?.soaPrimary,
      "ns1.real.example",
    );
    assert.equal(
      readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_SOA_MAILBOX: "dns.real.example" }).dns?.soaMailbox,
      "dns.real.example",
    );
    for (const bad of ["notfullyqualified", "has space.example", "-leading.example", "a..b"]) {
      assert.throws(
        () => readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_SOA_PRIMARY: bad }),
        /PARALLAX_DNS_SOA_PRIMARY must be a fully-qualified domain name/u,
        bad,
      );
    }
  });

  it("reads NOTIFY destinations only when they are named", () => {
    assert.equal(readConfig({ PARALLAX_DNS_PORT: "53" }).dns?.notifyTo, undefined);
    assert.deepEqual(
      readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_NOTIFY_TO: " 127.0.0.1:5300 , 10.0.0.2 " }).dns?.notifyTo,
      ["127.0.0.1:5300", "10.0.0.2"],
    );
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

  it("denies zone transfers by default and validates their separate allowlist", () => {
    assert.deepEqual(readConfig({ PARALLAX_DNS_PORT: "53" }).dns?.transferAllow, []);
    assert.deepEqual(readConfig({
      PARALLAX_DNS_PORT: "53",
      PARALLAX_DNS_TRANSFER_ALLOW: "10.0.0.2/32, 2001:db8::/48",
    }).dns?.transferAllow, ["10.0.0.2/32", "2001:db8::/48"]);
    assert.throws(
      () => readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_TRANSFER_ALLOW: "10.0.0.0/99" }),
      /PARALLAX_DNS_TRANSFER_ALLOW contains an invalid prefix/,
    );
    assert.throws(
      () => readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_TRANSFER_ALLOW: "not-an-address" }),
      /PARALLAX_DNS_TRANSFER_ALLOW contains an invalid address/,
    );
  });

  it("reads a server to publish the internal view into, and the key it is named with", () => {
    const secret = Buffer.alloc(32, 4).toString("base64");
    const base = {
      PARALLAX_DNS_PORT: "53",
      PARALLAX_OWNERSHIP_SECRET: "an-ownership-secret-of-at-least-32-bytes",
      PARALLAX_DNS_TSIG_KEYS: `update.key:hmac-sha256:${secret}`,
    };
    const update = readConfig({ ...base, PARALLAX_DNS_INTERNAL_UPDATE: "10.0.0.9:5353#update.key" }).dns?.internalUpdate;
    assert.equal(update?.host, "10.0.0.9");
    assert.equal(update?.port, 5353);
    // Named, not repeated: one secret authorises the transfer and the update,
    // and a second copy is a second thing to rotate.
    assert.equal(update?.key.name, "update.key");
    assert.deepEqual(update?.key.secret, Buffer.from(secret, "base64"));

    assert.equal(readConfig({ ...base }).dns?.internalUpdate, undefined);
    assert.deepEqual(readConfig({ ...base, PARALLAX_DNS_INTERNAL_UPDATE: "[2001:db8::9]:53#update.key" }).dns?.internalUpdate?.host, "2001:db8::9");

    assert.throws(
      () => readConfig({ ...base, PARALLAX_DNS_INTERNAL_UPDATE: "10.0.0.9:53#absent.key" }),
      /names key absent.key, which is not in PARALLAX_DNS_TSIG_KEYS/,
    );
    assert.throws(
      () => readConfig({ ...base, PARALLAX_DNS_INTERNAL_UPDATE: "10.0.0.9:53" }),
      /must be host:port#keyname/,
    );
    // Publishing into another server writes ownership markers into it, and
    // there is no marker without a secret. Refused here so `config check` says
    // so before a rollout rather than the adapter's constructor after one.
    assert.throws(
      () => readConfig({
        PARALLAX_DNS_PORT: "53",
        PARALLAX_DNS_TSIG_KEYS: `update.key:hmac-sha256:${secret}`,
        PARALLAX_DNS_INTERNAL_UPDATE: "10.0.0.9:53#update.key",
      }),
      /needs PARALLAX_OWNERSHIP_SECRET/,
    );
  });

  it("reads TSIG keys and refuses ones that would not authenticate anything", () => {
    const secret = Buffer.alloc(32, 4).toString("base64");
    assert.deepEqual(readConfig({ PARALLAX_DNS_PORT: "53" }).dns?.tsigKeys, []);
    const keys = readConfig({
      PARALLAX_DNS_PORT: "53",
      PARALLAX_DNS_TSIG_KEYS: `transfer.key:hmac-sha256:${secret}, second.key:hmac-sha512:${secret}`,
    }).dns?.tsigKeys ?? [];
    assert.deepEqual(keys.map((key) => `${key.name}/${key.algorithm}`), ["transfer.key/hmac-sha256", "second.key/hmac-sha512"]);
    assert.deepEqual(keys[0]?.secret, Buffer.from(secret, "base64"));
    assert.throws(
      () => readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_TSIG_KEYS: `k:hmac-sha1:${secret}` }),
      /PARALLAX_DNS_TSIG_KEYS algorithm must be one of/,
    );
    // Two entries under one name: verification takes the first and the operator
    // has no way to see which secret is in force.
    assert.throws(
      () => readConfig({ PARALLAX_DNS_PORT: "53", PARALLAX_DNS_TSIG_KEYS: `k:hmac-sha256:${secret},k:hmac-sha512:${secret}` }),
      /names k more than once/,
    );
  });
});
