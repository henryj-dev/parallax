import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { ProviderAdapter } from "../application/ports.ts";
import type { DesiredRecord } from "../domain/dns.ts";
import type { ProviderRecord, ReconcileOperation } from "../domain/reconciliation.ts";

interface FileProviderState {
  version: 1;
  nextId: number;
  targets: Record<string, ProviderRecord[]>;
}

export interface FileProviderAdapterOptions {
  path: string;
}

/** A small durable provider implementation suitable for local and single-node deployments. */
export class FileProviderAdapter implements ProviderAdapter {
  readonly #path: string;
  #state?: FileProviderState;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: FileProviderAdapterOptions) {
    if (!options.path.trim()) throw new Error("file provider path must not be empty");
    this.#path = resolve(options.path);
  }

  async list(target: string): Promise<ProviderRecord[]> {
    return this.#serialized(async () => {
      const state = await this.#load();
      return (state.targets[normalizeTarget(target)] ?? []).map(cloneRecord);
    });
  }

  async apply(target: string, operation: Exclude<ReconcileOperation, { kind: "conflict" }>): Promise<void> {
    await this.#serialized(async () => {
      const currentState = await this.#load();
      const state = structuredClone(currentState);
      const targetKey = normalizeTarget(target);
      const records = (state.targets[targetKey] ?? []).map(cloneRecord);
      if (operation.kind === "create") {
        records.push(asManaged(operation.desired, `file-${state.nextId++}`));
      } else {
        if (operation.kind === "delete" && !operation.actual.managed) {
          throw new Error(`refusing to delete unmanaged file provider record ${operation.providerId}`);
        }
        if (records.some((record) => record.providerId === operation.providerId && !record.managed)) {
          throw new Error(`refusing to modify unmanaged file provider record ${operation.providerId}`);
        }
        const index = records.findIndex((record) => record.providerId === operation.providerId && record.managed);
        if (index < 0) throw new Error(`managed file provider record ${operation.providerId} does not exist`);
        if (operation.kind === "update") records[index] = asManaged(operation.desired, operation.providerId);
        else records.splice(index, 1);
      }
      if (records.length === 0) delete state.targets[targetKey];
      else state.targets[targetKey] = records;
      await persistAtomically(this.#path, state);
      this.#state = state;
    });
  }

  async #load(): Promise<FileProviderState> {
    if (this.#state) return this.#state;
    let contents: string;
    try {
      contents = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        this.#state = { version: 1, nextId: 1, targets: {} };
        return this.#state;
      }
      throw error;
    }
    try {
      this.#state = parseState(JSON.parse(contents) as unknown);
      return this.#state;
    } catch (error) {
      throw new Error(`invalid file provider state at ${this.#path}`, { cause: error });
    }
  }

  async #serialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

function parseState(value: unknown): FileProviderState {
  if (!isObject(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !isObject(value.targets)) {
    throw new Error("unsupported state document");
  }
  const targets: Record<string, ProviderRecord[]> = {};
  for (const [rawTarget, rawRecords] of Object.entries(value.targets)) {
    const target = normalizeTarget(rawTarget);
    if (target !== rawTarget || !Array.isArray(rawRecords)) throw new Error("invalid target entry");
    targets[target] = rawRecords.map(parseProviderRecord);
  }
  return { version: 1, nextId: value.nextId as number, targets };
}

function parseProviderRecord(value: unknown): ProviderRecord {
  // Unmanaged records are representable so drift, conflicts, and adoption behave
  // here exactly as they do against a real provider.
  if (!isObject(value) || typeof value.id !== "string" || typeof value.providerId !== "string" || typeof value.managed !== "boolean" ||
      typeof value.name !== "string" || !["A", "AAAA", "CNAME", "TXT"].includes(String(value.type)) ||
      typeof value.content !== "string" || !Number.isInteger(value.ttl) ||
      (value.proxied !== undefined && typeof value.proxied !== "boolean")) {
    throw new Error("invalid provider record");
  }
  const record: ProviderRecord = {
    id: value.id,
    providerId: value.providerId,
    managed: value.managed,
    name: value.name,
    type: value.type as ProviderRecord["type"],
    content: value.content,
    ttl: value.ttl as number,
  };
  if (value.proxied !== undefined) record.proxied = value.proxied;
  return record;
}

function normalizeTarget(value: string): string {
  const match = /^(.+?)\/(internal|external)$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) throw new Error(`invalid provider target ${value}`);
  const zone = match[1].trim().toLowerCase().replace(/\.$/, "");
  if (!zone.includes(".") || zone.split(".").some((label) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) {
    throw new Error(`invalid provider target ${value}`);
  }
  return `${zone}/${match[2].toLowerCase()}`;
}

function asManaged(desired: DesiredRecord, providerId: string): ProviderRecord {
  return { ...structuredClone(desired), providerId, managed: true };
}

function cloneRecord(record: ProviderRecord): ProviderRecord {
  return { ...record };
}

async function persistAtomically(path: string, state: FileProviderState): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  let temporaryExists = false;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    try {
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    temporaryExists = false;
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
