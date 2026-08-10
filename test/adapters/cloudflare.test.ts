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
});
