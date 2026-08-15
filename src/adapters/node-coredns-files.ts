import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { CoreDnsFileOperations } from "./coredns-file.ts";

export interface NodeCoreDnsFileOperationsOptions {
  root: string;
  reload?(target: string, absolutePath: string): Promise<void>;
  /** Test/diagnostic seam fired after the real durability operation succeeds. */
  onDurabilityStep?(step: "file-synced" | "renamed" | "directory-synced"): void;
  /** Deterministic race seam; production wiring leaves it undefined. */
  beforeReadOpen?(absolutePath: string): Promise<void>;
}

/** Atomic, root-confined Node.js filesystem operations for CoreDNS zone files. */
export class NodeCoreDnsFileOperations implements CoreDnsFileOperations {
  readonly #root: string;
  readonly #reloadHook?: (target: string, absolutePath: string) => Promise<void>;
  readonly #onDurabilityStep?: NodeCoreDnsFileOperationsOptions["onDurabilityStep"];
  readonly #beforeReadOpen?: NodeCoreDnsFileOperationsOptions["beforeReadOpen"];
  readonly #writes = new Map<string, Promise<void>>();

  constructor(options: NodeCoreDnsFileOperationsOptions) {
    if (!options.root.trim()) throw new Error("CoreDNS file root must not be empty");
    this.#root = resolve(options.root);
    this.#reloadHook = options.reload;
    this.#onDurabilityStep = options.onDurabilityStep;
    this.#beforeReadOpen = options.beforeReadOpen;
  }

  async read(path: string): Promise<string | undefined> {
    const absolutePath = this.#safePath(path);
    await (this.#writes.get(absolutePath) ?? Promise.resolve());
    await this.#assertNoSymlinkEscape(absolutePath);
    await this.#beforeReadOpen?.(absolutePath);
    let file: Awaited<ReturnType<typeof open>>;
    try {
      // O_NOFOLLOW closes the lstat/open race for the final component. The
      // post-open realpath and inode comparison below cover a parent directory
      // being replaced with a symlink during that same window.
      file = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      if (isNodeError(error, "ELOOP")) throw new Error("CoreDNS zone file must not be a symbolic link");
      throw error;
    }
    try {
      const [opened, named, rootRealPath, openedRealPath] = await Promise.all([
        file.stat(),
        lstat(absolutePath),
        realpath(this.#root),
        realpath(absolutePath),
      ]);
      const fromRoot = relative(rootRealPath, openedRealPath);
      const escaped = fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
      if (escaped || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino) {
        throw new Error("CoreDNS zone file changed or resolved outside configured root while it was opened");
      }
      if (!opened.isFile()) throw new Error("CoreDNS zone file must be a regular file");
      return await file.readFile({ encoding: "utf8" });
    } finally {
      await file.close();
    }
  }

  async write(path: string, contents: string): Promise<void> {
    const absolutePath = this.#safePath(path);
    const previous = this.#writes.get(absolutePath) ?? Promise.resolve();
    const current = previous.then(async () => {
      await this.#assertNoSymlinkEscape(absolutePath);
      await atomicWrite(absolutePath, contents, this.#onDurabilityStep);
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

async function atomicWrite(
  path: string,
  contents: string,
  onStep?: NodeCoreDnsFileOperationsOptions["onDurabilityStep"],
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let temporaryExists = false;
  try {
    const temporary = await open(temporaryPath, "wx", ZONE_FILE_MODE);
    temporaryExists = true;
    try {
      await temporary.writeFile(contents, "utf8");
      await temporary.chmod(ZONE_FILE_MODE);
      await temporary.sync();
      onStep?.("file-synced");
    } finally {
      await temporary.close();
    }
    await rename(temporaryPath, path);
    temporaryExists = false;
    onStep?.("renamed");
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
      onStep?.("directory-synced");
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
