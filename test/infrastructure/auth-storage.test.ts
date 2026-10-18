import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AUTH_FEATURES_TABLE,
  AuthStorageCheckError,
  RECOGNIZED_AUTH_FEATURES,
  UnrecognizedAuthStorageError,
  assertPostgresAuthStorageIsRecognized,
  assertRecognizedAuthFeatures,
  describeStoredNames,
  readPostgresAuthFeatures,
} from "../../src/infrastructure/auth-storage.ts";
import { FileConfigurationStore } from "../../src/infrastructure/file-settings.ts";
import type { PgQueryable, PgQueryResult } from "../../src/infrastructure/postgres.ts";

/**
 * 저장소 호환 검사. PostgreSQL 쪽은 정해진 답을 주는 가짜 연결로 읽는 규칙만
 * 확인한다. 실제 PostgreSQL 에서의 거절은 검증하지 않았다. 이 버전의 마이그레이션에는
 * 표식 테이블이 없어서다. 설정 파일 쪽은 실제 파일로 확인하고, 서버 프로세스가
 * 리스너를 열기 전에 멈추는지는 `test/auth-mode-startup.test.ts` 가 확인한다.
 */

const LOOKUP = "SELECT to_regclass($1) IS NOT NULL AS present, EXISTS ("
  + "SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
  + "WHERE c.relname::text = $1 AND NOT pg_catalog.has_schema_privilege(n.oid, 'USAGE')) AS hidden";

interface Script {
  readonly present: unknown;
  readonly hidden?: unknown;
  readonly rows?: unknown[];
  /** 표식 테이블을 읽을 때 던질 오류. */
  readonly readError?: Error;
}

/** 질의 문장에 따라 정해진 답을 주고, 받은 질의를 기록하는 연결. */
function scriptedPool(answers: Script | Error): PgQueryable & { readonly queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query<Row>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
      queries.push(values === undefined ? text : `${text} ${JSON.stringify(values)}`);
      if (answers instanceof Error) throw answers;
      if (text.startsWith("SELECT to_regclass")) {
        const row = { present: answers.present, hidden: "hidden" in answers ? answers.hidden : false };
        return { rows: [row] as Row[], rowCount: 1 } as PgQueryResult<Row>;
      }
      if (answers.readError) throw answers.readError;
      return { rows: (answers.rows ?? []) as Row[], rowCount: answers.rows?.length ?? 0 } as PgQueryResult<Row>;
    },
  };
}

/** 출력 가능한 ASCII 밖의 글자(줄바꿈, 제어 문자 포함)가 하나도 없는지. */
function assertPrintable(text: string): void {
  assert.doesNotMatch(text, /[^\x20-\x7e]/u, JSON.stringify(text));
}

describe("authentication feature markers", () => {
  it("recognizes member accounts and nothing else", () => {
    assert.deepEqual(RECOGNIZED_AUTH_FEATURES, ["member-accounts-v1"]);
    assert.doesNotThrow(() => assertRecognizedAuthFeatures(["member-accounts-v1"], "the store"));
    assert.doesNotThrow(() => assertRecognizedAuthFeatures([], "the store"));
  });

  it("names every unknown feature, once, sorted and quoted", () => {
    assert.throws(
      () => assertRecognizedAuthFeatures(["member-accounts", "account-mfa", "member-accounts"], "the store"),
      (error: unknown) => {
        assert.ok(error instanceof UnrecognizedAuthStorageError);
        assert.match(error.message, /^the store records authentication features this version does not recognize: "account-mfa", "member-accounts"\./u);
        assert.match(error.message, /documented rollback/u);
        return true;
      },
    );
  });

  it("bounds how many names and how much of each name a message carries", () => {
    const many = Array.from({ length: 12 }, (_, index) => `feature-${String(index).padStart(2, "0")}`);
    assert.equal(
      describeStoredNames(many),
      '"feature-00", "feature-01", "feature-02", "feature-03", "feature-04" and 7 more',
    );
    const long = describeStoredNames(["a".repeat(5000)]);
    assert.equal(long, `"${"a".repeat(64)}..."`);
  });

  it("never lets a newline, control character or non-ASCII character through", () => {
    const control = describeStoredNames(["x\ny", "a\rb", "tab\there", "nul\u0000", "del\u007f"]);
    const unicode = describeStoredNames(["ls\u2028", "bidi\u202e", "emoji\u{1f600}", "quote\"back\\"]);
    assertPrintable(control);
    assertPrintable(unicode);
    assert.equal(control, String.raw`"x\ny", "a\rb", "tab\there", "nul\u0000", "del\u007f"`);
    assert.equal(unicode, String.raw`"ls\u2028", "bidi\u202e", "emoji\u{1f600}", "quote\"back\\"`);
  });
});

describe("PostgreSQL authentication feature markers", () => {
  it("treats a database without the marker table as a legacy store", async () => {
    assert.deepEqual(await readPostgresAuthFeatures(scriptedPool({ present: false })), []);
    const pool = scriptedPool({ present: false });
    await assertPostgresAuthStorageIsRecognized(pool);
    // 테이블이 없으면 그 테이블을 읽지 않는다. 표식 확인은 읽기 하나뿐이다.
    assert.deepEqual(pool.queries, [`${LOOKUP} ${JSON.stringify([AUTH_FEATURES_TABLE])}`]);
  });

  it("accepts an empty marker table", async () => {
    const pool = scriptedPool({ present: true, rows: [] });
    await assertPostgresAuthStorageIsRecognized(pool);
    assert.equal(pool.queries.length, 2);
    // 스키마를 한정하지 않는다. 다른 Parallax 테이블처럼 search_path 로 찾는다.
    assert.equal(pool.queries[1], `SELECT feature FROM ${AUTH_FEATURES_TABLE}`);
    // 어떤 질의도 스키마를 바꾸지 않는다.
    for (const query of pool.queries) assert.doesNotMatch(query, /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT)\b/iu);
  });

  it("refuses a feature a newer version recorded", async () => {
    await assert.rejects(
      assertPostgresAuthStorageIsRecognized(scriptedPool({ present: true, rows: [{ feature: "member-accounts" }] })),
      (error: unknown) => {
        assert.ok(error instanceof UnrecognizedAuthStorageError);
        assert.match(error.message, /^the database \(parallax_auth_features\) records authentication features this version does not recognize: "member-accounts"\./u);
        return true;
      },
    );
  });

  it("does not read a marker table in a schema it cannot use as no marker", async () => {
    await assert.rejects(
      readPostgresAuthFeatures(scriptedPool({ present: false, hidden: true })),
      (error: unknown) => {
        assert.ok(error instanceof AuthStorageCheckError);
        assert.match(error.message, /parallax_auth_features exists in a schema this role cannot use/u);
        return true;
      },
    );
  });

  it("calls a failed lookup a failed check, not an incompatible store", async () => {
    for (const present of [null, "t", 1, undefined]) {
      await assert.rejects(readPostgresAuthFeatures(scriptedPool({ present })), AuthStorageCheckError, String(present));
    }
    await assert.rejects(readPostgresAuthFeatures(scriptedPool({ present: false, hidden: null })), AuthStorageCheckError);
    await assert.rejects(
      readPostgresAuthFeatures(scriptedPool(new Error("connect ECONNREFUSED 10.0.0.11:5432\nsecond line"))),
      (error: unknown) => {
        assert.ok(error instanceof AuthStorageCheckError);
        assert.match(error.message, /^the authentication feature table could not be looked up: connect ECONNREFUSED 10\.0\.0\.11:5432 second line$/u);
        assertPrintable(error.message);
        return true;
      },
    );
    await assert.rejects(
      readPostgresAuthFeatures(scriptedPool({ present: true, readError: new Error("permission denied for table parallax_auth_features") })),
      (error: unknown) => {
        assert.ok(error instanceof AuthStorageCheckError);
        assert.match(error.message, /^parallax_auth_features could not be read: permission denied/u);
        return true;
      },
    );
  });

  it("refuses a row it cannot read as an incompatible store, without echoing it", async () => {
    const rows = [{ feature: null }, { feature: "" }, { feature: 3 }, {}, { feature: "Member" }, { feature: "a".repeat(65) },
      { feature: "member\naccounts" }, { feature: "1member" }, { feature: "m\u00e9mber" }];
    for (const row of rows) {
      await assert.rejects(
        readPostgresAuthFeatures(scriptedPool({ present: true, rows: [row] })),
        (error: unknown) => {
          assert.ok(error instanceof UnrecognizedAuthStorageError, JSON.stringify(row));
          assert.equal(error.message, "parallax_auth_features holds a row this version cannot read");
          return true;
        },
      );
    }
    assert.deepEqual(await readPostgresAuthFeatures(scriptedPool({ present: true, rows: [{ feature: `m${"a".repeat(63)}` }] })), [`m${"a".repeat(63)}`]);
  });
});

describe("configuration file authentication feature markers", () => {
  async function withFile(document: unknown, check: (path: string, store: FileConfigurationStore) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "parallax-auth-features-"));
    try {
      const path = join(directory, "config.json");
      await writeFile(path, `${JSON.stringify(document)}\n`, { mode: 0o600 });
      await check(path, new FileConfigurationStore(path));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("reads a file with no marker as before, and does not add one", async () => {
    await withFile({ version: 1, settings: { auditRetentionDays: 30 }, accessTokens: [] }, async (path, store) => {
      assert.deepEqual(await store.settings.read(), { auditRetentionDays: 30 });
      await store.settings.write({ auditRetentionDays: 7 });
      assert.equal("authFeatures" in JSON.parse(await readFile(path, "utf8")), false);
    });
  });

  it("keeps an empty marker list through every kind of write", async () => {
    await withFile({ version: 1, settings: {}, accessTokens: [], authFeatures: [] }, async (path, store) => {
      const stored = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      const token = { id: "token-1", subject: "ci", role: "admin", digest: "A".repeat(43), createdAt: "2026-10-01T00:00:00.000Z" } as const;
      const writes: [string, () => Promise<unknown>][] = [
        ["settings.write", () => store.settings.write({ auditRetentionDays: 7 })],
        ["settings.update", () => store.settings.update(async () => ({ patch: { revisionRetention: 5 }, result: undefined }))],
        ["credentials.write", () => store.credentials.write("sealed-document")],
        ["credentials.update", () => store.credentials.update(() => ({ document: "sealed-document-2", result: undefined }))],
        ["accessTokens.create", () => store.accessTokens.create(token)],
        ["accessTokens.touch", () => store.accessTokens.touch([{ id: "token-1", at: "2026-10-02T00:00:00.000Z" }])],
        ["accessTokens.revoke", () => store.accessTokens.revoke("token-1", 1)],
      ];
      for (const [name, write] of writes) {
        await write();
        assert.deepEqual((await stored()).authFeatures, [], name);
      }
      const final = await stored();
      assert.deepEqual(final.settings, { auditRetentionDays: 7, revisionRetention: 5 });
      assert.equal(final.credentials, "sealed-document-2");
    });
  });

  it("refuses a feature a newer version recorded, on read and on write, and leaves the file alone", async () => {
    const document = { version: 1, settings: {}, accessTokens: [], authFeatures: ["member-accounts"] };
    await withFile(document, async (path, store) => {
      const before = await readFile(path, "utf8");
      await assert.rejects(store.settings.read(), /the configuration file records authentication features this version does not recognize: "member-accounts"/u);
      await assert.rejects(store.settings.write({ auditRetentionDays: 7 }), /"member-accounts"/u);
      await assert.rejects(store.accessTokens.list(), /"member-accounts"/u);
      await assert.rejects(store.accessTokens.touch([{ id: "token-1", at: "2026-10-02T00:00:00.000Z" }]), /"member-accounts"/u);
      await assert.rejects(store.credentials.read(), /"member-accounts"/u);
      assert.equal(await readFile(path, "utf8"), before);
    });
  });

  it("refuses a marker list it cannot read, without echoing it", async () => {
    const lists = ["member-accounts", [""], [1], null, {}, ["Member"], ["a".repeat(65)], ["member\naccounts"], ["m\u00e9mber"], ["ok", 2]];
    for (const authFeatures of lists) {
      await withFile({ version: 1, settings: {}, accessTokens: [], authFeatures }, async (_path, store) => {
        await assert.rejects(store.settings.read(), (error: unknown) => {
          assert.ok(error instanceof Error, JSON.stringify(authFeatures));
          assert.equal(error.message, "unsupported configuration file: authFeatures must be a list of names");
          return true;
        });
      });
    }
  });

  it("refuses a field it does not know instead of dropping it on the next write", async () => {
    await withFile({ version: 1, settings: {}, accessTokens: [], members: [{ email: "someone@example.com" }] }, async (path, store) => {
      const before = await readFile(path, "utf8");
      await assert.rejects(store.settings.read(), /unsupported configuration file: unknown field "members"$/u);
      await assert.rejects(store.settings.write({ auditRetentionDays: 7 }), /unknown field "members"/u);
      assert.equal(await readFile(path, "utf8"), before);
    });
  });

  it("quotes and bounds unknown field names, so a value pasted as a key is not echoed whole", async () => {
    const pasted = `secret\n${"s".repeat(4000)}`;
    const fields: Record<string, unknown> = { version: 1, settings: {}, accessTokens: [], [pasted]: true };
    for (let index = 0; index < 9; index += 1) fields[`extra${index}`] = true;
    await withFile(fields, async (_path, store) => {
      await assert.rejects(store.settings.read(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assertPrintable(error.message);
        assert.ok(error.message.length < 600, String(error.message.length));
        assert.doesNotMatch(error.message, /s{65}/u);
        assert.match(error.message, /and 5 more$/u);
        return true;
      });
    });
  });

  it("still refuses any version but 1 and 2", async () => {
    for (const version of [3, 0, "1", "2", null]) {
      await withFile({ version, settings: {}, accessTokens: [] }, async (_path, store) => {
        await assert.rejects(store.settings.read(), /^Error: unsupported configuration file$/u, String(version));
      });
    }
    await withFile({ settings: {}, accessTokens: [] }, async (_path, store) => {
      await assert.rejects(store.settings.read(), /unsupported configuration file/u);
    });
  });
});
