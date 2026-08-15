import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Zone } from "../../src/domain/dns.ts";
import { unservedTargets } from "../../src/http/readiness.ts";

function zone(name: string, views: string[]): Zone {
  return {
    name,
    revision: 1,
    views: views.map((view) => ({ name: view, records: [] })),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const NOTHING_CONFIGURED = (): boolean => false;

describe("readiness", () => {
  it("counts the internal view a public zone implies, even where nobody wrote one", () => {
    // Split-horizon materializes `internal` from `external`, so a zone with a
    // public view has an internal one to serve whether or not it was written.
    assert.deepEqual(
      unservedTargets([zone("example.com", ["external"])], NOTHING_CONFIGURED, false),
      ["example.com/external", "example.com/internal"],
    );
  });

  it("is satisfied by a configured provider", () => {
    const configured = (target: string): boolean => target === "example.com/internal";
    assert.deepEqual(unservedTargets([zone("example.com", ["internal"])], configured, false), []);
  });

  it("counts the built-in listener as serving the internal view", () => {
    // Without this a deployment that answers DNS itself instead of publishing
    // into CoreDNS or PowerDNS fails its readiness probe forever while
    // answering every query correctly, and is never sent traffic to prove it.
    assert.deepEqual(unservedTargets([zone("example.com", ["internal"])], NOTHING_CONFIGURED, true), []);
  });

  it("does not let the listener stand in for the external view", () => {
    // The listener answers the internal view and nothing else. A public zone
    // with no provider is still a zone nothing will publish.
    assert.deepEqual(
      unservedTargets([zone("example.com", ["external"])], NOTHING_CONFIGURED, true),
      ["example.com/external"],
    );
  });

  it("reports every zone that is short, not only the first", () => {
    assert.deepEqual(
      unservedTargets(
        [zone("one.example", ["internal"]), zone("two.example", ["internal"])],
        NOTHING_CONFIGURED,
        false,
      ),
      ["one.example/internal", "two.example/internal"],
    );
  });

  it("has nothing to say about a deployment with no zones yet", () => {
    assert.deepEqual(unservedTargets([], NOTHING_CONFIGURED, false), []);
  });
});
