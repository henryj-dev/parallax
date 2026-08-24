import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { providerManagement, type RecordType } from "../../src/domain/dns.ts";
import { overallApplyState } from "../../src/application/control-plane.ts";
import type { ApplyStatus } from "../../src/application/ports.ts";
import { applyVerdict, desiredState, providerManagedReason, readRecords } from "../../public/store.js";

/**
 * The portal decides whether to offer a delete button, and the server decides
 * whether to honour it. Those are two copies of one rule, and a rule with two
 * copies drifts: the portal offers what the server refuses, or hides what it
 * would have allowed. Neither shows up in a test of either half alone.
 *
 * So both are run over the same table. The cases are not chosen to be easy --
 * they include the spellings and near-misses that a second implementation gets
 * wrong first.
 */
const CASES: readonly { type: RecordType; content: string; managed: boolean; managedBy?: unknown }[] = [
  { type: "CNAME", content: "origin.example.net", managed: true, managedBy: { service: "worker", resource: "example-dashboard" } },
  { type: "CNAME", content: "public.r2.dev", managed: true, managedBy: { service: "r2", resource: "example-static" } },
  { type: "A", content: "8.8.8.10", managed: true, managedBy: { service: "worker", resource: "tiny-contract-api" } },
  // A binding neither side can read is not a binding either side may act on.
  { type: "CNAME", content: "origin.example.net", managed: false, managedBy: { service: "pages", resource: "site" } },
  { type: "CNAME", content: "origin.example.net", managed: false, managedBy: { service: "worker" } },
  { type: "AAAA", content: "100::", managed: true },
  { type: "AAAA", content: "0100::", managed: true },
  { type: "AAAA", content: "100:0:0:0:0:0:0:0", managed: true },
  { type: "AAAA", content: "0100:0000:0000:0000:0000:0000:0000:0000", managed: true },
  { type: "AAAA", content: "100::1", managed: false },
  { type: "AAAA", content: "2001:db8::1", managed: false },
  { type: "AAAA", content: "2606:4700::1", managed: false },
  { type: "A", content: "192.0.2.0", managed: true },
  { type: "A", content: "192.0.2.1", managed: false },
  { type: "A", content: "10.0.0.11", managed: false },
  { type: "CNAME", content: "pub-1234.r2.dev", managed: true },
  { type: "CNAME", content: "PUB-1234.R2.DEV.", managed: true },
  { type: "CNAME", content: "notr2.dev", managed: false },
  { type: "CNAME", content: "origin.example.net", managed: false },
  { type: "TXT", content: "100::", managed: false },
];

describe("portal and domain agree on which records the provider owns", () => {
  it("classifies every case the same way on both sides", () => {
    for (const testCase of CASES) {
      const record = { type: testCase.type, content: testCase.content, managedBy: testCase.managedBy };
      const server = providerManagement(record as Parameters<typeof providerManagement>[0]) !== undefined;
      const portal = providerManagedReason(record) !== "";
      assert.equal(server, testCase.managed, `server: ${testCase.type} ${testCase.content}`);
      assert.equal(portal, testCase.managed, `portal: ${testCase.type} ${testCase.content}`);
    }
  });

  it("marks the row the portal renders, so the lock reaches the button", () => {
    const rows = readRecords({
      views: [{
        name: "external",
        records: [
          { id: "apex", name: "@", type: "AAAA", content: "100::", ttl: 300 },
          { id: "web", name: "www", type: "A", content: "8.8.8.10", ttl: 300 },
        ],
      }],
    });
    const apex = rows.find((row) => row.id === "apex");
    const web = rows.find((row) => row.id === "web");
    assert.equal(apex?.views.external.managed, "originless");
    assert.equal(web?.views.external.managed, "", "an ordinary record stays editable");
  });

  it("shows a service record as the provider shows it: the service, and what it serves", () => {
    // The screenshot this came from: the type column says `R2` and the content
    // column names the bucket. The CNAME is still underneath, for the tooltip
    // and for what gets saved -- it is just not what the row is about.
    const rows = readRecords({
      views: [{
        name: "external",
        records: [
          { id: "assets", name: "static-apps", type: "CNAME", content: "public.r2.dev", ttl: 1, proxied: true,
            managedBy: { service: "r2", resource: "example-static" } },
          { id: "api", name: "contract-api", type: "CNAME", content: "origin.example.net", ttl: 1, proxied: true,
            managedBy: { service: "worker", resource: "tiny-contract-api" } },
          { id: "web", name: "www", type: "A", content: "8.8.8.10", ttl: 300 },
        ],
      }],
    });
    const bucket = rows.find((row) => row.id === "assets");
    assert.equal(bucket?.typeLabel, "R2");
    assert.equal(bucket?.views.external.label, "example-static");
    assert.equal(bucket?.views.external.content, "public.r2.dev", "what is stored is still stored");
    assert.equal(bucket?.views.external.managed, "service", "and the row is closed");

    const worker = rows.find((row) => row.id === "api");
    assert.equal(worker?.typeLabel, "Worker");
    assert.equal(worker?.views.external.label, "tiny-contract-api");

    const plain = rows.find((row) => row.id === "web");
    assert.equal(plain?.typeLabel, "A", "an ordinary record is still its type");
    assert.equal(plain?.views.external.label, "8.8.8.10");
    assert.equal(plain?.views.external.managed, "");
  });

  it("sends the binding back, so saving a page cannot unlock a row", () => {
    // The server treats a record that arrives without its binding as changed
    // and refuses the save. A page that dropped the field would therefore
    // break every save -- or, if the server were laxer, quietly unlock the row.
    const rows = readRecords({
      views: [{
        name: "external",
        records: [{ id: "assets", name: "static-apps", type: "CNAME", content: "public.r2.dev", ttl: 1, proxied: true,
          managedBy: { service: "r2", resource: "example-static" } }],
      }],
    });
    const sent = desiredState(rows) as { views: { name: string; records: { managedBy?: unknown }[] }[] };
    const external = sent.views.find((view) => view.name === "external");
    assert.deepEqual(external?.records[0]?.managedBy, { service: "r2", resource: "example-static" });
  });

  it("leaves a record that exists only inside unmarked", () => {
    // An internal override is the portal's own record, whatever it holds. The
    // flag is read off the external record, and there is none here.
    const rows = readRecords({
      views: [{ name: "internal", records: [{ id: "apex", name: "@", type: "AAAA", content: "100::", ttl: 60 }] }],
    });
    assert.equal(rows[0]?.views.external.managed, "");
  });
});

/**
 * The portal decides what colour to report an apply in, and the server decides
 * what colour to paint the zone's dot. Two copies of one rule again -- and this
 * pair matters more than most, because the disagreement is silent in exactly
 * one direction: the portal saying "applied" over a failure is a green notice
 * nobody questions.
 */
const APPLY_CASES: readonly { label: string; statuses: ApplyStatus[]; expected: string }[] = [
  { label: "nothing to reconcile", statuses: [], expected: "" },
  {
    label: "every view applied",
    statuses: [
      { zone: "z", view: "internal", desiredRevision: 2, appliedRevision: 2, state: "applied" },
      { zone: "z", view: "external", desiredRevision: 2, appliedRevision: 2, state: "applied" },
    ],
    expected: "applied",
  },
  {
    label: "one view failed among applied ones",
    statuses: [
      { zone: "z", view: "internal", desiredRevision: 2, appliedRevision: 2, state: "applied" },
      { zone: "z", view: "external", desiredRevision: 2, appliedRevision: 0, state: "failed" },
    ],
    expected: "failed",
  },
  {
    label: "a failure outranks a pending",
    statuses: [
      { zone: "z", view: "internal", desiredRevision: 2, appliedRevision: 0, state: "pending" },
      { zone: "z", view: "external", desiredRevision: 2, appliedRevision: 0, state: "failed" },
    ],
    expected: "failed",
  },
  {
    label: "one pending is enough to not be applied",
    statuses: [
      { zone: "z", view: "internal", desiredRevision: 2, appliedRevision: 2, state: "applied" },
      { zone: "z", view: "external", desiredRevision: 2, appliedRevision: 0, state: "pending" },
    ],
    expected: "pending",
  },
];

describe("portal and control plane agree on how an apply turned out", () => {
  it("reaches the same verdict from the same statuses", () => {
    for (const testCase of APPLY_CASES) {
      assert.equal(overallApplyState(testCase.statuses), testCase.expected, `server: ${testCase.label}`);
      assert.equal(applyVerdict(testCase.statuses), testCase.expected, `portal: ${testCase.label}`);
    }
  });

  it("does not read a missing or malformed answer as success", () => {
    // The portal receives this over HTTP, so it can be handed anything.
    for (const input of [undefined, null, "statuses", {}, [null], [{ view: "external" }]]) {
      assert.notEqual(applyVerdict(input), "applied", JSON.stringify(input) ?? "undefined");
    }
  });
});
