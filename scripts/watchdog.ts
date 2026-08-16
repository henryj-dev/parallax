/**
 * Kills a test process that outlives its tests, and says what was holding it.
 *
 * A bound on each test does not bound a process whose tests have all finished
 * while something keeps its event loop alive. That is what a run looked like
 * from the outside: the last file printed its result, and then eight minutes of
 * nothing, ended by the job's cleanup terminating three orphaned node
 * processes. Nothing failed, so nothing was reported; the only evidence was a
 * clock.
 *
 * The timer is unref'd, so it never keeps a healthy process alive and never
 * fires in one -- it can only fire in a process that was already refusing to
 * leave. When it does, it names the resources still open, which is the question
 * a duration cannot answer.
 */
const LIMIT_MS = Number(process.env.PARALLAX_TEST_WATCHDOG_MS ?? 180_000);

const watchdog = setTimeout(() => {
  const counts = new Map<string, number>();
  for (const resource of process.getActiveResourcesInfo()) {
    counts.set(resource, (counts.get(resource) ?? 0) + 1);
  }
  const held = [...counts].map(([resource, count]) => `${resource}×${count}`).join(", ");
  process.stderr.write(
    `\nwatchdog: this process was still alive ${LIMIT_MS}ms after it started.\n` +
    `watchdog: holding ${held || "nothing this can see"}\n` +
    `watchdog: argv ${process.argv.slice(1).join(" ")}\n`);
  process.exit(1);
}, LIMIT_MS);

watchdog.unref();
