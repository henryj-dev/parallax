/**
 * The environment a spawned Parallax process gets in a test.
 *
 * Every one of these tests states the configuration it is about -- no provider,
 * a hostile value, a DNS port already taken -- and then spread `process.env`
 * underneath it to keep `PATH` and the rest of the shell. That inherits more
 * than `PATH`. This repository tells a developer to keep a `.env` and reach the
 * CLI through it (`pnpm cli`, `pnpm dev`), so the shell that runs `pnpm test`
 * usually has `PARALLAX_*` exported -- and a test asserting that a deployment
 * with **no** identity provider refuses to start was handed one.
 *
 * Measured on a developer machine with ten of those variables exported:
 * `config-check` and `open-deployment-behind-proxy` failed, for reasons that had
 * nothing to do with the change under test. CI never saw it, because CI runs from
 * a bare checkout -- which is exactly what makes this the worse kind of failure.
 * It is red only where somebody is working, so it teaches them that a red result
 * is noise.
 *
 * So the shell is kept, minus everything that configures Parallax. `PATH`,
 * `HOME`, `TMPDIR` and the rest survive; anything the process would read as
 * configuration has to be named by the test that wants it.
 *
 * ⚠️ This is not a substitute for a test passing its own values. It removes the
 * inherited ones, so what the test names is all there is.
 */

/** Variables that configure Parallax rather than the machine it runs on. */
function configuresParallax(name: string): boolean {
  return name.startsWith("PARALLAX_") || name === "DATABASE_URL" || name === "HOST" || name === "PORT";
}

/**
 * The current environment with every Parallax setting removed, then `overrides`
 * applied. A key set to `""` in `overrides` survives as an empty string, which
 * is how these tests say "explicitly absent" to a reader that also removes it.
 */
export function parallaxEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!configuresParallax(name)) environment[name] = value;
  }
  return { ...environment, ...overrides };
}
