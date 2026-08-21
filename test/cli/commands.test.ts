import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInvocation, usage, UsageError } from "../../src/cli/argv.ts";
import {
  CommandPermissionError,
  CommandUnavailableError,
  listCommands,
  runCommand,
  UnknownCommandError,
  type CommandContext,
} from "../../src/cli/commands.ts";
import { AccessTokenService } from "../../src/application/access-tokens.ts";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { SettingsService } from "../../src/application/settings.ts";
import type { AccessTokenRepository, SettingsRepository, StoredAccessToken } from "../../src/application/ports.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";
import type { Role } from "../../src/security/http-authorization.ts";

class MemorySettingsRepository implements SettingsRepository {
  values: Record<string, unknown> = {};
  #tail: Promise<void> = Promise.resolve();
  async read(): Promise<Record<string, unknown>> {
    await this.#tail;
    return { ...this.values };
  }
  async write(patch: Record<string, unknown>): Promise<void> { this.values = { ...this.values, ...patch }; }
  update<T>(
    operation: (current: Record<string, unknown>) => Promise<{ patch: Record<string, unknown>; result: T }>,
  ): Promise<T> {
    const result = this.#tail.then(async () => {
      const replacement = await operation({ ...this.values });
      await this.write(replacement.patch);
      return replacement.result;
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

class MemoryAccessTokenRepository implements AccessTokenRepository {
  tokens: StoredAccessToken[] = [];
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
}

async function context(role: Role = "admin"): Promise<CommandContext> {
  const adapters = createInMemoryAdapters();
  const settings = new SettingsService(new MemorySettingsRepository());
  const accessTokens = new AccessTokenService(new MemoryAccessTokenRepository());
  await settings.load();
  await accessTokens.load();
  return {
    runtime: {
      controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider),
      settings,
      accessTokens,
    },
    actor: "test",
    role,
  };
}

describe("command layer", () => {
  it("drives a zone through its whole life from commands alone", async () => {
    const parallax = await context();

    await runCommand(parallax, "zone create", { zone: "example.com" });
    await runCommand(parallax, "record set", {
      zone: "example.com",
      view: "external",
      id: "www",
      record: { name: "www", type: "A", content: "8.8.8.8", ttl: 300 },
    });
    const applied = await runCommand(parallax, "apply", { zone: "example.com" }) as {
      statuses: Array<{ view: string; state: string }>;
    };
    assert.deepEqual(applied.statuses.map((status) => `${status.view}:${status.state}`), [
      "external:applied",
      "internal:applied",
    ]);

    const listed = await runCommand(parallax, "zone list") as {
      zones: Array<{ name: string }>; limit: number; offset: number; hasMore: boolean;
    };
    assert.deepEqual(listed.zones.map((zone) => zone.name), ["example.com"]);
    assert.deepEqual([listed.limit, listed.offset, listed.hasMore], [50, 0, false]);

    const deleted = await runCommand(parallax, "zone delete", { zone: "example.com" }) as {
      removedProviderRecords: unknown[];
    };
    assert.equal(deleted.removedProviderRecords.length, 2);
  });

  it("honours the optimistic-concurrency guard rather than the revision being read", async () => {
    const parallax = await context();
    await runCommand(parallax, "zone create", { zone: "example.com" });
    await runCommand(parallax, "record set", {
      zone: "example.com", view: "external", id: "a",
      record: { name: "a", type: "A", content: "8.8.8.8", ttl: 300 },
    });

    await assert.rejects(
      runCommand(parallax, "record set", {
        zone: "example.com", view: "external", id: "b",
        record: { name: "b", type: "A", content: "8.8.8.9", ttl: 300 },
        expectedRevision: 1,
      }),
      /expected revision 1/,
    );
  });

  it("refuses a command the caller's role does not reach", async () => {
    const viewer = await context("viewer");
    assert.ok(await runCommand(viewer, "zone list"));
    await assert.rejects(
      runCommand(viewer, "zone create", { zone: "example.com" }),
      (error: unknown) => error instanceof CommandPermissionError && /editor role/.test(error.message),
    );
    await assert.rejects(
      runCommand(viewer, "settings get"),
      (error: unknown) => error instanceof CommandPermissionError,
    );
  });

  it("rejects an unknown command and unknown or missing options", async () => {
    const parallax = await context();
    await assert.rejects(runCommand(parallax, "zone destroy"), UnknownCommandError);
    await assert.rejects(runCommand(parallax, "zone get", { zone: "example.com", colour: "red" }), /unknown option --colour/);
    await assert.rejects(runCommand(parallax, "zone get", {}), /--zone is required/);
  });

  it("reports a service this process does not have instead of crashing", async () => {
    const adapters = createInMemoryAdapters();
    const bare: CommandContext = {
      runtime: { controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) },
      actor: "test",
      role: "admin",
    };
    await assert.rejects(runCommand(bare, "settings get"), CommandUnavailableError);
    await assert.rejects(runCommand(bare, "credential profile list"), CommandUnavailableError);
    // The file backend has no schema, so migrating is refused rather than
    // reported as a no-op success.
    await assert.rejects(runCommand(bare, "migrate"), CommandUnavailableError);
  });

  it("applies the schema through the same command layer as everything else", async () => {
    const parallax = await context();
    const runs: number[] = [];
    const withDatabase: CommandContext = {
      ...parallax,
      runtime: {
        ...parallax.runtime,
        migrate: async () => {
          runs.push(1);
          return { directory: "/app/migrations", applied: ["001_initial.sql"] };
        },
      },
    };
    assert.deepEqual(await runCommand(withDatabase, "migrate"), {
      directory: "/app/migrations",
      applied: ["001_initial.sql"],
    });
    assert.equal(runs.length, 1);
    await assert.rejects(
      runCommand({ ...withDatabase, role: "editor" }, "migrate"),
      (error: unknown) => error instanceof CommandPermissionError,
    );
    // A refused caller must not have reached the database at all.
    assert.equal(runs.length, 1);
  });

  it("coerces argv strings into the types each option declares", async () => {
    const parallax = await context();
    await runCommand(parallax, "zone create", { zone: "example.com" });
    // Everything from a terminal is a string; the layer types it once.
    const page = await runCommand(parallax, "history", { zone: "example.com", limit: "1" }) as {
      entries: unknown[]; limit: number;
    };
    assert.equal(page.limit, 1);
    assert.equal(page.entries.length, 1);
    const zones = await runCommand(parallax, "zone list", { limit: "1", offset: "0" }) as {
      zones: unknown[]; limit: number; offset: number;
    };
    assert.deepEqual([zones.zones.length, zones.limit, zones.offset], [1, 1, 0]);
    await assert.rejects(runCommand(parallax, "history", { limit: "lots" }), /--limit must be a number/);
  });

  it("every command declares a role and a summary", () => {
    for (const command of listCommands()) {
      assert.match(command.name, /^[a-z]+( [a-z]+)*$/, command.name);
      assert.ok(command.summary.length > 0, command.name);
      assert.ok(["admin", "editor", "viewer"].includes(command.role), command.name);
    }
  });
});

describe("command line parsing", () => {
  it("matches the longest command path before reading options", () => {
    assert.deepEqual(parseInvocation(["zone", "list"]), { name: "zone list", input: {} });
    assert.deepEqual(parseInvocation(["zone", "list", "--limit", "2", "--offset=1"]), {
      name: "zone list", input: { limit: "2", offset: "1" },
    });
    assert.deepEqual(parseInvocation(["credential", "profile", "set", "--name", "a", "--token", "b"]), {
      name: "credential profile set",
      input: { name: "a", token: "b" },
    });
  });

  it("reads --flag value, --flag=value, bare flags and --no-flag", () => {
    assert.deepEqual(parseInvocation(["zone", "delete", "--zone", "a.example", "--abandonProviderRecords"]).input, {
      zone: "a.example",
      abandonProviderRecords: true,
    });
    assert.deepEqual(parseInvocation(["zone", "delete", "--zone=a.example", "--no-abandonProviderRecords"]).input, {
      zone: "a.example",
      abandonProviderRecords: false,
    });
    assert.deepEqual(parseInvocation(["apply", "pending", "--retryFailed"]).input, { retryFailed: true });
  });

  it("refuses an unusable invocation", () => {
    assert.throws(() => parseInvocation([]), UsageError);
    assert.throws(() => parseInvocation(["nonsense"]), /unknown command/);
    assert.throws(() => parseInvocation(["zone", "list", "extra"]), /unexpected argument: extra/);
    assert.throws(() => parseInvocation(["zone", "list", "value"]), UsageError);
  });

  it("documents the whole surface and one command at a time", () => {
    const all = usage();
    for (const command of listCommands()) assert.ok(all.includes(command.name), command.name);
    assert.match(usage("record set"), /--record \(required\)/);
  });
});
