import assert from "node:assert/strict";
import { test } from "node:test";
import { authRateLimitConflicts } from "../../.upstream/apps/hosted/cloud/src/infrastructure/auth-rate-limit.ts";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { betterAuth } from "../../.upstream/apps/hosted/cloud/node_modules/better-auth/dist/index.mjs";
import { kyselyAdapter } from "../../.upstream/apps/hosted/cloud/node_modules/@better-auth/kysely-adapter/dist/index.mjs";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "../../.upstream/apps/hosted/cloud/node_modules/kysely/dist/index.js";

for (const max of [1, 2])
  test(`concurrent first auth requests preserve max=${max} without a database error`, async () => {
    const pg = new PGlite();
    const errors: string[] = [];
    const reads = Promise.withResolvers<void>();
    let missing = 0;
    const connection: DatabaseConnection = {
      async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
        try {
          const result = await pg.query<Record<string, unknown>>(query.sql, [...query.parameters]);
          if (
            /^select .* from "rateLimit"/s.test(query.sql) &&
            missing < 2 &&
            result.rows.length === 0
          ) {
            missing++;
            if (missing === 2) reads.resolve();
            await reads.promise;
          }
          return { rows: result.rows as R[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
        } catch (error) {
          errors.push(
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : "unknown",
          );
          throw error;
        }
      },
      async *streamQuery() {
        throw new Error("The auth fixture does not stream SQL");
      },
    };
    const database = new Kysely<{
      ordinary: { id: string };
      rateLimit: { id: string; key: string; count: number; lastRequest: number };
    }>({
      plugins: [authRateLimitConflicts()],
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
        createDriver: () => ({
          init: async () => {},
          acquireConnection: async () => connection,
          releaseConnection: async () => {},
          destroy: async () => {},
          beginTransaction: async () => {
            await pg.exec("begin");
          },
          commitTransaction: async () => {
            await pg.exec("commit");
          },
          rollbackTransaction: async () => {
            await pg.exec("rollback");
          },
        }),
      },
    });
    try {
      await pg.exec(`CREATE TABLE "rateLimit" (
        id text PRIMARY KEY, key text NOT NULL UNIQUE,
        count integer NOT NULL, "lastRequest" bigint NOT NULL
      )`);
      const auth = betterAuth({
        baseURL: "http://localhost:3000",
        secret: "fixture-only-auth-secret-never-used-outside-tests",
        database: kyselyAdapter(database, { type: "postgres", transaction: true }),
        rateLimit: { enabled: true, storage: "database", window: 60, max },
        advanced: { database: { validateSchema: false } },
        logger: { disabled: true },
      });
      await auth.$context;
      const request = () =>
        auth.handler(
          new Request("http://localhost:3000/api/auth/ok", {
            headers: { origin: "http://localhost:3000", "x-forwarded-for": "192.0.2.1" },
          }),
        );
      const responses = await Promise.all([request(), request()]);
      const statuses = responses.map((response) => response.status).sort();
      assert.equal(
        missing,
        2,
        "both first requests read the missing counter before either inserts",
      );
      assert.deepEqual(statuses, max === 1 ? [200, 429] : [200, 200]);
      const rows = await pg.query<{ id: string; count: number }>(
        'SELECT id, count FROM "rateLimit"',
      );
      assert.deepEqual(
        rows.rows.map(({ count }) => ({ count })),
        [{ count: max }],
        "the losing insert is counted by native atomic increment",
      );
      assert.equal(
        (await request()).status,
        429,
        "the race cannot admit a request beyond the limit",
      );
      assert.deepEqual(
        errors,
        [],
        "normal first-request contention must not issue a failing database statement",
      );
      await pg.exec("CREATE TABLE ordinary (id text PRIMARY KEY)");
      await database.insertInto("ordinary").values({ id: "duplicate" }).execute();
      await assert.rejects(
        database.insertInto("ordinary").values({ id: "duplicate" }).execute(),
        { code: "23505" },
        "unrelated tables retain their constraint errors",
      );
      await assert.rejects(
        database
          .insertInto("rateLimit")
          .values({ id: rows.rows[0]!.id, key: "different-key", count: 1, lastRequest: 1 })
          .returningAll()
          .execute(),
        { code: "23505" },
        "a different unique constraint on the rate-limit table still fails",
      );
      assert.deepEqual(errors, ["23505", "23505"]);
      console.log("auth first-request race", {
        max,
        statuses,
        persistedCount: rows.rows[0]!.count,
        expectedConstraintErrorCodes: errors,
      });
    } finally {
      await database.destroy();
      await pg.close();
    }
  });
