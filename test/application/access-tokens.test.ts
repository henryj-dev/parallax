import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { describe, it } from "node:test";
import { AccessTokenService, isStrongBootstrapToken } from "../../src/application/access-tokens.ts";
import type { AccessTokenRepository, StoredAccessToken } from "../../src/application/ports.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";
import { InMemoryAccessTokenRepository } from "../../src/infrastructure/in-memory.ts";
import { authenticate, createAuthorizedHandler } from "../../src/security/http-authorization.ts";

class MemoryAccessTokenRepository implements AccessTokenRepository {
  tokens: StoredAccessToken[] = [];
  /** Every batch the service flushed, so the buffering can be observed. */
  touched: { id: string; at: string }[][] = [];
  touchFails = false;
  async list(): Promise<StoredAccessToken[]> { return this.tokens.map((token) => ({ ...token })); }
  async create(token: StoredAccessToken): Promise<void> { this.tokens.push({ ...token }); }
  async revoke(id: string, retainedAdministratorCount: number): Promise<"deleted" | "not-found" | "last-admin"> {
    const index = this.tokens.findIndex((token) => token.id === id);
    if (index < 0) return "not-found";
    if (this.tokens[index]?.role === "admin"
      && this.tokens.filter((token, tokenIndex) => tokenIndex !== index && token.role === "admin").length + retainedAdministratorCount === 0) {
      return "last-admin";
    }
    this.tokens.splice(index, 1);
    return "deleted";
  }

  async touch(uses: readonly { readonly id: string; readonly at: string }[]): Promise<void> {
    if (this.touchFails) throw new Error("last-use flush failed");
    this.touched.push(uses.map((use) => ({ ...use })));
    for (const use of uses) {
      const index = this.tokens.findIndex((token) => token.id === use.id);
      const existing = this.tokens[index];
      if (existing) this.tokens[index] = { ...existing, lastUsedAt: use.at };
    }
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("AccessTokenService", () => {
  // A deployment runs the command line in a separate process (`kubectl exec`),
  // so these two instances stand for the server and that command.
  function pair(repository: AccessTokenRepository): { server: AccessTokenService; cli: AccessTokenService } {
    const bootstrap = [{ token: "bootstrap-token-long-enough-for-the-check", subject: "boot", role: "admin" as const }];
    return { server: new AccessTokenService(repository, bootstrap), cli: new AccessTokenService(repository, bootstrap) };
  }

  function accepts(service: AccessTokenService, token: string): boolean {
    return authenticate(new Request("http://localhost/api/v1/zones", {
      headers: { authorization: `Bearer ${token}` },
    }), service.security()) !== undefined;
  }

  it("treats an expiry it cannot read as already past", async () => {
    // `Date.parse` gives NaN, and `NaN <= now` is false -- so this token used to
    // authenticate forever while `list()` showed an expiry the operator believed
    // was in force. It arrives from a restore or a direct store write; `issue`
    // always writes a valid timestamp.
    const repository = new InMemoryAccessTokenRepository();
    await repository.create({
      id: "broken",
      subject: "someone",
      role: "admin",
      digest: Buffer.alloc(32, 1).toString("base64url"),
      createdAt: "2026-08-08T00:00:00.000Z",
      expiresAt: "whenever",
    });
    const service = new AccessTokenService(repository);
    await service.load();
    assert.deepEqual(service.security().tokens ?? [], [], "a token with an unreadable expiry still authenticated");
    assert.equal((await service.list())[0]?.expired, true);
  });

  it("accepts a token another process issued, without being restarted", async () => {
    const repository = new MemoryAccessTokenRepository();
    const { server, cli } = pair(repository);
    await server.load();
    await cli.load();
    const stop = server.startRefreshing(5);

    const issued = await cli.issue("ops-henry", "admin");
    assert.equal(accepts(server, issued.token), false, "not yet -- the server has not read the store since");
    await scheduler.wait(30);
    assert.equal(accepts(server, issued.token), true);
    stop();
  });

  it("stops accepting a token another process revoked, without being restarted", async () => {
    const repository = new MemoryAccessTokenRepository();
    const { server, cli } = pair(repository);
    await cli.load();
    const issued = await cli.issue("ops-henry", "admin");
    await server.load();
    assert.equal(accepts(server, issued.token), true);

    const stop = server.startRefreshing(5);
    await cli.revoke(issued.metadata.id);
    await scheduler.wait(30);
    assert.equal(accepts(server, issued.token), false, "a revocation that leaves the token working is not a revocation");
    stop();
  });

  it("keeps the tokens it has when the store cannot be read", async () => {
    const repository = new MemoryAccessTokenRepository();
    const { server, cli } = pair(repository);
    await cli.load();
    const issued = await cli.issue("ops-henry", "admin");
    await server.load();

    const errors: unknown[] = [];
    repository.list = async () => { throw new Error("store is unreachable"); };
    const stop = server.startRefreshing(5, (error) => errors.push(error));
    await scheduler.wait(30);
    stop();

    assert.ok(errors.length > 0, "the failure must be reported, not swallowed");
    assert.equal(accepts(server, issued.token), true,
      "an unreachable store must not lock out everyone holding a valid token");
  });

  it("returns a new token once and stores only its digest", async () => {
    const repository = new MemoryAccessTokenRepository();
    const service = new AccessTokenService(repository);
    await service.load();

    const issued = await service.issue("operator", "editor");
    assert.equal(issued.metadata.subject, "operator");
    assert.equal(issued.metadata.role, "editor");
    assert.ok(issued.token.length >= 43, issued.token);

    const stored = repository.tokens[0];
    assert.ok(stored);
    assert.equal(JSON.stringify(repository.tokens).includes(issued.token), false);
    assert.equal(JSON.stringify(service.list()).includes(issued.token), false);
    assert.equal("token" in stored, false);
  });

  it("authenticates a token it issued and rejects one it did not", async () => {
    const service = new AccessTokenService(new MemoryAccessTokenRepository());
    await service.load();
    assert.equal(service.security().enabled, false);

    const issued = await service.issue("owner", "admin");
    assert.equal(service.security().enabled, true);

    const handler = createAuthorizedHandler(() => service.security(), async () => Response.json({ ok: true }));
    const call = async (token: string): Promise<Response> => handler(new Request("https://portal.example/api/v1/zones", {
      headers: { authorization: `Bearer ${token}` },
    }));

    assert.equal((await call(issued.token)).status, 200);
    assert.equal((await call("not-a-real-token-0000000000000000")).status, 401);
  });

  it("keeps at least one administrator so a deployment cannot lock itself out", async () => {
    const service = new AccessTokenService(new MemoryAccessTokenRepository());
    await service.load();
    const admin = await service.issue("owner", "admin");
    const viewer = await service.issue("reader", "viewer");

    await assert.rejects(service.revoke(admin.metadata.id), /last administrator token/);
    assert.equal(await service.revoke(viewer.metadata.id), true);

    const second = await service.issue("deputy", "admin");
    assert.equal(await service.revoke(admin.metadata.id), true);
    assert.equal(service.list().map((token) => token.subject).join(","), "deputy");
    assert.equal(second.metadata.role, "admin");
  });

  it("lists environment tokens as managed so the API cannot revoke them", async () => {
    const service = new AccessTokenService(new MemoryAccessTokenRepository(), [
      { token: "break-glass-token-0000000000000000", role: "admin", subject: "bootstrap" },
    ]);
    await service.load();

    assert.deepEqual(service.list().map((token) => [token.subject, token.managed]), [["bootstrap", true]]);
    assert.equal(await service.revoke("environment-1"), false);
    // A bootstrap admin also satisfies the last-administrator rule.
    const extra = await service.issue("owner", "admin");
    assert.equal(await service.revoke(extra.metadata.id), true);
  });

  it("rejects an unusable subject or role", async () => {
    const service = new AccessTokenService(new MemoryAccessTokenRepository());
    await service.load();
    await assert.rejects(service.issue("", "admin"), /subject/);
    await assert.rejects(service.issue("owner", "superuser"), /role/);
  });

  it("round-trips through the file backend used when no database is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-tokens-"));
    try {
      const path = join(directory, "configuration.json");
      const first = new AccessTokenService(new FileConfigurationStore(path).accessTokens);
      await first.load();
      const issued = await first.issue("owner", "admin");

      const persisted = await readFile(path, "utf8");
      assert.equal(persisted.includes(issued.token), false);

      const restarted = new AccessTokenService(new FileConfigurationStore(path).accessTokens);
      await restarted.load();
      assert.deepEqual(restarted.list().map((token) => token.subject), ["owner"]);
      assert.equal(restarted.security().enabled, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent last-admin revocations in the repository", async () => {
    const repository = new InMemoryAccessTokenRepository();
    const service = new AccessTokenService(repository);
    await service.load();
    const first = await service.issue("first", "admin");
    const second = await service.issue("second", "admin");

    const results = await Promise.allSettled([
      service.revoke(first.metadata.id),
      service.revoke(second.metadata.id),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await repository.list()).filter((token) => token.role === "admin").length, 1);
    assert.equal(service.security().enabled, true);
  });

  it("never returns to authentication-disabled after observing a stored token", async () => {
    const repository = new MemoryAccessTokenRepository();
    const service = new AccessTokenService(repository);
    await service.load();
    await service.issue("owner", "admin");
    repository.tokens = [];
    await service.load();

    assert.equal(service.security().enabled, true);
    const response = await createAuthorizedHandler(() => service.security(), async () => new Response("open"))(
      new Request("https://portal.example/api/v1/zones"),
    );
    assert.equal(response.status, 401);
  });

  it("drops a revoked digest locally even when the post-delete reload fails", async () => {
    const repository = new MemoryAccessTokenRepository();
    const service = new AccessTokenService(repository, [{
      token: "bootstrap-token-long-enough-for-the-check", role: "admin", subject: "bootstrap",
    }]);
    await service.load();
    const issued = await service.issue("reader", "viewer");
    repository.list = async () => { throw new Error("store unavailable"); };

    assert.equal(await service.revoke(issued.metadata.id), true);
    assert.equal(accepts(service, issued.token), false);
  });

  it("does not let a delayed load resurrect a token revoked after it started", async () => {
    const repository = new MemoryAccessTokenRepository();
    const service = new AccessTokenService(repository, [{
      token: "bootstrap-token-long-enough-for-the-check", role: "admin", subject: "bootstrap",
    }]);
    await service.load();
    const issued = await service.issue("reader", "viewer");

    const loadStarted = deferred();
    const releaseLoad = deferred();
    let delayNextLoad = true;
    repository.list = async () => {
      const snapshot = repository.tokens.map((token) => ({ ...token }));
      if (delayNextLoad) {
        delayNextLoad = false;
        loadStarted.resolve();
        await releaseLoad.promise;
      }
      return snapshot;
    };

    const loading = service.load();
    await loadStarted.promise;
    const revoking = service.revoke(issued.metadata.id);
    await scheduler.yield();
    releaseLoad.resolve();
    assert.deepEqual(await Promise.all([loading, revoking]), [undefined, true]);
    assert.equal(accepts(service, issued.token), false);
  });

  it("does not let a delayed load hide a token issued after it started", async () => {
    const repository = new MemoryAccessTokenRepository();
    const service = new AccessTokenService(repository);
    await service.load();

    const loadStarted = deferred();
    const releaseLoad = deferred();
    let delayNextLoad = true;
    repository.list = async () => {
      const snapshot = repository.tokens.map((token) => ({ ...token }));
      if (delayNextLoad) {
        delayNextLoad = false;
        loadStarted.resolve();
        await releaseLoad.promise;
      }
      return snapshot;
    };

    const loading = service.load();
    await loadStarted.promise;
    const issuing = service.issue("reader", "viewer");
    await scheduler.yield();
    releaseLoad.resolve();
    const [, issued] = await Promise.all([loading, issuing]);
    assert.equal(accepts(service, issued.token), true);
  });

  it("coalesces overlapping refresh ticks into one repository read", async () => {
    const repository = new MemoryAccessTokenRepository();
    const firstLoadStarted = deferred();
    const releaseLoad = deferred();
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    repository.list = async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      firstLoadStarted.resolve();
      await releaseLoad.promise;
      active -= 1;
      return [];
    };

    const service = new AccessTokenService(repository);
    const errors: unknown[] = [];
    const stop = service.startRefreshing(1, (error) => errors.push(error));
    await firstLoadStarted.promise;
    await scheduler.wait(20);
    stop();

    assert.equal(calls, 1);
    assert.equal(maximumActive, 1);
    releaseLoad.resolve();
    await scheduler.yield();
    assert.deepEqual(errors, []);
  });

  it("does not fan out driver reads after an application-level timeout", async () => {
    const repository = new MemoryAccessTokenRepository();
    const service = new AccessTokenService(repository, [], () => new Date(), 20);
    await service.load();
    const release = deferred();
    let calls = 0;
    repository.list = async () => {
      calls += 1;
      await release.promise;
      return [];
    };

    const stop = service.startRefreshing(1, () => undefined);
    await scheduler.wait(70);
    stop();
    assert.equal(calls, 1, "later ticks reuse the still-pending driver query");
    release.resolve();
    await scheduler.yield();
  });

  it("never publishes a timed-out pre-revoke snapshot after the durable deletion", async () => {
    const repository = new MemoryAccessTokenRepository();
    const now = new Date("2026-08-15T00:00:00.000Z");
    const service = new AccessTokenService(repository, [{
      token: "bootstrap-token-long-enough-for-the-check", role: "admin", subject: "bootstrap",
    }], () => now, 20);
    await service.load();
    const issued = await service.issue("reader", "viewer");

    const readStarted = deferred();
    const releaseRead = deferred();
    repository.list = async () => {
      const snapshot = repository.tokens.map((token) => ({ ...token }));
      readStarted.resolve();
      await releaseRead.promise;
      return snapshot;
    };

    const staleLoad = service.load();
    await readStarted.promise;
    await assert.rejects(staleLoad, /timed out/u);
    const revoking = service.revoke(issued.metadata.id);
    await scheduler.yield();
    releaseRead.resolve();

    assert.equal(await revoking, true);
    assert.equal(service.list().some((token) => token.id === issued.metadata.id), false);
    assert.equal(accepts(service, issued.token), false);
  });

  it("never publishes a timed-out pre-issue snapshot over the new token", async () => {
    const repository = new MemoryAccessTokenRepository();
    const now = new Date("2026-08-15T00:00:00.000Z");
    const service = new AccessTokenService(repository, [], () => now, 20);
    await service.load();

    const readStarted = deferred();
    const releaseRead = deferred();
    repository.list = async () => {
      const snapshot = repository.tokens.map((token) => ({ ...token }));
      readStarted.resolve();
      await releaseRead.promise;
      return snapshot;
    };

    const staleLoad = service.load();
    await readStarted.promise;
    await assert.rejects(staleLoad, /timed out/u);
    const issuing = service.issue("reader", "viewer");
    await scheduler.yield();
    releaseRead.resolve();

    const issued = await issuing;
    assert.equal(service.list().some((token) => token.id === issued.metadata.id), true);
    assert.equal(accepts(service, issued.token), true);
  });

  it("bounds fail-open cache age and exposes token-store readiness", async () => {
    let now = new Date("2026-08-15T00:00:00.000Z");
    const repository = new MemoryAccessTokenRepository();
    const service = new AccessTokenService(repository, [], () => now, 1_000);
    await service.load();
    const issued = await service.issue("owner", "admin");
    repository.list = async () => { throw new Error("store unavailable"); };
    await assert.rejects(service.load(), /unavailable/);
    assert.equal(service.readiness().status, "degraded");
    assert.equal(accepts(service, issued.token), true);

    now = new Date("2026-08-15T00:00:01.001Z");
    assert.deepEqual({ ready: service.readiness().ready, status: service.readiness().status }, { ready: false, status: "stale" });
    assert.equal(accepts(service, issued.token), false);
    assert.equal(service.security().enabled, true);
  });

  it("fails closed when a refresh hangs past the maximum cache age", async () => {
    let now = new Date("2026-08-15T00:00:00.000Z");
    const repository = new MemoryAccessTokenRepository();
    const service = new AccessTokenService(repository, [], () => now, 1_000);
    await service.load();
    const issued = await service.issue("owner", "admin");
    const release = deferred();
    repository.list = async () => {
      await release.promise;
      return repository.tokens.map((token) => ({ ...token }));
    };

    const loading = service.load();
    await scheduler.yield();
    now = new Date("2026-08-15T00:00:01.001Z");
    assert.equal(service.readiness().ready, false);
    assert.equal(accepts(service, issued.token), false);

    release.resolve();
    await loading;
    assert.equal(service.readiness().ready, true);
    assert.equal(accepts(service, issued.token), true);
  });

  it("re-reads and locks the file backend across independent instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-token-lock-"));
    try {
      const path = join(directory, "private", "configuration.json");
      const bootstrap = [{ token: "bootstrap-token-long-enough-for-the-check", role: "admin" as const, subject: "boot" }];
      const left = new AccessTokenService(new FileConfigurationStore(path).accessTokens, bootstrap);
      const right = new AccessTokenService(new FileConfigurationStore(path).accessTokens, bootstrap);
      await Promise.all([left.load(), right.load()]);
      const [first, second] = await Promise.all([left.issue("left", "viewer"), right.issue("right", "viewer")]);
      await left.load();
      assert.deepEqual(left.list().filter((token) => !token.managed).map((token) => token.subject).sort(), ["left", "right"]);

      await right.revoke(first.metadata.id);
      await left.load();
      assert.equal(accepts(left, first.token), false);
      assert.equal(accepts(left, second.token), true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recognizes only canonical 256-bit base64url bootstrap token format", () => {
    assert.equal(isStrongBootstrapToken("A".repeat(32)), false);
    assert.equal(isStrongBootstrapToken("aGVsbG8td29ybGQ"), false);
    assert.equal(isStrongBootstrapToken(Buffer.alloc(32, 7).toString("base64url")), true);
  });
});

/**
 * A token used to be valid until somebody remembered to revoke it, and nothing
 * said whether anybody still used it -- so the safe action and the
 * discoverable one were different, which is how unused credentials survive.
 */
describe("access tokens end, and say when they were last used", () => {
  function serviceAt(clock: { now: number }) {
    const repository = new MemoryAccessTokenRepository();
    const service = new AccessTokenService(repository, [], () => new Date(clock.now));
    return { repository, service };
  }

  it("refuses a lifetime outside the bounds, and takes one inside them", async () => {
    const clock = { now: Date.UTC(2026, 0, 1) };
    const { service } = serviceAt(clock);
    await service.load();

    await assert.rejects(service.issue("bot", "viewer", 30), /expiresIn must be an integer/u);
    await assert.rejects(service.issue("bot", "viewer", 1.5), /expiresIn must be an integer/u);

    const issued = await service.issue("bot", "viewer", 3600);
    assert.equal(issued.metadata.expiresAt, new Date(clock.now + 3_600_000).toISOString());
    assert.equal(issued.metadata.expired, false);
  });

  it("keeps authenticating until the moment it does not", async () => {
    const clock = { now: Date.UTC(2026, 0, 1) };
    const { service } = serviceAt(clock);
    await service.load();
    const issued = await service.issue("bot", "editor", 3600);

    const digestOf = (config: ReturnType<typeof service.security>) =>
      (config.digests ?? []).map((record) => record.subject);
    assert.deepEqual(digestOf(service.security()), ["bot"]);

    clock.now += 3_600_001;
    // No store read in between: the view notices on its own, which is what
    // stops an expiry from waiting on the next refresh tick.
    assert.deepEqual(digestOf(service.security()), [], "expired tokens leave the security view");

    const listed = service.list().find((token) => token.id === issued.metadata.id);
    assert.equal(listed?.expired, true, "still listed, so it can be seen and revoked");
  });

  it("leaves a token with no expiry alone", async () => {
    const clock = { now: Date.UTC(2026, 0, 1) };
    const { service } = serviceAt(clock);
    await service.load();
    await service.issue("forever", "viewer");

    clock.now += 10 * 365 * 86_400_000;
    // Reload first: ten years also crosses the cache's staleness deadline, and
    // that is a different rule doing its own job. What is asserted here is that
    // no expiry means no expiry.
    await service.load();
    assert.deepEqual((service.security().digests ?? []).map((record) => record.subject), ["forever"]);
    assert.equal(service.list().find((token) => token.subject === "forever")?.expiresAt, undefined);
  });

  it("records a use once per flush rather than once per request", async () => {
    const clock = { now: Date.UTC(2026, 0, 1) };
    const { repository, service } = serviceAt(clock);
    await service.load();
    const issued = await service.issue("busy", "viewer");

    const config = service.security();
    const id = (config.digests ?? [])[0]?.id;
    assert.equal(id, issued.metadata.id, "the security view names which token each digest is");

    // What the authorization layer does on a successful match.
    clock.now += 1000;
    config.onTokenUse?.(id as string);
    config.onTokenUse?.(id as string);
    config.onTokenUse?.(id as string);
    assert.equal(repository.touched.length, 0, "nothing is written on the request path");

    await service.load();
    assert.deepEqual(repository.touched, [[{ id, at: new Date(clock.now).toISOString() }]],
      "one row for three uses, carrying the newest moment");
    assert.equal(service.list().find((token) => token.id === id)?.lastUsedAt, new Date(clock.now).toISOString());
  });

  it("does not let a failed flush disturb anything else", async () => {
    const clock = { now: Date.UTC(2026, 0, 1) };
    const { repository, service } = serviceAt(clock);
    await service.load();
    await service.issue("busy", "viewer");
    const id = (service.security().digests ?? [])[0]?.id as string;

    repository.touchFails = true;
    service.security().onTokenUse?.(id);
    await service.load();

    assert.equal(service.readiness().ready, true, "the read still succeeded");
    assert.equal(service.list().length, 1);
  });
});
