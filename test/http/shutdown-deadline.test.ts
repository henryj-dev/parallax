import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { after, describe, it } from "node:test";
import { shutdownProcess } from "../../src/shutdown.ts";

/**
 * A pod is given a grace period and then killed.
 *
 * `server.close()` stops accepting and then waits for every open connection.
 * Node reaps *idle* keep-alive connections on close by itself, so that half is
 * already handled -- measured, not assumed: the first version of this test
 * opened an idle keep-alive connection and shutdown finished in milliseconds
 * without any deadline. What still waits is a request that is in flight and
 * does not finish. `requestTimeout` bounds it at 60 seconds, which is longer
 * than a grace period, and the process is then SIGKILLed -- possibly mid-apply.
 */
describe("shutdown with a request still in flight", () => {
  const servers: Server[] = [];
  const openSockets: ReturnType<typeof connect>[] = [];
  after(() => {
    for (const socket of openSockets) socket.destroy();
    for (const server of servers) server.close();
  });

  /**
   * A server whose handler never answers, so the request stays in flight.
   *
   * `arrived` resolves when the handler is entered, which is the only moment
   * that is actually "in flight". Waiting a fixed 50ms instead was the same
   * claim without the evidence: on a loaded runner the request has not been
   * accepted yet, `close()` then finds nothing to wait for, and the deadline
   * assertion below passes while measuring an empty server -- a green result
   * for a shutdown that was never put under the condition it is about.
   */
  async function stalled(): Promise<{ server: Server; port: number; arrived: Promise<void> }> {
    let arrive!: () => void;
    const arrived = new Promise<void>((resolve) => { arrive = resolve; });
    const server = createServer(() => { arrive(); /* deliberately no response */ });
    server.requestTimeout = 60_000;
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { server, port, arrived };
  }

  async function sendRequest(port: number, arrived: Promise<void>): Promise<void> {
    const socket = connect(port, "127.0.0.1");
    openSockets.push(socket);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    // The server itself says when it has the request. A slow machine makes this
    // take longer; it cannot make it proceed without one.
    await arrived;
  }

  it("finishes within its deadline while a request is stuck", async () => {
    const { server, port, arrived } = await stalled();
    await sendRequest(port, arrived);

    const started = Date.now();
    await shutdownProcess({ http: server, timers: [], graceMs: 250 });
    const elapsed = Date.now() - started;

    // Without a deadline this waits out requestTimeout, set to 60s above.
    assert.ok(elapsed < 5_000, `shutdown took ${elapsed}ms`);
  });

  it("still closes promptly when nothing is connected", async () => {
    const { server } = await stalled();
    const started = Date.now();
    await shutdownProcess({ http: server, timers: [], graceMs: 5_000 });
    // The deadline is a ceiling, not a wait: an idle server must not sit on it.
    assert.ok(Date.now() - started < 1_000);
  });
});
