import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { configureDatabasePoolBudget } from "../../.upstream/apps/hosted/cloud/scripts/database-pool-budget.ts";
import { databasePoolParameters } from "../../.upstream/apps/hosted/cloud/src/infrastructure/database-pool-policy.ts";

function run(
  options: {
    existing?: boolean;
    readback?: boolean;
    status?: number;
    mode?: string;
    nullableCatalog?: "initial" | "readback" | "both";
    nullBudgetReadback?: boolean;
  } = {},
) {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let reads = 0;
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ method: request.method, path, body });
      const parameters = Object.entries(databasePoolParameters).map(([name, value]) => ({
        namespace: "pgbouncer",
        name,
        value,
      }));
      parameters.push({
        namespace: "pgbouncer",
        name: "pool_mode",
        value: options.mode ?? "transaction",
      });
      let data: unknown = path.endsWith("parameters")
        ? (++reads === 1 && !options.existing) || (reads > 1 && options.readback === false)
          ? parameters.filter((row) => row.name !== "max_db_connections")
          : parameters
        : request.method === "PATCH"
          ? { id: "change", state: "completed", started_at: null, previous_parameters: null }
          : { data: [{ id: "change", state: "completed", started_at: null }] };
      if (Array.isArray(data) && options.nullableCatalog) {
        const includeNulls =
          options.nullableCatalog === "both" ||
          (reads === 1
            ? options.nullableCatalog === "initial"
            : options.nullableCatalog === "readback");
        data = [
          ...data,
          ...Array.from({ length: 183 - data.length }, (_, index) => ({
            namespace: "pgconf",
            name: `unrelated_${index}`,
            value: "default",
          })),
          { namespace: "pgconf", name: "pginsights.enabled", value: includeNulls ? null : "off" },
          {
            namespace: "pgconf",
            name: "pginsights.bgworker_threads",
            value: includeNulls ? null : "0",
          },
        ];
      }
      if (Array.isArray(data) && reads > 1 && options.nullBudgetReadback) {
        data = data.map((row) =>
          row.name === "max_db_connections" ? { ...row, value: null } : row,
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json(data, { status: options.status ?? 200 }),
      );
    }),
  );
  return {
    requests,
    result: Effect.runPromise(
      configureDatabasePoolBudget.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            PLANETSCALE_ORGANIZATION: "fixture",
            POOL_BUDGET_DATABASE: "fixture",
            POOL_BUDGET_BRANCH: "main",
            PLANETSCALE_API_TOKEN_ID: "fixture",
            PLANETSCALE_API_TOKEN: "fixture",
          }),
        ),
      ),
    ),
  };
}

test("deploy applies the shared cap and bounded retirement, waits for completion, and checks readback", async () => {
  const proof = run();
  await proof.result;
  assert.deepEqual(
    proof.requests.map((request) => request.method),
    ["GET", "PATCH", "GET", "GET"],
  );
  assert.deepEqual(proof.requests[1]!.body, { parameters: { pgbouncer: databasePoolParameters } });
  const unchanged = run({ existing: true });
  await unchanged.result;
  assert.deepEqual(
    unchanged.requests.map((request) => request.method),
    ["GET"],
  );
});

test("invalid pool mode, failed API response and false readback stop deployment", async () => {
  for (const options of [{ mode: "session" }, { status: 403 }, { readback: false }])
    await assert.rejects(run(options).result);
});

for (const nullableCatalog of ["initial", "readback", "both"] as const) {
  test(`deploy accepts a 185-row catalog with unrelated null values on ${nullableCatalog} reads`, async () => {
    const proof = run({ nullableCatalog });
    await proof.result;
    assert.deepEqual(
      proof.requests.map((request) => request.method),
      ["GET", "PATCH", "GET", "GET"],
    );
    assert.deepEqual(proof.requests[1]!.body, {
      parameters: { pgbouncer: databasePoolParameters },
    });
  });
}

test("an already configured budget accepts unrelated null catalog values without a write", async () => {
  const unchanged = run({ existing: true, nullableCatalog: "both" });
  await unchanged.result;
  assert.deepEqual(
    unchanged.requests.map((request) => request.method),
    ["GET"],
  );
});

test("a null required budget value on readback still refuses deployment", async () => {
  await assert.rejects(run({ nullBudgetReadback: true }).result);
});
