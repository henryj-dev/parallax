import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, it } from "node:test";

import { Ns1ProviderAdapter } from "../../src/adapters/ns1.ts";
import { ownershipComment } from "../../src/adapters/ownership.ts";

const OWNERSHIP_SECRET = "test-ownership-secret-that-is-at-least-32-bytes";

describe("Ns1ProviderAdapter", () => {
  it("lists provider records and recognizes only target-scoped managed metadata", async () => {
    const fetch = async (): Promise<Response> => Response.json({
      records: [
        {
          id: "one",
          domain: "example.com",
          type: "A",
          ttl: 60,
          answers: [{ answer: ["192.0.2.1"] }],
          meta: { parallax: ownershipComment("example.com/external", "root", OWNERSHIP_SECRET) },
        },
        {
          id: "two",
          domain: "www.example.com",
          type: "CNAME",
          ttl: 300,
          answers: [{ answer: ["origin.example.net"] }],
        },
        {
          id: "mx",
          domain: "example.com",
          type: "MX",
          ttl: 300,
          answers: [{ answer: ["10", "mail.example.net"] }],
        },
      ],
    });
    const adapter = new Ns1ProviderAdapter({ apiKey: "secret", fetch, ownershipSecret: OWNERSHIP_SECRET });

    assert.deepEqual(await adapter.list("example.com/external"), [
      { id: "root", providerId: "one", managed: true, name: "@", type: "A", content: "192.0.2.1", ttl: 60 },
      { id: "two", providerId: "two", managed: false, name: "www", type: "CNAME", content: "origin.example.net", ttl: 300 },
      { id: "mx", providerId: "mx", managed: false, name: "@", type: "MX", content: "10 mail.example.net", ttl: 300 },
    ]);
  });

  it("creates, updates and deletes through the NS1 record contract", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ url, method, body });
      if (method === "GET" && url.includes("/example.com/www.example.com/A")) {
        return Response.json({
          id: "web",
          domain: "www.example.com",
          type: "A",
          ttl: 60,
          answers: [{ answer: ["192.0.2.1"] }],
          meta: { parallax: ownershipComment("example.com/external", "web", OWNERSHIP_SECRET) },
        });
      }
      return Response.json({});
    };
    const adapter = new Ns1ProviderAdapter({ apiKey: "secret", fetch, ownershipSecret: OWNERSHIP_SECRET });

    await adapter.apply("example.com/external", {
      kind: "create",
      desired: { id: "web", name: "www", type: "A", content: "192.0.2.10", ttl: 120 },
    });
    await adapter.apply("example.com/external", {
      kind: "update",
      providerId: "web",
      desired: { id: "web", name: "www", type: "A", content: "192.0.2.11", ttl: 60 },
    });
    await adapter.apply("example.com/external", {
      kind: "delete",
      providerId: "web",
      actual: {
        id: "web", providerId: "web", managed: true, name: "www", type: "A", content: "192.0.2.11", ttl: 60,
      },
    });

    assert.equal(calls[0]?.method, "PUT");
    assert.match(String(calls[0]?.url), /\/zones\/example.com\/www.example.com\/A$/);
    assert.equal(new URL(String(calls[0]?.url)).pathname.endsWith("/A"), true);
    assert.deepEqual((calls[0]?.body as { answers: unknown }).answers, [{ answer: ["192.0.2.10"] }]);
    assert.equal((calls[0]?.body as { meta: { parallax: string } }).meta.parallax,
      ownershipComment("example.com/external", "web", OWNERSHIP_SECRET));
    assert.equal(calls[1]?.method, "GET");
    assert.equal(calls[2]?.method, "POST");
    assert.equal(calls[3]?.method, "GET");
    assert.equal(calls[4]?.method, "DELETE");
  });

  it("refuses to skip a supported type that has no usable RDATA", async () => {
    const fetch = async (): Promise<Response> => Response.json({
      records: [{ id: "https-1", domain: "_https.example.com", type: "HTTPS", ttl: 300, answers: [] }],
    });
    const adapter = new Ns1ProviderAdapter({ apiKey: "secret", fetch, ownershipSecret: OWNERSHIP_SECRET });
    await assert.rejects(() => adapter.list("example.com/external"), /no usable RDATA/);
  });

  it("redacts the API key from transport failures", async () => {
    const adapter = new Ns1ProviderAdapter({
      apiKey: "super-secret",
      ownershipSecret: OWNERSHIP_SECRET,
      fetch: async () => { throw new Error("key super-secret failed"); },
    });
    await assert.rejects(() => adapter.list("example.com/external"), (error: unknown) => {
      assert.match(String(error), /\[redacted\]/);
      assert.doesNotMatch(String(error), /super-secret/);
      assert.doesNotMatch(inspect(error), /super-secret/);
      return true;
    });
  });
});
