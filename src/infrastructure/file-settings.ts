import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  AccessTokenRepository,
  CredentialRepository,
  SettingsRepository,
  StoredAccessToken,
} from "../application/ports.ts";

interface ConfigurationDocument {
  version: 1;
  settings: Record<string, unknown>;
  credentials?: string;
  accessTokens: StoredAccessToken[];
}

/**
 * The fileless-mode counterpart to the database tables: settings, the sealed
 * credential document, and access-token digests share one JSON file that is
 * replaced atomically, so a crash leaves either the old or the new set.
 */
export class FileConfigurationStore {
  readonly #path: string;
  #document: ConfigurationDocument | undefined;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    if (path.trim().length === 0) throw new Error("configuration file path must not be empty");
    this.#path = path;
  }

  get settings(): SettingsRepository {
    return {
      read: async () => ({ ...(await this.#load()).settings }),
      write: async (values) => {
        await this.#mutate((document) => {
          document.settings = { ...document.settings, ...values };
        });
      },
    };
  }

  get credentials(): CredentialRepository {
    return {
      read: async () => (await this.#load()).credentials,
      write: async (sealed) => {
        await this.#mutate((document) => { document.credentials = sealed; });
      },
    };
  }

  get accessTokens(): AccessTokenRepository {
    return {
      list: async () => (await this.#load()).accessTokens.map((token) => ({ ...token })),
      create: async (token) => {
        await this.#mutate((document) => {
          if (document.accessTokens.some((existing) => existing.digest === token.digest)) {
            throw new Error("access token already exists");
          }
          document.accessTokens.push({ ...token });
        });
      },
      delete: async (id) => this.#mutate((document) => {
        const index = document.accessTokens.findIndex((token) => token.id === id);
        if (index < 0) return false;
        document.accessTokens.splice(index, 1);
        return true;
      }),
    };
  }

  async #load(): Promise<ConfigurationDocument> {
    if (this.#document) return this.#document;
    let source: string;
    try {
      source = await readFile(this.#path, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.#document = { version: 1, settings: {}, accessTokens: [] };
      return this.#document;
    }
    this.#document = parseDocument(JSON.parse(source) as unknown);
    return this.#document;
  }

  #mutate<T>(operation: (document: ConfigurationDocument) => T): Promise<T> {
    const result = this.#writeTail.then(async () => {
      const draft = structuredClone(await this.#load());
      const value = operation(draft);
      await this.#writeAtomically(draft);
      this.#document = draft;
      return value;
    });
    this.#writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #writeAtomically(document: ConfigurationDocument): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
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
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function parseDocument(value: unknown): ConfigurationDocument {
  if (!isObject(value) || value.version !== 1) throw new Error("unsupported configuration file");
  const settings = isObject(value.settings) ? value.settings : {};
  const credentials = typeof value.credentials === "string" ? value.credentials : undefined;
  const accessTokens = Array.isArray(value.accessTokens) ? value.accessTokens.map(readAccessToken) : [];
  return { version: 1, settings, ...(credentials ? { credentials } : {}), accessTokens };
}

function readAccessToken(value: unknown): StoredAccessToken {
  if (!isObject(value)
    || typeof value.id !== "string"
    || typeof value.subject !== "string"
    || typeof value.digest !== "string"
    || typeof value.createdAt !== "string"
    || (value.role !== "admin" && value.role !== "editor" && value.role !== "viewer")) {
    throw new Error("invalid stored access token");
  }
  return { id: value.id, subject: value.subject, role: value.role, digest: value.digest, createdAt: value.createdAt };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
