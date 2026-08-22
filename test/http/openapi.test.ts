import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ControlPlane, NotFoundError } from "../../src/application/control-plane.ts";
import { findCommand, listCommands, satisfiesRole } from "../../src/cli/commands.ts";
import { createApiHandler, resolveRoute } from "../../src/http/api.ts";
import { buildOpenApiDocument, listOperations, minimumRole, type DocumentedOperation } from "../../src/http/openapi.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";
import { authorize, ROLES } from "../../src/security/http-authorization.ts";

/**
 * Commands with no route of their own, and why.
 *
 * An exclusion list rather than silence: a command that grows an HTTP surface
 * and no documentation should fail here, and the only way for that to be true
 * is for every command to be accounted for one way or the other.
 */
const NOT_OVER_HTTP: Readonly<Record<string, string>> = {
  migrate: "the serving runtime has no migrate capability on purpose, so an HTTP administrator cannot turn this process's database role into a schema-changing one",
};

const document = buildOpenApiDocument();
const operations = listOperations();

function commandOf(operation: DocumentedOperation): string | undefined {
  if (operation.source.kind === "command") return operation.source.command;
  if (operation.source.kind === "dispatch") return operation.source.sampleCommand;
  return undefined;
}

function label(operation: DocumentedOperation): string {
  return `${operation.method} ${operation.path}`;
}

describe("the OpenAPI document describes the routes that exist", () => {
  it("resolves every documented operation to the command it names", async () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const operation of operations) {
      const expected = commandOf(operation);
      if (expected === undefined) continue;
      checked += 1;
      try {
        const match = await resolveRoute(operation.method, operation.sample.path, operation.sample.body);
        if (match.command !== expected) wrong.push(`${label(operation)} reaches "${match.command}", documented as "${expected}"`);
      } catch (error) {
        wrong.push(`${label(operation)} does not resolve at all: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
    // An empty `wrong` is what a working walk gives and what a walk over nothing
    // gives, and the assertion below cannot tell them apart.
    assert.ok(checked > 20, `the document describes command routes; walking found ${checked}`);
    assert.deepEqual(wrong, [], "the document names a command the router does not reach");
  });

  it("does not claim a dispatcher route for a path the dispatcher never sees", async () => {
    const served = operations.filter((operation) => operation.source.kind === "process" && operation.path.startsWith("/api/v1"));
    assert.ok(served.length > 0, "some documented routes are answered ahead of the dispatcher");
    for (const operation of served) {
      // Two things would answer the same path otherwise, and which one wins is
      // the order they happen to be tried in.
      await assert.rejects(
        resolveRoute(operation.method, operation.sample.path, operation.sample.body),
        NotFoundError,
        `${label(operation)} is documented as answered before the dispatcher, but the dispatcher routes it too`,
      );
    }
  });

  it("answers the session route it documents, rather than 404", async () => {
    // The only claim the walk above cannot make about a process-served route:
    // that anything serves it at all. A wrong credential proves the route is
    // there, because a route that is not there answers 404 before looking.
    const adapters = createInMemoryAdapters();
    const handler = createApiHandler(
      { controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) },
      { enabled: true, tokens: [{ token: "z".repeat(43), role: "admin", subject: "owner" }] },
    );
    const response = await handler(new Request("http://localhost/api/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ token: "not-the-stored-one" }),
    }));
    assert.notEqual(response.status, 404, "POST /api/v1/session is documented but nothing serves it");
    assert.equal(response.status, 401);
  });

  it("documents every command that is reachable over HTTP", () => {
    const documented = new Set(operations.map(commandOf).filter((name) => name !== undefined));
    const missing = listCommands()
      .map((command) => command.name)
      .filter((name) => !documented.has(name) && NOT_OVER_HTTP[name] === undefined);
    assert.deepEqual(missing, [], "a command exists that the API description does not mention");
  });

  it("keeps its exclusion list to commands that really have no route", async () => {
    for (const name of Object.keys(NOT_OVER_HTTP)) {
      assert.ok(findCommand(name), `${name} is excused from the document but is not a command`);
    }
    // `migrate` is excused because the serving runtime cannot run it. If a route
    // ever appears for it, the excuse stops being true and this says so.
    await assert.rejects(resolveRoute("POST", "/api/v1/migrate", {}), NotFoundError);
  });
});

describe("the role the document states is the role the gates enforce", () => {
  it("names the least role that gets through both of them", () => {
    let checked = 0;
    for (const operation of operations) {
      if (operation.source.kind !== "command") continue;
      const command = findCommand(operation.source.command);
      assert.ok(command, `${label(operation)} names an unknown command`);
      const role = minimumRole(operation);
      assert.ok(role, `${label(operation)} has no role that reaches it at all`);
      checked += 1;

      const request = new Request(`http://parallax.invalid${operation.sample.path}`, { method: operation.method });
      assert.ok(satisfiesRole(role, command.role), `${label(operation)} documents ${role}, below the command's ${command.role}`);
      assert.ok(authorize({ role, subject: "test" }, request), `${label(operation)} documents ${role}, which the security layer refuses`);

      const lower = ROLES[ROLES.indexOf(role) - 1];
      if (lower === undefined) continue;
      const passesBoth = satisfiesRole(lower, command.role) && authorize({ role: lower, subject: "test" }, request);
      assert.equal(passesBoth, false, `${label(operation)} documents ${role}, but ${lower} reaches it too`);
    }
    assert.ok(checked > 20, `the document has command routes to check; found ${checked}`);
  });

  it("reports the stricter of the two gates where they disagree", () => {
    // `authorize` lets any reader reach a GET, and `fallback list` demands an
    // administrator. A document that read only the route table would say
    // `viewer` here, and a viewer's token would get a 403 from the command.
    const fallback = operations.find((operation) => operation.method === "GET" && operation.path === "/api/v1/fallback/{profile}");
    assert.ok(fallback, "the fallback listing is documented");
    assert.equal(minimumRole(fallback), "admin");
    assert.equal(authorize({ role: "viewer", subject: "test" }, new Request("http://parallax.invalid/api/v1/fallback/main")), true);
  });
});

describe("the document is a document a generator can read", () => {
  it("declares OpenAPI 3.1 with a relative server, so it never names a host", () => {
    assert.equal(document.openapi, "3.1.0");
    assert.deepEqual((document.servers as { url: string }[]).map((server) => server.url), ["/"]);
  });

  it("resolves every schema reference it makes", () => {
    const defined = new Set(Object.keys((document.components as { schemas: Record<string, unknown> }).schemas));
    const dangling: string[] = [];
    let seen = 0;
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") {
          seen += 1;
          const name = value.replace("#/components/schemas/", "");
          if (!defined.has(name)) dangling.push(value);
          continue;
        }
        walk(value);
      }
    };
    walk(document);
    assert.ok(seen > 50, `the document refers to its schemas; found ${seen} references`);
    assert.deepEqual([...new Set(dangling)], [], "a schema is referenced that the document does not define");
  });

  it("gives every operation a unique operationId and its declared success status", () => {
    const ids: string[] = [];
    for (const [path, item] of Object.entries(document.paths as Record<string, Record<string, unknown>>)) {
      assert.ok(path.startsWith("/"), `${path} is not a path`);
      for (const [method, operation] of Object.entries(item)) {
        const value = operation as { operationId: string; responses: Record<string, unknown>; summary: string };
        ids.push(value.operationId);
        assert.ok(value.summary.length > 0, `${method} ${path} has no summary`);
        const documented = operations.find((candidate) =>
          candidate.path === path && candidate.method.toLowerCase() === method);
        assert.ok(documented, `${method} ${path} is in the document but not in the inventory`);
        assert.ok(
          value.responses[String(documented.success.status)],
          `${method} ${path} claims ${documented.success.status} and does not describe it`,
        );
      }
    }
    assert.equal(new Set(ids).size, ids.length, "two operations share an operationId, so a generated client loses one");
  });

  it("reads each operation's summary out of the command registry rather than repeating it", () => {
    const listing = operations.find((operation) => operation.method === "GET" && operation.path === "/api/v1/zones");
    assert.ok(listing);
    const paths = document.paths as Record<string, Record<string, { summary: string }>>;
    assert.equal(paths["/api/v1/zones"]?.get?.summary, findCommand("zone list")?.summary);
  });

  it("takes its enumerations from the domain rather than listing them again", () => {
    const schemas = (document.components as { schemas: Record<string, { enum?: string[] }> }).schemas;
    assert.deepEqual(schemas.View?.enum, ["external", "internal"]);
    assert.ok((schemas.RecordType?.enum ?? []).includes("HTTPS"), "the record types come from the domain's list");
    assert.deepEqual(schemas.Role?.enum, [...ROLES]);
  });
});

describe("the document is served", () => {
  it("answers GET /api/v1/openapi.json with itself", async () => {
    const adapters = createInMemoryAdapters();
    const handler = createApiHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) });
    const response = await handler(new Request("http://localhost/api/v1/openapi.json"));
    assert.equal(response.status, 200);
    const body = await response.json();
    // The whole document, not a spot check. The route and `parallax openapi`
    // both run the same builder, and a pipeline that diffs the command's output
    // against what a deployment serves is entitled to expect exactly that.
    assert.deepEqual(body, JSON.parse(JSON.stringify(document)));
  });
});
