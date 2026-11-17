import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { configureDatabasePoolBudget } from "../.upstream/apps/hosted/cloud/scripts/database-pool-budget.ts";
import {
  databaseBackendBudget,
  databaseBackendBudgetFor,
  databaseConnectionPlan as plan,
  databasePoolParametersFor,
  previewDatabaseBackendBudget,
} from "../.upstream/apps/hosted/cloud/src/infrastructure/database-pool-policy.ts";
import { previewPoolConnections } from "../.upstream/apps/hosted/cloud/src/infrastructure/preview-database.ts";
import { primaryHeadroom, releaseDatabasePolicy } from "./release-phases/headroom.ts";
import { databaseBackendBudget as verifiedBudget } from "./database-budget-verification.ts";

const ordinarySlots = (maxConnections: number) =>
  maxConnections - plan.superuserReservedConnections;
const steadyPeak = (budget: number) => plan.logicalDatabases * budget + plan.unpooledConnections;

test("production max_connections 50 gives 16 backends per database with four slots of release margin", () => {
  assert.equal(plan.production.maxConnections, 50);
  assert.equal(databaseBackendBudget, 16);
  // 2 × 16 pooled + 4 unpooled + 7 release clients = 43 of 47 ordinary slots.
  assert.equal(steadyPeak(16) + plan.releaseConnections, 43);
  assert.equal(ordinarySlots(50), 47);
  assert.equal(ordinarySlots(50) - (steadyPeak(16) + plan.releaseConnections), 4);
});

test("preview branches keep PlanetScale's default 25 connections and five backends", () => {
  assert.equal(plan.preview.maxConnections, 25);
  assert.equal(previewDatabaseBackendBudget, 5);
  assert.equal(previewPoolConnections, 5);
  assert.ok(steadyPeak(5) + plan.releaseConnections <= ordinarySlots(25));
});

test("every plan leaves a fully loaded pool admissible to a release", () => {
  for (const target of [plan.production, plan.preview]) {
    const budget = databaseBackendBudgetFor(target);
    assert.ok(
      steadyPeak(budget) + plan.releaseConnections + target.margin <=
        ordinarySlots(target.maxConnections),
      `max_connections ${target.maxConnections}`,
    );
  }
  assert.equal(databaseBackendBudgetFor({ maxConnections: 25, margin: 0 }), 5);
  assert.equal(databaseBackendBudgetFor({ maxConnections: 50, margin: 4 }), 16);
  assert.throws(
    () => databaseBackendBudgetFor({ maxConnections: 15, margin: 0 }),
    /max_connections 15/,
  );
});

test("release preflight, the budget and its verifier read the same declaration", () => {
  assert.equal(releaseDatabasePolicy.maxConnections, plan.production.maxConnections);
  assert.equal(
    releaseDatabasePolicy.superuserReservedConnections,
    plan.superuserReservedConnections,
  );
  assert.equal(releaseDatabasePolicy.connections, plan.releaseLogins);
  assert.equal(plan.releaseConnections, 7);
  assert.equal(verifiedBudget, databaseBackendBudget);
  assert.deepEqual(databasePoolParametersFor(databaseBackendBudget), {
    default_pool_size: "16",
    max_db_connections: "16",
    min_pool_size: "0",
    reserve_pool_size: "0",
    server_lifetime: "60",
    server_idle_timeout: "15",
  });
});

const metrics = (used: number, maxConnections: number) => ({
  branch: { name: "main" },
  metrics: [
    {
      metric: "planetscale_postgres_connection_state",
      values: [{ pod: "primary", role: "primary", value: used }],
    },
    {
      metric: "planetscale_postgres_settings_max_connections",
      values: [{ pod: "primary", role: "primary", value: maxConnections }],
    },
  ],
});

test("release preflight admits the steady peak and refuses a drifted max_connections by name", () => {
  assert.deepEqual(primaryHeadroom(metrics(steadyPeak(databaseBackendBudget), 50), "main"), {
    observed: 36,
    ordinarySlots: 47,
    envelope: plan.releaseConnections,
  });
  assert.throws(() => primaryHeadroom(metrics(13, 25), "main"), /observed max 25, expected max 50/);
});

/** `undefined` leaves the max_connections row out of the provider catalog. */
function budgetRun(branch: string, maxConnections: string | null | undefined) {
  const requests: { method: string; body?: unknown }[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ method: request.method, body });
      const written = requests.find((entry) => entry.method === "PATCH")?.body as
        | { parameters: { pgbouncer: Record<string, string> } }
        | undefined;
      const pool = written?.parameters.pgbouncer ?? databasePoolParametersFor(5);
      const data = path.endsWith("parameters")
        ? [
            ...Object.entries(pool).map(([name, value]) => ({
              namespace: "pgbouncer",
              name,
              value,
            })),
            { namespace: "pgbouncer", name: "pool_mode", value: "transaction" },
            ...(maxConnections === undefined
              ? []
              : [{ namespace: "pgconf", name: "max_connections", value: maxConnections }]),
          ]
        : request.method === "PATCH"
          ? { id: "change", state: "completed" }
          : { data: [{ id: "change", state: "completed" }] };
      return HttpClientResponse.fromWeb(request, Response.json(data));
    }),
  );
  const result = Effect.runPromise(
    configureDatabasePoolBudget.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          PLANETSCALE_ORGANIZATION: "fixture",
          POOL_BUDGET_DATABASE: "fixture",
          POOL_BUDGET_BRANCH: branch,
          PLANETSCALE_API_TOKEN_ID: "fixture",
          PLANETSCALE_API_TOKEN: "fixture",
        }),
      ),
    ),
  );
  return { requests, result };
}

test("the release budget step writes the budget derived for each branch's limit", async () => {
  const main = budgetRun("main", "50");
  await main.result;
  assert.deepEqual(main.requests.find((request) => request.method === "PATCH")?.body, {
    parameters: { pgbouncer: databasePoolParametersFor(16) },
  });
  for (const reported of ["25", null]) {
    const preview = budgetRun("test-pr-1", reported);
    await preview.result;
    assert.deepEqual(
      preview.requests.map((request) => request.method),
      ["GET"],
      `a preview reporting ${reported} is already at five backends`,
    );
  }
  const raisedPreview = budgetRun("test-pr-1", "50");
  await raisedPreview.result;
  assert.deepEqual(raisedPreview.requests.find((request) => request.method === "PATCH")?.body, {
    parameters: { pgbouncer: databasePoolParametersFor(18) },
  });
});

test("production whose max_connections drifted from the plan refuses before any write, naming both values", async () => {
  for (const observed of ["25", "100", null, undefined]) {
    const run = budgetRun("main", observed);
    await assert.rejects(run.result, (error: { message?: string }) => {
      assert.match(
        String(error.message),
        new RegExp(`max_connections is ${observed ?? "unset"} on main; the plan declares 50`),
      );
      return true;
    });
    assert.deepEqual(
      run.requests.map((request) => request.method),
      ["GET"],
    );
  }
});

test("a preview limit that is not a count, or too small for any budget, refuses before any write", async () => {
  for (const [reported, reason] of [
    ["unlimited", /max_connections is unlimited on test-pr-1, which is not a connection count/],
    ["15", /No PgBouncer backend budget fits max_connections 15: .* on test-pr-1/],
  ] as const) {
    const run = budgetRun("test-pr-1", reported);
    await assert.rejects(run.result, (error: { _tag?: string; message?: string }) => {
      assert.equal(error._tag, "PoolBudgetFailed");
      assert.match(String(error.message), reason);
      return true;
    });
    assert.deepEqual(
      run.requests.map((request) => request.method),
      ["GET"],
    );
  }
});
