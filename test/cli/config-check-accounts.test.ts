import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkConfig } from "../../src/cli/config-check.ts";
import { accountTestPolicy } from "../support/accounts.ts";

/** Everything accounts mode needs, with placeholder values and no network. */
function accountsEnvironment(policyFile: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "", PARALLAX_AUTH_MODE: "accounts", PARALLAX_ACCOUNT_POLICY_FILE: policyFile,
    PARALLAX_ACCOUNT_KEY: randomBytes(32).toString("base64url"), PARALLAX_ACCOUNT_PUBLIC_ORIGIN: "https://dns.example.com",
    PARALLAX_SMTP_HOST: "smtp.example.com", PARALLAX_SMTP_PORT: "465", PARALLAX_SMTP_TLS: "implicit", PARALLAX_SMTP_NAME: "dns.example.com",
    PARALLAX_SMTP_FROM: "parallax@example.com", PARALLAX_SMTP_USER: "parallax", PARALLAX_SMTP_PASSWORD: "not-a-real-password",
    PARALLAX_SMTP_CONNECTION_TIMEOUT_MS: "2000", PARALLAX_SMTP_GREETING_TIMEOUT_MS: "2000", PARALLAX_SMTP_SOCKET_TIMEOUT_MS: "2000", PARALLAX_SMTP_DNS_TIMEOUT_MS: "2000",
    PARALLAX_SMTP_MAX_CONNECTIONS: "1", PARALLAX_SMTP_MAX_QUEUED: "4", PARALLAX_SMTP_MAX_MESSAGES: "10",
  };
}

describe("the preflight for member accounts", () => {
  it("shows how much memory password hashing can take at once, and warns above 512 MiB without failing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parallax-config-accounts-"));
    try {
      const write = async (maxConcurrent: number) => {
        const path = join(directory, `policy-${maxConcurrent}.json`);
        await writeFile(path, JSON.stringify({ ...accountTestPolicy, password: { ...accountTestPolicy.password, maxConcurrent,
          scrypt: { N: 65536, r: 8, p: 2, maxmem: 100663296, keylen: 32 }, verifyLimits: { maxMemoryBytes: 100663296, maxWork: 1048576, maxKeylen: 32 } } }));
        return path;
      };
      const small = checkConfig(accountsEnvironment(await write(2)));
      assert.deepEqual(small.accountHashing, { peakMiB: 192 });
      const large = checkConfig(accountsEnvironment(await write(8)));
      assert.equal(large.environment, "ok", "a warning, not a failure");
      assert.equal(large.accountHashing?.peakMiB, 768);
      assert.match(large.accountHashing?.warning ?? "", /768 MiB/u);
      assert.equal("accountHashing" in checkConfig({ DATABASE_URL: "" }), false, "legacy mode reports nothing about it");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
