import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AccessTokenService } from "../../src/application/access-tokens.ts";
import type { AccessTokenRepository, StoredAccessToken } from "../../src/application/ports.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";
import { createAuthorizedHandler } from "../../src/security/http-authorization.ts";

class MemoryAccessTokenRepository implements AccessTokenRepository {
  tokens: StoredAccessToken[] = [];
  async list(): Promise<StoredAccessToken[]> { return this.tokens.map((token) => ({ ...token })); }
  async create(token: StoredAccessToken): Promise<void> { this.tokens.push({ ...token }); }
  async delete(id: string): Promise<boolean> {
    const index = this.tokens.findIndex((token) => token.id === id);
    if (index < 0) return false;
    this.tokens.splice(index, 1);
    return true;
  }
}

describe("AccessTokenService", () => {
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
});
