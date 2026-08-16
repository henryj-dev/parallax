import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DesiredRecord } from "../../src/domain/dns.ts";
import { buildReconcilePlan, type ProviderRecord } from "../../src/domain/reconciliation.ts";

const desired: DesiredRecord = { id: "root", name: "@", type: "A", content: "192.0.2.10", ttl: 60 };

describe("managed-only reconciliation", () => {
  it("creates missing records and updates managed records", () => {
    assert.equal(buildReconcilePlan([desired], []).operations[0]?.kind, "create");
    const actual: ProviderRecord = { ...desired, content: "192.0.2.9", providerId: "one", managed: true };
    assert.deepEqual(buildReconcilePlan([desired], [actual]).summary, { create: 0, update: 1, delete: 0, conflict: 0, untouched: 0 });
  });

  it("deletes only managed records and reports unmanaged collisions", () => {
    const obsolete: ProviderRecord = { ...desired, providerId: "managed", managed: true };
    const foreign: ProviderRecord = { ...desired, id: "foreign", name: "legacy", providerId: "foreign", managed: false };
    // `foreign` is nobody's here: not managed, not desired. It is deleted by
    // nothing and now counted rather than passing in silence.
    assert.deepEqual(buildReconcilePlan([], [obsolete, foreign]).summary, { create: 0, update: 0, delete: 1, conflict: 0, untouched: 1 });

    const collision: ProviderRecord = { ...desired, content: "203.0.113.1", providerId: "foreign", managed: false };
    assert.equal(buildReconcilePlan([desired], [collision]).operations[0]?.kind, "conflict");
  });

  it("deletes incompatible names before creating CNAME and handles duplicates deterministically", () => {
    const cname: DesiredRecord = { id: "www", name: "www", type: "CNAME", content: "example.com", ttl: 60 };
    const address: ProviderRecord = { id: "www-a", name: "www", type: "A", content: "192.0.2.1", ttl: 60, providerId: "a", managed: true };
    assert.deepEqual(buildReconcilePlan([cname], [address]).operations.map((operation) => operation.kind), ["delete", "create"]);

    const managed: ProviderRecord = { ...desired, content: "203.0.113.1", providerId: "m", managed: true };
    const unmanaged: ProviderRecord = { ...desired, content: "203.0.113.2", providerId: "u", managed: false };
    assert.deepEqual(
      buildReconcilePlan([desired], [managed, unmanaged]).summary,
      buildReconcilePlan([desired], [unmanaged, managed]).summary,
    );
    assert.equal(buildReconcilePlan([desired], [managed, unmanaged]).summary.conflict, 1);
  });

  it("reconciles every value in a multi-value RRset without deleting sibling values", () => {
    const second: DesiredRecord = { ...desired, id: "root-two", content: "192.0.2.11" };
    const firstActual: ProviderRecord = { ...desired, providerId: "provider-b", managed: true };
    const staleActual: ProviderRecord = { ...second, content: "192.0.2.12", providerId: "provider-a", managed: true };

    const plan = buildReconcilePlan([second, desired], [firstActual, staleActual]);
    assert.deepEqual(plan.summary, { create: 0, update: 1, delete: 0, conflict: 0, untouched: 0 });
    assert.deepEqual(plan.operations, [{ kind: "update", providerId: "provider-a", desired: second }]);
  });

  it("matches duplicate provider values one-to-one and deletes only the surplus managed copy", () => {
    const duplicate: ProviderRecord = { ...desired, providerId: "provider-b", managed: true };
    const keeper: ProviderRecord = { ...desired, providerId: "provider-a", managed: true };
    const plan = buildReconcilePlan([desired], [duplicate, keeper]);

    assert.deepEqual(plan.summary, { create: 0, update: 0, delete: 1, conflict: 0, untouched: 0 });
    assert.deepEqual(plan.operations, [{ kind: "delete", providerId: "provider-b", actual: duplicate }]);
  });

  it("never disowns a managed record when an unmanaged exact copy appears", () => {
    const managed: ProviderRecord = { ...desired, providerId: "managed-copy", managed: true };
    const decoy: ProviderRecord = { ...desired, id: "foreign", providerId: "foreign-copy", managed: false };
    const plan = buildReconcilePlan([desired], [decoy, managed]);

    assert.equal(plan.summary.conflict, 1);
    assert.equal(plan.summary.delete, 0);
    assert.equal(plan.operations.some((operation) => operation.kind === "delete"
      && operation.providerId === managed.providerId), false);
  });

  it("fails closed when an unmanaged RRset has the desired value plus an extra value", () => {
    const exact: ProviderRecord = { ...desired, id: "foreign-exact", providerId: "foreign-exact", managed: false };
    const extra: ProviderRecord = {
      ...desired,
      id: "foreign-extra",
      content: "192.0.2.99",
      providerId: "foreign-extra",
      managed: false,
    };

    const plan = buildReconcilePlan([desired], [extra, exact]);

    assert.deepEqual(plan.summary, { create: 0, update: 0, delete: 0, conflict: 1, untouched: 0 });
    assert.deepEqual(plan.operations, [{
      kind: "conflict",
      actual: extra,
      desired,
      reason: "an unmanaged provider RRset contains a value outside desired state",
    }]);
  });

  it("uses managed record identity when one value is edited or removed", () => {
    const second: DesiredRecord = { ...desired, id: "root-two", content: "192.0.2.11" };
    const firstActual: ProviderRecord = { ...desired, providerId: "provider-first", managed: true };
    const secondActual: ProviderRecord = { ...second, providerId: "provider-second", managed: true };
    assert.deepEqual(buildReconcilePlan([second], [firstActual, secondActual]).operations, [
      { kind: "delete", providerId: "provider-first", actual: firstActual },
    ]);

    const edited = { ...second, content: "192.0.2.12" };
    assert.deepEqual(buildReconcilePlan([edited], [secondActual]).operations, [
      { kind: "update", providerId: "provider-second", desired: edited },
    ]);
  });

  it("does not drift when Cloudflare reports Auto TTL for a proxied record", () => {
    const proxied: DesiredRecord = { id: "web", name: "www", type: "A", content: "8.8.8.8", ttl: 3600, proxied: true };
    const actual: ProviderRecord = { ...proxied, ttl: 1, providerId: "cloudflare-id", managed: true };
    assert.deepEqual(buildReconcilePlan([proxied], [actual]).summary, { create: 0, update: 0, delete: 0, conflict: 0, untouched: 0 });
  });
});

describe("records the provider holds and this does not", () => {
  it("counts them rather than leaving an empty plan to speak for them", () => {
    // The reading that nearly went into a handoff: `operations: []` taken to mean
    // the provider is empty, when it meant there was nothing here to act on.
    // Adoption describes without taking over, so a record dropped from the
    // desired state stays exactly where it was -- and the plan says nothing.
    const plan = buildReconcilePlan([], [
      { id: "seed-a", name: "seed-a", type: "A", content: "192.0.2.10", ttl: 300, providerId: "cf-1", managed: false },
      { id: "seed-b", name: "seed-b", type: "A", content: "192.0.2.11", ttl: 300, providerId: "cf-2", managed: false },
    ]);
    assert.deepEqual(plan.operations, [], "none of them is ours to touch");
    assert.equal(plan.summary.untouched, 2, "and the plan says so");
  });

  it("does not count what it is about to delete", () => {
    const plan = buildReconcilePlan([], [
      { id: "ours", name: "www", type: "A", content: "192.0.2.10", ttl: 300, providerId: "cf-1", managed: true },
    ]);
    assert.equal(plan.summary.delete, 1);
    assert.equal(plan.summary.untouched, 0, "a record we own and are removing is not untouched");
  });

  it("does not count an unmanaged record it is already reporting as a conflict", () => {
    // Every other way an unmanaged record is met produces a conflict. Counting it
    // here as well would say the same record twice in two different vocabularies.
    const plan = buildReconcilePlan(
      [{ id: "web", name: "www", type: "A", content: "192.0.2.20", ttl: 300 }],
      [{ id: "theirs", name: "www", type: "A", content: "192.0.2.99", ttl: 300, providerId: "cf-9", managed: false }],
    );
    assert.equal(plan.summary.conflict, 1);
    assert.equal(plan.summary.untouched, 0);
  });
});
