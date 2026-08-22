/**
 * Stops the listeners and the runtime so a subsequent bind on those ports can
 * succeed. SIGTERM is the production path; tests call the same function.
 */

/** Long enough for an in-flight request to finish, short enough to beat a grace period. */
const DEFAULT_GRACE_MS = 10_000;

interface ClosableServer {
  close(callback?: (error?: Error) => void): void;
  /**
   * Present on a real `http.Server`, absent on the plain object a test hands in.
   * Optional so both compile, and so this file does not become a reason to
   * build a fake server in a test that is about something else.
   */
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export async function shutdownProcess(parts: {
  dns?: { close(): Promise<void> };
  http?: ClosableServer;
  redirect?: ClosableServer;
  runtime?: { close(): Promise<void> };
  timers?: Iterable<{ unref?: () => void }>;
  /**
   * How long the HTTP listeners may take before their remaining connections are
   * cut.
   *
   * `close()` waits for every open connection, and a keep-alive connection is
   * open while it is idle -- so an unbounded close waits out `keepAliveTimeout`
   * for a browser that has simply wandered off, and `requestTimeout` for a slow
   * one. A pod is not given that long: the grace period ends and SIGKILL
   * arrives, which is the one way to be stopped in the middle of an apply.
   */
  graceMs?: number;
}): Promise<void> {
  for (const timer of parts.timers ?? []) {
    if (typeof (timer as NodeJS.Timeout).unref === "function") {
      clearInterval(timer as NodeJS.Timeout);
    }
  }
  const graceMs = parts.graceMs ?? DEFAULT_GRACE_MS;
  const closeServer = (server: ClosableServer | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => { if (error) reject(error); else resolve(); });
      // After `close()`, so a connection that goes idle between the two is not
      // missed: `close()` has already stopped accepting, and this reaps what is
      // sitting there with no request on it.
      server.closeIdleConnections?.();
    });

  await parts.dns?.close().catch(() => undefined);
  // Both listeners share one deadline rather than one each, because the
  // deadline exists to bound the whole shutdown.
  await withDeadline(
    Promise.all([
      closeServer(parts.http).catch(() => undefined),
      closeServer(parts.redirect).catch(() => undefined),
    ]).then(() => undefined),
    graceMs,
    () => {
      // Whatever is still holding a connection has had its time. Cutting them
      // ends `close()`, which is what the callers above are waiting on.
      parts.http?.closeAllConnections?.();
      parts.redirect?.closeAllConnections?.();
    },
  );
  await parts.runtime?.close().catch(() => undefined);
}

/**
 * Waits for `work`, and if the deadline passes first runs `onExpiry` and keeps
 * waiting. The expiry is what makes `work` finish, so this returns the real
 * completion rather than abandoning it.
 */
async function withDeadline(work: Promise<void>, ms: number, onExpiry: () => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(() => { onExpiry(); resolve(); }, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([work, expiry.then(() => work)]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
