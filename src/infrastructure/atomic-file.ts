import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 15_000;

interface LockOwner {
  readonly hostname: string;
  readonly pid: number;
  readonly nonce: string;
}

/**
 * Creates a private data directory, or verifies that an existing directory was
 * explicitly provisioned as private. Never chmod an existing directory: a
 * configured file such as `/tmp/config.json` must fail closed instead of
 * changing the permissions of a shared parent directory.
 */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  const absolutePath = resolve(path);
  if (absolutePath === parse(absolutePath).root) {
    throw new Error(`refusing to use filesystem root as a private data directory: ${path}`);
  }

  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`private data path must be a real directory, not a symbolic link: ${path}`);
  }

  const mode = metadata.mode & 0o7777;
  if (mode !== 0o700) {
    throw new Error(
      `private data directory must already have mode 0700: ${path} has ${mode.toString(8).padStart(4, "0")}`,
    );
  }

  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId !== undefined && metadata.uid !== effectiveUserId) {
    throw new Error(`private data directory must be owned by the current user: ${path}`);
  }
}

/**
 * Serializes a whole-file read/modify/write transaction across processes.
 *
 * The callback must re-read the protected file after entering this function;
 * callers deliberately do not receive a cached snapshot here. The lock file
 * contains only process metadata, never application state or credentials.
 */
export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number; retryMs?: number } = {},
): Promise<T> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const lockPath = join(directory, `.${basename(path)}.lock`);
  const owner: LockOwner = { hostname: hostname(), pid: process.pid, nonce: randomUUID() };
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      // A lock whose recorded pid is gone on this host is not a live writer.
      // The inode is re-checked after the pid probe so a replacement lock is
      // not unlinked. A lock without a pid, or one held by a live process, is
      // left until the waiter times out.
      if (await reclaimDeadLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring file lock for ${path}; if no writer is active, remove stale lock ${lockPath}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
      continue;
    }
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
      return await operation();
    } finally {
      try {
        await unlink(lockPath).catch((error: unknown) => {
          if (!isNodeError(error, "ENOENT")) throw error;
        });
      } finally {
        await handle.close();
      }
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

/** Unlinks a lock only when this host recorded it and that pid is gone. */
async function reclaimDeadLock(lockPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, "r");
  } catch (error) {
    return isNodeError(error, "ENOENT");
  }
  try {
    const inspected = await handle.stat();
    let owner: LockOwner;
    try {
      owner = JSON.parse((await handle.readFile("utf8")).trim()) as LockOwner;
    } catch {
      return false;
    }
    if (owner.hostname !== hostname() || typeof owner.pid !== "number" || pidAlive(owner.pid)) return false;
    const current = await lstat(lockPath);
    if (current.ino !== inspected.ino || current.dev !== inspected.dev) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
