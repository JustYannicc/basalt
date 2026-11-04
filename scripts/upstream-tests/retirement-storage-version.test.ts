import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/core.ts";
import { retirementReader } from "../../.upstream/apps/hosted/cloud/scripts/pool-token-retirement-reader.ts";

const require = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const { PgliteClient } = await import(require.resolve("@effect/sql-pglite/PgliteClient"));

test("retirement accepts the migrated host schema and refuses other storage versions", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        const pg = (yield* PgliteClient).pglite;
        const reader = yield* retirementReader(
          pg as unknown as Parameters<typeof retirementReader>[0],
          "fixture-organization",
          {
            target: "fixture-retirement",
            database: Redacted.make("postgresql://fixture.invalid/retirement"),
            encryptionKey: Redacted.make("ab".repeat(32)),
            poolSigningKeys: [Redacted.make("cd".repeat(32))],
          },
        );
        const current = yield* reader.identity;
        assert.equal(current.version, "4.0.28");
        assert.ok(Number.isFinite(Date.parse(current.snapshot)));
        for (const version of ["4.0.25", "4.0.99"]) {
          yield* sql`update private_executor_settings set value = ${version} where key = 'version'`;
          const refused = yield* Effect.exit(reader.identity);
          assert.equal(refused._tag, "Failure");
          const [row] =
            yield* sql`select value from private_executor_settings where key = 'version'`;
          assert.equal(row?.value, version);
        }
      }),
    ).pipe(Effect.provide(pgliteLayer())),
  );
});
