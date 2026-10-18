import { randomUUID } from "node:crypto";
import { emptyAccountState, MEMBER_ACCOUNTS_FEATURE, readAccountState, readMemberAudit, retainAudit, type AccountState, type AccountStateStore, type AccountTransaction, type MemberAudit } from "../application/accounts/state.ts";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  AccessTokenRepository,
  CredentialRepository,
  SettingsRepository,
  StoredAccessToken,
} from "../application/ports.ts";
import { ensurePrivateDirectory, withFileLock } from "./atomic-file.ts";
import { AUTH_FEATURE_NAME, assertRecognizedAuthFeatures, describeStoredNames } from "./auth-storage.ts";

/** The draft `#mutate` hands out is edited in place, so the rows are writable. */
type MutableAccessToken = { -readonly [K in keyof StoredAccessToken]: StoredAccessToken[K] };

interface ConfigurationDocument {
  version: 1 | 2;
  accounts?: AccountState;
  accountAudit?: MemberAudit[];
  settings: Record<string, unknown>;
  credentials?: string;
  accessTokens: MutableAccessToken[];
  /** 저장소가 켠 인증 기능. 빈 목록도 그대로 다시 쓴다. */
  authFeatures?: string[];
}

/**
 * The fileless-mode counterpart to the database tables: settings, the sealed
 * credential document, and access-token digests share one JSON file that is
 * replaced atomically, so a crash leaves either the old or the new set.
 */
export class FileConfigurationStore {
  readonly #path: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error("configuration file path must not be empty");
    this.#path = path;
  }

  get accounts(): AccountStateStore {
    return {
      transact: async (operation) => this.#mutate((document) => {
        const transaction: AccountTransaction = { state: structuredClone(document.accounts ?? emptyAccountState()), audit: [] };
        const result = operation(transaction);
        if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("account transaction callback must be synchronous");
        const state = readAccountState(transaction.state);
        if (document.accounts?.enabled && !state.enabled) throw new Error("account activation cannot be reversed");
        document.accounts = state;
        document.accountAudit = retainAudit(readMemberAudit([...(document.accountAudit ?? []), ...transaction.audit]), transaction.retention);
        document.version = 2;
        if (state.enabled) document.authFeatures = [...new Set([...(document.authFeatures ?? []), MEMBER_ACCOUNTS_FEATURE])];
        return structuredClone(result);
      }),
      read: async () => structuredClone((await this.#readLatest()).accounts ?? emptyAccountState()),
      snapshot: async () => {
        const document = await this.#readLatest();
        return structuredClone({ state: document.accounts ?? emptyAccountState(), audit: document.accountAudit ?? [] });
      },
    };
  }

  get settings(): SettingsRepository {
    return {
      read: async () => ({ ...(await this.#readLatest()).settings }),
      write: async (values) => {
        await this.#mutate((document) => {
          document.settings = { ...document.settings, ...values };
        });
      },
      update: async (operation) => this.#mutate(async (document) => {
        const replacement = await operation(structuredClone(document.settings));
        document.settings = { ...document.settings, ...replacement.patch };
        return replacement.result;
      }),
    };
  }

  get credentials(): CredentialRepository {
    return {
      read: async () => (await this.#readLatest()).credentials,
      write: async (sealed) => {
        await this.#mutate((document) => { document.credentials = sealed; });
      },
      update: async (operation) => this.#mutate((document) => {
        const update = operation(document.credentials);
        document.credentials = update.document;
        return update.result;
      }),
    };
  }

  get accessTokens(): AccessTokenRepository {
    return {
      list: async () => (await this.#readLatest()).accessTokens.map((token) => ({ ...token })),
      create: async (token) => {
        await this.#mutate((document) => {
          if (document.accessTokens.some((existing) => existing.digest === token.digest)) {
            throw new Error("access token already exists");
          }
          document.accessTokens.push({ ...token });
        });
      },
      touch: async (uses) => {
        if (uses.length === 0) return;
        await this.#mutate((document) => {
          for (const use of uses) {
            const token = document.accessTokens.find((candidate) => candidate.id === use.id);
            // Never backwards, and a token revoked since the use was recorded
            // is simply gone -- neither is worth failing a flush over.
            if (token && !(token.lastUsedAt && token.lastUsedAt >= use.at)) token.lastUsedAt = use.at;
          }
        });
      },
      revoke: async (id, retainedAdministratorCount) => this.#mutate((document) => {
        const index = document.accessTokens.findIndex((token) => token.id === id);
        if (index < 0) return "not-found";
        const target = document.accessTokens[index];
        if (target?.role === "admin") {
          const storedAdministrators = document.accessTokens
            .filter((token, tokenIndex) => tokenIndex !== index && token.role === "admin").length;
          if (storedAdministrators + retainedAdministratorCount === 0) return "last-admin";
        }
        document.accessTokens.splice(index, 1);
        return "deleted";
      }),
    };
  }

  async #load(): Promise<ConfigurationDocument> {
    await ensurePrivateDirectory(dirname(this.#path));
    let source: string;
    try {
      await chmod(this.#path, 0o600);
      source = await readFile(this.#path, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return { version: 1, settings: {}, accessTokens: [] };
    }
    return parseDocument(JSON.parse(source) as unknown);
  }

  async #readLatest(): Promise<ConfigurationDocument> {
    await this.#writeTail;
    return this.#load();
  }

  #mutate<T>(operation: (document: ConfigurationDocument) => T | Promise<T>): Promise<T> {
    const result = this.#writeTail.then(() => withFileLock(this.#path, async () => {
      // Re-read only after obtaining the cross-process lock. A snapshot read
      // before the lock can overwrite a CLI or replica change made while this
      // process was waiting.
      const draft = structuredClone(await this.#load());
      const value = await operation(draft);
      await this.#writeAtomically(draft);
      return value;
    }));
    this.#writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #writeAtomically(document: ConfigurationDocument): Promise<void> {
    const directory = dirname(this.#path);
    await ensurePrivateDirectory(directory);
    const temporaryPath = join(directory, `.${basename(this.#path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.#path);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

/** 이 버전이 읽고 다시 쓸 수 있는 최상위 필드. */
const DOCUMENT_FIELDS = new Set(["version", "settings", "credentials", "accessTokens", "authFeatures", "accounts", "accountAudit"]);

function parseDocument(value: unknown): ConfigurationDocument {
  if (!isObject(value) || (value.version !== 1 && value.version !== 2)) throw new Error("unsupported configuration file");
  // 모르는 필드는 버리지 않고 거절한다. 이 문서는 읽을 때마다 다시 쓰일 수 있다.
  // 버리면 미래 버전이 남긴 회원 데이터를 받아들인 척하고 다음 쓰기에서 지운다.
  const unknownFields = Object.keys(value).filter((field) => !DOCUMENT_FIELDS.has(field)).sort();
  if (unknownFields.length > 0) {
    // 필드 이름은 파일에서 온 값이다. 따옴표로 감싸고 개수와 길이를 줄여서 적는다.
    throw new Error(`unsupported configuration file: unknown field ${describeStoredNames(unknownFields)}`);
  }
  let authFeatures: string[] | undefined;
  if (value.authFeatures !== undefined) {
    if (!Array.isArray(value.authFeatures)
      || !value.authFeatures.every((feature) => typeof feature === "string" && AUTH_FEATURE_NAME.test(feature))) {
      throw new Error("unsupported configuration file: authFeatures must be a list of names");
    }
    authFeatures = [...(value.authFeatures as string[])];
    assertRecognizedAuthFeatures(authFeatures, "the configuration file");
  }
  const settings = isObject(value.settings) ? value.settings : {};
  const credentials = typeof value.credentials === "string" ? value.credentials : undefined;
  const accessTokens = Array.isArray(value.accessTokens) ? value.accessTokens.map(readAccessToken) : [];
  if (new Set(accessTokens.map((token) => token.id)).size !== accessTokens.length
    || new Set(accessTokens.map((token) => token.digest)).size !== accessTokens.length) {
    throw new Error("duplicate stored access token");
  }
  const accounts = value.accounts === undefined ? undefined : readAccountState(value.accounts);
  const accountAudit = value.accountAudit === undefined ? undefined : readMemberAudit(value.accountAudit);
  if ((accounts !== undefined || accountAudit !== undefined || authFeatures?.includes(MEMBER_ACCOUNTS_FEATURE)) && value.version !== 2) {
    throw new Error("account state requires configuration version 2");
  }
  if ((accounts !== undefined) !== (accountAudit !== undefined)
    || Boolean(accounts?.enabled) !== Boolean(authFeatures?.includes(MEMBER_ACCOUNTS_FEATURE))) throw new Error("incomplete account activation");
  // 읽은 표식과 회원 상태를 모든 설정 쓰기에서 보존한다.
  return {
    version: value.version,
    ...(accounts ? { accounts, accountAudit } : {}),
    settings,
    ...(credentials ? { credentials } : {}),
    accessTokens,
    ...(authFeatures ? { authFeatures } : {}),
  };
}

function readAccessToken(value: unknown): MutableAccessToken {
  if (!isObject(value)
    || typeof value.id !== "string"
    || typeof value.subject !== "string"
    || typeof value.digest !== "string"
    || typeof value.createdAt !== "string"
    || (value.role !== "admin" && value.role !== "editor" && value.role !== "viewer")) {
    throw new Error("invalid stored access token");
  }
  const digest = Buffer.from(value.digest, "base64url");
  const createdAt = new Date(value.createdAt);
  if (value.id.length === 0 || value.id.length > 128 || /[\u0000-\u001f\u007f]/u.test(value.id)
    || value.subject.trim().length === 0 || value.subject.length > 128 || /[\u0000-\u001f\u007f]/u.test(value.subject)
    || !/^[A-Za-z0-9_-]{43}$/u.test(value.digest) || digest.byteLength !== 32 || digest.toString("base64url") !== value.digest
    || Number.isNaN(createdAt.valueOf()) || createdAt.toISOString() !== value.createdAt) {
    throw new Error("invalid stored access token");
  }
  const optional = (field: "expiresAt" | "lastUsedAt"): Record<string, string> => {
    const at = value[field];
    if (at === undefined) return {};
    if (typeof at !== "string" || Number.isNaN(new Date(at).valueOf()) || new Date(at).toISOString() !== at) {
      throw new Error("invalid stored access token");
    }
    return { [field]: at };
  };
  return {
    id: value.id, subject: value.subject, role: value.role, digest: value.digest, createdAt: value.createdAt,
    ...optional("expiresAt"),
    ...optional("lastUsedAt"),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
