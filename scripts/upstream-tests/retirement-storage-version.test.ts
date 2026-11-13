import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { fumadb } from "fumadb-effect";
import { sqlAdapter } from "fumadb-effect/sql";
import { historicalLayout, preludeSchemas } from "./storage-prelude-fixture.ts";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  makeExecutorStorage,
  currentStorageVersion,
} from "../../.upstream/packages/sdk/src/core.ts";
import { retirementReader } from "../../.upstream/apps/hosted/cloud/scripts/pool-token-retirement-reader.ts";

const require = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const {
  PgliteClient,
}: typeof import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-pglite/dist/PgliteClient.js") =
  await import(require.resolve("@effect/sql-pglite/PgliteClient"));

for (const baseline of ["fresh", "4.0.29"])
  test(`retirement accepts the migrated host schema from ${baseline} and refuses other storage versions`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (baseline === "4.0.29") {
            yield* historicalLayout("4.0.28");
            const migrator = yield* fumadb({
              namespace: "executor",
              schemas: preludeSchemas,
            }).client(sqlAdapter({ provider: "postgresql" })).createMigrator;
            yield* (yield* migrator.up()).execute;
          }
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
          assert.equal(currentStorageVersion, "4.0.30");
          assert.equal(current.version, currentStorageVersion);
          assert.ok(Number.isFinite(Date.parse(current.snapshot)));
          for (const version of ["4.0.25", "4.0.28", "4.0.29", "4.0.99"]) {
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
