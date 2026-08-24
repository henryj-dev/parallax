import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 15_000;

interface LockOwner {
  readonly hostname: string;
  readonly pid: number;
  readonly nonce: string;
  /**
   * When the holding process started, as the kernel counts it.
   *
   * A pid alone does not identify a process across a restart, and in a
   * container it identifies almost nothing: the server is pid 1 every time and
   * the hostname is the pod's, so a lock left by a crash named exactly the
   * process that came back. `pidAlive` then said "held", and every write failed
   * from then on until somebody deleted the file by hand -- one OOMKill away,
   * on the file backend, which is the default.
   *
   * Absent where the kernel will not say (anything without `/proc`, so macOS),
   * and there the pid check stands alone as before.
   */
  readonly startedAt?: string;
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
  const startedAt = processStartedAt("self");
  const owner: LockOwner = {
    hostname: hostname(),
    pid: process.pid,
    nonce: randomUUID(),
    ...(startedAt === undefined ? {} : { startedAt }),
  };
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
      if (Date.now() >= deadline) throw new Error(await timeoutMessage(path, lockPath));
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

/**
 * Why the wait ended, said as precisely as the lock file allows.
 *
 * The old sentence always advised removing the lock "if no writer is active",
 * which reads as an instruction and is wrong exactly when it is followed: a
 * long apply holds its zone lock for the whole of its provider traffic, and
 * deleting that lock lets a second writer in beside it. A dead lock is now
 * reclaimed automatically where the kernel can prove it is dead, so a timeout
 * means a live holder far more often than it used to.
 */
async function timeoutMessage(path: string, lockPath: string): Promise<string> {
  const holder = await readLockOwner(lockPath);
  if (holder && holder.hostname === hostname() && pidAlive(holder.pid)) {
    return `timed out acquiring file lock for ${path}: pid ${holder.pid} on this host is holding it and is still running.`
      + " A long provider apply holds its zone for the whole run; wait for it rather than removing the lock.";
  }
  if (holder) {
    return `timed out acquiring file lock for ${path}: it is held by pid ${holder.pid} on ${holder.hostname}.`
      + ` If nothing is writing there, remove ${lockPath}.`;
  }
  return `timed out acquiring file lock for ${path}; if no writer is active, remove stale lock ${lockPath}`;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse((await readFile(lockPath, "utf8")).trim());
    if (parsed === null || typeof parsed !== "object") return undefined;
    const owner = parsed as LockOwner;
    return typeof owner.hostname === "string" && typeof owner.pid === "number" ? owner : undefined;
  } catch {
    return undefined;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Field 22 of `/proc/<pid>/stat`: the process's start time in clock ticks since
 * boot. Read after the last `)` because the second field is the executable name
 * and may itself contain spaces or brackets.
 *
 * Two processes that share a pid cannot share this, so it is what makes the
 * comparison below an identity rather than a guess.
 */
function processStartedAt(pid: number | "self"): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterName = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTime = afterName[19];
    return startTime && /^\d+$/u.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
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
    if (owner.hostname !== hostname() || typeof owner.pid !== "number") return false;
    if (pidAlive(owner.pid)) {
      // The pid is in use -- but by the process that took this lock, or by one
      // that merely inherited its number? Where the kernel can say, ask it.
      const running = processStartedAt(owner.pid);
      const held = typeof owner.startedAt === "string" ? owner.startedAt : undefined;
      if (running === undefined || held === undefined || running === held) return false;
    }
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
