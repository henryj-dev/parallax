import { TOTP, Secret } from "otpauth";
import { AccountService } from "../../src/application/accounts/service.ts";
import type { AccountStateStore } from "../../src/application/accounts/state.ts";
import type { AccountPolicy } from "../../src/domain/account-policy.ts";

/** Test-only costs and durations. These are not production defaults. */
export const accountTestPolicy: AccountPolicy = {
  loginKey: "email-nfc-lowercase-v1",
  password: { verifyLimits: { maxMemoryBytes: 16 * 1024 * 1024, maxWork: 1024 * 8 * 2, maxKeylen: 64 }, minLength: 10, maxBytes: 1024, scrypt: { N: 1024, r: 8, p: 1, maxmem: 16 * 1024 * 1024, keylen: 32 }, maxConcurrent: 2, maxQueued: 16 },
  session: { idleSeconds: 300, absoluteSeconds: 3600, touchIntervalSeconds: 10, maxPerUser: 10 }, recentAuthSeconds: 120,
  mfa: { digits: 6, periodSeconds: 30, window: 0, algorithm: "SHA256", recoveryCodeCount: 5, issuer: "Example" },
  tokens: { inviteSeconds: 600, resetSeconds: 300, emailChangeSeconds: 300, challengeSeconds: 120, enrollmentSeconds: 600 },
  rateLimit: { login: { attempts: 100, windowSeconds: 60, baseDelaySeconds: 60, maxDelaySeconds: 60 }, mfa: { attempts: 100, windowSeconds: 60, baseDelaySeconds: 60, maxDelaySeconds: 60 },
    reset: { attempts: 100, windowSeconds: 60, baseDelaySeconds: 60, maxDelaySeconds: 60 }, link: { attempts: 100, windowSeconds: 60, baseDelaySeconds: 60, maxDelaySeconds: 60 }, maxEntries: 1000 },
  retention: { auditDays: 30, auditMaxEntries: 1000 },
};
export function accountFixture(store: AccountStateStore, policy: AccountPolicy = accountTestPolicy) {
  let now = 1800000000000;
  const messages: { to: string; purpose: string; link: string }[] = [];
  const notices: { to: string; event: string }[] = [];
  let mailFailure = false;
  const dependencies = { store, policy, key: Buffer.alloc(32, 7), publicOrigin: "https://dns.example.com", now: () => now,
    mailer: { send: async (m: { to: string; purpose: string; link: string }) => { if (mailFailure) throw new Error("test SMTP unavailable"); messages.push(m); }, sendSecurityNotification: async (notice: { to: string; event: string }) => { notices.push(notice); } } };
  return {
    create: () => AccountService.create(dependencies), messages, notices, now: () => now, advance: (ms = 30000) => { now += ms; }, failMail: () => { mailFailure = true; },
    otp: (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: accountTestPolicy.mfa.digits, period: accountTestPolicy.mfa.periodSeconds, algorithm: accountTestPolicy.mfa.algorithm }).generate({ timestamp: now }),
  };
}
export async function enrolledAdministrator(service: AccountService, f: ReturnType<typeof accountFixture>) {
  await service.enable(); const result = await service.bootstrap("admin@example.com", "test-password-1", "Administrator");
  if (!("challenge" in result)) throw new Error("expected bootstrap challenge");
  const enrollment = await service.beginEnrollment({ challenge: result.challenge });
  const login = await service.confirmEnrollment({ challenge: result.challenge, otp: f.otp(enrollment.secretBase32), ip: "203.0.113.7" });
  return { ...login, secret: enrollment.secretBase32, actor: { token: login.token } };
}
