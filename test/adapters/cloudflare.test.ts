import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, it } from "node:test";

import { CloudflareProviderAdapter } from "../../src/adapters/cloudflare.ts";
import { ownershipComment } from "../../src/adapters/ownership.ts";

const OWNERSHIP_SECRET = "test-ownership-secret-that-is-at-least-32-bytes";

describe("CloudflareProviderAdapter", () => {
  it("maps provider names and recognizes only target-scoped managed comments", async () => {
    const fetch = async (): Promise<Response> => Response.json({
      success: true,
      result: [
        { id: "one", name: "example.com", type: "A", content: "192.0.2.1", ttl: 60, proxied: false, comment: ownershipComment("example.com/external", "root", OWNERSHIP_SECRET) },
        { id: "two", name: "www.example.com", type: "CNAME", content: "origin.example.net", ttl: 300, proxied: true, comment: "human owned" },
        { id: "other", name: "internal.example.com", type: "A", content: "10.0.0.1", ttl: 60, comment: ownershipComment("example.com/internal", "internal", OWNERSHIP_SECRET) },
      ],
      result_info: { page: 1, total_pages: 1 },
    });
    const adapter = new CloudflareProviderAdapter({ token: "secret", zoneId: "zone-1", fetch, ownershipSecret: OWNERSHIP_SECRET });

    assert.deepEqual(await adapter.list("example.com/external"), [
      { id: "root", providerId: "one", managed: true, name: "@", type: "A", content: "192.0.2.1", ttl: 60, proxied: false },
      { id: "two", providerId: "two", managed: false, name: "www", type: "CNAME", content: "origin.example.net", ttl: 1, proxied: true },
      { id: "other", providerId: "other", managed: false, name: "internal", type: "A", content: "10.0.0.1", ttl: 60 },
    ]);
  });

  it("lists a supported type that arrived as data rather than content", async () => {
    const fetch = async (): Promise<Response> => Response.json({
      success: true,
      result: [
        { id: "https-1", name: "_https.example.com", type: "HTTPS", data: "1 . alpn=h2", ttl: 300 },
      ],
      result_info: { page: 1, total_pages: 1 },
    });
    const adapter = new CloudflareProviderAdapter({ token: "secret", zoneId: "zone-1", fetch, ownershipSecret: OWNERSHIP_SECRET });
    assert.deepEqual(await adapter.list("example.com/external"), [
      { id: "https-1", providerId: "https-1", managed: false, name: "_https", type: "HTTPS", content: "1 . alpn=h2", ttl: 300 },
    ]);
  });

  it("lists a supported type whose RDATA arrived only as a data object", async () => {
    const fetch = async (): Promise<Response> => Response.json({
      success: true,
      result: [
        { id: "https-1", name: "_https.example.com", type: "HTTPS", data: { priority: 1, target: ".", value: "alpn=h2" }, ttl: 300 },
      ],
      result_info: { page: 1, total_pages: 1 },
    });
    const adapter = new CloudflareProviderAdapter({ token: "secret", zoneId: "zone-1", fetch, ownershipSecret: OWNERSHIP_SECRET });
    assert.deepEqual(await adapter.list("example.com/external"), [
      { id: "https-1", providerId: "https-1", managed: false, name: "_https", type: "HTTPS", content: "1 . alpn=h2", ttl: 300 },
    ]);
  });

  it("refuses to skip a supported type that has no usable RDATA", async () => {
    const fetch = async (): Promise<Response> => Response.json({
      success: true,
      result: [
        { id: "https-1", name: "_https.example.com", type: "HTTPS", ttl: 300 },
      ],
      result_info: { page: 1, total_pages: 1 },
    });
    const adapter = new CloudflareProviderAdapter({ token: "secret", zoneId: "zone-1", fetch, ownershipSecret: OWNERSHIP_SECRET });
    await assert.rejects(() => adapter.list("example.com/external"), /no usable RDATA/);
  });

  it("compares provider hostnames after trailing-dot and case differences", async () => {
    const fetch = async (): Promise<Response> => Response.json({
      success: true,
      result: [
        { id: "ns", name: "example.com", type: "NS", content: "NS1.Example.NET.", ttl: 300 },
        { id: "mx", name: "example.com", type: "MX", content: "Mail.Example.NET.", priority: 10, ttl: 300 },
      ],
      result_info: { page: 1, total_pages: 1 },
    });
    const adapter = new CloudflareProviderAdapter({ token: "secret", zoneId: "zone-1", fetch, ownershipSecret: OWNERSHIP_SECRET });
    assert.deepEqual((await adapter.list("example.com/external")).map((record) => record.content), [
      "ns1.example.net",
      "10 mail.example.net",
    ]);
  });

  it("drops proxied from types Cloudflare cannot proxy, which it reports anyway", async () => {
    // Cloudflare answers with `proxied` on every record, including TXT and MX.
    // Carrying that through would describe a record this control plane refuses.
    const fetch = async (): Promise<Response> => Response.json({
      success: true,
      result: [
        { id: "txt", name: "example.com", type: "TXT", content: "v=spf1 -all", ttl: 300, proxied: false },
        { id: "web", name: "www.example.com", type: "A", content: "192.0.2.1", ttl: 300, proxied: false },
      ],
      result_info: { page: 1, total_pages: 1 },
    });
    const adapter = new CloudflareProviderAdapter({ token: "secret", zoneId: "zone-1", fetch, ownershipSecret: OWNERSHIP_SECRET });

    assert.deepEqual(await adapter.list("example.com/external"), [
      { id: "txt", providerId: "txt", managed: false, name: "@", type: "TXT", content: "v=spf1 -all", ttl: 300 },
      // Kept here: on an address record, not proxying is a decision, not noise.
      { id: "web", providerId: "web", managed: false, name: "www", type: "A", content: "192.0.2.1", ttl: 300, proxied: false },
    ]);
  });

  it("reads a TXT value out of the quoted form Cloudflare returns it in", async () => {
    // Cloudflare hands back presentation format, and splits anything over 255
    // characters into several strings whether or not the operator did.
    const fetch = async (): Promise<Response> => Response.json({
      success: true,
      result: [
        { id: "spf", name: "example.com", type: "TXT", content: '"v=spf1 include:_spf.example.net ~all"', ttl: 300 },
        { id: "split", name: "long.example.com", type: "TXT", content: '"first half" "second half"', ttl: 300 },
        { id: "quote", name: "odd.example.com", type: "TXT", content: '"says \\"hello\\""', ttl: 300 },
        { id: "bare", name: "bare.example.com", type: "TXT", content: "unquoted=value", ttl: 300 },
      ],
      result_info: { page: 1, total_pages: 1 },
    });
    const adapter = new CloudflareProviderAdapter({ token: "secret", zoneId: "zone-1", fetch, ownershipSecret: OWNERSHIP_SECRET });

    assert.deepEqual((await adapter.list("example.com/external")).map((record) => record.content), [
      "v=spf1 include:_spf.example.net ~all",
      // Rejoined: the strings are one value, split only to satisfy the wire.
      "first halfsecond half",
      'says "hello"',
      "unquoted=value",
    ]);
  });

  it("moves the MX preference between Cloudflare's priority field and the record's content", async () => {
    // Cloudflare keeps the leading number of MX, SRV and URI RDATA in its own
    // field. The desired state keeps the whole presentation form, so the two
    // have to be taken apart on the way out and put back on the way in.
    const sent: unknown[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)));
        return Response.json({ success: true, result: {} });
      }
      return Response.json({
        success: true,
        result: [
          { id: "mx", name: "example.com", type: "MX", content: "mail.example.net", priority: 10, ttl: 300 },
          // Already in presentation form: the priority must not be added twice.
          { id: "srv", name: "_sip.example.com", type: "SRV", content: "10 5 5060 sip.example.net", priority: 10, ttl: 300 },
          // The shape a live zone actually returns: weight, port and target, with
          // the priority in its own field. This one begins with a digit as well,
          // which is why "does it start with a number" could not tell the two
          // apart -- and why adopting an SRV failed until it counted fields.
          { id: "srv-live", name: "_autodiscover._tcp.example.com", type: "SRV", content: "0 443 mx.example.com", priority: 1, ttl: 300 },
          // Same shape one field down: weight and target, priority separate.
          { id: "uri", name: "_ftp.example.com", type: "URI", content: '10 "ftp://ftp.example.com/"', priority: 5, ttl: 300 },
        ],
        result_info: { page: 1, total_pages: 1 },
      });
    };
    const adapter = new CloudflareProviderAdapter({ token: "secret", zoneId: "zone-1", fetch, ownershipSecret: OWNERSHIP_SECRET });

    assert.deepEqual((await adapter.list("example.com/external")).map((record) => record.content), [
      "10 mail.example.net",
      "10 5 5060 sip.example.net",
      "1 0 443 mx.example.com",
      '5 10 "ftp://ftp.example.com/"',
    ]);

    await adapter.apply("example.com/external", {
      kind: "create",
      desired: { id: "mail", name: "@", type: "MX", content: "20 backup.example.net", ttl: 300 },
    });
    assert.deepEqual(sent, [{
      name: "example.com", type: "MX", content: "backup.example.net", priority: 20, ttl: 300,
      comment: (sent[0] as { comment: string }).comment,
    }]);
  });

  it("refuses a record whose ownership marker will not fit a Cloudflare comment", async () => {
    const calls: string[] = [];
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      calls.push(String(input));
      return Response.json({ success: true, result: {} });
    };
    const adapter = new CloudflareProviderAdapter({ token: "secret", zoneId: "zone-1", fetch, ownershipSecret: OWNERSHIP_SECRET });

    await assert.rejects(
      adapter.apply("example.com/external", {
        kind: "create",
        desired: { id: "a".repeat(64), name: "www", type: "A", content: "192.0.2.1", ttl: 300 },
      }),
      (error: Error) => {
        assert.equal(error.name, "ProviderConstraintError");
        // Naming Cloudflare matters: the same record publishes fine elsewhere.
        assert.match(error.message, /Cloudflare allows 100 characters/);
        assert.match(error.message, new RegExp(`record ${"a".repeat(64)}`));
        return true;
      },
    );
    assert.deepEqual(calls, [], "the record must not be sent before the marker is known to fit");
  });

  it("creates fully-qualified records with authorization, ownership metadata and Cloudflare Auto TTL", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return Response.json({ success: true, result: { id: "created" } });
    };
    const adapter = new CloudflareProviderAdapter({ token: "secret", zoneId: "zone-1", fetch, ownershipSecret: OWNERSHIP_SECRET });

    await adapter.apply("example.com/external", {
      kind: "create",
      desired: { id: "web", name: "www", type: "A", content: "192.0.2.10", ttl: 120, proxied: true },
    });

    assert.equal(calls[0]?.url, "https://api.cloudflare.com/client/v4/zones/zone-1/dns_records");
    assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer secret");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      name: "www.example.com",
      type: "A",
      content: "192.0.2.10",
      ttl: 1,
      proxied: true,
      comment: ownershipComment("example.com/external", "web", OWNERSHIP_SECRET),
    });
  });

  it("normalizes proxied provider responses to Auto TTL", async () => {
    const fetch = async (): Promise<Response> => Response.json({
      success: true,
      result: [{
        id: "one", name: "www.example.com", type: "A", content: "8.8.8.8", ttl: 300, proxied: true,
        comment: ownershipComment("example.com/external", "web", OWNERSHIP_SECRET),
      }],
      result_info: { total_pages: 1 },
    });
    const adapter = new CloudflareProviderAdapter({ token: "secret", zoneId: "zone-1", fetch, ownershipSecret: OWNERSHIP_SECRET });
    assert.equal((await adapter.list("example.com/external"))[0]?.ttl, 1);
  });

  it("redacts credentials from transport and API failures", async () => {
    const transport = new CloudflareProviderAdapter({
      token: "super-secret",
      zoneId: "zone-1",
      ownershipSecret: OWNERSHIP_SECRET,
      fetch: async () => { throw new Error("Bearer super-secret failed"); },
    });
    await assert.rejects(() => transport.list("example.com/external"), (error: unknown) => {
      assert.match(String(error), /\[redacted\]/);
      assert.doesNotMatch(String(error), /super-secret/);
      assert.doesNotMatch(inspect(error), /super-secret/);
      return true;
    });

    const api = new CloudflareProviderAdapter({
      token: "super-secret",
      zoneId: "zone-1",
      ownershipSecret: OWNERSHIP_SECRET,
      fetch: async () => Response.json({ success: false, errors: [{ code: 10000, message: "token super-secret invalid" }] }, { status: 403 }),
    });
    await assert.rejects(() => api.list("example.com/external"), /HTTP 403; codes 10000/);
  });

  it("revalidates target ownership before updates and deletes", async () => {
    const methods: string[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      methods.push(init?.method ?? "GET");
      return Response.json({ success: true, result: {
        id: "foreign", name: "www.example.com", type: "A", content: "192.0.2.1", ttl: 60, comment: "human owned",
      } });
    };
    const adapter = new CloudflareProviderAdapter({ token: "secret", zoneId: "zone-1", fetch, ownershipSecret: OWNERSHIP_SECRET });
    await assert.rejects(
      () => adapter.apply("example.com/external", { kind: "update", providerId: "foreign", desired: { id: "web", name: "www", type: "A", content: "192.0.2.2", ttl: 60 } }),
      /not owned/,
    );
    assert.deepEqual(methods, ["GET"]);

    await assert.rejects(
      () => adapter.apply("example.com/external", { kind: "delete", providerId: "foreign", actual: { id: "root", providerId: "owned", managed: true, name: "@", type: "A", content: "192.0.2.1", ttl: 60 } }),
      /does not match/,
    );
    assert.deepEqual(methods, ["GET"]);
  });

  it("bounds request time and provider pagination", async () => {
    let signal: AbortSignal | undefined;
    const adapter = new CloudflareProviderAdapter({
      token: "secret",
      zoneId: "zone-1",
      timeoutMs: 25,
      maxPages: 2,
      ownershipSecret: OWNERSHIP_SECRET,
      fetch: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return Response.json({ success: true, result: [], result_info: { total_pages: 3 } });
      },
    });
    await assert.rejects(() => adapter.list("example.com/external"), /pagination exceeds/);
    assert.ok(signal instanceof AbortSignal);
  });

  describe("which names Workers and R2 publish for themselves", () => {
    const serviceFetch = (paths: string[]) => async (input: string | URL | Request): Promise<Response> => {
      const path = String(input);
      paths.push(path.replace("https://api.cloudflare.com/client/v4", ""));
      if (path.includes("/workers/domains")) {
        return Response.json({
          success: true,
          result: [
            { id: "d1", hostname: "example.com", service: "example-dashboard", zone_id: "zone-1" },
            { id: "d2", hostname: "contract-api.example.com", service: "tiny-contract-api", zone_id: "zone-1" },
          ],
        });
      }
      if (path.includes("/r2/buckets/")) {
        const bucket = /\/r2\/buckets\/([^/]+)\//u.exec(path)?.[1];
        return Response.json({
          success: true,
          result: {
            domains: bucket === "example-static"
              ? [{ domain: "static-apps.example.com", enabled: true }, { domain: "cdn.elsewhere.test", enabled: true }]
              : [{ domain: "static-toss.example.com", enabled: false }],
          },
        });
      }
      return Response.json({ success: true, result: { buckets: [{ name: "example-static" }, { name: "appintoss" }] } });
    };

    it("names the worker and the bucket behind each hostname in this zone", async () => {
      const paths: string[] = [];
      const adapter = new CloudflareProviderAdapter({
        token: "secret", zoneId: "zone-1", accountId: "acct-1",
        ownershipSecret: OWNERSHIP_SECRET, fetch: serviceFetch(paths),
      });

      assert.deepEqual(await adapter.serviceOwnership("example.com/external"), [
        { name: "@", service: "worker", resource: "example-dashboard" },
        { name: "contract-api", service: "worker", resource: "tiny-contract-api" },
        { name: "static-apps", service: "r2", resource: "example-static" },
        // Disabled, not removed: the bucket stopped serving the name, it did
        // not hand the record back, so the record is still not ours to edit.
        { name: "static-toss", service: "r2", resource: "appintoss" },
      ]);
      assert.ok(paths[0]?.includes("zone_id=zone-1"), "the Workers lookup is filtered to this zone");
      assert.ok(!paths.some((path) => path.includes("cdn.elsewhere")), "a bucket domain in another zone is simply not ours");
    });

    it("says so instead of guessing when no account id was configured", async () => {
      // The zone reconciles without one -- DNS is zone-scoped and these lookups
      // are not -- so this has to fail loudly rather than report nothing owned,
      // which is the answer that unlocks every row.
      const adapter = new CloudflareProviderAdapter({
        token: "secret", zoneId: "zone-1", ownershipSecret: OWNERSHIP_SECRET,
        fetch: async () => Response.json({ success: true, result: [] }),
      });
      await assert.rejects(() => adapter.serviceOwnership("example.com/external"), /account id/u);
    });

    it("refuses a partial answer when an account holds more buckets than it will read", async () => {
      const adapter = new CloudflareProviderAdapter({
        token: "secret", zoneId: "zone-1", accountId: "acct-1", maxBuckets: 1,
        ownershipSecret: OWNERSHIP_SECRET, fetch: serviceFetch([]),
      });
      await assert.rejects(() => adapter.serviceOwnership("example.com/external"), /cannot be read completely/u);
    });
  });
});
