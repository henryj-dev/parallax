import { createHash } from "node:crypto";
import type { ProviderAdapter } from "../application/ports.ts";
import { RECORD_TYPES, type DesiredRecord, type RecordType } from "../domain/dns.ts";
import type { ProviderRecord, ReconcileOperation } from "../domain/reconciliation.ts";
import { assertAnswered, exchange, readAnswers, storedType, writeQuestion, type AnsweredRecord, type DnsEndpoint, type TsigVerification } from "../dns/client.ts";
import { encodeRdata, rrType } from "../dns/rdata.ts";
import { signRequest, type TsigKey } from "../dns/tsig.ts";
import { CLASS_IN, TYPE, WireFormatError, writeName } from "../dns/wire.ts";
import { ownershipComment, readOwnershipComment } from "./ownership.ts";

/**
 * Publishing into any server that speaks RFC 2136, which is BIND, Knot,
 * PowerDNS and NSD-with-a-front-end at once.
 *
 * A protocol rather than a vendor, which is the point: there is no API shape to
 * guess at, the authentication is TSIG (RFC 8945, already here for zone
 * transfer), and an update is atomic by definition -- every prerequisite and
 * every change in one message, applied together or not at all.
 *
 * ⚠️ **These servers have nowhere to put a per-record marker.** No comment
 * field, no metadata, no row id. The ownership marker therefore lives in the
 * zone itself, as a TXT record at a reserved name beside the record it marks.
 * That is the PowerDNS answer in a different shape: still stored at the
 * provider, so a process that lost its state -- or a second one that never
 * wrote anything -- still knows what is ours. See `docs/provider-adapters.md`.
 */

export interface Rfc2136AdapterOptions {
  /** Where the primary listens. TCP, because a transfer requires it. */
  readonly server: DnsEndpoint;
  /** Signs every update and every transfer. Unsigned is not offered. */
  readonly key: TsigKey;
  readonly ownershipSecret: string;
  readonly now?: () => number;
}

/**
 * Where a marker lives, relative to the record it marks.
 *
 * Under the record's own owner name rather than in one pile at the apex, so a
 * server's own per-name access rules keep applying and a zone read by a person
 * shows the marker next to what it belongs to.
 */
const MARKER_PREFIX = "_parallax";

/** RFC 2136 §2.5: the class an update section uses to mean "remove this rdata". */
const CLASS_NONE = 254;
const OPCODE_UPDATE = 5;

export class Rfc2136ProviderAdapter implements ProviderAdapter {
  readonly #server: DnsEndpoint;
  readonly #key: TsigKey;
  readonly #ownershipSecret: string;
  readonly #now: () => number;
  #nextId = 1;

  constructor(options: Rfc2136AdapterOptions) {
    this.#server = options.server;
    this.#key = options.key;
    this.#ownershipSecret = options.ownershipSecret;
    this.#now = options.now ?? Date.now;
    // Fails here rather than at the first apply, the way the other adapters do.
    ownershipComment("validation/target", "validation", this.#ownershipSecret);
  }

  async list(target: string): Promise<ProviderRecord[]> {
    const zone = zoneOf(target);
    const answers = await this.#transfer(zone);
    const markers = this.#markers(target, zone, answers);

    const records: ProviderRecord[] = [];
    for (const answer of answers) {
      const type = storedType(answer.type);
      // The zone's own SOA and NS, and anything this build does not store.
      if (type === undefined || answer.content === undefined) continue;
      const name = relativeName(answer.name, zone);
      if (name === undefined) continue;
      // Our own bookkeeping is not zone content, the same way Cloudflare's
      // comment field is not a record.
      if (isMarkerName(name)) continue;

      const owned = markers.get(recordKey(name, type, answer.content));
      records.push({
        id: owned ?? `unmanaged-${this.#nextId++}`,
        providerId: owned === undefined ? unmanagedId(name, type, answer.content) : managedId(owned),
        managed: owned !== undefined,
        name,
        type,
        content: answer.content,
        ttl: answer.ttl,
      });
    }
    return records;
  }

  async apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> {
    const zone = zoneOf(target);
    if (operation.kind === "create") {
      await this.#update(zone, [], [
        ...addRecord(zone, operation.desired),
        ...addMarker(zone, target, operation.desired, this.#ownershipSecret),
      ]);
      return;
    }
    if (operation.kind === "delete") {
      // The same refusal both other adapters make, and for the same reason.
      if (!operation.actual.managed) throw new Error(`refusing to delete unmanaged record ${operation.providerId}`);
      const recordId = ownedRecordId(operation.providerId);
      if (recordId === undefined) throw new Error(`refusing to delete record ${operation.providerId}, which carries no ownership of ours`);
      const marker = markerRecord(target, operation.actual, recordId, this.#ownershipSecret);
      await this.#update(
        zone,
        // The marker must still be there. If somebody removed it between the
        // listing and now, this record is no longer ours to delete and the
        // server refuses the whole message rather than half of it.
        [requireMarker(zone, operation.actual.name, marker)],
        [...deleteRecord(zone, operation.actual), ...deleteMarker(zone, operation.actual.name, marker)],
      );
      return;
    }

    const recordId = ownedRecordId(operation.providerId);
    if (recordId === undefined) throw new Error(`refusing to write to record ${operation.providerId}, which carries no ownership of ours`);
    const previous = await this.#currentValue(target, zone, operation.desired, recordId);
    const oldMarker = markerRecord(target, previous, recordId, this.#ownershipSecret);
    // One message: the old record and its marker out, the new ones in. RFC 2136
    // applies an update section as a unit, so there is no moment where the
    // record exists without a marker or the other way round.
    await this.#update(
      zone,
      [requireMarker(zone, operation.desired.name, oldMarker)],
      [
        ...deleteRecord(zone, previous),
        ...deleteMarker(zone, previous.name, oldMarker),
        ...addRecord(zone, operation.desired),
        ...addMarker(zone, target, operation.desired, this.#ownershipSecret),
      ],
    );
  }

  /** The record this id names, as the server holds it right now. */
  async #currentValue(target: string, zone: string, desired: DesiredRecord, recordId: string): Promise<DesiredRecord> {
    const absolute = absoluteName(desired.name, zone);
    const [values, markers] = await Promise.all([
      this.#query(absolute, rrType(desired.type)),
      this.#query(absoluteName(markerName(desired.name), zone), TYPE.TXT),
    ]);
    const owned = new Set<string>();
    for (const marker of markers) {
      const parsed = parseMarker(marker.content, this.#ownershipSecret, target, desired.name);
      // Read from `_parallax.<name>`, so the record they describe is this
      // name -- the same join `#markers` makes out of a whole transfer.
      if (parsed?.recordId === recordId) owned.add(`${desired.name}\u0000${parsed.key}`);
    }
    for (const value of values) {
      if (value.content === undefined) continue;
      if (owned.has(recordKey(desired.name, desired.type, value.content))) {
        return { ...desired, content: value.content, ttl: value.ttl };
      }
    }
    throw new Error(`no record owned by ${recordId} is at ${absolute}, so there is nothing to change`);
  }

  /** Every marker in the zone that verifies for this target. */
  #markers(target: string, zone: string, answers: readonly AnsweredRecord[]): Map<string, string> {
    const markers = new Map<string, string>();
    for (const answer of answers) {
      if (answer.type !== TYPE.TXT || answer.content === undefined) continue;
      const name = relativeName(answer.name, zone);
      if (name === undefined || !isMarkerName(name)) continue;
      const parsed = parseMarker(answer.content, this.#ownershipSecret, target, markedName(name));
      // The marker names a type and a content digest; which record it describes
      // comes from where it sits. Joining the two here is what stops a marker
      // at one name from claiming an identical record at another.
      if (parsed) markers.set(`${markedName(name)}\u0000${parsed.key}`, parsed.recordId);
    }
    return markers;
  }

  async #transfer(zone: string): Promise<AnsweredRecord[]> {
    const request = signRequest(writeQuestion(zone, TYPE.AXFR, this.#id()), this.#key, this.#now);
    const replies = await exchange(this.#server, request.message, "transfer", this.#verify(request.mac));
    for (const reply of replies) assertAnswered(reply, `the transfer of ${zone}`);
    return readAnswers(replies);
  }

  async #query(name: string, type: number): Promise<AnsweredRecord[]> {
    const request = signRequest(writeQuestion(name, type, this.#id()), this.#key, this.#now);
    const [reply] = await exchange(this.#server, request.message, "one", this.#verify(request.mac));
    if (!reply) throw new Error(`no answer for ${name}`);
    // NXDOMAIN is a fact, not a failure: it means nothing is there yet.
    if ((reply.readUInt16BE(2) & 0xf) === 3) return [];
    assertAnswered(reply, `the query for ${name}`);
    return readAnswers([reply]);
  }

  async #update(zone: string, prerequisites: readonly Buffer[], updates: readonly Buffer[]): Promise<void> {
    const message = writeUpdate(zone, prerequisites, updates, this.#id());
    const request = signRequest(message, this.#key, this.#now);
    const [reply] = await exchange(this.#server, request.message, "one", this.#verify(request.mac));
    if (!reply) throw new Error(`no answer to the update of ${zone}`);
    assertAnswered(reply, `the update of ${zone}`);
  }

  /**
   * What every answer is checked against.
   *
   * The signing was one-way once: requests carried a MAC and replies were read
   * for their rcode alone. The zone this adapter reads decides which records it
   * believes it owns, so taking it on the network's word made every guard below
   * it decorative.
   */
  #verify(requestMac: Buffer): TsigVerification {
    return { key: this.#key, requestMac, now: this.#now };
  }

  #id(): number {
    // Not a security value -- TSIG is what authenticates -- so a counter is
    // enough, and one that never repeats within a connection is all TCP needs.
    this.#nextId = (this.#nextId + 1) & 0xffff;
    return this.#nextId;
  }
}

// -------------------------------------------------------------- the message --

/** RFC 2136 §2: the same header, four sections renamed. */
function writeUpdate(zone: string, prerequisites: readonly Buffer[], updates: readonly Buffer[], id: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(OPCODE_UPDATE << 11, 2);
  header.writeUInt16BE(1, 4); // one zone
  header.writeUInt16BE(prerequisites.length, 6);
  header.writeUInt16BE(updates.length, 8);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(TYPE.SOA, 0);
  question.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([header, writeName(zone), question, ...prerequisites, ...updates]);
}

function resourceRecord(name: string, type: number, klass: number, ttl: number, rdata: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(klass, 2);
  header.writeUInt32BE(ttl, 4);
  header.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([writeName(name), header, rdata]);
}

function addRecord(zone: string, record: DesiredRecord): Buffer[] {
  return [resourceRecord(absoluteName(record.name, zone), rrType(record.type), CLASS_IN, record.ttl, encodeRdata(record.type, record.content))];
}

/** RFC 2136 §2.5.4: class NONE deletes exactly this rdata, leaving the rest of the RRset. */
function deleteRecord(zone: string, record: DesiredRecord): Buffer[] {
  return [resourceRecord(absoluteName(record.name, zone), rrType(record.type), CLASS_NONE, 0, encodeRdata(record.type, record.content))];
}

function addMarker(zone: string, target: string, record: DesiredRecord, secret: string): Buffer[] {
  const marker = markerRecord(target, record, record.id, secret);
  return [resourceRecord(absoluteName(markerName(record.name), zone), TYPE.TXT, CLASS_IN, 0, encodeRdata("TXT", marker))];
}

function deleteMarker(zone: string, name: string, marker: string): Buffer[] {
  return [resourceRecord(absoluteName(markerName(name), zone), TYPE.TXT, CLASS_NONE, 0, encodeRdata("TXT", marker))];
}

/** RFC 2136 §2.4.2: this exact rdata must be present, or nothing in the message happens. */
function requireMarker(zone: string, name: string, marker: string): Buffer {
  return resourceRecord(absoluteName(markerName(name), zone), TYPE.TXT, CLASS_IN, 0, encodeRdata("TXT", marker));
}

// ------------------------------------------------------------- the marker --

/**
 * `<type> <content digest> <ownership marker>`, where the marker signs the
 * other two **and the name it sits under**.
 *
 * 🔴 It did not, and that was a complete break of the one promise this control
 * plane makes. `ownershipComment` signs `(target, recordId)` and nothing else,
 * so the type and the digest were an unsigned plaintext prefix and the record a
 * marker described was decided purely by where the TXT was placed. All three
 * are things an attacker chooses.
 *
 * The exploit, run end to end before this was written: read our own marker out
 * of public DNS (`dig TXT _parallax.blog.example.com`), copy the signature
 * verbatim, recompute the two plaintext fields for somebody else's `www A`, and
 * write the result to `_parallax.www`. One TXT write in the zone -- the
 * permission an ACME delegation hands out -- and `list()` reported `www` as
 * ours, reconciliation planned a delete for it, and `apply` carried it out with
 * this deployment's privileged TSIG key.
 *
 * Both guards in `apply` passed, because both asked whether the marker verified
 * rather than whether it verified *for this record*. The prerequisite passed too:
 * it asks only that the marker still exist, and the attacker left theirs there.
 *
 * Signing the scope is what fixes it. Moving a marker, or editing either
 * plaintext field, now invalidates the signature it was copied from.
 */
function markerScope(target: string, name: string, type: RecordType, digest: string): string {
  return `${target}\u0000${name}\u0000${type}\u0000${digest}`;
}

function markerRecord(target: string, record: DesiredRecord, recordId: string, secret: string): string {
  const digest = contentDigest(record.content);
  return `${record.type} ${digest} ${ownershipComment(markerScope(target, record.name, record.type, digest), recordId, secret)}`;
}

/**
 * Reads a marker as a claim about the record at `atName`, and verifies it as
 * that claim. `atName` is not taken from the marker -- it is where the marker
 * was found, which is exactly what the signature now covers.
 */
function parseMarker(
  content: string | undefined,
  secret: string,
  target: string,
  atName: string,
): { key: string; recordId: string } | undefined {
  if (content === undefined) return undefined;
  const parts = content.split(" ");
  if (parts.length < 3) return undefined;
  const [type, digest, ...marker] = parts as [string, string, ...string[]];
  if (!(RECORD_TYPES as readonly string[]).includes(type)) return undefined;
  const ownership = readOwnershipComment(marker.join(" "), secret, markerScope(target, atName, type as RecordType, digest));
  if (!ownership) return undefined;
  return { key: `${type}\u0000${digest}`, recordId: ownership.recordId };
}

/** Short on purpose: a TXT string is 255 bytes and the marker is most of it. */
function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

function recordKey(name: string, type: RecordType, content: string): string {
  return `${name}\u0000${type}\u0000${contentDigest(content)}`;
}

/** The key a marker at this name produces, so the two can be compared. */
function markedName(markerOwner: string): string {
  return markerOwner === MARKER_PREFIX ? "@" : markerOwner.slice(MARKER_PREFIX.length + 1);
}

function markerName(name: string): string {
  return name === "@" ? MARKER_PREFIX : `${MARKER_PREFIX}.${name}`;
}

function isMarkerName(name: string): boolean {
  return name === MARKER_PREFIX || name.startsWith(`${MARKER_PREFIX}.`);
}

function managedId(recordId: string): string {
  return `p:${recordId}`;
}

function ownedRecordId(providerId: string): string | undefined {
  return providerId.startsWith("p:") ? providerId.slice(2) : undefined;
}

function unmanagedId(name: string, type: RecordType, content: string): string {
  return `u:${name}/${type}/${contentDigest(content)}`;
}

// --------------------------------------------------------------- the names --

function zoneOf(target: string): string {
  const zone = target.split("/")[0] ?? "";
  if (!zone) throw new WireFormatError(`${target} is not a <zone>/<view> target`);
  return zone;
}

function absoluteName(name: string, zone: string): string {
  return name === "@" ? zone : `${name}.${zone}`;
}

function relativeName(absolute: string, zone: string): string | undefined {
  if (absolute === zone) return "@";
  return absolute.endsWith(`.${zone}`) ? absolute.slice(0, -(zone.length + 1)) : undefined;
}
