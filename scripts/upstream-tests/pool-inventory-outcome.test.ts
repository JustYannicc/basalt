import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Console, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import type { SqlClient } from "effect/sql";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import { Stack } from "alchemy/Stack";
import { RuntimeContext, unpackEnvValue } from "alchemy/RuntimeContext";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { reportHostPoolInventory } from "../../.upstream/apps/hosted/cloud/src/infrastructure/pool-inventory.ts";
import { cloudBackgroundJobs } from "../../.upstream/apps/hosted/cloud/src/infrastructure/background-jobs.ts";

const { WorkerEnvironment } = await import(
  new URL("../../node_modules/alchemy/lib/Cloudflare/Workers/WorkerRuntime.js", import.meta.url)
    .href
);

const secret = "synthetic-dispatch-key";
const privateText = "synthetic-private-inventory-data";
const endpoint = "https://fixture.test/api/internal/jobs/pool-migration-inventory";

for (const mode of ["success", "sql", "schema", "bound"] as const) {
  test(`pool inventory ${mode} reports its outcome through the authenticated job route`, async (t) => {
    const queries: string[] = [];
    const messages: string[] = [];
    const failure = new SqlError({ reason: new ConnectionError({ cause: privateText }) });
    const statement = (strings: TemplateStringsArray) => {
      const query = strings.join("");
      queries.push(query);
      return Effect.succeed(
        query.includes("current_setting")
          ? [{ read_only: "on", snapshot: "2026-11-12T00:00:00Z" }]
          : [],
      );
    };
    // The SQL boundary is synthetic; the producer, validation, logging and HTTP route are real.
    const sql = Object.assign(statement, {
      withTransaction: <A, E, R>(work: Effect.Effect<A, E, R>) => work,
      unsafe: (query: string) => {
        queries.push(query);
        return mode === "sql"
          ? Effect.fail(failure)
          : Effect.succeed(
              mode === "schema"
                ? [{ private: { value: privateText } }]
                : mode === "bound"
                  ? [{ private: privateText.repeat(30) }]
                  : [],
            );
      },
    }) as unknown as SqlClient.SqlClient;
    const consoleService: Console.Console = Object.assign(Object.create(console), {
      info: (message: string) => {
        messages.push(message);
      },
    });
    const run = reportHostPoolInventory.pipe(
      Effect.provideService(GroupDatabase, Effect.succeed(sql)),
      Effect.provideService(Console.Console, consoleService),
    );
    const expected =
      mode === "success"
        ? { outcome: "completed" }
        : {
            outcome: "failed",
            failure:
              mode === "sql"
                ? "SqlError"
                : mode === "schema"
                  ? "SchemaError"
                  : "UnrecognizedFailure",
          };
    assert.deepEqual(await Effect.runPromise(run), expected);

    const jobs = await Effect.runPromise(
      cloudBackgroundJobs.pipe(
        Effect.provideService(WorkerEnvironment, {}),
        Effect.provideService(Stack, {
          name: "fixture",
          stage: "fixture",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(RuntimeContext, {
          Type: "fixture",
          id: "fixture",
          env: {},
          get: <A>() =>
            Effect.succeed(unpackEnvValue<A>(JSON.stringify({ _tag: "Redacted", value: secret }))),
          set: (key) => Effect.succeed(key),
        }),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      jobs
        .route(() => run)
        .pipe(
          Layer.provide(
            Layer.succeed(RuntimeContext, {
              Type: "fixture",
              id: "fixture",
              env: {},
              get: <A>() =>
                Effect.succeed(
                  unpackEnvValue<A>(JSON.stringify({ _tag: "Redacted", value: secret })),
                ),
              set: (key) => Effect.succeed(key),
            }),
          ),
        ),
      { disableLogger: true },
    );
    t.after(dispose);
    const before = queries.length;
    assert.equal((await handler(new Request(endpoint, { method: "POST" }))).status, 404);
    assert.equal(queries.length, before);
    const response = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("executor-job-outcome"), expected.outcome);
    assert.equal(
      response.headers.get("executor-job-failure"),
      "failure" in expected ? expected.failure : null,
    );
    assert.equal(await response.text(), "");
    assert.equal(
      messages.some((line) => line.includes(privateText)),
      false,
    );
    const ends = messages.map((line) => JSON.parse(line)).filter((entry) => entry.event === "end");
    assert.equal(ends.length, 2);
    assert.ok(ends.every((entry) => entry.complete === (mode === "success")));
    assert.ok(queries.includes("set transaction isolation level repeatable read read only"));
    if (mode !== "success") {
      assert.equal(
        messages.some((line) => JSON.parse(line).event === "part"),
        false,
      );
    }
  });
}
