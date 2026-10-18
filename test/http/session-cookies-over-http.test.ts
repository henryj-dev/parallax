import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { ControlPlane } from "../../src/application/control-plane.ts";
import { createNodeHandler, type NodeHandlerOptions } from "../../src/http/api.ts";
import { createInMemoryAdapters } from "../../src/infrastructure/in-memory.ts";
import { ACCOUNT_SESSION_COOKIE, type SecurityConfig } from "../../src/security/http-authorization.ts";

/**
 * 로그인·로그아웃 응답의 Set-Cookie 가 실제 Node HTTP 전송을 거쳐서도 줄마다
 * 따로 나가는지.
 *
 * 확인 장치가 없는 배포에서는 토큰 로그인과 로그아웃이 늘 두 쿠키를 보낸다. 토큰
 * 세션 쿠키(또는 그 지우기)와 회원 쿠키 지우기다. 남은 회원 쿠키가 없는 평범한
 * 로그인도 마찬가지다. `Response` 객체만 보면 둘 다 있지만, Node 어댑터가 헤더를
 * 옮기면서 하나를 덮어쓰면 브라우저에는 하나만 간다. 그러면 평범한 포털 로그인도
 * 세션 없이 끝난다. 그래서 여기서는 실제 서버를 띄우고, 받은 쪽의 `rawHeaders` 와
 * `headersDistinct` 를 그대로 확인한다. 받은 쿠키로 다음 요청을 보내서 실제로
 * 통과하는지도 본다.
 */

const ADMIN_TOKEN = "admin-secret-00000000000000000000";
const STALE = `${ACCOUNT_SESSION_COOKIE}=stale-member-session`;
const security: SecurityConfig = {
  enabled: true,
  tokens: [{ token: ADMIN_TOKEN, role: "admin", subject: "owner" }],
  tokenSessionSecret: "token-session-secret-that-is-at-least-32-bytes",
};

interface Answer {
  readonly status: number;
  readonly setCookies: string[];
  readonly rawSetCookies: string[];
  readonly headers: Record<string, string[]>;
  readonly body: string;
}

/** Node 의 HTTP 클라이언트로 보낸다. fetch 를 쓰지 않아 받은 헤더를 그대로 본다. */
function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const rawSetCookies: string[] = [];
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          if (incoming.rawHeaders[index]?.toLowerCase() === "set-cookie") rawSetCookies.push(incoming.rawHeaders[index + 1] as string);
        }
        const distinct = incoming.headersDistinct as Record<string, string[]>;
        resolve({
          status: incoming.statusCode ?? 0,
          setCookies: distinct["set-cookie"] ?? [],
          rawSetCookies,
          headers: distinct,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

/** 브라우저 쿠키 저장소의 최소판. `Max-Age=0` 은 지우고, 나머지는 덮어쓴다. */
class CookieJar {
  readonly #cookies = new Map<string, string>();

  constructor(initial: string[] = []) {
    for (const pair of initial) this.#set(pair);
  }

  store(answer: Answer): void {
    for (const line of answer.setCookies) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      if (attributes.includes("Max-Age=0")) this.#cookies.delete(pair.slice(0, pair.indexOf("=")));
      else this.#set(pair);
    }
  }

  names(): string[] {
    return [...this.#cookies.keys()].sort();
  }

  header(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  #set(pair: string): void {
    const separator = pair.indexOf("=");
    this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

async function listen(options: NodeHandlerOptions): Promise<Server> {
  const adapters = createInMemoryAdapters();
  const handler = createNodeHandler({ controlPlane: new ControlPlane(adapters.zones, adapters.statuses, adapters.provider) }, security, options);
  const server = createServer((incoming, response) => {
    handler(incoming, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** 요청마다 찍히는 접근 로그 한 줄을 이 묶음 동안만 거둔다. */
function silenceAccessLog(): () => void {
  const original = console.log;
  console.log = () => undefined;
  return () => { console.log = original; };
}

/** 한 리스너와 그 리스너가 판단할 출처. 요청마다 붙일 헤더도 함께 둔다. */
interface Listener {
  readonly port: number;
  readonly origin: string;
  readonly extra: Record<string, string>;
}

const listeners = [
  {
    title: "plain http",
    options: {},
    origin: (port: number) => `http://127.0.0.1:${port}`,
    extra: {},
    prefix: "",
    secure: "",
  },
  {
    // 전송은 평문이지만 이 리스너가 TLS 를 끝낸다고 알려서 https 로 판단하게 한다.
    title: "a listener that ends TLS itself",
    options: { terminatesTls: true },
    origin: (port: number) => `https://127.0.0.1:${port}`,
    extra: {},
    prefix: "__Host-",
    secure: "; Secure",
  },
  {
    // TLS 를 끝내는 프록시 뒤. 운영 규칙처럼 publicOrigin 과 함께 전달 헤더를 믿는다.
    title: "a trusted proxy that ends TLS",
    options: { publicOrigin: "https://dns.example.com", trustForwardedHeaders: true },
    origin: () => "https://dns.example.com",
    extra: { "x-forwarded-proto": "https", "x-forwarded-host": "dns.example.com", "x-forwarded-for": "203.0.113.7" },
    prefix: "__Host-",
    secure: "; Secure",
  },
] as const;

for (const transport of listeners) {
  describe(`session cookies through the Node HTTP transport, ${transport.title}`, () => {
    let server: Server;
    let listener: Listener;
    let restore: () => void;
    const session = `${transport.prefix}parallax_session`;
    const account = `${transport.prefix}${ACCOUNT_SESSION_COOKIE}`;
    const clearedSession = `${session}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${transport.secure}`;
    const clearedAccount = `${account}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${transport.secure}`;

    before(async () => {
      restore = silenceAccessLog();
      server = await listen(transport.options);
      const port = (server.address() as AddressInfo).port;
      listener = { port, origin: transport.origin(port), extra: transport.extra };
    });
    after(async () => {
      await close(server);
      restore();
    });

    const headersWith = (cookie: string, more: Record<string, string> = {}): Record<string, string> => ({
      ...listener.extra, ...(cookie ? { cookie } : {}), ...more,
    });
    const signIn = (cookie: string, token = ADMIN_TOKEN): Promise<Answer> => call(listener.port, "POST", "/api/v1/session",
      headersWith(cookie, { origin: listener.origin, "content-type": "application/json" }), JSON.stringify({ token }));
    const whoAmI = (cookie: string): Promise<Answer> => call(listener.port, "GET", "/api/v1/session", headersWith(cookie));
    const signOut = (cookie: string): Promise<Answer> => call(listener.port, "DELETE", "/api/v1/session", headersWith(cookie, { origin: listener.origin }));

    for (const [start, initial] of [["with no account cookie", []], ["with a leftover account cookie", [`${transport.prefix}${STALE}`]]] as const) {
      it(`signs in, passes, signs out and is refused, ${start}`, async () => {
        const jar = new CookieJar([...initial]);
        const signedIn = await signIn(jar.header());
        assert.equal(signedIn.status, 200, signedIn.body);
        // 줄마다 따로 온다. 하나로 합쳐지거나 앞의 것이 덮이지 않는다.
        assert.equal(signedIn.rawSetCookies.length, 2, signedIn.rawSetCookies.join("\n"));
        assert.deepEqual(signedIn.setCookies, signedIn.rawSetCookies);
        assert.match(signedIn.rawSetCookies[0] as string, new RegExp(`^${session}=v1\\.[^;]+; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${transport.secure}$`, "u"));
        assert.equal(signedIn.rawSetCookies[1], clearedAccount);
        // 다른 헤더는 예전처럼 하나씩 옮겨진다.
        assert.equal(signedIn.headers["x-request-id"]?.length, 1);
        assert.match(signedIn.headers["content-type"]?.[0] ?? "", /^application\/json/u);

        jar.store(signedIn);
        assert.deepEqual(jar.names(), [session]);
        const next = await whoAmI(jar.header());
        assert.equal(next.status, 200, next.body);
        assert.deepEqual(JSON.parse(next.body), { role: "admin", subject: "owner" });

        const issued = jar.header();
        const signedOut = await signOut(issued);
        assert.equal(signedOut.status, 204, signedOut.body);
        assert.deepEqual(signedOut.rawSetCookies, [clearedSession, clearedAccount]);
        assert.deepEqual(signedOut.setCookies, signedOut.rawSetCookies);
        jar.store(signedOut);
        assert.deepEqual(jar.names(), []);
        assert.equal((await whoAmI(jar.header())).status, 401);
        // 로그아웃한 세션 쿠키를 다시 보내도 통과하지 않는다.
        assert.equal((await whoAmI(issued)).status, 401);
      });
    }

    it("sends no cookie on a failed sign-in", async () => {
      const refused = await signIn(`${transport.prefix}${STALE}`, "not-a-configured-token-0000000000");
      assert.equal(refused.status, 401);
      assert.deepEqual(refused.rawSetCookies, []);
    });
  });
}
