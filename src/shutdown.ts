/**
 * Stops the listeners and the runtime so a subsequent bind on those ports can
 * succeed. SIGTERM is the production path; tests call the same function.
 */
export async function shutdownProcess(parts: {
  dns?: { close(): Promise<void> };
  http?: { close(callback?: (error?: Error) => void): void };
  redirect?: { close(callback?: (error?: Error) => void): void };
  runtime?: { close(): Promise<void> };
  timers?: Iterable<{ unref?: () => void }>;
}): Promise<void> {
  for (const timer of parts.timers ?? []) {
    if (typeof (timer as NodeJS.Timeout).unref === "function") {
      clearInterval(timer as NodeJS.Timeout);
    }
  }
  const closeServer = (server: { close(callback?: (error?: Error) => void): void } | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => { if (error) reject(error); else resolve(); });
    });
  await parts.dns?.close().catch(() => undefined);
  await closeServer(parts.http).catch(() => undefined);
  await closeServer(parts.redirect).catch(() => undefined);
  await parts.runtime?.close().catch(() => undefined);
}
