import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { CoreDnsFileOperations } from "./coredns-file.ts";

export interface NodeCoreDnsFileOperationsOptions {
  root: string;
  reload?(target: string, absolutePath: string): Promise<void>;
}

/** Atomic, root-confined Node.js filesystem operations for CoreDNS zone files. */
export class NodeCoreDnsFileOperations implements CoreDnsFileOperations {
  readonly #root: string;
  readonly #reloadHook?: (target: string, absolutePath: string) => Promise<void>;
  readonly #writes = new Map<string, Promise<void>>();

  constructor(options: NodeCoreDnsFileOperationsOptions) {
    if (!options.root.trim()) throw new Error("CoreDNS file root must not be empty");
    this.#root = resolve(options.root);
    this.#reloadHook = options.reload;
  }

  async read(path: string): Promise<string | undefined> {
    const absolutePath = this.#safePath(path);
    await (this.#writes.get(absolutePath) ?? Promise.resolve());
    await this.#assertNoSymlinkEscape(absolutePath);
    try {
      return await readFile(absolutePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async write(path: string, contents: string): Promise<void> {
    const absolutePath = this.#safePath(path);
    const previous = this.#writes.get(absolutePath) ?? Promise.resolve();
    const current = previous.then(async () => {
      await this.#assertNoSymlinkEscape(absolutePath);
      await atomicWrite(absolutePath, contents);
    });
    const tracked = current.catch(() => undefined);
    this.#writes.set(absolutePath, tracked);
    try {
      await current;
    } finally {
      if (this.#writes.get(absolutePath) === tracked) this.#writes.delete(absolutePath);
    }
  }

  async reload(target: string, path: string): Promise<void> {
    const absolutePath = this.#safePath(path);
    await (this.#writes.get(absolutePath) ?? Promise.resolve());
    await this.#assertNoSymlinkEscape(absolutePath);
    await this.#reloadHook?.(target, absolutePath);
  }

  #safePath(path: string): string {
    if (!path || path.includes("\0")) throw new Error("CoreDNS path must not be empty");
    const absolutePath = isAbsolute(path) ? resolve(path) : resolve(this.#root, path);
    const fromRoot = relative(this.#root, absolutePath);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`CoreDNS path is outside configured root: ${path}`);
    }
    return absolutePath;
  }

  async #assertNoSymlinkEscape(absolutePath: string): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await mkdir(dirname(absolutePath), { recursive: true });
    const [rootRealPath, parentRealPath] = await Promise.all([realpath(this.#root), realpath(dirname(absolutePath))]);
    const fromRoot = relative(rootRealPath, parentRealPath);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("CoreDNS path resolves outside configured root");
    }
    try {
      if ((await lstat(absolutePath)).isSymbolicLink()) throw new Error("CoreDNS zone file must not be a symbolic link");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

// CoreDNS usually runs as its own user, so a zone file it cannot read is an
// outage. Zone data is public by definition, unlike the credential store.
const ZONE_FILE_MODE = 0o644;

async function atomicWrite(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let temporaryExists = false;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: ZONE_FILE_MODE });
    temporaryExists = true;
    await rename(temporaryPath, path);
    temporaryExists = false;
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
