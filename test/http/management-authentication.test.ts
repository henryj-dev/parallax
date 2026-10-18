import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authenticateManagementRequest } from "../../src/http/management-authentication.ts";
import {
  ACCOUNT_SESSION_COOKIE,
  type AccountSessionResolution,
  type SecurityConfig,
} from "../../src/security/http-authorization.ts";

/**
 * `/metrics`, `/health/ready` 의 상세, 포털 진입 판단이 쓰는 확인 경로.
 * `src/index.ts` 는 이 함수의 세 결과를 각각 200/401/503(지표), 상세 포함/판정만
 * (준비 상태), 진입/로그인 이동/문서 그대로(포털)로 바꾼다.
 */

const TOKEN = "management-token-0000000000000000000";
const ORIGIN = "http://127.0.0.1:8080";

function security(answer: () => AccountSessionResolution | Promise<AccountSessionResolution>, seen: string[] = []): SecurityConfig {
  return {
    enabled: true,
    tokens: [{ token: TOKEN, role: "viewer", subject: "scraper" }],
    accountSessions: {
      resolve: async (value) => {
        seen.push(value);
        return answer();
      },
      // 이 경로는 세션을 끊지 않는다. 불리면 테스트가 실패한다.
      revoke: async () => { throw new Error("management checks never revoke a session"); },
    },
  };
}

describe("authenticateManagementRequest", () => {
  it("answers each outcome of the account session check separately", async () => {
    const cookie = `${ACCOUNT_SESSION_COOKIE}=member-session`;
    assert.equal(
      await authenticateManagementRequest({ cookie }, security(() => ({ status: "active", role: "viewer", subject: "member-1" })), ORIGIN),
      "authenticated",
    );
    assert.equal(await authenticateManagementRequest({ cookie }, security(() => ({ status: "rejected" })), ORIGIN), "unauthenticated");
    assert.equal(
      await authenticateManagementRequest({ cookie }, security(() => { throw new Error("down"); }), ORIGIN),
      "unavailable",
    );
  });

  it("accepts a bearer token without asking the resolver, and refuses a wrong one", async () => {
    const seen: string[] = [];
    const config = security(() => ({ status: "active", role: "admin", subject: "member-1" }), seen);
    const cookie = `${ACCOUNT_SESSION_COOKIE}=member-session`;

    assert.equal(await authenticateManagementRequest({ authorization: `Bearer ${TOKEN}`, cookie }, config, ORIGIN), "authenticated");
    assert.equal(await authenticateManagementRequest({ authorization: "Bearer not-the-token-00000000000000000", cookie }, config, ORIGIN), "unauthenticated");
    assert.equal(await authenticateManagementRequest({}, config, ORIGIN), "unauthenticated");
    assert.deepEqual(seen, []);
  });

  it("reads the cookie name the request's origin calls for", async () => {
    const seen: string[] = [];
    const config = security(() => ({ status: "active", role: "viewer", subject: "member-1" }), seen);

    assert.equal(
      await authenticateManagementRequest({ cookie: `__Host-${ACCOUNT_SESSION_COOKIE}=secure-session` }, config, "https://dns.example.com"),
      "authenticated",
    );
    assert.equal(
      await authenticateManagementRequest({ cookie: `${ACCOUNT_SESSION_COOKIE}=bare-session` }, config, "https://dns.example.com"),
      "unauthenticated",
    );
    assert.deepEqual(seen, ["secure-session"]);
  });

  it("treats a deployment with authentication disabled as no authenticated caller, as before", async () => {
    assert.equal(
      await authenticateManagementRequest({ authorization: `Bearer ${TOKEN}` }, { enabled: false, tokens: [] }, ORIGIN),
      "unauthenticated",
    );
  });

  it("refuses a resolver on a deployment with authentication disabled, as the API handler does", async () => {
    const seen: string[] = [];
    const disabled: SecurityConfig = { ...security(() => ({ status: "active", role: "admin", subject: "member-1" }), seen), enabled: false };
    await assert.rejects(
      authenticateManagementRequest({ cookie: `${ACCOUNT_SESSION_COOKIE}=member-session` }, disabled, ORIGIN),
      { name: "TypeError", message: "invalid security configuration" },
    );
    assert.deepEqual(seen, []);
  });

  it("copies only string header values, so an array-shaped one counts as no credential", async () => {
    // 문자열이 아닌 헤더 값은 옮기지 않는다. 그 결과는 자격 증명 없음이다.
    const config = security(() => ({ status: "active", role: "admin", subject: "member-1" }));
    assert.equal(
      await authenticateManagementRequest({ cookie: [`${ACCOUNT_SESSION_COOKIE}=a`] as unknown as string }, config, ORIGIN),
      "unauthenticated",
    );
  });
});
