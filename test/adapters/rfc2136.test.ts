import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, describe, it } from "node:test";
import { Rfc2136ProviderAdapter } from "../../src/adapters/rfc2136.ts";
import { buildReconcilePlan } from "../../src/domain/reconciliation.ts";
import { ownershipComment } from "../../src/adapters/ownership.ts";
import { encodeRdata } from "../../src/dns/rdata.ts";
import { parseTsigKey } from "../../src/dns/tsig.ts";
import { TYPE } from "../../src/dns/wire.ts";
import { startFakePrimary, type FakePrimary } from "./rfc2136-server.ts";

const OWNERSHIP_SECRET = "test-ownership-secret-that-is-at-least-32-bytes";
const KEY = parseTsigKey(`update.key:hmac-sha256:${Buffer.alloc(32, 3).toString("base64")}`, "TEST");
const ZONE = "example.com";
const TARGET = `${ZONE}/internal`;

const running: FakePrimary[] = [];
after(async () => { await Promise.all(running.splice(0).map((primary) => primary.close())); });

async function primaryAndAdapter(records: Parameters<typeof startFakePrimary>[0]["records"] = []) {
  const primary = await startFakePrimary({ zone: ZONE, key: KEY, records });
  running.push(primary);
  const adapter = new Rfc2136ProviderAdapter({
    server: { host: "127.0.0.1", port: primary.port, timeoutMs: 5_000 },
    key: KEY,
    ownershipSecret: OWNERSHIP_SECRET,
  });
  return { primary, adapter };
}

/** A record somebody else put in the zone, with no marker beside it. */
function theirs(name: string, content: string) {
  return { name: `${name}.${ZONE}`, type: TYPE.A, ttl: 300, rdata: encodeRdata("A", content) };
}

describe("the RFC 2136 provider", () => {
  it("writes a record and the marker that says it is ours, in one message", async () => {
    const { primary, adapter } = await primaryAndAdapter();
    await adapter.apply(TARGET, { kind: "create", desired: { id: "web", name: "www", type: "A", content: "192.0.2.10", ttl: 300 } });

    // One update, not two: a record that existed without its marker would be
    // invisible to the next listing and get created a second time.
    assert.equal(primary.updates, 1);
    const written = primary.records.map((record) => `${record.name}/${record.type}`);
    assert.deepEqual(written.sort(), [`_parallax.www.${ZONE}/${TYPE.TXT}`, `www.${ZONE}/${TYPE.A}`]);

    const [listed] = await adapter.list(TARGET);
    assert.ok(listed);
    assert.equal(listed.managed, true);
    assert.equal(listed.id, "web");
    assert.equal(listed.content, "192.0.2.10");
    // The marker is bookkeeping, not zone content -- the same way Cloudflare's
    // comment field is not listed as a record.
    assert.equal((await adapter.list(TARGET)).length, 1);
  });

  it("does not claim a record whose marker was written for another target", async () => {
    const marker = `A ${"0".repeat(16)} ${ownershipComment(`${ZONE}/external`, "web", OWNERSHIP_SECRET)}`;
    const { adapter } = await primaryAndAdapter([
      theirs("www", "192.0.2.10"),
      { name: `_parallax.www.${ZONE}`, type: TYPE.TXT, ttl: 0, rdata: encodeRdata("TXT", marker) },
    ]);
    const [listed] = await adapter.list(TARGET);
    assert.equal(listed?.managed, false, "a marker for the external view claimed an internal record");
  });

  it("does not let a marker at one name claim an identical record at another", async () => {
    // Same type, same content, so the marker's own fields match -- and it sits
    // at `_parallax.a`, which is what says it describes `a` and not `b`.
    const { primary, adapter } = await primaryAndAdapter([theirs("a", "192.0.2.10"), theirs("b", "192.0.2.10")]);
    await adapter.apply(TARGET, { kind: "create", desired: { id: "one", name: "a", type: "A", content: "192.0.2.11", ttl: 300 } });
    void primary;

    const listed = await adapter.list(TARGET);
    const owned = listed.filter((record) => record.managed);
    assert.deepEqual(owned.map((record) => `${record.name}=${record.content}`), ["a=192.0.2.11"]);
  });

  it("refuses to change a record whose marker has gone", async () => {
    const { primary, adapter } = await primaryAndAdapter();
    await adapter.apply(TARGET, { kind: "create", desired: { id: "web", name: "www", type: "A", content: "192.0.2.10", ttl: 300 } });
    const [listed] = await adapter.list(TARGET);
    assert.ok(listed);

    // Somebody removes the marker between the listing and the write.
    const index = primary.records.findIndex((record) => record.type === TYPE.TXT);
    primary.records.splice(index, 1);

    await assert.rejects(
      () => adapter.apply(TARGET, {
        kind: "update", providerId: listed.providerId,
        desired: { id: "web", name: "www", type: "A", content: "192.0.2.99", ttl: 300 },
      }),
      "a record whose ownership had been removed was written to anyway",
    );
    // ...and the record is untouched, because the prerequisite refused the
    // whole message rather than half of it.
    assert.equal(primary.records.filter((record) => record.type === TYPE.A).length, 1);
    assert.deepEqual(primary.records.find((record) => record.type === TYPE.A)?.rdata, encodeRdata("A", "192.0.2.10"));
  });

  it("moves the marker with the record it describes", async () => {
    const { primary, adapter } = await primaryAndAdapter();
    await adapter.apply(TARGET, { kind: "create", desired: { id: "web", name: "www", type: "A", content: "192.0.2.10", ttl: 300 } });
    const [before] = await adapter.list(TARGET);
    assert.ok(before);

    await adapter.apply(TARGET, {
      kind: "update", providerId: before.providerId,
      desired: { id: "web", name: "www", type: "A", content: "192.0.2.20", ttl: 600 },
    });

    // Exactly one record and exactly one marker: an update that added the new
    // marker without removing the old one would leave the record claimed twice.
    assert.equal(primary.records.filter((record) => record.type === TYPE.A).length, 1);
    assert.equal(primary.records.filter((record) => record.type === TYPE.TXT).length, 1);
    const [after] = await adapter.list(TARGET);
    assert.equal(after?.content, "192.0.2.20");
    assert.equal(after?.ttl, 600);
    assert.equal(after?.managed, true);
    assert.equal(after?.providerId, before.providerId, "the identity moved with the content");
  });

  it("signs everything, and a server that will not take an unsigned message is answered", async () => {
    const { adapter } = await primaryAndAdapter();
    // The fake primary answers NOTAUTH to anything unsigned, so a working
    // listing is itself the proof that the transfer carried a signature.
    assert.deepEqual(await adapter.list(TARGET), []);

    const wrong = new Rfc2136ProviderAdapter({
      server: { host: "127.0.0.1", port: (running.at(-1) as FakePrimary).port, timeoutMs: 5_000 },
      key: { ...KEY, secret: Buffer.alloc(32, 9) },
      ownershipSecret: OWNERSHIP_SECRET,
    });
    // RFC 8945 §5.2 keeps NOTAUTH readable without a signature, precisely so a
    // peer can say which of the two ends is wrong. Anything else unsigned is
    // discarded before it is read.
    await assert.rejects(() => wrong.list(TARGET), /refused this key: NOTAUTH/u, "a wrong key was accepted");
  });

  /**
   * The break this adapter shipped with, kept as the exploit that found it.
   *
   * The marker's signature covered `(target, recordId)` and nothing else, so
   * the type and content digest were unsigned plaintext and the record a marker
   * described was decided by where the TXT sat. Every one of those is an
   * attacker's choice if they can write a single TXT in the zone -- which is
   * what an ACME delegation grants.
   */
  it("refuses a marker whose signature was copied from another record", async () => {
    const { primary, adapter } = await primaryAndAdapter([theirs("www", "198.51.100.9")]);
    await adapter.apply(TARGET, { kind: "create", desired: { id: "blog", name: "blog", type: "A", content: "203.0.113.5", ttl: 300 } });

    // Read our own marker the way anyone can: `dig TXT _parallax.blog…`.
    const published = primary.records.find((record) => record.type === TYPE.TXT);
    assert.ok(published);
    const marker = published.rdata.subarray(1).toString();
    const token = marker.split(" ").slice(2).join(" ");

    // Copy the signature verbatim; recompute only the two plaintext fields for
    // somebody else's record, and plant it where that record lives.
    const digest = createHash("sha256").update("198.51.100.9", "utf8").digest("hex").slice(0, 16);
    primary.records.push({
      name: `_parallax.www.${ZONE}`, type: TYPE.TXT, ttl: 0,
      rdata: encodeRdata("TXT", `A ${digest} ${token}`),
    });

    const listed = await adapter.list(TARGET);
    const victim = listed.find((record) => record.name === "www");
    assert.equal(victim?.managed, false, "a copied signature claimed a record it was not issued for");
    // ...so reconciliation has nothing to delete. This is the step that used to
    // reach `apply` and remove the record with this deployment's own key.
    const plan = buildReconcilePlan(
      [{ id: "blog", name: "blog", type: "A", content: "203.0.113.5", ttl: 300 }],
      listed,
    );
    assert.deepEqual(plan.operations.filter((operation) => operation.kind === "delete"), []);
  });

  it("refuses an answer that is not signed, and reads the one refusal that cannot be", async () => {
    const { primary, adapter } = await primaryAndAdapter();
    // A peer that answers without a signature is a peer we cannot identify.
    primary.stripSignatures = true;
    await assert.rejects(() => adapter.list(TARGET), /carried no signature/u);
  });

  it("refuses a transfer that stopped part way through", async () => {
    const { primary, adapter } = await primaryAndAdapter([theirs("www", "198.51.100.9")]);
    // RFC 5936 §6: a transfer with an error detected is discarded whole. A
    // short zone read as a complete one makes every missing record look deleted.
    primary.truncateTransfer = true;
    await assert.rejects(() => adapter.list(TARGET), /closed part way through/u);
  });

  it("leaves the zone's own records alone", async () => {
    const { adapter } = await primaryAndAdapter([
      { name: ZONE, type: TYPE.NS, ttl: 3600, rdata: encodeRdata("NS", `ns.${ZONE}`) },
      theirs("www", "192.0.2.10"),
    ]);
    const listed = await adapter.list(TARGET);
    // The SOA is not a stored type and never appears; NS is, so it does -- as
    // somebody else's record, which is what it is.
    assert.deepEqual(
      listed.map((record) => `${record.name}/${record.type}/${record.managed}`).sort(),
      ["@/NS/false", "www/A/false"],
    );
  });
});
