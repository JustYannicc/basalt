import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { fumadb } from "../../.upstream/packages/fumadb-effect/src/index.ts";
import {
  column,
  idColumn,
  schema,
  table,
} from "../../.upstream/packages/fumadb-effect/src/schema.ts";
import { sqlAdapter } from "../../.upstream/packages/fumadb-effect/src/sql.ts";

const require = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const port = Number(process.env.BASALT_MYSQL_TEST_PORT);

test(
  "MySQL string sets preserve column collations and oversized unmatched values",
  { skip: !port && "BASALT_MYSQL_TEST_PORT needs an isolated MySQL database named string_sets" },
  async () => {
    const Mysql: typeof import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-mysql2/dist/MysqlClient.js") =
      await import(require.resolve("@effect/sql-mysql2/MysqlClient"));
    const name = `string_set_${randomUUID().replaceAll("-", "")}`;
    const shape = schema({
      version: "1.0.0",
      tables: {
        rows: table(name, {
          id: idColumn("id", Schema.String),
          value: column("value", Schema.NullOr(Schema.String)),
        }),
      },
    });
    const orm = fumadb({ namespace: name, schemas: [shape] })
      .client(sqlAdapter({ provider: "mysql" }))
      .orm("1.0.0");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [settings] = yield* sql<{
            database: string;
            connection: string;
          }>`select @@collation_database as \`database\`, @@collation_connection as connection`;
          assert.equal(settings?.database, "utf8mb4_0900_ai_ci");
          assert.equal(settings?.connection, "utf8mb4_unicode_ci");
          yield* sql`create table ${sql(name)} (id varchar(255) primary key, value text)`;
          yield* Effect.addFinalizer(() => sql`drop table ${sql(name)}`.pipe(Effect.orDie));
          const values = [
            "",
            "NULL",
            "a,b",
            "a\\b",
            'a"b',
            "a\nb",
            "x'); SELECT 1; --",
            "☃🚀",
            "{x}",
            "}x",
            "  ",
            "trailing ",
          ];
          for (const [id, value] of values.entries())
            yield* sql`insert into ${sql(name)} values (${String(id)}, ${value})`;
          yield* sql`insert into ${sql(name)} values ('null-row', null)`;
          const ids = values.map((_, id) => String(id)).sort();
          for (const collation of ["utf8mb4_0900_ai_ci", "utf8mb4_unicode_ci", "utf8mb4_bin"]) {
            yield* sql.unsafe(`alter table ${name} modify value text collate ${collation}`);
            for (const operator of ["in", "not in"] as const) {
              for (const input of [["NULL"], ["NULL", "NULL"], ["q".repeat(70_000)]]) {
                const rows = yield* orm.findMany("rows", {
                  where: (b) => b("value", operator, input),
                });
                const matches = input[0] === "NULL";
                const expected =
                  operator === "in"
                    ? matches
                      ? ["1"]
                      : []
                    : ids.filter((id) => !matches || id !== "1");
                assert.deepEqual(
                  rows.map((row) => row.id).sort(),
                  expected,
                  JSON.stringify({ collation, operator, oversized: !matches }),
                );
              }
            }
          }
        }),
      ).pipe(
        Effect.provide(
          Mysql.layer({
            host: "127.0.0.1",
            port,
            username: "root",
            database: "string_sets",
          }),
        ),
      ),
    );
  },
);
