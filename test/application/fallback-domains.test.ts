import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CloudflareFallbackDomains, FallbackDomainForbiddenError, type FallbackDomain } from "../../src/adapters/cloudflare-fallback.ts";
import { CredentialNotFoundError } from "../../src/application/cloudflare-credentials.ts";
import { FallbackDomainService, type ProfileSecretReader } from "../../src/application/fallback-domains.ts";
import { ownershipComment } from "../../src/adapters/ownership.ts";

/** The provider's list, and a record of every request made against it. */
function stubProvider(initial: FallbackDomain[]) {
  const calls: { method: string; url: string; authorization: string; body?: unknown }[] = [];
  let stored = [...initial];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url: String(input), authorization: headers.get("authorization") ?? "", body });
    if (method === "PUT") {
      stored = (body as { suffix: string; dns_server?: string[]; description?: string }[]).map((entry) => ({
        suffix: entry.suffix,
        ...(entry.dns_server ? { dnsServer: entry.dns_server } : {}),
        ...(entry.description ? { description: entry.description } : {}),
      }));
    }
    const result = stored.map((domain) => ({
      suffix: domain.suffix,
      ...(domain.dnsServer ? { dns_server: [...domain.dnsServer] } : {}),
      ...(domain.description ? { description: domain.description } : {}),
    }));
    return new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  };
  return { calls, fetch, stored: () => stored };
}

const DEFAULTS: FallbackDomain[] = [
  { suffix: "localhost" }, { suffix: "internal" }, { suffix: "lan" },
];

function serviceOver(provider: ReturnType<typeof stubProvider>, secrets?: ProfileSecretReader) {
  return new FallbackDomainService({
    secrets: secrets ?? {
      getProfileSecret: async (name) => name === "main"
        ? { name, accountId: "acct-1", token: "tok-secret" }
        : undefined,
    },
    createClient: (options) => new CloudflareFallbackDomains({ ...options, fetch: provider.fetch }),
  });
}

describe("fallback domains", () => {
  it("authenticates with the token the profile already holds", async () => {
    const provider = stubProvider(DEFAULTS);
    await serviceOver(provider).list("main");
    assert.equal(provider.calls[0]?.authorization, "Bearer tok-secret", "nobody supplied a second token");
    assert.match(provider.calls[0]?.url ?? "", /\/accounts\/acct-1\/devices\/policy\/fallback_domains$/u);
  });

  it("adds one suffix without dropping what was already there", async () => {
    // The provider replaces the whole list on every write, so the danger is not
    // that this fails -- it is that it succeeds and takes the defaults with it.
    const provider = stubProvider(DEFAULTS);
    const change = await serviceOver(provider).set("main", {
      suffix: "tinyuniver.se",
      dnsServer: ["10.17.192.70"],
      description: "internal view",
    });
    assert.equal(change.outcome, "added");
    assert.deepEqual(change.domains.map((domain) => domain.suffix),
      ["localhost", "internal", "lan", "tinyuniver.se"]);
    const written = provider.calls.find((call) => call.method === "PUT")?.body as unknown[];
    assert.equal(written.length, 4, "the whole list went back, not just the new entry");
  });

  it("reads before it writes", async () => {
    const provider = stubProvider(DEFAULTS);
    await serviceOver(provider).set("main", { suffix: "example.com", dnsServer: ["10.0.0.1"] });
    assert.deepEqual(provider.calls.map((call) => call.method), ["GET", "PUT"]);
  });

  it("replaces an entry rather than adding a second one for the same suffix", async () => {
    const provider = stubProvider([...DEFAULTS, { suffix: "tinyuniver.se", dnsServer: ["10.17.239.78"] }]);
    const change = await serviceOver(provider).set("main", { suffix: "TinyUniver.SE.", dnsServer: ["10.17.192.70"] });
    assert.equal(change.outcome, "updated");
    const matching = change.domains.filter((domain) => domain.suffix.toLowerCase().startsWith("tinyuniver"));
    assert.equal(matching.length, 1, "case and the trailing dot are spelling, not a second entry");
    assert.deepEqual(matching[0]?.dnsServer, ["10.17.192.70"]);
  });

  it("writes nothing when the entry is already what was asked for", async () => {
    const provider = stubProvider([...DEFAULTS, { suffix: "tinyuniver.se", dnsServer: ["10.17.192.70"] }]);
    const change = await serviceOver(provider).set("main", { suffix: "tinyuniver.se", dnsServer: ["10.17.192.70"] });
    assert.equal(change.outcome, "unchanged");
    assert.deepEqual(provider.calls.map((call) => call.method), ["GET"], "no write at all");
  });

  it("removes one suffix and leaves the rest", async () => {
    const provider = stubProvider([...DEFAULTS, { suffix: "tinyuniver.se", dnsServer: ["10.17.192.70"] }]);
    const change = await serviceOver(provider).remove("main", "tinyuniver.se");
    assert.equal(change.outcome, "removed");
    assert.deepEqual(change.domains.map((domain) => domain.suffix), ["localhost", "internal", "lan"]);
  });

  it("does not claim to have removed something that was never there", async () => {
    const provider = stubProvider(DEFAULTS);
    const change = await serviceOver(provider).remove("main", "absent.example");
    assert.equal(change.outcome, "unchanged");
    assert.deepEqual(provider.calls.map((call) => call.method), ["GET"]);
  });

  it("addresses a named device profile when one is given", async () => {
    const provider = stubProvider(DEFAULTS);
    await serviceOver(provider).list("main", "policy-7");
    assert.match(provider.calls[0]?.url ?? "", /\/devices\/policy\/policy-7\/fallback_domains$/u);
  });

  it("refuses a profile that is not stored", async () => {
    const provider = stubProvider(DEFAULTS);
    await assert.rejects(serviceOver(provider).list("absent"), (error: unknown) => error instanceof CredentialNotFoundError);
  });

  it("says an account id is missing rather than building a nonsense URL", async () => {
    // The DNS side never needed one, so a profile that works for records can
    // still be missing it. Without this the request goes to `/accounts//devices`.
    const provider = stubProvider(DEFAULTS);
    const service = serviceOver(provider, { getProfileSecret: async (name) => ({ name, token: "tok-secret" }) });
    await assert.rejects(service.list("main"), /account id/u);
    assert.equal(provider.calls.length, 0, "nothing was sent");
  });

  it("tells a token that cannot reach device settings apart from a bad request", async () => {
    // The expected first answer for a credential made for DNS. Reported as its
    // own failure so it is not read as "the list is wrong".
    const service = new FallbackDomainService({
      secrets: { getProfileSecret: async (name) => ({ name, accountId: "acct-1", token: "tok-secret" }) },
      createClient: (options) => new CloudflareFallbackDomains({
        ...options,
        fetch: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status: 403 }),
      }),
    });
    await assert.rejects(service.list("main"), (error: unknown) =>
      error instanceof FallbackDomainForbiddenError && /Zero Trust device settings/u.test(error.message));
  });

  it("does not report success when the provider returns a shorter list than it was sent", async () => {
    // A write that is accepted and silently truncated looks exactly like a write
    // that worked, and the list it manages is one nobody reads again by hand.
    const service = new FallbackDomainService({
      secrets: { getProfileSecret: async (name) => ({ name, accountId: "acct-1", token: "tok-secret" }) },
      createClient: (options) => new CloudflareFallbackDomains({
        ...options,
        fetch: async (_input, init) => new Response(JSON.stringify({
          success: true,
          errors: [],
          result: (init?.method ?? "GET") === "PUT" ? [{ suffix: "localhost" }] : [{ suffix: "localhost" }],
        }), { status: 200 }),
      }),
    });
    await assert.rejects(service.set("main", { suffix: "tinyuniver.se", dnsServer: ["10.17.192.70"] }),
      /did not return tinyuniver\.se/u);
  });

  it("never puts the token in a transport failure message", async () => {
    const service = new FallbackDomainService({
      secrets: { getProfileSecret: async (name) => ({ name, accountId: "acct-1", token: "tok-secret" }) },
      createClient: (options) => new CloudflareFallbackDomains({
        ...options,
        fetch: async () => { throw new Error("connect failed using Bearer tok-secret"); },
      }),
    });
    await assert.rejects(service.list("main"), (error: unknown) =>
      error instanceof Error && !error.message.includes("tok-secret") && error.message.includes("[redacted]"));
  });
});

describe("keeping the overrides in step with the zones", () => {
  const SECRET = "a-secret-long-enough-to-sign-with-000000000000";
  const marker = (suffix: string) => ownershipComment(`fallback/${suffix}`, "entry", SECRET);

  /** The live list: other teams' entries, the defaults, and one of ours. */
  const OTHERS: FallbackDomain[] = [
    { suffix: "hackers.com", dnsServer: ["15.165.65.2"] },
    { suffix: "kosaf.go.kr", dnsServer: ["168.126.63.1", "168.126.63.2"] },
    { suffix: "localhost" },
  ];

  function syncing(initial: FallbackDomain[]) {
    const provider = stubProvider(initial);
    const service = new FallbackDomainService({
      secrets: { getProfileSecret: async (name) => ({ name, accountId: "acct-1", token: "tok-secret" }) },
      ownershipSecret: SECRET,
      createClient: (options) => new CloudflareFallbackDomains({ ...options, fetch: provider.fetch }),
    });
    return { provider, service };
  }

  it("adds an entry for a zone that has none, and derives it rather than being told", async () => {
    const { service } = syncing(OTHERS);
    const plan = await service.plan("main", ["tinyuniver.se"], "10.17.192.70");
    assert.deepEqual(plan.add.map((entry) => entry.suffix), ["tinyuniver.se"]);
    assert.deepEqual(plan.add[0]?.dnsServer, ["10.17.192.70"]);
    assert.equal(plan.untouched, 3, "everyone else's entries are counted, not planned");
  });

  it("claims an unsigned entry that already sends the name where this would", async () => {
    // What `fallback set` leaves behind, and what a person typing into the
    // dashboard leaves behind. Refusing it forever would report a conflict that
    // can only be cleared by deleting the entry -- and deleting it drops the
    // internal view for every device until the next write lands.
    const { service, provider } = syncing([...OTHERS, { suffix: "tinyuniver.se", dnsServer: ["10.17.192.70"], description: "internal view" }]);
    const plan = await service.plan("main", ["tinyuniver.se"], "10.17.192.70");
    assert.deepEqual(plan.adopt.map((entry) => entry.suffix), ["tinyuniver.se"]);
    assert.deepEqual(plan.conflict, []);
    const { domains } = await service.sync("main", ["tinyuniver.se"], "10.17.192.70");
    const claimed = domains.find((entry) => entry.suffix === "tinyuniver.se");
    assert.deepEqual(claimed?.dnsServer, ["10.17.192.70"], "where it points did not move");
    assert.notEqual(claimed?.description, "internal view", "only the marker changed");
    assert.equal(domains.length, OTHERS.length + 1, "nobody else's entry moved");
    void provider;
  });

  it("still refuses an unsigned entry that sends the name somewhere else", async () => {
    const { service } = syncing([...OTHERS, { suffix: "tinyuniver.se", dnsServer: ["10.0.0.9"] }]);
    const plan = await service.plan("main", ["tinyuniver.se"], "10.17.192.70");
    assert.deepEqual(plan.adopt, [], "claiming it would move where the name resolves");
    assert.deepEqual(plan.conflict.map((entry) => entry.suffix), ["tinyuniver.se"]);
  });

  it("never writes over an entry it did not create", async () => {
    // Somebody added this suffix by hand. Taking it over would move another
    // team's DNS on the strength of a name collision.
    const { service, provider } = syncing([...OTHERS, { suffix: "tinyuniver.se", dnsServer: ["10.0.0.9"] }]);
    const plan = await service.plan("main", ["tinyuniver.se"], "10.17.192.70");
    assert.deepEqual(plan.conflict.map((entry) => entry.suffix), ["tinyuniver.se"]);
    assert.deepEqual(plan.add, []);
    assert.deepEqual(plan.update, []);
    await service.sync("main", ["tinyuniver.se"], "10.17.192.70");
    assert.equal(provider.calls.filter((call) => call.method === "PUT").length, 0, "a conflict writes nothing");
  });

  it("keeps every other entry when it does write", async () => {
    const { service, provider } = syncing(OTHERS);
    const { domains } = await service.sync("main", ["tinyuniver.se"], "10.17.192.70");
    assert.equal(domains.length, 4);
    for (const entry of OTHERS) {
      const kept = domains.find((domain) => domain.suffix === entry.suffix);
      assert.deepEqual(kept?.dnsServer, entry.dnsServer, `${entry.suffix} survived unchanged`);
    }
  });

  it("moves its own entry when the resolver changes, and leaves the marker verifiable", async () => {
    const { service } = syncing([...OTHERS, { suffix: "tinyuniver.se", dnsServer: ["10.17.239.78"], description: marker("tinyuniver.se") }]);
    const plan = await service.plan("main", ["tinyuniver.se"], "10.17.192.70");
    assert.deepEqual(plan.update.map((entry) => entry.dnsServer), [["10.17.192.70"]]);
    assert.equal(plan.add.length + plan.remove.length, 0);
  });

  it("removes its own entry for a zone it no longer holds", async () => {
    const { service } = syncing([...OTHERS, { suffix: "gone.example", dnsServer: ["10.17.192.70"], description: marker("gone.example") }]);
    const plan = await service.plan("main", ["tinyuniver.se"], "10.17.192.70");
    assert.deepEqual(plan.remove.map((entry) => entry.suffix), ["gone.example"]);
  });

  it("does not accept a marker minted for another suffix", async () => {
    // The marker is signed for the suffix it sits on, so lifting one onto a
    // different entry does not make that entry ours to delete.
    const { service } = syncing([...OTHERS, { suffix: "hackers.co.kr", dnsServer: ["15.165.65.2"], description: marker("tinyuniver.se") }]);
    const plan = await service.plan("main", ["tinyuniver.se"], "10.17.192.70");
    assert.deepEqual(plan.remove, [], "not ours, so not removed");
    assert.deepEqual(plan.add.map((entry) => entry.suffix), ["tinyuniver.se"]);
  });

  it("reports nothing to do without writing", async () => {
    const { service, provider } = syncing([...OTHERS, { suffix: "tinyuniver.se", dnsServer: ["10.17.192.70"], description: marker("tinyuniver.se") }]);
    const { plan } = await service.sync("main", ["tinyuniver.se"], "10.17.192.70");
    assert.equal(plan.unchanged, 1);
    assert.equal(provider.calls.filter((call) => call.method === "PUT").length, 0);
  });

  it("refuses to plan without a signing secret, rather than treating every entry as unowned", async () => {
    // Without the secret nothing verifies, so every entry would look like
    // somebody else's -- and every zone would look like it needed adding.
    const provider = stubProvider(OTHERS);
    const service = new FallbackDomainService({
      secrets: { getProfileSecret: async (name) => ({ name, accountId: "acct-1", token: "tok-secret" }) },
      createClient: (options) => new CloudflareFallbackDomains({ ...options, fetch: provider.fetch }),
    });
    await assert.rejects(service.plan("main", ["tinyuniver.se"], "10.17.192.70"), /OWNERSHIP_SECRET/u);
  });

  it("refuses to plan with no resolver address", async () => {
    const { service } = syncing(OTHERS);
    await assert.rejects(service.plan("main", ["tinyuniver.se"], "  "), /fallbackResolver/u);
  });
});
