import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { configureDatabasePoolBudget } from "../../.upstream/apps/hosted/cloud/scripts/database-pool-budget.ts";
import { databasePoolParameters } from "../../.upstream/apps/hosted/cloud/src/infrastructure/database-pool-policy.ts";

function run(
  options: { existing?: boolean; readback?: boolean; status?: number; mode?: string } = {},
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
      const data = path.endsWith("parameters")
        ? (++reads === 1 && !options.existing) || (reads > 1 && options.readback === false)
          ? parameters.filter((row) => row.name !== "max_db_connections")
          : parameters
        : request.method === "PATCH"
          ? { id: "change", state: "completed" }
          : { data: [{ id: "change", state: "completed" }] };
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
