import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { createApiHandler, createNodeHandler } from "../../src/http/api.ts";
import { ProviderNotConfiguredError } from "../../src/application/ports.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";

function setup(): ReturnType<typeof createApiHandler> {
  const adapters = createInMemoryAdapters();
  return createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) });
}

function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json", "x-parallax-actor": "test-user" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("HTTP API", () => {
  it("resolves HEAD exactly like GET and answers it without a body", async () => {
    const adapters = createInMemoryAdapters();
    const handler = createNodeHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) });
    const incoming = Readable.from([]) as IncomingMessage;
    incoming.method = "HEAD";
    incoming.url = "/api/v1/zones";
    incoming.headers = { host: "localhost" };
    let status = 0;
    let responseBody: string | undefined = "unset";
    const headers: Record<string, string> = {};
    const response = {
      set statusCode(code: number) { status = code; },
      setHeader(name: string, value: string) { headers[name] = value; return this; },
      end(value?: string) { responseBody = value; return this; },
    } as unknown as ServerResponse;

    await handler(incoming, response);
    assert.equal(status, 200);
    assert.equal(responseBody, undefined);
    assert.equal(headers["content-length"], String(JSON.stringify({
      zones: [], limit: 50, offset: 0, hasMore: false,
    }).length));
  });

  it("attaches a trusted transport client key without requiring a socket on mocks", async () => {
    const adapters = createInMemoryAdapters();
    const token = "node-handler-admin-token-000000000000";
    const handler = createNodeHandler(
      { controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) },
      { enabled: true, tokens: [{ token, role: "admin", subject: "owner" }], maxFailedAttempts: 1, lockoutMs: 60_000 },
      { trustForwardedHeaders: true },
    );
    const call = async (forwardedFor: string, authorization: string): Promise<number> => {
      const incoming = Readable.from([]) as IncomingMessage;
      incoming.method = "GET";
      incoming.url = "/api/v1/zones";
      incoming.headers = { host: "localhost", "x-forwarded-for": forwardedFor, authorization };
      let status = 0;
      const response = {
        set statusCode(code: number) { status = code; },
        setHeader() { return this; },
        end() { return this; },
      } as unknown as ServerResponse;
      await handler(incoming, response);
      return status;
    };

    assert.equal(await call("spoofed-prefix, 203.0.113.10", "Bearer wrong-token-value-long-enough"), 401);
    assert.equal(await call("203.0.113.20", `Bearer ${token}`), 200);
    assert.equal(await call("different-prefix, 203.0.113.10", "Bearer another-wrong-token-value"), 429,
      "a client cannot reset or evade its bucket by changing a prepended forwarded value");
    assert.equal(await call("203.0.113.30", "Bearer wrong-token-value-long-enough"), 401);
  });

  it("adopts provider records over HTTP and refuses the call without a view", async () => {
    const adapters = createInMemoryAdapters();
    const api = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) });
    assert.equal((await api(request("/api/v1/zones", "POST", { name: "example.com" }))).status, 201);
    adapters.provider.seed("example.com/external", [
      { id: "a", name: "www", type: "A", content: "203.0.113.1", ttl: 300, providerId: "cf-1", managed: false },
    ]);

    // A missing view must be refused, not coerced into the string "undefined".
    const viewless = await api(request("/api/v1/zones/example.com/adopt", "POST", {}));
    assert.equal(viewless.status, 400);

    const response = await api(request("/api/v1/zones/example.com/adopt?view=external", "POST", {}));
    assert.equal(response.status, 200);
    const body = await response.json() as { adopted: { id: string }[] };
    assert.deepEqual(body.adopted.map((record) => record.id), ["www-a"]);
  });

  it("dry-runs adoption over HTTP and leaves the zone unchanged", async () => {
    const adapters = createInMemoryAdapters();
    const api = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) });
    assert.equal((await api(request("/api/v1/zones", "POST", { name: "example.com" }))).status, 201);
    adapters.provider.seed("example.com/external", [
      { id: "a", name: "www", type: "A", content: "203.0.113.1", ttl: 300, providerId: "cf-1", managed: false },
    ]);

    const preview = await api(request("/api/v1/zones/example.com/adopt?view=external&dryRun=true", "POST", {}));
    assert.equal(preview.status, 200);
    const body = await preview.json() as { adopted: { id: string }[]; seen: number };
    assert.equal(body.seen, 1);
    assert.deepEqual(body.adopted.map((record) => record.id), ["www-a"]);

    const zone = await (await api(request("/api/v1/zones/example.com"))).json() as {
      revision: number;
      views: Array<{ name: string; records?: unknown[] }>;
    };
    assert.equal(zone.revision, 1);
    assert.equal((zone.views ?? []).flatMap((view) => view.records ?? []).length, 0);
  });

  it("applies every pending zone from the overview over HTTP", async () => {
    const adapters = createInMemoryAdapters();
    const api = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) });
    assert.equal((await api(request("/api/v1/zones", "POST", { name: "pending.example" }))).status, 201);
    assert.equal((await api(request("/api/v1/zones/pending.example/views/external/records/web", "PUT", {
      name: "www", type: "A", content: "8.8.8.8", ttl: 300,
    }))).status, 200);
    const response = await api(request("/api/v1/apply", "POST", {}));
    assert.equal(response.status, 200);
    const body = await response.json() as { applied: string[]; skipped: string[]; failed: unknown[] };
    assert.deepEqual(body.applied, ["pending.example"]);
  });

  it("retries failed zones over HTTP only with retryFailed=true", async () => {
    const adapters = createInMemoryAdapters();
    const api = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) });
    assert.equal((await api(request("/api/v1/zones", "POST", { name: "retry.example" }))).status, 201);
    assert.equal((await api(request("/api/v1/zones/retry.example/views/external/records/web", "PUT", {
      name: "www", type: "A", content: "8.8.8.8", ttl: 300,
    }))).status, 200);
    adapters.provider.failure = new Error("provider refused");
    await api(request("/api/v1/zones/retry.example/apply", "POST", {}));
    adapters.provider.failure = undefined;

    const ordinary = await api(request("/api/v1/apply", "POST", {}));
    assert.deepEqual((await ordinary.json() as { retried: string[]; failed: { zone: string }[] }).retried, []);

    const retry = await api(request("/api/v1/apply?retryFailed=true", "POST", {}));
    assert.equal(retry.status, 200);
    assert.deepEqual((await retry.json() as { retried: string[] }).retried, ["retry.example"]);
  });

  it("exports and imports a presentation-format zone file over HTTP", async () => {
    const api = setup();
    assert.equal((await api(request("/api/v1/zones", "POST", { name: "example.com" }))).status, 201);
    const imported = await api(request("/api/v1/zones/example.com/import", "POST", {
      text: "$ORIGIN example.com.\n@ 60 IN A 8.8.8.8\n",
    }));
    assert.equal(imported.status, 200);
    const exported = await api(request("/api/v1/zones/example.com/export"));
    assert.equal(exported.status, 200);
    const body = await exported.json() as { text: string };
    assert.match(body.text, /IN A 8\.8\.8\.8/);
  });

  it("reads the audit trail without a zone", async () => {
    const api = setup();
    assert.equal((await api(request("/api/v1/zones", "POST", { name: "one.example" }))).status, 201);
    assert.equal((await api(request("/api/v1/zones", "POST", { name: "two.example" }))).status, 201);
    const page = await (await api(request("/api/v1/history"))).json() as { entries: Array<{ action: string; zone?: string }> };
    assert.ok(page.entries.some((entry) => entry.action === "zone.created"));
    assert.ok(page.entries.length >= 2);
  });

  it("reports malformed percent-encoding in a path as a client error", async () => {
    const api = setup();
    const response = await api(request("/api/v1/zones/%zz"));
    assert.equal(response.status, 400);
    assert.deepEqual((await response.json() as { error: string }).error, "validation_failed");
  });

  it("refuses views no provider can reconcile instead of storing them", async () => {
    const api = setup();
    assert.equal((await api(request("/api/v1/zones", "POST", { name: "example.com" }))).status, 201);

    const stored = await api(request("/api/v1/zones/example.com/views/staging/records/web", "PUT", {
      name: "www", type: "A", content: "8.8.8.8", ttl: 300,
    }));
    assert.equal(stored.status, 400);
    assert.match(JSON.stringify(await stored.json()), /view must be one of external or internal/);

    // The zone stays previewable rather than being poisoned by an unroutable view.
    assert.equal((await api(request("/api/v1/zones/example.com/preview"))).status, 200);
  });

  it("reports an unconfigured provider as a conflict rather than an internal error", async () => {
    const adapters = createInMemoryAdapters();
    const api = createApiHandler({
      controlPlane: new ControlPlane(adapters.zones, adapters.statuses, {
        list: () => { throw new ProviderNotConfiguredError("no provider is configured for example.com/external"); },
        apply: async () => undefined,
      }),
    });
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    await api(request("/api/v1/zones/example.com/views/external/records/web", "PUT", {
      name: "www", type: "A", content: "8.8.8.8", ttl: 300,
    }));

    const preview = await api(request("/api/v1/zones/example.com/preview"));
    assert.equal(preview.status, 409);
    assert.deepEqual(await preview.json(), {
      error: "provider_not_configured",
      message: "no provider is configured for example.com/external",
    });
  });


  it("previews the views it can read and names the ones it cannot", async () => {
    // Split-horizon materializes `internal` from `external` whether or not a
    // provider backs it, so on a deployment publishing to Cloudflare alone one
    // unreadable view used to fail the whole preview -- and preview is the step
    // that exists so nothing is applied unseen.
    const adapters = createInMemoryAdapters();
    const api = createApiHandler({
      controlPlane: new ControlPlane(adapters.zones, adapters.statuses, {
        list: async (target: string) => {
          if (target.endsWith("/internal")) throw new ProviderNotConfiguredError(`no provider is configured for ${target}`);
          return [];
        },
        apply: async () => undefined,
      }),
    });
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    await api(request("/api/v1/zones/example.com/views/external/records/web", "PUT", {
      name: "www", type: "A", content: "8.8.8.8", ttl: 300,
    }));

    const response = await api(request("/api/v1/zones/example.com/preview"));
    assert.equal(response.status, 200);
    const body = await response.json() as { views: Record<string, { summary: { create: number }; operations: unknown[]; error?: string }> };

    assert.equal(body.views.external?.summary.create, 1, "the readable view still reports its plan");
    assert.equal(body.views.external?.error, undefined);
    // An empty plan with an error must never be mistaken for one with nothing
    // to do, so the reason is carried beside the empty counts.
    assert.deepEqual(body.views.internal?.operations, []);
    assert.match(String(body.views.internal?.error), /no provider is configured for example\.com\/internal/);

    // Asking for that view by name is asking about it, so the failure is the answer.
    assert.equal((await api(request("/api/v1/zones/example.com/preview?view=internal"))).status, 409);
  });

  it("bounds history and revision pages and reports whether more remain", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    for (const id of ["one", "two", "three"]) {
      await api(request(`/api/v1/zones/example.com/views/external/records/${id}`, "PUT", {
        name: id, type: "A", content: "8.8.8.8", ttl: 300,
      }));
    }

    const page = await (await api(request("/api/v1/zones/example.com/history?limit=2"))).json() as {
      entries: Array<{ revision: number }>; limit: number; offset: number; hasMore: boolean;
    };
    assert.deepEqual(page.entries.map((entry) => entry.revision), [4, 3]);
    assert.deepEqual([page.limit, page.offset, page.hasMore], [2, 0, true]);

    const revisions = await (await api(request("/api/v1/zones/example.com/revisions?limit=2"))).json() as {
      revisions: Array<{ revision: number }>; hasMore: boolean;
    };
    assert.deepEqual(revisions.revisions.map((item) => item.revision), [3, 4]);
    assert.equal(revisions.hasMore, true);
    assert.equal((await api(request("/api/v1/zones/example.com/history?limit=abc"))).status, 400);
  });

  it("bounds the alphabetical zone listing and reports whether more remain", async () => {
    const api = setup();
    for (const name of ["charlie.example", "alpha.example", "bravo.example"]) {
      await api(request("/api/v1/zones", "POST", { name }));
    }

    const first = await (await api(request("/api/v1/zones?limit=2"))).json() as {
      zones: Array<{ name: string }>; limit: number; offset: number; hasMore: boolean;
    };
    assert.deepEqual(first.zones.map((zone) => zone.name), ["alpha.example", "bravo.example"]);
    assert.deepEqual([first.limit, first.offset, first.hasMore], [2, 0, true]);

    const second = await (await api(request("/api/v1/zones?limit=2&offset=2"))).json() as {
      zones: Array<{ name: string }>; hasMore: boolean;
    };
    assert.deepEqual(second.zones.map((zone) => zone.name), ["charlie.example"]);
    assert.equal(second.hasMore, false);
    assert.equal((await api(request("/api/v1/zones?offset=nope"))).status, 400);
  });

  it("withdraws published records when deleting a zone and reports what it removed", async () => {
    const adapters = createInMemoryAdapters();
    const api = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) });
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    await api(request("/api/v1/zones/example.com/views/external/records/root", "PUT", {
      name: "@", type: "A", content: "8.8.8.8", ttl: 300,
    }));
    await api(request("/api/v1/zones/example.com/apply", "POST"));
    assert.equal((await adapters.provider.list("example.com/external")).length, 1);

    const deleted = await api(request("/api/v1/zones/example.com", "DELETE"));
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), {
      zone: "example.com",
      removedProviderRecords: [
        { view: "external", id: "root", name: "@", type: "A", content: "8.8.8.8" },
        { view: "internal", id: "internal-root-a-utrwak", name: "@", type: "A", content: "8.8.8.8" },
      ],
      abandonedProviderTargets: [],
    });
    assert.deepEqual(await adapters.provider.list("example.com/external"), []);
    assert.deepEqual(await adapters.provider.list("example.com/internal"), []);
  });

  it("abandons only unreadable provider targets when the caller opts in explicitly", async () => {
    const adapters = createInMemoryAdapters();
    const api = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) });
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    await api(request("/api/v1/zones/example.com/views/external/records/root", "PUT", {
      name: "@", type: "A", content: "8.8.8.8", ttl: 300,
    }));
    await api(request("/api/v1/zones/example.com/apply", "POST"));
    const originalList = adapters.provider.list.bind(adapters.provider);
    adapters.provider.list = async (target: string) => {
      if (target === "example.com/internal") throw new Error("provider is gone");
      return originalList(target);
    };

    const deleted = await api(request("/api/v1/zones/example.com?abandonProviderRecords=true", "DELETE"));
    adapters.provider.list = originalList;
    assert.equal(deleted.status, 200);
    const result = await deleted.json() as {
      removedProviderRecords: Array<{ view: string }>;
      abandonedProviderTargets: Array<{ view: string; target: string }>;
    };
    assert.deepEqual(result.removedProviderRecords.map((record) => record.view), ["external"]);
    assert.deepEqual(result.abandonedProviderTargets, [{ view: "internal", target: "example.com/internal" }]);
    assert.deepEqual(await adapters.provider.list("example.com/external"), []);
    assert.equal((await adapters.provider.list("example.com/internal")).length, 1);
    assert.equal((await api(request("/api/v1/zones/other.com?abandonProviderRecords=yes", "DELETE"))).status, 400);
  });

  it("accepts underscored service names required by DMARC, DKIM and ACME", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const saved = await api(request("/api/v1/zones/example.com/views/external/records/dmarc", "PUT", {
      name: "_dmarc", type: "TXT", content: "v=DMARC1; p=none", ttl: 300,
    }));
    assert.equal(saved.status, 200);
    const zone = await saved.json() as { views: Array<{ records: Array<{ name: string }> }> };
    assert.equal(zone.views[0]?.records[0]?.name, "_dmarc");
  });

  it("rejects oversized request bodies before buffering them", async () => {
    const adapters = createInMemoryAdapters();
    const handler = createNodeHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) });
    const incoming = Readable.from([]) as IncomingMessage;
    incoming.method = "POST";
    incoming.url = "/api/v1/zones";
    incoming.headers = { host: "localhost", "content-length": String(1_048_577) };
    let status = 0;
    let responseBody = "";
    const response = {
      writeHead(code: number) { status = code; return this; },
      end(value?: string) { responseBody = value ?? ""; return this; },
    } as unknown as ServerResponse;

    await handler(incoming, response);
    assert.equal(status, 413);
    assert.match(responseBody, /payload_too_large/);
  });

  it("returns the non-global publication acknowledgement contract through the API", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const unsafe = { name: "app", type: "A", content: "192.0.2.10", ttl: 60 };
    const blocked = await api(request("/api/v1/zones/example.com/views/external/records/app", "PUT", unsafe));
    assert.equal(blocked.status, 400);
    assert.match(JSON.stringify(await blocked.json()), /acknowledgeNonGlobalIp/);
    const accepted = await api(request("/api/v1/zones/example.com/views/external/records/app", "PUT", {
      ...unsafe, acknowledgeNonGlobalIp: true,
    }));
    assert.equal(accepted.status, 200);
  });

  it("previews a complete synthesized internal view and rejects cross-view DNS conflicts", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const candidate = {
      views: [
        { name: "external", records: [
          { id: "root", name: "@", type: "A", content: "8.8.8.8", ttl: 60, proxied: true },
          { id: "www", name: "www", type: "CNAME", content: "example.com", ttl: 300, proxied: true },
        ] },
        { name: "internal", records: [
          { id: "root-override", name: "@", type: "A", content: "10.0.0.8", ttl: 30 },
        ] },
      ],
    };
    const preview = await api(request("/api/v1/zones/example.com/preview?view=internal", "POST", candidate));
    assert.equal(preview.status, 200);
    const body = await preview.json() as { views: { internal: { operations: Array<{ desired: { content: string; proxied?: boolean } }> } } };
    assert.deepEqual(body.views.internal.operations.map((operation) => operation.desired.content).sort(), ["10.0.0.8", "example.com"]);
    assert.ok(body.views.internal.operations.every((operation) => operation.desired.proxied === undefined));

    const conflict = await api(request("/api/v1/zones/example.com", "PUT", {
      views: [
        { name: "external", records: [{ id: "address", name: "www", type: "A", content: "8.8.8.8", ttl: 60 }] },
        { name: "internal", records: [{ id: "alias", name: "www", type: "CNAME", content: "internal.example.com", ttl: 60 }] },
      ],
    }));
    assert.equal(conflict.status, 400);
    assert.match(JSON.stringify(await conflict.json()), /cannot coexist/);
  });

  it("supports zone CRUD, record CRUD, preview, apply, status and history", async () => {
    const api = setup();
    assert.equal((await api(request("/api/v1/zones", "POST", { name: "example.com" }))).status, 201);
    const put = await api(request("/api/v1/zones/example.com/views/external/records/root", "PUT", {
      name: "@", type: "A", content: "8.8.8.10", ttl: 60, proxied: true,
    }));
    assert.equal(put.status, 200);

    const preview = await (await api(request("/api/v1/zones/example.com/preview", "POST"))).json() as { views: { external: { summary: { create: number } } } };
    assert.equal(preview.views.external.summary.create, 1);
    assert.equal((await api(request("/api/v1/zones/example.com/apply", "POST"))).status, 200);
    const status = await (await api(request("/api/v1/zones/example.com/status"))).json() as { statuses: Array<{ state: string }> };
    assert.equal(status.statuses[0]?.state, "applied");
    const history = await (await api(request("/api/v1/zones/example.com/history"))).json() as {
      entries: Array<{ action: string }>;
    };
    assert.equal(history.entries.filter((entry) => entry.action.startsWith("provider.apply.")).length, 4);
    assert.ok(history.entries.some((entry) => entry.action === "record.upserted"));
    assert.ok(history.entries.some((entry) => entry.action === "zone.created"));
    assert.equal((await api(request("/api/v1/zones/example.com/views/external/records/root", "DELETE"))).status, 200);
    assert.equal((await api(request("/api/v1/zones/example.com", "DELETE"))).status, 200);
  });

  it("keeps individual RRset values addressable through record CRUD", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    for (const [id, content] of [["mx-one", "8.8.8.8"], ["mx-two", "8.8.4.4"]]) {
      assert.equal((await api(request(`/api/v1/zones/example.com/views/external/records/${id}`, "PUT", {
        name: "mail", type: "A", content, ttl: 60,
      }))).status, 200);
    }
    const removed = await api(request("/api/v1/zones/example.com/views/external/records/mx-one", "DELETE"));
    const zone = await removed.json() as { views: Array<{ name: string; records: Array<{ id: string; content: string }> }> };
    assert.deepEqual(zone.views.find((view) => view.name === "external")?.records, [
      { id: "mx-two", name: "mail", type: "A", content: "8.8.4.4", ttl: 60 },
    ]);
  });

  it("accepts a whole desired state with PUT and previews an unsaved candidate", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const desired = { views: { external: { records: [{ id: "root", name: "@", type: "A", content: "8.8.8.20", ttl: 300 }] } } };
    const previewResponse = await api(request("/api/v1/zones/example.com/preview", "POST", desired));
    const preview = await previewResponse.json() as { views: { external: { summary: { create: number } } } };
    assert.equal(preview.views.external.summary.create, 1);
    const before = await (await api(request("/api/v1/zones/example.com"))).json() as { revision: number; views: unknown[] };
    assert.equal(before.views.length, 0);
    const replaced = await (await api(request("/api/v1/zones/example.com", "PUT", desired))).json() as { revision: number };
    assert.equal(replaced.revision, 2);
  });

  it("returns actionable validation errors", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const response = await api(request("/api/v1/zones/example.com/views/external/records/root", "PUT", {
      name: "@", type: "A", content: "999.1.1.1", ttl: 0,
    }));
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string; issues: string[] };
    assert.equal(body.error, "validation_failed");
    assert.ok(body.issues.length >= 2);
  });

  it("normalizes proxied external TTL to Auto and rejects unsupported DNS-only TTLs", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const proxied = await api(request("/api/v1/zones/example.com/views/external/records/web", "PUT", {
      name: "www", type: "A", content: "8.8.8.8", ttl: 3600, proxied: true,
    }));
    assert.equal(proxied.status, 200);
    const zone = await proxied.json() as { views: Array<{ name: string; records: Array<{ ttl: number }> }> };
    assert.equal(zone.views.find((view) => view.name === "external")?.records[0]?.ttl, 1);

    for (const ttl of [59, 86_401]) {
      const rejected = await api(request("/api/v1/zones/example.com/views/external/records/dns", "PUT", {
        name: "dns", type: "A", content: "8.8.4.4", ttl, proxied: false,
      }));
      assert.equal(rejected.status, 400, String(ttl));
      assert.match(JSON.stringify(await rejected.json()), /Auto.*60.*86400/);
    }
  });

  it("uses revision ETags to reject stale desired-state writes", async () => {
    const api = setup();
    const created = await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    assert.equal(created.headers.get("etag"), '"1"');
    const fetched = await api(request("/api/v1/zones/example.com"));
    assert.equal(fetched.headers.get("etag"), '"1"');

    const desired = { views: [{ name: "external", records: [] }] };
    const first = await api(request("/api/v1/zones/example.com", "PUT", desired, { "if-match": '"1"' }));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("etag"), '"2"');

    const stale = await api(request("/api/v1/zones/example.com", "PUT", desired, { "if-match": '"1"' }));
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
      error: "conflict",
      message: "expected revision 1 for zone example.com, but the current revision is 2",
    });
    assert.equal((await (await api(request("/api/v1/zones/example.com"))).json() as { revision: number }).revision, 2);
  });

  it("requires If-Match to be one quoted positive integer when supplied", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const desired = { views: [] };
    for (const value of ["1", "*", 'W/"1"', '"0"', '"1", "2"']) {
      const response = await api(request("/api/v1/zones/example.com", "PUT", desired, { "if-match": value }));
      assert.equal(response.status, 400, value);
    }
  });

  it("checks If-Match on record writes and deletes", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const record = { name: "@", type: "A", content: "8.8.8.10", ttl: 60 };
    const created = await api(request(
      "/api/v1/zones/example.com/views/external/records/root",
      "PUT",
      record,
      { "if-match": '"1"' },
    ));
    assert.equal(created.headers.get("etag"), '"2"');
    assert.equal((await api(request(
      "/api/v1/zones/example.com/views/external/records/root",
      "DELETE",
      undefined,
      { "if-match": '"1"' },
    ))).status, 409);
    const deleted = await api(request(
      "/api/v1/zones/example.com/views/external/records/root",
      "DELETE",
      undefined,
      { "if-match": '"2"' },
    ));
    assert.equal(deleted.status, 200);
    assert.equal(deleted.headers.get("etag"), '"3"');
  });

  it("checks If-Match when restoring revisions and deleting zones", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    await api(request(
      "/api/v1/zones/example.com/views/external/records/root",
      "PUT",
      { name: "@", type: "A", content: "8.8.8.10", ttl: 60 },
      { "if-match": '"1"' },
    ));

    assert.equal((await api(request(
      "/api/v1/zones/example.com/revisions/1/restore",
      "POST",
      undefined,
      { "if-match": '"1"' },
    ))).status, 409);
    const restored = await api(request(
      "/api/v1/zones/example.com/revisions/1/restore",
      "POST",
      undefined,
      { "if-match": '"2"' },
    ));
    assert.equal(restored.headers.get("etag"), '"3"');
    assert.equal((await api(request("/api/v1/zones/example.com", "DELETE", undefined, { "if-match": '"2"' }))).status, 409);
    assert.equal((await api(request("/api/v1/zones/example.com", "DELETE", undefined, { "if-match": '"3"' }))).status, 200);
  });

  it("rejects apply when desired state changed after preview without touching the provider", async () => {
    const adapters = createInMemoryAdapters();
    const api = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) });
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    const preview = await api(request("/api/v1/zones/example.com/preview", "POST"));
    assert.equal((await preview.json() as { revision: number }).revision, 1);
    await api(request(
      "/api/v1/zones/example.com/views/external/records/root",
      "PUT",
      { name: "@", type: "A", content: "8.8.8.10", ttl: 60 },
      { "if-match": '"1"' },
    ));

    const staleApply = await api(request(
      "/api/v1/zones/example.com/apply",
      "POST",
      undefined,
      { "if-match": '"1"' },
    ));
    assert.equal(staleApply.status, 409);
    assert.equal(adapters.provider.calls.length, 0);
    assert.equal((await adapters.statuses.list("example.com")).length, 2);
    assert.ok((await adapters.statuses.list("example.com")).every((status) => status.state === "pending"));
  });

  it("lists, reads and restores revision snapshots", async () => {
    const api = setup();
    await api(request("/api/v1/zones", "POST", { name: "example.com" }));
    await api(request("/api/v1/zones/example.com/views/external/records/root", "PUT", {
      name: "@", type: "A", content: "8.8.8.10", ttl: 60,
    }));
    await api(request("/api/v1/zones/example.com/views/external/records/root", "PUT", {
      name: "@", type: "A", content: "8.8.8.20", ttl: 60,
    }));

    const listedResponse = await api(request("/api/v1/zones/example.com/revisions"));
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json() as { revisions: Array<{ revision: number }> };
    assert.deepEqual(listed.revisions.map((item) => item.revision), [1, 2, 3]);

    const snapshot = await (await api(request("/api/v1/zones/example.com/revisions/2"))).json() as { revision: number; views: Array<{ records: Array<{ content: string }> }> };
    assert.equal(snapshot.views[0]?.records[0]?.content, "8.8.8.10");
    const restored = await (await api(request("/api/v1/zones/example.com/revisions/2/restore", "POST"))).json() as { revision: number };
    assert.equal(restored.revision, 4);
    assert.equal((await api(request("/api/v1/zones/example.com/revisions/not-a-number"))).status, 400);
    assert.equal((await api(request("/api/v1/zones/example.com/revisions/99"))).status, 404);
  });
});
