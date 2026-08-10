import { effectiveExternalTtl, type DesiredRecord } from "./dns.ts";

export interface ProviderRecord extends DesiredRecord {
  providerId: string;
  managed: boolean;
}

export type ReconcileOperation =
  | { kind: "create"; desired: DesiredRecord }
  | { kind: "update"; providerId: string; desired: DesiredRecord }
  | { kind: "delete"; providerId: string; actual: ProviderRecord }
  | { kind: "conflict"; actual: ProviderRecord; desired?: DesiredRecord; reason: string };

export interface ReconcilePlan {
  operations: ReconcileOperation[];
  summary: { create: number; update: number; delete: number; conflict: number };
}

export function buildReconcilePlan(desired: DesiredRecord[], actual: ProviderRecord[]): ReconcilePlan {
  const deletes: ReconcileOperation[] = [];
  const updates: ReconcileOperation[] = [];
  const creates: ReconcileOperation[] = [];
  const conflicts: ReconcileOperation[] = [];
  const actualByKey = new Map<string, ProviderRecord[]>();
  for (const record of actual) {
    const key = recordKey(record);
    const group = actualByKey.get(key) ?? [];
    group.push(record);
    actualByKey.set(key, group);
  }
  for (const group of actualByKey.values()) group.sort((left, right) => left.providerId.localeCompare(right.providerId));
  const desiredByKey = new Map<string, DesiredRecord[]>();
  for (const record of desired) {
    const key = recordKey(record);
    const group = desiredByKey.get(key) ?? [];
    group.push(record);
    desiredByKey.set(key, group);
  }
  for (const group of desiredByKey.values()) group.sort(compareRecords);

  const keys = new Set([...desiredByKey.keys(), ...actualByKey.keys()]);
  for (const key of [...keys].sort()) {
    const wanted = desiredByKey.get(key) ?? [];
    const candidates = actualByKey.get(key) ?? [];
    if (wanted.length === 0) {
      for (const candidate of candidates) {
        if (candidate.managed) deletes.push({ kind: "delete", providerId: candidate.providerId, actual: candidate });
      }
      continue;
    }

    const unmanaged = candidates.filter((candidate) => !candidate.managed);
    if (unmanaged.length > 0) {
      const remaining = [...unmanaged];
      for (const record of wanted) {
        const exactIndex = remaining.findIndex((candidate) => sameRecord(record, candidate));
        if (exactIndex >= 0) remaining.splice(exactIndex, 1);
        else conflicts.push({
          kind: "conflict",
          actual: unmanaged[0] as ProviderRecord,
          desired: record,
          reason: "an unmanaged provider record already owns this name and type",
        });
      }
      for (const candidate of candidates.filter((item) => item.managed)) {
        deletes.push({ kind: "delete", providerId: candidate.providerId, actual: candidate });
      }
      continue;
    }

    const remainingActual = [...candidates];
    const unmatchedById: DesiredRecord[] = [];
    for (const record of wanted) {
      const identityIndex = remainingActual.findIndex((candidate) => candidate.id === record.id);
      if (identityIndex < 0) {
        unmatchedById.push(record);
        continue;
      }
      const candidate = remainingActual.splice(identityIndex, 1)[0] as ProviderRecord;
      if (!sameRecord(record, candidate)) updates.push({ kind: "update", providerId: candidate.providerId, desired: record });
    }
    const remainingDesired: DesiredRecord[] = [];
    for (const record of unmatchedById) {
      const exactIndex = remainingActual.findIndex((candidate) => sameRecord(record, candidate));
      if (exactIndex >= 0) remainingActual.splice(exactIndex, 1);
      else remainingDesired.push(record);
    }
    const updateCount = Math.min(remainingDesired.length, remainingActual.length);
    for (let index = 0; index < updateCount; index += 1) {
      const candidate = remainingActual[index] as ProviderRecord;
      updates.push({ kind: "update", providerId: candidate.providerId, desired: remainingDesired[index] as DesiredRecord });
    }
    for (const record of remainingDesired.slice(updateCount)) creates.push({ kind: "create", desired: record });
    for (const candidate of remainingActual.slice(updateCount)) {
      deletes.push({ kind: "delete", providerId: candidate.providerId, actual: candidate });
    }
  }

  const operations = [...deletes, ...updates, ...creates, ...conflicts];
  const summary = { create: 0, update: 0, delete: 0, conflict: 0 };
  for (const operation of operations) summary[operation.kind] += 1;
  return { operations, summary };
}

function recordKey(record: Pick<DesiredRecord, "name" | "type">): string {
  return `${record.name.toLowerCase()}\u0000${record.type}`;
}

function sameRecord(desired: DesiredRecord, actual: ProviderRecord): boolean {
  return desired.content === actual.content
    && effectiveExternalTtl(desired) === effectiveExternalTtl(actual)
    && (desired.proxied ?? false) === (actual.proxied ?? false);
}

function compareRecords(left: DesiredRecord, right: DesiredRecord): number {
  return recordKey(left).localeCompare(recordKey(right))
    || left.content.localeCompare(right.content)
    || left.id.localeCompare(right.id);
}
