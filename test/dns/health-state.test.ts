import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileProbeAllowList, probeBlockReason } from "../../src/dns/health/address.ts";
import {
  effectiveStatus,
  HEALTH_RESULT_FRESHNESS_MS,
  INITIAL_PROBE_STATE,
  recordProbe,
  type ProbeState,
} from "../../src/dns/health/state.ts";

const ok = { ok: true } as const;
const fail = { ok: false, category: "connection" } as const;

function run(results: readonly { ok: boolean; category?: "connection" }[], start: ProbeState = INITIAL_PROBE_STATE): ProbeState {
  let state = start;
  let at = 1_000;
  for (const result of results) {
    state = recordProbe(state, result, at);
    at += 10_000;
  }
  return state;
}

describe("probe state", () => {
  it("trusts a never-failed address on its first success", () => {
    const state = run([ok]);
    assert.equal(state.status, "healthy");
    assert.equal(effectiveStatus(state, 1_000), "healthy");
  });

  it("keeps a healthy address through two failures and drops it on the third", () => {
    assert.equal(run([ok, fail, fail]).status, "healthy");
    assert.equal(run([ok, fail, fail, fail]).status, "unhealthy");
  });

  it("asks a failed address for two successes in a row before trusting it again", () => {
    const failed = run([fail]);
    assert.equal(failed.status, "unhealthy");
    assert.equal(run([ok], failed).status, "unhealthy");
    assert.equal(run([ok, ok], failed).status, "healthy");
    assert.equal(run([ok, fail, ok], failed).status, "unhealthy");
  });

  it("remembers the failure category and status code", () => {
    const state = recordProbe(INITIAL_PROBE_STATE, { ok: false, category: "http-status", status: 503 }, 5);
    assert.equal(state.lastFailure, "http-status");
    assert.equal(state.lastStatusCode, 503);
    assert.equal(state.checkedAt, 5);
  });

  it("goes stale without new results, and a stale history does not count toward recovery", () => {
    const healthy = run([ok]);
    const checkedAt = healthy.checkedAt ?? 0;
    assert.equal(effectiveStatus(healthy, checkedAt + HEALTH_RESULT_FRESHNESS_MS), "healthy");
    assert.equal(effectiveStatus(healthy, checkedAt + HEALTH_RESULT_FRESHNESS_MS + 1), "stale");
    assert.equal(effectiveStatus(INITIAL_PROBE_STATE, 0), "unknown");

    // One success after an unobserved gap restarts from unknown, still remembering the failure.
    const failing = run([fail, ok]);
    const later = recordProbe(failing, ok, (failing.checkedAt ?? 0) + HEALTH_RESULT_FRESHNESS_MS + 1);
    assert.equal(later.status, "unknown");
    assert.equal(later.successes, 1);
  });
});

describe("probe address safety", () => {
  const allow = compileProbeAllowList(["10.0.0.0/24", "203.0.113.0/24", "fd00::/8", "0.0.0.0/0"], [443, 8080]);
  const narrow = compileProbeAllowList(["10.0.0.0/24"], [443]);

  it("accepts an address inside an allowed network on an allowed port", () => {
    assert.equal(probeBlockReason("10.0.0.11", 443, narrow), undefined);
    assert.equal(probeBlockReason("::ffff:10.0.0.11", 443, narrow), undefined);
  });

  it("refuses outside the networks, on another port, and with an empty list", () => {
    assert.equal(probeBlockReason("10.0.1.11", 443, narrow), "outside-allowed-networks");
    assert.equal(probeBlockReason("10.0.0.11", 22, narrow), "port-not-allowed");
    assert.equal(probeBlockReason("10.0.0.11", 443, compileProbeAllowList([], [])), "outside-allowed-networks");
    assert.equal(probeBlockReason("10.0.0.11", 443, compileProbeAllowList(["10.0.0.0/24"], [])), "port-not-allowed");
  });

  it("holds an IPv6 allow-list to IPv6: every embedded IPv4 form is refused or judged as IPv4", () => {
    const everyV6 = compileProbeAllowList(["::/0"], [443]);
    // IPv4-mapped is folded to the IPv4 address, which ::/0 does not contain.
    assert.equal(probeBlockReason("::ffff:10.0.0.11", 443, everyV6), "outside-allowed-networks");
    assert.equal(probeBlockReason("::ffff:a00:b", 443, everyV6), "outside-allowed-networks");
    assert.equal(probeBlockReason("::ffff:127.0.0.1", 443, everyV6), "reserved-range");
    assert.equal(probeBlockReason("::ffff:169.254.169.254", 443, everyV6), "reserved-range");
    // The other embeddings never reach the list.
    for (const address of ["::10.0.0.11", "::127.0.0.1", "::ffff:0:127.0.0.1", "::ffff:0:a00:b", "64:ff9b::7f00:1", "2001:0:cb00:7107::1", "2002:7f00:1::1"]) {
      assert.equal(probeBlockReason(address, 443, everyV6), "translated-range", address);
    }
    assert.equal(probeBlockReason("::1", 443, everyV6), "reserved-range");
    assert.equal(probeBlockReason("::", 443, everyV6), "reserved-range");
    // An ordinary IPv6 address is still allowed.
    assert.equal(probeBlockReason("fd00::11", 443, everyV6), undefined);
    assert.equal(probeBlockReason("2001:db8::11", 443, everyV6), undefined);
  });

  it("refuses reserved and translated ranges whatever the list allows", () => {
    for (const address of ["127.0.0.1", "0.0.0.0", "169.254.169.254", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "ff02::1", "fd00:ec2::254", "::ffff:127.0.0.1",
      "100.100.100.200", "168.63.129.16", "::ffff:100.100.100.200"]) {
      assert.equal(probeBlockReason(address, 443, allow), "reserved-range", address);
    }
    for (const address of ["64:ff9b::a00:b", "2002:a00:b::1", "::10.0.0.11", "::a00:b", "::ffff:0:a00:b", "::ffff:0:10.0.0.11", "2001:0:a00:b::1", "2001::1"]) {
      assert.equal(probeBlockReason(address, 443, allow), "translated-range", address);
    }
    assert.equal(probeBlockReason("fe80::1%en0", 443, allow), "zone-id");
    assert.equal(probeBlockReason("app.example.com", 443, allow), "not-an-address");
  });
});
