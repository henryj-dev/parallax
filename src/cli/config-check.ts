import { readConfig } from "../config.ts";

/**
 * What the serving process would refuse to start with, asked before it starts.
 *
 * Startup validation is fail-closed on purpose: a setting this process cannot
 * honour stops it rather than quietly doing something else. On a deployment
 * where this pod is a resolver's only upstream, that refusal is not one pod --
 * it is name resolution for everything behind it, discovered at the moment the
 * old pod is already gone.
 *
 * So the same reading is available without starting anything. It touches no
 * store, binds no port, and reads only the environment, which is the class of
 * failure that arrives with a rollout.
 *
 * Deliberately not in the command layer and so not reachable over HTTP: a
 * running server has already passed this, and answering it there would describe
 * the server's own environment to whoever asked.
 */
export interface ConfigCheck {
  readonly environment: "ok";
  /** What the portal offers a visitor with no session. */
  readonly portalSignIn: string;
  readonly identityProvider: "configured" | "absent";
  /** Where the listener would bind, and how many upstreams it would relay to. */
  readonly dns: string;
  readonly tls: "on" | "off";
  readonly storage: "postgresql" | "file";
  /**
   * How many break-glass tokens the environment carries, and nothing more.
   *
   * Whether this deployment requires authentication is a fact about the store,
   * which this deliberately does not open -- so it is not reported. Saying
   * "open" here because the environment names none would be a claim about a
   * place nobody looked.
   */
  readonly bootstrapTokens: number;
}

/**
 * Names and shapes only. A preflight is run wherever a deployment is run, and
 * its output goes wherever that output goes -- so no value that is a secret,
 * and no value that is a credential's length, appears here.
 */
export function checkConfig(environment: NodeJS.ProcessEnv = process.env): ConfigCheck {
  const config = readConfig(environment);
  return {
    environment: "ok",
    portalSignIn: config.portalSignIn,
    identityProvider: config.oidc ? "configured" : "absent",
    dns: config.dns ? `${config.dns.host}:${config.dns.port} forward=${config.dns.forwardTo.length}` : "disabled",
    tls: config.tls ? "on" : "off",
    storage: config.databaseUrl ? "postgresql" : "file",
    bootstrapTokens: config.bootstrapTokens.length,
  };
}
