import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CloudflareProviderAdapter } from "../../src/adapters/cloudflare.ts";
import { ownershipComment } from "../../src/adapters/ownership.ts";
import { Rfc2136ProviderAdapter } from "../../src/adapters/rfc2136.ts";
import { encodeRdata, rrType } from "../../src/dns/rdata.ts";
import { parseTsigKey } from "../../src/dns/tsig.ts";
import type { ProviderAdapter } from "../../src/application/ports.ts";
import type { DesiredRecord } from "../../src/domain/dns.ts";
import type { ProviderRecord } from "../../src/domain/reconciliation.ts";
import { FileProviderAdapter } from "../../src/infrastructure/file-provider.ts";
import { InMemoryProvider } from "../../src/infrastructure/in-memory.ts";
import { startFakePrimary } from "./rfc2136-server.ts";

/**
 * What every provider adapter has to do, asked of each of them the same way.
 *
 * Until this existed each adapter was tested against its own idea of itself:
 * `cloudflare.test.ts` calls `apply` eight times and never once calls `list`
 * afterwards, so **nothing had ever round-tripped a record through it**. An
 * adapter that accepted a create and dropped it would have passed.
 *
 * The rules below are not this file's invention -- they are what
 * `buildReconcilePlan` and the control plane already assume. They are written
 * down here so the next adapter has something to code against, and so the ones
 * that exist cannot drift apart from each other quietly.
 *
 * ⚠️ A harness's `reopen` is the load-bearing one. It builds a second adapter
 * over the same stored data, which is how ownership gets tested for what it
 * actually claims: that `managed` is recovered **from the provider**, not
 * remembered by the object that wrote it. An adapter that keeps ownership in a
 * field passes every other test here.
 */

interface ProviderContractSubject {
  readonly adapter: ProviderAdapter;
  readonly target: string;
  /** A record placed at the provider by somebody who is not this control plane. */
  seedUnmanaged(record: DesiredRecord): Promise<void>;
  /** A second adapter over the same stored data. */
  reopen(): Promise<ProviderAdapter>;
  close?(): Promise<void>;
}

interface ProviderContractHarness {
  readonly name: string;
  open(): Promise<ProviderContractSubject>;
  /**
   * Rules this implementation does not claim, each with the reason.
   *
   * An escape hatch with a sentence attached, not a switch: a harness that
   * skips a rule has to say why in the same place, so the exemption is read
   * every time somebody opens this file.
   */
  readonly exempt?: Readonly<Record<string, string>>;
}

const OWNERSHIP_SECRET = "test-ownership-secret-that-is-at-least-32-bytes";
const TARGET = "example.com/external";

function desired(overrides: Partial<DesiredRecord> = {}): DesiredRecord {
  return { id: "web", name: "www", type: "A", content: "192.0.2.10", ttl: 300, ...overrides };
}

/**
 * That a rejection is a refusal, and not the code falling over on the way to
 * one.
 *
 * `assert.rejects(fn, "…")` reads a string as the *message* rather than as a
 * check on the error -- Node's own documentation calls that the easy mistake --
 * so the rules below accepted **any** rejection at all. A `TypeError` raised
 * before the ownership check had run satisfied "somebody else's record was not
 * overwritten" exactly as well as the refusal did, which is the one rule this
 * file calls the product's promise.
 *
 * Four adapters refuse in four sentences, so there is no single regex to pin
 * here. What can be pinned is the shape: an `Error` that says something, and
 * not one of the classes a runtime raises when the code itself is wrong.
 */
function aRefusal(error: unknown): true {
  assert.ok(error instanceof Error, `the operation failed with something that is not an Error: ${String(error)}`);
  assert.ok(
    !(error instanceof TypeError) && !(error instanceof ReferenceError),
    `the operation broke before it could refuse: ${error.stack ?? error.message}`,
  );
  assert.notEqual(error.message.trim(), "", "a refusal with no sentence in it tells an operator nothing");
  return true;
}

function describeProviderContract(harness: ProviderContractHarness): void {
  describe(harness.name, () => {
    /** Runs a rule, or records why this implementation is excused from it. */
    const rule = (name: string, body: (subject: ProviderContractSubject) => Promise<void>): void => {
      const excuse = harness.exempt?.[name];
      it(excuse ? `${name} — 면제: ${excuse}` : name, async (context) => {
        if (excuse) {
          context.skip(excuse);
          return;
        }
        const subject = await harness.open();
        try {
          await body(subject);
        } finally {
          await subject.close?.();
        }
      });
    };

    rule("an untouched target lists nothing, rather than failing", async ({ adapter, target }) => {
      assert.deepEqual(await adapter.list(target), []);
    });

    rule("a created record comes back owned, with an id that drives the next call", async (subject) => {
      const { adapter, target } = subject;
      await adapter.apply(target, { kind: "create", desired: desired() });

      const [listed, ...rest] = await adapter.list(target);
      assert.equal(rest.length, 0, "one create produced more than one record");
      assert.ok(listed, "a created record did not come back");
      assert.equal(listed.managed, true, "the adapter does not recognize what it wrote");
      assert.ok(listed.providerId.length > 0, "a listed record must carry an id the provider knows it by");
      assert.equal(listed.name, "www");
      assert.equal(listed.type, "A");
      assert.equal(listed.content, "192.0.2.10");
      // The control plane's own identifier, recovered from the provider. This
      // is what lets a plan built now match a record written by a process that
      // has since restarted.
      assert.equal(listed.id, "web");
    });

    rule("an update keeps the record's identity and changes what was asked", async ({ adapter, target }) => {
      await adapter.apply(target, { kind: "create", desired: desired() });
      const before = (await adapter.list(target))[0];
      assert.ok(before);

      await adapter.apply(target, {
        kind: "update",
        providerId: before.providerId,
        desired: desired({ content: "192.0.2.20", ttl: 600 }),
      });

      const after = (await adapter.list(target))[0];
      assert.ok(after);
      assert.equal(after.content, "192.0.2.20");
      assert.equal(after.ttl, 600);
      assert.equal(after.managed, true, "an update must not lose ownership");
      assert.equal(after.providerId, before.providerId, "an update is not a replace");
    });

    rule("a deleted record is gone from the next listing", async ({ adapter, target }) => {
      await adapter.apply(target, { kind: "create", desired: desired() });
      const record = (await adapter.list(target))[0];
      assert.ok(record);
      await adapter.apply(target, { kind: "delete", providerId: record.providerId, actual: record });
      assert.deepEqual(await adapter.list(target), []);
    });

    /**
     * Silence here is the dangerous answer: reconciliation reads a successful
     * apply as convergence, so an adapter that shrugs at an id it cannot find
     * reports a zone as applied while the record is not there.
     */
    rule("an operation naming a record that is not there fails rather than passing", async ({ adapter, target }) => {
      const absent: ProviderRecord = { ...desired(), providerId: "no-such-record", managed: true };
      await assert.rejects(
        () => adapter.apply(target, { kind: "update", providerId: absent.providerId, desired: desired() }),
        aRefusal,
        "an update against a missing record reported success",
      );
      await assert.rejects(
        () => adapter.apply(target, { kind: "delete", providerId: absent.providerId, actual: absent }),
        aRefusal,
        "a delete against a missing record reported success",
      );
    });

    /**
     * Adoption, drift and conflict all read this list. A record left out
     * because we did not write it is a record the operator is told does not
     * exist -- and `buildReconcilePlan` would then propose creating it again.
     */
    rule("a record this control plane did not write is listed, and marked unowned", async (subject) => {
      const { adapter, target } = subject;
      await subject.seedUnmanaged(desired({ id: "theirs", name: "legacy", content: "203.0.113.9" }));
      const [listed] = await adapter.list(target);
      assert.ok(listed, "somebody else's record was not listed at all");
      assert.equal(listed.managed, false, "an unmarked record was reported as ours");
      assert.equal(listed.name, "legacy");
    });

    /**
     * The product's one promise. The control plane is supposed to emit
     * `conflict` rather than `update` here, so this is the second lock on the
     * same door -- which is the point: the first one is a plan, and a plan is
     * built from a listing that may already be stale.
     */
    rule("a record this control plane does not own is never written to", async (subject) => {
      const { adapter, target } = subject;
      await subject.seedUnmanaged(desired({ id: "theirs", name: "legacy", content: "203.0.113.9" }));
      const [theirs] = await adapter.list(target);
      assert.ok(theirs);

      await assert.rejects(
        () => adapter.apply(target, { kind: "update", providerId: theirs.providerId, desired: desired({ name: "legacy", content: "192.0.2.99" }) }),
        aRefusal,
        "somebody else's record was overwritten",
      );
      await assert.rejects(
        () => adapter.apply(target, { kind: "delete", providerId: theirs.providerId, actual: theirs }),
        aRefusal,
        "somebody else's record was deleted",
      );
      // ...and it is still there, unchanged.
      const [after] = await adapter.list(target);
      assert.equal(after?.content, "203.0.113.9");
      assert.equal(after?.managed, false);
    });

    rule("two records at one name and type stay distinguishable", async ({ adapter, target }) => {
      await adapter.apply(target, { kind: "create", desired: desired({ id: "one", content: "192.0.2.1" }) });
      await adapter.apply(target, { kind: "create", desired: desired({ id: "two", content: "192.0.2.2" }) });

      const listed = await adapter.list(target);
      assert.equal(listed.length, 2);
      assert.equal(new Set(listed.map((record) => record.providerId)).size, 2, "two records share one provider id");
      assert.deepEqual(listed.map((record) => record.content).sort(), ["192.0.2.1", "192.0.2.2"]);

      // Deleting one leaves the other exactly as it was.
      const first = listed.find((record) => record.content === "192.0.2.1");
      assert.ok(first);
      await adapter.apply(target, { kind: "delete", providerId: first.providerId, actual: first });
      const remaining = await adapter.list(target);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]?.content, "192.0.2.2");
    });

    rule("a listing is a copy, not a handle on the provider", async ({ adapter, target }) => {
      await adapter.apply(target, { kind: "create", desired: desired() });
      const listed = await adapter.list(target);
      const record = listed[0];
      assert.ok(record);
      record.content = "10.0.0.1";
      record.managed = false;
      listed.length = 0;
      const again = (await adapter.list(target))[0];
      assert.equal(again?.content, "192.0.2.10", "a caller's edit reached the provider");
      assert.equal(again?.managed, true);
    });

    /**
     * `[]` is "no service owns any of these names" and it **unlocks records**.
     * Not knowing is a different answer, and there are two ways to give it:
     * `undefined`, or a throw. The control plane treats them identically --
     * `#serviceOwnership` catches and warns -- so a throw is not a failure
     * here, it is the same answer carrying the reason `undefined` cannot.
     *
     * ⚠️ Written this way after the first version of this rule got it wrong.
     * It asserted "returns undefined", the Cloudflare adapter threw, and the
     * throw turned out to be the better answer: it names the missing account id
     * and token permissions where an operator is already reading. The port's
     * own comment mentioned only `undefined`, which is what made the rule wrong
     * -- so that comment now says both.
     */
    rule("not knowing who owns a name is never reported as nobody owning it", async ({ adapter, target }) => {
      // ⚠️ 여기 있던 `if (!adapter.serviceOwnership) return;` 이 이 규칙을 넷 중
      // 둘에게 **통과로 기록**했다 -- 단언 하나 없이. 구현이 없다는 것은 답이지만
      // 그 답의 이름은 「통과」가 아니라 「면제」이고, 면제는 이유가 옆에 적힌다.
      assert.ok(adapter.serviceOwnership, "this rule was neither answered nor exempted; say which in the harness's `exempt`");
      // Every harness opens un-configured, so this is exactly the state where
      // the wrong answer would be `[]`.
      const answer = await adapter.serviceOwnership(target).then(
        (said) => ({ said }),
        (threw: unknown) => ({ threw }),
      );

      if ("threw" in answer) {
        // 던지기가 `undefined` 보다 나은 답인 이유는 오로지 이유를 실어 나르기
        // 때문이다. 그 문장이 고칠 곳을 대지 못하면 운영자에게 남는 것은 침묵과
        // 같고, 그러면 굳이 던질 이유도 없다 -- 그래서 문장 자체를 못 박는다.
        assert.ok(answer.threw instanceof Error, `a provider that cannot answer threw something that is not an Error: ${String(answer.threw)}`);
        assert.match(answer.threw.message, /account id/iu, "the throw does not name the configuration that is missing");
        assert.match(answer.threw.message, /Read on its token/u, "the throw does not name the token permissions that would repair it");
        return;
      }
      // `[]` 하나만이 금지된 답이다: 「어떤 서비스도 이 이름들을 갖고 있지
      // 않다」로 읽히고, 그것이 레코드를 푼다. `undefined` 는 포트가 문서로
      // 인정한 「말할 수 없다」이므로 여기서 실패가 아니다.
      assert.notDeepEqual(answer.said, [],
        "a provider that cannot answer reported that no service owns anything, which unlocks records");
      if (answer.said !== undefined) {
        assert.ok(Array.isArray(answer.said), "an answer that is not `undefined` has to be the list it claims to be");
      }
    });

    /**
     * The one that separates an adapter from a bookkeeping object: ownership is
     * a fact stored at the provider, so a process that restarts -- or a second
     * replica that never wrote anything -- still knows what is ours.
     */
    rule("ownership is read back from the provider, not remembered by the writer", async (subject) => {
      const { adapter, target } = subject;
      await subject.seedUnmanaged(desired({ id: "theirs", name: "legacy", content: "203.0.113.9" }));
      await adapter.apply(target, { kind: "create", desired: desired() });

      const fresh = await subject.reopen();
      const listed = await fresh.list(target);
      assert.equal(listed.length, 2);
      const ours = listed.find((record) => record.name === "www");
      const theirs = listed.find((record) => record.name === "legacy");
      assert.equal(ours?.managed, true, "a fresh adapter does not recognize what an earlier one wrote");
      assert.equal(ours?.id, "web", "the control plane's identifier did not survive the round trip");
      assert.equal(theirs?.managed, false, "a fresh adapter claimed a record it never wrote");
    });
  });
}

// ---------------------------------------------------------------- harnesses --

describeProviderContract({
  name: "the file provider",
  exempt: {
    // 파일 하나가 곧 프로바이더라, 이름을 발행하는 서비스라는 것이 없다.
    // `serviceOwnership` 을 두지 않는 것이 이 어댑터의 답이고 -- 포트에서 이
    // 메서드가 선택인 이유가 그것이다 -- 그러니 통과가 아니라 면제로 센다.
    "not knowing who owns a name is never reported as nobody owning it":
      "저장소가 파일 하나뿐이라 바인딩을 물어볼 서비스가 없다",
  },
  async open() {
    const directory = await mkdtemp(join(tmpdir(), "parallax-provider-contract-"));
    const path = join(directory, "provider.json");
    const adapter = new FileProviderAdapter({ path });
    return {
      adapter,
      target: TARGET,
      async seedUnmanaged(record) {
        // Written straight into the store, because that is what "somebody else
        // put it there" means -- it must not come through `apply`.
        const state = await readFile(path, "utf8").then(
          (raw) => JSON.parse(raw) as { version: 1; nextId: number; targets: Record<string, unknown[]> },
          () => ({ version: 1 as const, nextId: 1, targets: {} as Record<string, unknown[]> }),
        );
        state.targets[TARGET] = [
          ...(state.targets[TARGET] ?? []),
          { ...record, providerId: `theirs-${state.nextId}`, managed: false },
        ];
        state.nextId += 1;
        await writeFile(path, JSON.stringify(state), { mode: 0o600 });
      },
      async reopen() {
        return new FileProviderAdapter({ path });
      },
      async close() {
        await rm(directory, { recursive: true, force: true });
      },
    };
  },
});

describeProviderContract({
  name: "the in-memory provider",
  exempt: {
    // 소유권 검사 면제가 여기 있었다. 이 스위트가 그것을 물었고, 답이 「진짜 어댑터
    // 둘은 하는데 이것만 안 한다」였다 — 그래서 면제를 지우고 구현을 맞췄다.
    "ownership is read back from the provider, not remembered by the writer":
      "저장소가 곧 이 객체라 「다시 연다」가 성립하지 않는다",
  },
  async open() {
    const adapter = new InMemoryProvider();
    return {
      adapter,
      target: TARGET,
      async seedUnmanaged(record) {
        adapter.seed(TARGET, [
          ...await adapter.list(TARGET),
          { ...record, providerId: `theirs-${record.name}`, managed: false },
        ]);
      },
      async reopen() {
        return adapter;
      },
    };
  },
});

/**
 * A Cloudflare that remembers.
 *
 * Every existing Cloudflare test answers one canned payload, which is why none
 * of them could round-trip. This is the smallest store that behaves like the
 * five endpoints the adapter actually uses.
 */
function cloudflareStub(): { fetch: typeof fetch; seed(record: DesiredRecord & { comment?: string }): void } {
  const records = new Map<string, Record<string, unknown>>();
  let next = 1;

  const json = (body: unknown, status = 200): Response => Response.json(body, { status });
  const fail = (message: string, status: number): Response =>
    json({ success: false, errors: [{ message }] }, status);

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const match = /\/dns_records(?:\/(?<id>[^/?]+))?$/u.exec(url.pathname);
    if (!match) return fail("unexpected path", 404);
    const id = match.groups?.id;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};

    if (method === "GET" && !id) {
      return json({ success: true, result: [...records.values()], result_info: { page: 1, total_pages: 1 } });
    }
    if (method === "GET" && id) {
      const record = records.get(id);
      return record ? json({ success: true, result: record }) : fail("record not found", 404);
    }
    if (method === "POST") {
      const created = `cf-${next++}`;
      records.set(created, { ...body, id: created });
      return json({ success: true, result: records.get(created) });
    }
    if (!id || !records.has(id)) return fail("record not found", 404);
    if (method === "PATCH") {
      records.set(id, { ...records.get(id), ...body, id });
      return json({ success: true, result: records.get(id) });
    }
    if (method === "DELETE") {
      records.delete(id);
      return json({ success: true, result: { id } });
    }
    return fail(`unexpected method ${method}`, 405);
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    seed(record) {
      const created = `cf-${next++}`;
      records.set(created, {
        id: created,
        name: record.name === "@" ? "example.com" : `${record.name}.example.com`,
        type: record.type,
        content: record.content,
        ttl: record.ttl,
        ...(record.comment === undefined ? {} : { comment: record.comment }),
      });
    },
  };
}

describeProviderContract({
  name: "the Cloudflare provider",
  async open() {
    const store = cloudflareStub();
    const build = (): ProviderAdapter => new CloudflareProviderAdapter({
      token: "secret",
      zoneId: "zone-1",
      fetch: store.fetch,
      ownershipSecret: OWNERSHIP_SECRET,
    });
    return {
      adapter: build(),
      target: TARGET,
      async seedUnmanaged(record) {
        store.seed(record);
      },
      async reopen() {
        return build();
      },
    };
  },
});

/**
 * The adapter this suite was written before, which is the order it was meant to
 * be used in: the rules were the specification, and the harness was the first
 * thing written of the adapter rather than the last.
 */
describeProviderContract({
  name: "the RFC 2136 provider",
  exempt: {
    // 프로토콜이 존에 실린 레코드밖에 모른다. 어떤 서비스가 어떤 이름을 발행
    // 중인지는 DNS 바깥의 사실이고, RFC 2136 에는 그것을 물을 자리가 없다.
    "not knowing who owns a name is never reported as nobody owning it":
      "존에 실린 레코드가 전부이고, 바인딩을 물어볼 자리가 프로토콜에 없다",
  },
  async open() {
    const key = parseTsigKey(`update.key:hmac-sha256:${Buffer.alloc(32, 3).toString("base64")}`, "TEST");
    const primary = await startFakePrimary({ zone: "example.com", key });
    const build = (): ProviderAdapter => new Rfc2136ProviderAdapter({
      server: { host: "127.0.0.1", port: primary.port, timeoutMs: 5_000 },
      key,
      ownershipSecret: OWNERSHIP_SECRET,
    });
    return {
      adapter: build(),
      // This adapter publishes the internal view; the external target is
      // Cloudflare's. The marker carries the target either way.
      target: "example.com/internal",
      async seedUnmanaged(record) {
        // Straight into the zone, with no marker beside it -- which is exactly
        // what a record somebody else added looks like.
        primary.records.push({
          name: record.name === "@" ? "example.com" : `${record.name}.example.com`,
          type: rrType(record.type),
          ttl: record.ttl,
          rdata: encodeRdata(record.type, record.content),
        });
      },
      async reopen() {
        return build();
      },
      async close() {
        await primary.close();
      },
    };
  },
});

/** Proof that the ownership marker is what the round trip actually rests on. */
describe("the contract's own control", () => {
  it("a Cloudflare record carrying a marker for another target is not ours", async () => {
    const store = cloudflareStub();
    store.seed({ ...desired(), comment: ownershipComment("example.com/internal", "web", OWNERSHIP_SECRET) });
    const adapter = new CloudflareProviderAdapter({
      token: "secret", zoneId: "zone-1", fetch: store.fetch, ownershipSecret: OWNERSHIP_SECRET,
    });
    const [listed] = await adapter.list(TARGET);
    // The marker is real and verifies -- against a different target. Reading it
    // as ours would let the internal view's records be rewritten by the
    // external one, which is the whole reason the target is inside the marker.
    assert.equal(listed?.managed, false);
  });
});
