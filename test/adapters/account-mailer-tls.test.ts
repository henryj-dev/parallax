import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { createServer as createTlsServer } from "node:tls";
import { promisify } from "node:util";
import nodemailer from "nodemailer";
import { AccountMailer, type AccountMailerConfig, type AccountMailMessage, type AccountSmtpOptions } from "../../src/adapters/account-mailer.ts";

const run = promisify(execFile);
const CONFIG: AccountMailerConfig = {
  from: "accounts@example.com", publicOrigin: "https://app.example.com",
  actionPaths: { invite: "/account/invite", "password-reset": "/account/reset", "email-change": "/account/email" },
  smtp: { host: "smtp.example.com", name: "app.example.com", port: 465, tls: "implicit",
    auth: { user: "example-user", pass: "example-password" }, connectionTimeoutMs: 1000,
    greetingTimeoutMs: 1000, socketTimeoutMs: 1000, dnsTimeoutMs: 1000, maxConnections: 1, maxQueued: 1, maxMessages: 1 },
};
const INPUT = { to: "person@example.com", purpose: "invite", link: "https://app.example.com/account/invite?token=example-token" } as const;
let directory: string;
let ca: Buffer, certificate: Buffer, privateKey: Buffer;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "parallax-mail-tls-"));
  const execute = async (args: string[]): Promise<void> => {
    await run("openssl", args, { cwd: directory, timeout: 10000 });
  };
  // Ephemeral test CA and leaf key: no reusable private keys belong in source fixtures.
  await execute(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Example Test CA"]);
  await execute(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=smtp.example.com"]);
  await writeFile(join(directory, "extensions.cnf"), "subjectAltName=DNS:smtp.example.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n");
  await execute(["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
    "-out", "server.pem", "-days", "1", "-extfile", "extensions.cnf"]);
  [ca, certificate, privateKey] = await Promise.all(["ca.pem", "server.pem", "server.key"].map((name) => readFile(join(directory, name)))) as [Buffer, Buffer, Buffer];
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function listen(server: Server, context: TestContext): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(3000, () => socket.destroy());
  });
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

function configFor(port: number, tls: AccountMailerConfig["smtp"]["tls"] = "implicit", smtp: Partial<AccountMailerConfig["smtp"]> = {}): AccountMailerConfig {
  return { ...CONFIG, smtp: { ...CONFIG.smtp, ...smtp, port, tls } };
}

function transport(port: number, trust: boolean): { transportFactory: (options: AccountSmtpOptions) => { sendMail: (message: AccountMailMessage) => Promise<unknown>; close: () => void } } {
  return { transportFactory: (options) => {
    // The configured unprivileged port is used as-is; only the host name is mapped to loopback.
    assert.equal(options.port, port);
    const real = nodemailer.createTransport({ ...options, host: "127.0.0.1",
      tls: { ...options.tls, ...(trust ? { ca } : {}) } });
    return {
      sendMail: (message) => real.sendMail({ ...message, envelope: { ...message.envelope, to: [...message.envelope.to] } }),
      close: () => real.close(),
    };
  } };
}

function smtpSession(socket: Socket, state: { authenticated: boolean; envelope: string[]; messages: string[] }): void {
  let pending = "", inData = false;
  const data: string[] = [];
  socket.setEncoding("utf8");
  socket.write("220 smtp.example.com isolated test server\r\n");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    if (pending.length > 65536) { socket.destroy(); return; }
    for (;;) {
      const newline = pending.indexOf("\r\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 2);
      if (inData) {
        if (line === ".") {
          state.messages.push(data.join("\r\n"));
          data.length = 0;
          inData = false;
          socket.write("250 message accepted\r\n");
        } else {
          data.push(line.startsWith("..") ? line.slice(1) : line);
          if (data.reduce((length, value) => length + value.length, 0) > 65536) { socket.destroy(); return; }
        }
      } else if (/^EHLO /u.test(line)) socket.write("250-smtp.example.com\r\n250 AUTH PLAIN\r\n");
      else if (line.startsWith("AUTH PLAIN ")) {
        const submitted = Buffer.from(line.slice(11), "base64").toString("utf8");
        state.authenticated = submitted === `\0${CONFIG.smtp.auth.user}\0${CONFIG.smtp.auth.pass}`;
        socket.write(state.authenticated ? "235 authenticated\r\n" : "535 authentication failed\r\n");
      } else if (/^(MAIL FROM:|RCPT TO:)/u.test(line)) {
        if (!state.authenticated) socket.write("530 authentication required\r\n");
        else { state.envelope.push(line); socket.write("250 accepted\r\n"); }
      } else if (line === "DATA" && state.authenticated) {
        inData = true;
        socket.write("354 end with a dot\r\n");
      } else if (line === "QUIT") socket.end("221 goodbye\r\n");
      else if (line === "RSET" || line === "NOOP") socket.write("250 accepted\r\n");
      else socket.write("500 unsupported command\r\n");
    }
  });
}

async function sanitizedFailure(mailer: AccountMailer): Promise<void> {
  await assert.rejects(mailer.send(INPUT), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "account mail unavailable");
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes(CONFIG.smtp.auth.pass), false);
    assert.equal(JSON.stringify(error).includes("example-token"), false);
    return true;
  });
}

describe("isolated real SMTP/TLS account delivery", () => {
  it("authenticates and sends over CA-validated implicit TLS on an arbitrary high port", { timeout: 10000 }, async (context) => {
    const state = { authenticated: false, envelope: [] as string[], messages: [] as string[] };
    const server = createTlsServer({ key: privateKey, cert: certificate }, (socket) => smtpSession(socket, state));
    server.on("tlsClientError", () => {});
    const port = await listen(server, context);
    assert.ok(port > 1024);
    const mailer = new AccountMailer(configFor(port), transport(port, true));
    context.after(() => mailer.close());
    await mailer.send(INPUT);
    assert.equal(state.authenticated, true);
    assert.deepEqual(state.envelope, [`MAIL FROM:<${CONFIG.from}>`, `RCPT TO:<${INPUT.to}>`]);
    assert.equal(state.messages.length, 1);
    assert.match(state.messages[0]!, /From: accounts@example\.com/u);
    assert.match(state.messages[0]!, /To: person@example\.com/u);
    const decoded = state.messages[0]!.replace(/=\r\n/gu, "").replace(/=([A-Fa-f0-9]{2})/gu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    assert.ok(decoded.includes(INPUT.link));
    assert.ok(decoded.includes("example-token"));
    assert.equal(state.messages[0]!.includes(CONFIG.smtp.auth.pass), false);
  });

  it("rejects an untrusted test CA before transmitting credentials or message data", { timeout: 10000 }, async (context) => {
    let tlsSessions = 0;
    const server = createTlsServer({ key: privateKey, cert: certificate }, () => { tlsSessions++; });
    server.on("tlsClientError", () => {});
    const port = await listen(server, context);
    const mailer = new AccountMailer(configFor(port), transport(port, false));
    context.after(() => mailer.close());
    await sanitizedFailure(mailer);
    assert.equal(tlsSessions, 0);
  });

  for (const variant of [{ name: "refuses STARTTLS", advertise: true }, { name: "does not advertise STARTTLS", advertise: false }]) {
    it(`fails without plaintext fallback when a starttls server ${variant.name}`, { timeout: 10000 }, async (context) => {
      const commands: string[] = [];
      const server = createTcpServer((socket) => {
        socket.setEncoding("utf8");
        socket.write("220 smtp.example.com isolated plaintext test server\r\n");
        socket.on("data", (chunk: string) => {
          commands.push(chunk);
          if (chunk.startsWith("EHLO ")) socket.write(`250-smtp.example.com\r\n${variant.advertise ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN\r\n`);
          else if (chunk.startsWith("STARTTLS")) socket.write("454 TLS not available\r\n");
          else socket.write("500 TLS required\r\n");
        });
      });
      const port = await listen(server, context);
      const mailer = new AccountMailer(configFor(port, "starttls"), transport(port, true));
      context.after(() => mailer.close());
      await sanitizedFailure(mailer);
      assert.ok(commands.some((command) => command.startsWith("EHLO ")));
      // requireTLS attempts the upgrade even when it is not advertised; it never continues in plaintext.
      assert.ok(commands.some((command) => command.startsWith("STARTTLS")));
      for (const verb of ["AUTH", "MAIL", "RCPT", "DATA"]) assert.equal(commands.some((command) => command.startsWith(verb)), false);
      assert.equal(commands.join("").includes(CONFIG.smtp.auth.pass), false);
      assert.equal(commands.join("").includes("example-token"), false);
    });
  }

  it("bounds a stalled TLS SMTP greeting with the configured timeout", { timeout: 10000 }, async (context) => {
    const server = createTlsServer({ key: privateKey, cert: certificate }, () => {});
    server.on("tlsClientError", () => {});
    const port = await listen(server, context);
    const mailer = new AccountMailer(configFor(port, "implicit", { greetingTimeoutMs: 100 }), transport(port, true));
    context.after(() => mailer.close());
    const started = performance.now();
    await sanitizedFailure(mailer);
    assert.ok(performance.now() - started < 5000, "configured SMTP timeout must end stalled delivery");
  });
});
