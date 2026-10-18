import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createProbeTransport, MAX_PROBE_HEADER_BYTES, type ProbeTarget } from "../../src/dns/health/transport.ts";

/**
 * Every origin here listens on loopback. The probe is aimed at a documentation
 * address and `remap` carries the connection to the local listener, the way
 * the transport's own comment describes -- so nothing leaves this machine.
 */

const DOC_ADDRESS = "10.0.0.11";
const never = new AbortController().signal;

async function listen(server: Server | TcpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server | TcpServer): Promise<void> {
  (server as Server).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const toLoopback = (port: number) => () => ({ address: "127.0.0.1", port });

function target(probe: ProbeTarget["probe"], host = "app.example.com"): ProbeTarget {
  return { address: DOC_ADDRESS, probe, host };
}

describe("probe transport: TCP", () => {
  it("passes when the connection opens, and fails when nothing listens", async () => {
    const server = createTcpServer((socket) => socket.end());
    const port = await listen(server);
    try {
      const transport = createProbeTransport({ remap: toLoopback(port) });
      assert.deepEqual(await transport.probe(target({ kind: "tcp", port: 443 }), never), { ok: true });
    } finally {
      await close(server);
    }
    const closed = createProbeTransport({ remap: toLoopback(port) });
    assert.deepEqual(await closed.probe(target({ kind: "tcp", port: 443 }), never), { ok: false, category: "connection" });
  });

  it("never resolves a name: a hostname is refused before any socket opens", async () => {
    let connections = 0;
    const server = createTcpServer((socket) => { connections += 1; socket.end(); });
    const port = await listen(server);
    try {
      const byName = createProbeTransport();
      assert.deepEqual(await byName.probe({ ...target({ kind: "tcp", port }), address: "localhost" }, never), { ok: false, category: "blocked" });
      const remappedToName = createProbeTransport({ remap: () => ({ address: "localhost", port }) });
      assert.deepEqual(await remappedToName.probe(target({ kind: "http", port, path: "/" }), never), { ok: false, category: "blocked" });
      assert.equal(connections, 0);
    } finally {
      await close(server);
    }
  });

  it("gives up at the deadline and when aborted", async () => {
    // Accepts the connection and never answers the request.
    const held: Socket[] = [];
    const server = createTcpServer((socket) => { held.push(socket); });
    const port = await listen(server);
    try {
      const transport = createProbeTransport({ remap: toLoopback(port), deadlineMs: 150 });
      const started = Date.now();
      assert.deepEqual(await transport.probe(target({ kind: "http", port: 80, path: "/" }), never), { ok: false, category: "timeout" });
      assert.ok(Date.now() - started < 1_500);
      const controller = new AbortController();
      const pending = createProbeTransport({ remap: toLoopback(port), deadlineMs: 10_000 })
        .probe(target({ kind: "http", port: 80, path: "/" }), controller.signal);
      setTimeout(() => controller.abort(), 20);
      assert.deepEqual(await pending, { ok: false, category: "timeout" });
      const aborted = new AbortController();
      aborted.abort();
      assert.deepEqual(await transport.probe(target({ kind: "tcp", port: 80 }), aborted.signal), { ok: false, category: "timeout" });
    } finally {
      for (const socket of held) socket.destroy();
      await close(server);
    }
  });
});

describe("probe transport: HTTP", () => {
  const seen: { url?: string; host?: string; method?: string }[] = [];
  let port = 0;
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    seen.push({ url: request.url, host: request.headers.host, method: request.method });
    if (request.url === "/ok") return response.end("ready");
    if (request.url === "/created") return response.writeHead(204).end();
    if (request.url === "/down") return response.writeHead(503).end("down");
    if (request.url === "/moved") return response.writeHead(302, { location: "http://203.0.113.7/elsewhere" }).end();
    if (request.url === "/huge-header") {
      response.setHeader("x-filler", "a".repeat(MAX_PROBE_HEADER_BYTES * 2));
      return response.end();
    }
    if (request.url === "/huge-body") {
      // Far past the body cap; the probe must settle without reading it all.
      response.writeHead(200);
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const pushMore = (): void => {
        while (sent < 64 && response.write(chunk)) sent += 1;
        if (sent < 64) response.once("drain", () => { sent += 1; pushMore(); });
        else response.end();
      };
      pushMore();
      return;
    }
    response.writeHead(404).end();
  });

  before(async () => { port = await listen(server); });
  after(async () => { await close(server); });

  const probe = (path: string, probePort = 8080) =>
    createProbeTransport({ remap: toLoopback(port) }).probe(target({ kind: "http", port: probePort, path }), never);

  it("passes on any 2xx and sends the pinned path and the protected name", async () => {
    seen.length = 0;
    assert.deepEqual(await probe("/ok"), { ok: true, status: 200 });
    assert.deepEqual(await probe("/created"), { ok: true, status: 204 });
    assert.deepEqual(seen[0], { url: "/ok", host: "app.example.com:8080", method: "GET" });
    await probe("/ok", 80);
    assert.equal(seen.at(-1)?.host, "app.example.com");
  });

  it("fails on another status and does not follow a redirect", async () => {
    assert.deepEqual(await probe("/down"), { ok: false, category: "http-status", status: 503 });
    seen.length = 0;
    assert.deepEqual(await probe("/moved"), { ok: false, category: "http-status", status: 302 });
    assert.deepEqual(seen.map((entry) => entry.url), ["/moved"], "the redirect target is never requested");
  });

  it("bounds the header block and the body", async () => {
    assert.deepEqual(await probe("/huge-header"), { ok: false, category: "http-status" });
    const started = Date.now();
    assert.deepEqual(await probe("/huge-body"), { ok: true, status: 200 });
    assert.ok(Date.now() - started < 2_000);
  });
});

describe("probe transport: HTTPS", () => {
  let directory = "";
  let cert = "";
  let key = "";

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "parallax-health-tls-"));
    // A throwaway self-signed certificate for the documentation name. openssl
    // ships on every CI runner this suite uses; without it the test fails
    // loudly rather than skipping.
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=app.example.com",
      "-addext", "subjectAltName=DNS:app.example.com",
      "-keyout", join(directory, "key.pem"),
      "-out", join(directory, "cert.pem"),
    ], { stdio: "ignore" });
    cert = await readFile(join(directory, "cert.pem"), "utf8");
    key = await readFile(join(directory, "key.pem"), "utf8");
  });
  after(async () => { await rm(directory, { recursive: true, force: true }); });

  async function withOrigin(run: (port: number) => Promise<void>): Promise<void> {
    const origin = createHttpsServer({ cert, key }, (_request, response) => response.end("ready"));
    const port = await listen(origin);
    try {
      await run(port);
    } finally {
      await close(origin);
    }
  }

  it("verifies the certificate against the protected name", async () => {
    await withOrigin(async (port) => {
      const trusted = createProbeTransport({ remap: toLoopback(port), ca: cert });
      assert.deepEqual(await trusted.probe(target({ kind: "https", port: 443, path: "/" }), never), { ok: true, status: 200 });
      assert.deepEqual(
        await trusted.probe(target({ kind: "https", port: 443, path: "/" }, "other.example.com"), never),
        { ok: false, category: "tls" },
      );
      const untrusted = createProbeTransport({ remap: toLoopback(port) });
      assert.deepEqual(await untrusted.probe(target({ kind: "https", port: 443, path: "/" }), never), { ok: false, category: "tls" });
    });
  });
});
