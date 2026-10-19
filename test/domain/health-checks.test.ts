import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainValidationError, type DesiredRecord } from "../../src/domain/dns.ts";
import {
  countHealthCheckChanges,
  createHealthCheckPolicy,
  DEFAULT_HEALTH_HTTP_PATH,
  hasEnabledHealthChecks,
  healthCheckPathIssue,
  MAX_HEALTH_CHECKS_PER_ZONE,
  readHealthChecks,
  resolveProtectedRRsets,
} from "../../src/domain/health-checks.ts";

const record = (name: string, type: DesiredRecord["type"], content: string, ttl = 300, extra: Partial<DesiredRecord> = {}): DesiredRecord => ({
  id: `${name}-${type}-${content}`,
  name,
  type,
  content,
  ttl,
  ...extra,
});

function issuesOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof DomainValidationError);
    return error.issues;
  }
  assert.fail("expected a validation error");
}

describe("health check policies", () => {
  it("fills the defaults, leaves a policy off unless enabled is true, and normalizes the name and type", () => {
    const policy = createHealthCheckPolicy({ name: "App.", type: "a", probe: { kind: "HTTP", port: 8080 } });
    assert.deepEqual(policy, {
      name: "app",
      type: "A",
      enabled: false,
      probe: { kind: "http", port: 8080, path: DEFAULT_HEALTH_HTTP_PATH },
      responseTtlSeconds: 30,
    });
    assert.deepEqual(createHealthCheckPolicy({ name: "@", type: "AAAA", probe: { kind: "tcp", port: 443 } }).probe, { kind: "tcp", port: 443 });
    assert.equal(createHealthCheckPolicy({ name: "app", type: "A", enabled: true, probe: { kind: "tcp", port: 443 } }).enabled, true);
    assert.equal(createHealthCheckPolicy({ name: "app", type: "A", enabled: false, probe: { kind: "tcp", port: 443 } }).enabled, false);
    assert.equal(hasEnabledHealthChecks([{ name: "internal", records: [], healthChecks: [policy] }]), false);
  });

  it("refuses every malformed field and names each", () => {
    const issues = issuesOf(() => createHealthCheckPolicy({
      name: "*.app",
      type: "CNAME",
      enabled: "yes",
      probe: { kind: "udp", port: 0 },
      responseTtlSeconds: 4,
      extra: true,
    }));
    for (const fragment of ["unknown field extra", "wildcard", "type must be A or AAAA", "enabled must be a boolean", "responseTtlSeconds", "kind must be", "port must be"]) {
      assert.ok(issues.some((issue) => issue.includes(fragment)), `missing issue about ${fragment}: ${issues.join("; ")}`);
    }
    assert.ok(issuesOf(() => createHealthCheckPolicy({ name: "app", type: "A", probe: { kind: "tcp", port: 443, path: "/x" } }))
      .some((issue) => issue.includes("unsupported field path")));
    assert.ok(issuesOf(() => createHealthCheckPolicy({ name: "app", type: "A", probe: { kind: "http", port: 80 }, responseTtlSeconds: 61 }))
      .some((issue) => issue.includes("responseTtlSeconds")));
  });

  it("stores whenNoneHealthy only when it is answer-all, and refuses any other value", () => {
    const tcp = { name: "app", type: "A", probe: { kind: "tcp", port: 443 } };
    assert.equal("whenNoneHealthy" in createHealthCheckPolicy(tcp), false, "the default leaves the policy as it always was");
    assert.equal("whenNoneHealthy" in createHealthCheckPolicy({ ...tcp, whenNoneHealthy: "servfail" }), false);
    assert.deepEqual(createHealthCheckPolicy({ ...tcp, whenNoneHealthy: " Answer-All " }), {
      name: "app",
      type: "A",
      enabled: false,
      probe: { kind: "tcp", port: 443 },
      responseTtlSeconds: 30,
      whenNoneHealthy: "answer-all",
    });
    for (const value of ["answer_all", "fail-open", "", true, 1, null, ["answer-all"]]) {
      assert.ok(issuesOf(() => createHealthCheckPolicy({ ...tcp, whenNoneHealthy: value }))
        .some((issue) => issue.includes("whenNoneHealthy must be servfail or answer-all")), `accepted ${JSON.stringify(value)}`);
    }
    // Read back from the store the same way, so an unknown value never reaches the listener.
    assert.ok(issuesOf(() => readHealthChecks([{ ...tcp, whenNoneHealthy: "maybe" }], "internal"))
      .some((issue) => issue.includes("healthChecks[0] whenNoneHealthy")));
    assert.deepEqual(readHealthChecks([{ ...tcp, whenNoneHealthy: "answer-all" }], "internal")?.map((policy) => policy.whenNoneHealthy), ["answer-all"]);
  });

  it("treats an explicit servfail as the absent default and answer-all as a change", () => {
    const base = createHealthCheckPolicy({ name: "app", type: "A", enabled: true, probe: { kind: "tcp", port: 443 } });
    const explicit = createHealthCheckPolicy({ name: "app", type: "A", enabled: true, probe: { kind: "tcp", port: 443 }, whenNoneHealthy: "servfail" });
    assert.deepEqual(countHealthCheckChanges([base], [explicit]), { added: 0, removed: 0, changed: 0 });
    assert.deepEqual(countHealthCheckChanges([base], [{ ...base, whenNoneHealthy: "answer-all" }]), { added: 0, removed: 0, changed: 1 });
    assert.deepEqual(countHealthCheckChanges([{ ...base, whenNoneHealthy: "answer-all" }], [base]), { added: 0, removed: 0, changed: 1 });
  });

  it("holds the request path to an origin-form path", () => {
    assert.equal(healthCheckPathIssue("/health/ready?full=1"), undefined);
    assert.equal(healthCheckPathIssue("/a%20b"), undefined);
    for (const path of ["", "health", "//example.com/x", "/a b", "/a\r\nHost: x", "/a#b", "/a\\b", "/a%zz", "/é", `/${"a".repeat(256)}`]) {
      assert.notEqual(healthCheckPathIssue(path), undefined, `accepted ${JSON.stringify(path)}`);
    }
  });

  it("reads a view's list: absent stays absent, internal only, no duplicates, bounded", () => {
    assert.equal(readHealthChecks(undefined, "internal"), undefined);
    assert.deepEqual(readHealthChecks([], "internal"), []);
    assert.ok(issuesOf(() => readHealthChecks([], "external")).some((issue) => issue.includes("only on the internal view")));
    const tcp = { type: "A", probe: { kind: "tcp", port: 443 } };
    assert.ok(issuesOf(() => readHealthChecks([{ name: "app", ...tcp }, { name: "APP", ...tcp }], "internal"))
      .some((issue) => issue.includes("duplicates")));
    const many = Array.from({ length: MAX_HEALTH_CHECKS_PER_ZONE + 1 }, (_, index) => ({ name: `n${index}`, ...tcp }));
    assert.ok(issuesOf(() => readHealthChecks(many, "internal")).some((issue) => issue.includes(`at most ${MAX_HEALTH_CHECKS_PER_ZONE}`)));
    const sorted = readHealthChecks([{ name: "web", ...tcp }, { name: "app", ...tcp }, { name: "app", type: "AAAA", probe: tcp.probe }], "internal");
    assert.deepEqual(sorted?.map((policy) => `${policy.name}/${policy.type}`), ["app/A", "app/AAAA", "web/A"]);
  });

  it("counts changes and notices an enabled policy", () => {
    const base = createHealthCheckPolicy({ name: "app", type: "A", enabled: true, probe: { kind: "tcp", port: 443 } });
    const changed = { ...base, responseTtlSeconds: 10 };
    const added = createHealthCheckPolicy({ name: "web", type: "A", enabled: true, probe: { kind: "tcp", port: 443 } });
    assert.deepEqual(countHealthCheckChanges([base], [changed, added]), { added: 1, removed: 0, changed: 1 });
    assert.deepEqual(countHealthCheckChanges([base, added], []), { added: 0, removed: 2, changed: 0 });
    assert.equal(hasEnabledHealthChecks([{ name: "internal", records: [], healthChecks: [{ ...base, enabled: false }] }]), false);
    assert.equal(hasEnabledHealthChecks([{ name: "internal", records: [], healthChecks: [base] }]), true);
    assert.equal(hasEnabledHealthChecks([{ name: "external", records: [] }]), false);
  });
});

describe("protected RRsets", () => {
  const policy = createHealthCheckPolicy({ name: "app", type: "A", probe: { kind: "tcp", port: 443 }, responseTtlSeconds: 30 });

  it("takes the composed addresses and the smaller of the two TTLs", () => {
    const composed = [record("app", "A", "10.0.0.11", 20), record("app", "A", "10.0.0.12", 300), record("app", "AAAA", "fd00::11")];
    const { rrsets, issues } = resolveProtectedRRsets([policy], composed, composed, []);
    assert.deepEqual(issues, []);
    assert.deepEqual(rrsets[0]?.addresses, ["10.0.0.11", "10.0.0.12"]);
    assert.equal(rrsets[0]?.ttl, 20);
  });

  it("refuses a missing RRset, a placeholder address and a provider-owned record", () => {
    assert.match(resolveProtectedRRsets([policy], [], [], []).issues[0] ?? "", /no A record to protect/u);
    const placeholder = [record("app", "A", "192.0.2.0", 300, { proxied: true })];
    assert.match(resolveProtectedRRsets([policy], placeholder, placeholder, []).issues[0] ?? "", /provider-owned or placeholder/u);
    // Composition copies the address and drops the marker; the external source still carries it.
    const composed = [record("app", "A", "10.0.0.11")];
    const external = [record("app", "A", "10.0.0.11", 300, { managedBy: { service: "worker", resource: "w1" } })];
    assert.match(resolveProtectedRRsets([policy], composed, external, []).issues[0] ?? "", /provider-owned/u);
  });

  it("reads ownership from the override, not the external record, when the internal view overrides it", () => {
    const external = [record("app", "A", "192.0.2.0", 300, { proxied: true })];
    const overrides = [record("app", "A", "10.0.0.11")];
    const { rrsets, issues } = resolveProtectedRRsets([policy], overrides, external, overrides);
    assert.deepEqual(issues, []);
    assert.deepEqual(rrsets[0]?.addresses, ["10.0.0.11"]);
  });
});
