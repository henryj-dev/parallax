import nodemailer from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool/index.js";

export type AccountMailPurpose = "invite" | "password-reset" | "email-change";
export type AccountSecurityEvent = "password-changed" | "email-changed" | "mfa-reset" | "mfa-replaced" | "recovery-code-used"
  | "identity-linked" | "identity-unlinked";

export interface AccountMailerConfig {
  readonly from: string;
  readonly publicOrigin: string;
  readonly actionPaths: Readonly<Record<AccountMailPurpose, string>>;
  readonly smtp: {
    readonly host: string;
    readonly name: string;
    readonly port: number;
    /** Explicit TLS mode; never inferred from the port. Both modes validate the server certificate. */
    readonly tls: "implicit" | "starttls";
    readonly auth: { readonly user: string; readonly pass: string };
    readonly connectionTimeoutMs: number;
    readonly greetingTimeoutMs: number;
    readonly socketTimeoutMs: number;
    readonly dnsTimeoutMs: number;
    readonly maxConnections: number;
    readonly maxQueued: number;
    readonly maxMessages: number;
  };
}

export interface AccountMailMessage {
  readonly from: { readonly address: string };
  readonly to: { readonly address: string };
  readonly envelope: { readonly from: string; readonly to: readonly string[] };
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly disableFileAccess: true;
  readonly disableUrlAccess: true;
}

export interface AccountMailTransport {
  sendMail(message: AccountMailMessage): Promise<unknown>;
  close(): void;
}

export type AccountSmtpOptions = SMTPPool.Options & {
  readonly maxRecipients: 1;
  readonly maxRequeues: 0;
  readonly disableFileAccess: true;
  readonly disableUrlAccess: true;
};

export class AccountMailError extends Error {
  readonly code: "invalid-config" | "invalid-message" | "unavailable";

  constructor(code: AccountMailError["code"]) {
    super(code === "invalid-config" ? "invalid account mail configuration"
      : code === "invalid-message" ? "invalid account mail message" : "account mail unavailable");
    this.name = "AccountMailError";
    this.code = code;
  }
}

function bounded(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/** A single address only: no display names, recipient lists, controls, or header syntax. */
function address(value: string): boolean {
  return typeof value === "string" && value.length <= 254
    && /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(value)
    && !value.startsWith(".") && !value.includes("..") && !value.includes(".@");
}

function canonicalAddress(value: string): string {
  const index = value.lastIndexOf("@");
  return value.slice(0, index + 1) + value.slice(index + 1).toLowerCase();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function validateConfig(config: AccountMailerConfig): void {
  try {
    const origin = new URL(config.publicOrigin), smtp = config.smtp;
    if (!address(config.from) || origin.protocol !== "https:" || origin.origin !== config.publicOrigin
      || ![smtp.host, smtp.name].every((value) => typeof value === "string" && value.length <= 253
        && /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(value))
      || !bounded(smtp.port, 1, 65535) || (smtp.tls !== "implicit" && smtp.tls !== "starttls")
      || Object.hasOwn(smtp, "secure")
      || !smtp.auth.user || smtp.auth.user.length > 1024 || !smtp.auth.pass || smtp.auth.pass.length > 8192
      || !bounded(smtp.maxConnections, 1, 16) || !bounded(smtp.maxQueued, 0, 1024)
      || !bounded(smtp.maxMessages, 1, 10000)
      || ![smtp.connectionTimeoutMs, smtp.greetingTimeoutMs, smtp.socketTimeoutMs, smtp.dnsTimeoutMs]
        .every((value) => bounded(value, 1, 120000))) throw new Error("invalid config");
    for (const purpose of ["invite", "password-reset", "email-change"] as const) {
      const path = config.actionPaths[purpose];
      if (typeof path !== "string" || !/^\/[A-Za-z0-9/_-]+$/u.test(path) || path.startsWith("//")
        || new URL(path, origin).origin !== origin.origin) throw new Error("invalid path");
    }
  } catch {
    throw new AccountMailError("invalid-config");
  }
}

// The server cannot know the recipient's language, so each fixed template carries Korean, then English.
const LANGUAGES = ["ko", "en"] as const;
type Bilingual = Readonly<Record<(typeof LANGUAGES)[number], string>>;
interface BilingualTemplate { readonly subject: Bilingual; readonly body: Bilingual }

const ACTION_TEMPLATES: Readonly<Record<AccountMailPurpose, BilingualTemplate>> = {
  invite: { subject: { ko: "계정 초대", en: "Account invitation" },
    body: { ko: "계정 초대를 수락해 주세요.", en: "Please accept your account invitation." } },
  "password-reset": { subject: { ko: "비밀번호 재설정", en: "Password reset" },
    body: { ko: "비밀번호를 재설정해 주세요.", en: "Please reset your password." } },
  "email-change": { subject: { ko: "이메일 주소 확인", en: "Email address confirmation" },
    body: { ko: "새 이메일 주소를 확인해 주세요.", en: "Please confirm your new email address." } },
};
const ACTION_CONTINUE: Bilingual = { ko: "계속하기", en: "Continue" };
const ACTION_IGNORE: Bilingual = { ko: "요청하지 않았다면 이 메일을 무시하세요.", en: "If you did not request this, you can ignore this email." };
const SECURITY_TEMPLATES: Readonly<Record<AccountSecurityEvent, BilingualTemplate>> = {
  "password-changed": { subject: { ko: "비밀번호 변경 알림", en: "Password changed" },
    body: { ko: "계정 비밀번호가 변경됐습니다.", en: "Your account password was changed." } },
  "email-changed": { subject: { ko: "이메일 주소 변경 알림", en: "Email address changed" },
    body: { ko: "계정 이메일 주소가 변경됐습니다.", en: "Your account email address was changed." } },
  "mfa-reset": { subject: { ko: "다중 인증 초기화 알림", en: "Multi-factor authentication reset" },
    body: { ko: "계정 다중 인증이 초기화됐습니다.", en: "Multi-factor authentication for your account was reset." } },
  "mfa-replaced": { subject: { ko: "인증 앱 변경 알림", en: "Authenticator app replaced" },
    body: { ko: "계정에 연결된 인증 앱이 새 앱으로 바뀌었습니다.", en: "The authenticator app for your account was replaced with a new one." } },
  "recovery-code-used": { subject: { ko: "복구 코드 로그인 알림", en: "Recovery code sign-in" },
    body: { ko: "복구 코드로 계정에 로그인했습니다. 사용한 복구 코드는 다시 쓸 수 없습니다.",
      en: "Someone signed in to your account with a recovery code. That recovery code can no longer be used." } },
  "identity-linked": { subject: { ko: "SSO 로그인 연결 알림", en: "SSO sign-in linked" },
    body: { ko: "계정에 SSO 로그인이 연결됐습니다.", en: "An SSO sign-in was linked to your account." } },
  "identity-unlinked": { subject: { ko: "SSO 로그인 연결 해제 알림", en: "SSO sign-in unlinked" },
    body: { ko: "계정의 SSO 로그인 연결이 해제됐습니다.", en: "An SSO sign-in was unlinked from your account." } },
};
const SECURITY_CONTACT: Bilingual = { ko: "직접 한 일이 아니라면 관리자에게 문의하세요.", en: "If this was not you, contact your administrator." };

function bilingualSubject(template: BilingualTemplate): string {
  return `${template.subject.ko} / ${template.subject.en}`;
}

/** No outbox, plaintext token persistence, retries, headers, or caller-supplied message bodies. */
export class AccountMailer {
  readonly #from: string;
  readonly #origin: string;
  readonly #paths: Readonly<Record<AccountMailPurpose, string>>;
  readonly #transport: AccountMailTransport;
  readonly #maxConnections: number;
  readonly #maxQueued: number;
  readonly #queue: { start: () => void; reject: (error: AccountMailError) => void }[] = [];
  #active = 0;
  #closed = false;

  /** Transport injection is reserved for isolated tests; the default always enforces TLS validation. */
  constructor(config: AccountMailerConfig, dependencies: { readonly transportFactory?: (options: AccountSmtpOptions) => AccountMailTransport } = {}) {
    try {
      config = { ...config, actionPaths: { ...config.actionPaths }, smtp: { ...config.smtp, auth: { ...config.smtp.auth } } };
    } catch {
      throw new AccountMailError("invalid-config");
    }
    validateConfig(config);
    this.#from = canonicalAddress(config.from);
    this.#origin = config.publicOrigin;
    this.#paths = Object.freeze({ ...config.actionPaths });
    this.#maxConnections = config.smtp.maxConnections;
    this.#maxQueued = config.smtp.maxQueued;
    const smtp = config.smtp;
    const options: AccountSmtpOptions = {
      host: smtp.host, name: smtp.name, port: smtp.port, secure: smtp.tls === "implicit", requireTLS: true, ignoreTLS: false,
      auth: { user: smtp.auth.user, pass: smtp.auth.pass },
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", servername: smtp.host },
      pool: true, maxConnections: smtp.maxConnections, maxMessages: smtp.maxMessages, maxRequeues: 0,
      connectionTimeout: smtp.connectionTimeoutMs, greetingTimeout: smtp.greetingTimeoutMs,
      socketTimeout: smtp.socketTimeoutMs, dnsTimeout: smtp.dnsTimeoutMs,
      logger: false, debug: false, transactionLog: false, maxRecipients: 1,
      disableFileAccess: true, disableUrlAccess: true,
    };
    try {
      if (dependencies.transportFactory) this.#transport = dependencies.transportFactory(options);
      else {
        const transporter = nodemailer.createTransport(options);
        this.#transport = {
          sendMail: (message) => transporter.sendMail({ ...message, envelope: { ...message.envelope, to: [...message.envelope.to] } }),
          close: () => transporter.close(),
        };
      }
    } catch {
      throw new AccountMailError("unavailable");
    }
  }

  async send(input: { readonly to: string; readonly purpose: AccountMailPurpose; readonly link: string }): Promise<void> {
    if (!Object.hasOwn(ACTION_TEMPLATES, input.purpose) || !address(input.to)) throw new AccountMailError("invalid-message");
    let link: URL;
    try {
      if (typeof input.link !== "string" || input.link.length > 4096 || /[\x00-\x20\x7f\\]/u.test(input.link)) throw new Error("invalid link");
      link = new URL(input.link);
      if (link.origin !== this.#origin || link.username || link.password || link.hash
        || link.pathname !== this.#paths[input.purpose] || link.href !== input.link) throw new Error("invalid link");
    } catch {
      throw new AccountMailError("invalid-message");
    }
    const template = ACTION_TEMPLATES[input.purpose], href = escapeHtml(link.href);
    const text = LANGUAGES.map((language) => `${template.body[language]}\n\n${link.href}\n\n${ACTION_IGNORE[language]}`).join("\n\n---\n\n");
    const html = LANGUAGES.map((language) => `<div lang="${language}"><p>${escapeHtml(template.body[language])}</p>`
      + `<p><a href="${href}">${escapeHtml(ACTION_CONTINUE[language])}</a></p><p>${escapeHtml(ACTION_IGNORE[language])}</p></div>`).join("<hr>");
    await this.#send(this.#message(input.to, bilingualSubject(template), text, html));
  }

  async sendSecurityNotification(input: { readonly to: string; readonly event: AccountSecurityEvent }): Promise<void> {
    if (!Object.hasOwn(SECURITY_TEMPLATES, input.event) || !address(input.to)) throw new AccountMailError("invalid-message");
    const template = SECURITY_TEMPLATES[input.event];
    const text = LANGUAGES.map((language) => `${template.body[language]}\n\n${SECURITY_CONTACT[language]}`).join("\n\n---\n\n");
    const html = LANGUAGES.map((language) => `<div lang="${language}"><p>${escapeHtml(template.body[language])}</p>`
      + `<p>${escapeHtml(SECURITY_CONTACT[language])}</p></div>`).join("<hr>");
    await this.#send(this.#message(input.to, bilingualSubject(template), text, html));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#queue.splice(0)) entry.reject(new AccountMailError("unavailable"));
    try { this.#transport.close(); } catch { /* Closing must not reveal transport or credential details. */ }
  }

  #message(to: string, subject: string, text: string, html: string): AccountMailMessage {
    const canonicalTo = canonicalAddress(to);
    return { from: { address: this.#from }, to: { address: canonicalTo }, envelope: { from: this.#from, to: [canonicalTo] },
      subject, text, html, disableFileAccess: true, disableUrlAccess: true };
  }

  #send(message: AccountMailMessage): Promise<void> {
    if (this.#closed || (this.#active >= this.#maxConnections && this.#queue.length >= this.#maxQueued)) {
      return Promise.reject(new AccountMailError("unavailable"));
    }
    return new Promise((resolve, reject) => {
      const start = (): void => {
        this.#active++;
        // Promise.resolve also normalizes a synchronously throwing injected transport.
        void Promise.resolve().then(async () => {
          const result = await this.#transport.sendMail(message);
          if (typeof result !== "object" || result === null) throw new AccountMailError("unavailable");
          const { accepted, rejected } = result as { accepted?: unknown; rejected?: unknown };
          if (!Array.isArray(accepted) || accepted.length !== 1 || (Array.isArray(rejected) && rejected.length > 0)) {
            throw new AccountMailError("unavailable");
          }
          const recipient: unknown = accepted[0];
          const recipientAddress = typeof recipient === "string" ? recipient
            : typeof recipient === "object" && recipient !== null ? (recipient as { address?: unknown }).address : undefined;
          if (recipientAddress !== message.to.address) throw new AccountMailError("unavailable");
        }).then(
          () => { release(); resolve(); },
          () => { release(); reject(new AccountMailError("unavailable")); },
        );
      };
      const release = (): void => {
        this.#active--;
        if (!this.#closed) this.#queue.shift()?.start();
      };
      if (this.#active < this.#maxConnections) start();
      else this.#queue.push({ start, reject });
    });
  }
}
