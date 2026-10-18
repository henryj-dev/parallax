import assert from "node:assert/strict";
import { describe, it } from "node:test";
import nodemailer from "nodemailer";
import { AccountMailer, AccountMailError, type AccountMailerConfig, type AccountMailMessage,
  type AccountMailTransport, type AccountSmtpOptions } from "../../src/adapters/account-mailer.ts";

const CONFIG: AccountMailerConfig = { from: "accounts@example.com", publicOrigin: "https://app.example.com",
  actionPaths: { invite: "/account/invite", "password-reset": "/account/password-reset", "email-change": "/account/email-change" },
  smtp: { host: "smtp.example.com", name: "app.example.com", port: 587, tls: "starttls", auth: { user: "example-user", pass: "example-password" },
    connectionTimeoutMs: 1000, greetingTimeoutMs: 1000, socketTimeoutMs: 1000, dnsTimeoutMs: 1000,
    maxConnections: 1, maxQueued: 1, maxMessages: 10 } };
const INVITE = { to: "person@example.com", purpose: "invite", link: "https://app.example.com/account/invite?token=example-token" } as const;

function fake(): { messages: AccountMailMessage[]; options: AccountSmtpOptions[]; transport: AccountMailTransport;
  transportFactory: (options: AccountSmtpOptions) => AccountMailTransport } {
  const messages: AccountMailMessage[] = [], options: AccountSmtpOptions[] = [];
  const transport: AccountMailTransport = { sendMail: async (message) => { messages.push(message); return { accepted: [message.to.address], rejected: [] }; }, close: () => {} };
  return { messages, options, transport, transportFactory: (settings) => { options.push(settings); return transport; } };
}

const unavailable = (error: unknown): boolean => error instanceof AccountMailError && error.code === "unavailable";

describe("account email adapter", () => {
  it("enforces TLS, certificate validation, no content logs, one recipient and bounded SMTP resources", () => {
    for (const smtp of [CONFIG.smtp, { ...CONFIG.smtp, port: 465, tls: "implicit" as const },
      { ...CONFIG.smtp, port: 2465, tls: "implicit" as const }, { ...CONFIG.smtp, port: 465, tls: "starttls" as const }]) {
      const source = fake();
      const mailer = new AccountMailer({ ...CONFIG, smtp }, source);
      const options = source.options[0]!;
      assert.equal(options.port, smtp.port);
      assert.equal(options.secure, smtp.tls === "implicit");
      assert.equal(options.requireTLS, true);
      assert.equal(options.ignoreTLS, false);
      assert.equal(options.tls?.rejectUnauthorized, true);
      assert.equal(options.tls?.minVersion, "TLSv1.2");
      assert.equal(options.tls?.servername, "smtp.example.com");
      assert.equal(options.logger, false);
      assert.equal(options.debug, false);
      assert.equal(options.transactionLog, false);
      assert.equal(options.disableFileAccess, true);
      assert.equal(options.disableUrlAccess, true);
      assert.equal(options.maxRecipients, 1);
      assert.equal(options.maxRequeues, 0);
      assert.equal(options.maxConnections, 1);
      assert.equal(options.connectionTimeout, 1000);
      assert.equal(options.greetingTimeout, 1000);
      assert.equal(options.socketTimeout, 1000);
      assert.equal(options.dnsTimeout, 1000);
      assert.equal(JSON.stringify(mailer), "{}");
      mailer.close();
    }
  });

  it("sends fixed templates with trusted links and escaped HTML without caller headers or attachments", async () => {
    const source = fake(), mailer = new AccountMailer(CONFIG, source);
    for (const purpose of ["invite", "password-reset", "email-change"] as const) {
      await mailer.send({ ...INVITE, purpose, link: `https://app.example.com${CONFIG.actionPaths[purpose]}?token=example-token&next=example` });
    }
    assert.equal(source.messages.length, 3);
    const message = source.messages[0]!;
    assert.deepEqual(message.from, { address: CONFIG.from });
    assert.deepEqual(message.to, { address: INVITE.to });
    assert.deepEqual(message.envelope, { from: CONFIG.from, to: [INVITE.to] });
    assert.ok(message.text.includes("?token=example-token&next=example"));
    assert.ok(message.html.includes("?token=example-token&amp;next=example"));
    const expected = [
      { subject: "계정 초대 / Account invitation", ko: "계정 초대를 수락해 주세요.", en: "Please accept your account invitation." },
      { subject: "비밀번호 재설정 / Password reset", ko: "비밀번호를 재설정해 주세요.", en: "Please reset your password." },
      { subject: "이메일 주소 확인 / Email address confirmation", ko: "새 이메일 주소를 확인해 주세요.", en: "Please confirm your new email address." },
    ];
    for (const [index, sent] of source.messages.entries()) {
      const copy = expected[index]!;
      assert.equal(sent.subject, copy.subject);
      assert.equal(/[\r\n]/u.test(sent.subject), false);
      for (const body of [sent.text, sent.html]) {
        assert.ok(body.includes(copy.ko) && body.includes(copy.en));
        assert.ok(body.indexOf(copy.ko) < body.indexOf(copy.en), "Korean paragraph precedes English");
        assert.ok(body.includes("요청하지 않았다면 이 메일을 무시하세요.") && body.includes("If you did not request this, you can ignore this email."));
      }
      assert.equal(sent.text.split("?token=example-token&next=example").length - 1, 2);
      assert.ok(sent.html.includes('<div lang="ko">') && sent.html.includes('<div lang="en">'));
      assert.ok(sent.html.includes(">계속하기</a>") && sent.html.includes(">Continue</a>"));
      const anchors = [...sent.html.matchAll(/<a\b[^>]*>/gu)].map((match) => match[0]);
      assert.equal(anchors.length, 2);
      for (const anchor of anchors) {
        assert.equal(anchor, `<a href="https://app.example.com${CONFIG.actionPaths[(["invite", "password-reset", "email-change"] as const)[index]!]}?token=example-token&amp;next=example">`);
      }
    }
    assert.equal("headers" in message, false);
    assert.equal("attachments" in message, false);
    assert.equal("cc" in message, false);
    assert.equal("bcc" in message, false);
    assert.equal(message.disableFileAccess, true);
    mailer.close();
  });

  it("uses the real Nodemailer JSON transport for an isolated no-network integration", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    let serialized = "";
    const mailer = new AccountMailer(CONFIG, { transportFactory: () => ({
      sendMail: async (message) => {
        const result = await transport.sendMail({ ...message, envelope: { ...message.envelope, to: [...message.envelope.to] } });
        serialized = result.message;
        // JSON transport does not deliver: model the SMTP acknowledgement separately.
        return { accepted: [message.to.address], rejected: [] };
      }, close: () => transport.close(),
    }) });
    await mailer.send({ ...INVITE, to: "Person@EXAMPLE.COM" });
    const message = JSON.parse(serialized) as { from: { address: string }; to: { address: string }[]; html: string };
    assert.equal(message.from.address, CONFIG.from);
    assert.equal(message.to.length, 1);
    assert.equal(message.to[0]?.address, "Person@example.com");
    assert.ok(message.html.includes("example-token"));
    mailer.close();
  });

  it("canonicalizes only envelope domains and configures explicit EHLO identity", async () => {
    const source = fake(), mailer = new AccountMailer({ ...CONFIG, from: "Accounts@EXAMPLE.COM" }, source);
    await mailer.send({ ...INVITE, to: "Person@EXAMPLE.COM" });
    assert.equal(source.options[0]!.name, "app.example.com");
    assert.deepEqual(source.messages[0]!.envelope, { from: "Accounts@example.com", to: ["Person@example.com"] });
    assert.deepEqual(source.messages[0]!.from, { address: "Accounts@example.com" });
    assert.deepEqual(source.messages[0]!.to, { address: "Person@example.com" });
    mailer.close();
    assert.throws(() => new AccountMailer({ ...CONFIG, smtp: { ...CONFIG.smtp, name: "invalid\r\nname" } }, fake()), { code: "invalid-config" });
  });

  it("allows only fixed security notifications, without token-bearing links", async () => {
    const source = fake(), mailer = new AccountMailer(CONFIG, source);
    const events = ["password-changed", "email-changed", "mfa-reset", "mfa-replaced", "recovery-code-used",
      "identity-linked", "identity-unlinked"] as const;
    for (const event of events) await mailer.sendSecurityNotification({ to: INVITE.to, event });
    assert.equal(source.messages.length, events.length);
    assert.equal(new Set(source.messages.map((message) => message.subject)).size, events.length);
    for (const message of source.messages) {
      assert.equal(message.text.includes("token="), false);
      assert.equal(/https?:|www\.|<a\b|href=/iu.test(`${message.text}${message.html}`), false);
      assert.match(message.subject, /^[^\r\n/]+ \/ [ -~]+$/u);
      assert.match(message.subject, /[가-힣]/u);
      assert.deepEqual(message.envelope, { from: CONFIG.from, to: [INVITE.to] });
      for (const key of ["headers", "attachments", "cc", "bcc"]) assert.equal(key in message, false);
      for (const body of [message.text, message.html]) {
        const ko = body.indexOf("직접 한 일이 아니라면 관리자에게 문의하세요."), en = body.indexOf("If this was not you, contact your administrator.");
        assert.ok(ko >= 0 && en > ko, "Korean paragraph precedes English");
      }
    }
    const copy = new Map(events.map((event, index) => [event, source.messages[index]!]));
    for (const [event, subject, ko, en] of [
      ["password-changed", "비밀번호 변경 알림 / Password changed", "계정 비밀번호가 변경됐습니다.", "Your account password was changed."],
      ["mfa-replaced", "인증 앱 변경 알림 / Authenticator app replaced", "계정에 연결된 인증 앱이 새 앱으로 바뀌었습니다.",
        "The authenticator app for your account was replaced with a new one."],
      ["recovery-code-used", "복구 코드 로그인 알림 / Recovery code sign-in",
        "복구 코드로 계정에 로그인했습니다. 사용한 복구 코드는 다시 쓸 수 없습니다.",
        "Someone signed in to your account with a recovery code. That recovery code can no longer be used."],
    ] as const) {
      const message = copy.get(event)!;
      assert.equal(message.subject, subject);
      for (const body of [message.text, message.html]) assert.ok(body.includes(ko) && body.includes(en) && body.indexOf(ko) < body.indexOf(en));
      assert.ok(message.html.includes('<div lang="ko">') && message.html.includes('<div lang="en">'));
    }
    for (const event of ["unknown", "__proto__", "toString"]) {
      await assert.rejects(mailer.sendSecurityNotification({ to: INVITE.to, event: event as "mfa-reset" }), { code: "invalid-message" });
    }
    assert.equal(source.messages.length, events.length);
    mailer.close();
  });

  it("rejects arbitrary recipients, headers, untrusted origins and wrong-purpose URLs before sending", async () => {
    const source = fake(), mailer = new AccountMailer(CONFIG, source);
    for (const to of ["person@example.com,other@example.com", "person@example.com\r\nBcc:other@example.com", "Person <person@example.com>", "invalid"]) {
      await assert.rejects(mailer.send({ ...INVITE, to }), { code: "invalid-message" });
    }
    for (const link of ["http://app.example.com/account/invite?token=example", "https://other.example.com/account/invite?token=example",
      "https://app.example.com/account/password-reset?token=example", "https://user:password@app.example.com/account/invite",
      "https://app.example.com/account/invite#example-token", "//app.example.com/account/invite", "/account/invite",
      "https://app.example.com/account/invite?token=example\n", "https://app.example.com/account/invite/../invite?token=example"]) {
      await assert.rejects(mailer.send({ ...INVITE, link }), { code: "invalid-message" });
    }
    assert.equal(source.messages.length, 0);
    mailer.close();
  });

  it("rejects insecure or unbounded configuration without contacting SMTP", () => {
    const source = fake();
    for (const config of [
      { ...CONFIG, publicOrigin: "http://app.example.com" }, { ...CONFIG, publicOrigin: "https://app.example.com/" },
      { ...CONFIG, from: "accounts@example.com\nBCC:other@example.com" },
      { ...CONFIG, smtp: { ...CONFIG.smtp, tls: undefined as unknown as "implicit" } },
      { ...CONFIG, smtp: { ...CONFIG.smtp, tls: "none" as unknown as "implicit" } },
      { ...CONFIG, smtp: { ...CONFIG.smtp, tls: "IMPLICIT" as unknown as "implicit" } },
      { ...CONFIG, smtp: { ...CONFIG.smtp, secure: false } as unknown as AccountMailerConfig["smtp"] },
      { ...CONFIG, smtp: { ...CONFIG.smtp, tls: "implicit" as const, secure: true } as unknown as AccountMailerConfig["smtp"] },
      ...[0, -1, 65536, 587.5, Number.NaN, Infinity].map((port) => ({ ...CONFIG, smtp: { ...CONFIG.smtp, port } })),
      { ...CONFIG, smtp: { ...CONFIG.smtp, port: "587" as unknown as number } },
      { ...CONFIG, smtp: { ...CONFIG.smtp, maxConnections: 0 } }, { ...CONFIG, smtp: { ...CONFIG.smtp, maxQueued: Infinity } },
      { ...CONFIG, smtp: { ...CONFIG.smtp, socketTimeoutMs: 0 } }, { ...CONFIG, smtp: { ...CONFIG.smtp, auth: { user: "", pass: "" } } },
      { ...CONFIG, actionPaths: { ...CONFIG.actionPaths, invite: "//other.example.com/invite" } },
    ]) assert.throws(() => new AccountMailer(config, source), { code: "invalid-config" });
    assert.equal(source.options.length, 0);
  });

  it("normalizes failures without preserving server responses, credentials, addresses or link tokens", async () => {
    const source = fake();
    source.transport.sendMail = async () => { throw new Error(`SMTP diagnostic ${CONFIG.smtp.auth.pass} ${INVITE.to} ${INVITE.link}`); };
    const mailer = new AccountMailer(CONFIG, source);
    await assert.rejects(mailer.send(INVITE), (error: unknown) => {
      assert.ok(error instanceof AccountMailError);
      assert.equal(error.message, "account mail unavailable");
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error).includes("example-token"), false);
      return true;
    });
    mailer.close();
  });

  it("requires a positive acknowledgement for the exact single recipient", async () => {
    const source = fake(), mailer = new AccountMailer(CONFIG, source);
    for (const response of [undefined, {}, { accepted: [], rejected: [INVITE.to] },
      { accepted: ["other@example.com"], rejected: [] }, { accepted: [INVITE.to], rejected: [INVITE.to] },
      { accepted: [INVITE.to, "other@example.com"], rejected: [] }]) {
      source.transport.sendMail = async () => response;
      await assert.rejects(mailer.send(INVITE), unavailable);
    }
    source.transport.sendMail = async () => ({ accepted: [{ address: INVITE.to }], rejected: [] });
    await mailer.send(INVITE);
    mailer.close();
  });

  it("bounds the application queue, releases failed slots, and rejects queued mail when closed", async () => {
    const completions: { resolve: () => void; reject: (error: Error) => void }[] = [];
    let closed = 0;
    const mailer = new AccountMailer(CONFIG, { transportFactory: () => ({
      sendMail: () => new Promise<void>((resolve, reject) => completions.push({ resolve, reject })), close: () => { closed++; },
    }) });
    const running = mailer.send(INVITE), runningResult = assert.rejects(running, unavailable);
    const queued = mailer.send(INVITE), queuedResult = assert.rejects(queued, unavailable);
    await assert.rejects(mailer.send(INVITE), unavailable);
    assert.equal(completions.length, 1);
    completions[0]!.reject(new Error("private SMTP failure"));
    await runningResult;
    assert.equal(completions.length, 2);
    const finalQueued = mailer.send(INVITE), finalResult = assert.rejects(finalQueued, unavailable);
    mailer.close();
    mailer.close();
    await finalResult;
    completions[1]!.reject(new Error("private SMTP failure"));
    await queuedResult;
    assert.equal(closed, 1);
    await assert.rejects(mailer.send(INVITE), unavailable);
  });
});
