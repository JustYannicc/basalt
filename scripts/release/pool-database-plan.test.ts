import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import * as Command from "alchemy/Command";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Output from "alchemy/Output";
import * as Planetscale from "alchemy/Planetscale";
import type * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Stack, evalStack } from "alchemy/Stack";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { State } from "alchemy/State/State";
import { ConfigProvider, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { poolDatabaseInfrastructure } from "../../src/pool/database.ts";
import type { ResourceState } from "alchemy/State/ResourceState";
import { makePlan, productionRows, type Declaration } from "./test/plan-fixture.ts";
import { plannedReasons } from "./plan-summary.ts";

// The real planner and Alchemy's own command provider over the pool database command as the stack
// declares it. Commands are applied without running a process (the fixture records them).

const databaseCommands = ["RuntimeDatabaseBudget", "Migrations", "PoolDatabase"];

/** Production's rows, the pool Worker recording its readiness, and no pool database command yet. */
const startingRows = () => {
  const rows = productionRows();
  (rows.PoolWorker as unknown as { bindings: { sid: string; data: unknown }[] }).bindings.push({
    sid: "POOL_DATABASE_READY",
    data: { bindings: [{ type: "plain_text", name: "POOL_DATABASE_READY", text: "ready" }] },
  });
  delete rows.PoolDatabase;
  return rows;
};

/** Applies the database commands as a release would, then returns State and the next plan. */
async function applied(context: TestContext, poolDatabase: Declaration["poolDatabase"] = {}) {
  const runs: string[] = [];
  const result = await makePlan(context, {
    rows: startingRows(),
    declared: { poolDatabase },
    settle: databaseCommands,
    commandRuns: runs,
  });
  // The pool size command runs first; the migration and the pool database command both wait on
  // it and on nothing of each other's, so their order is the scheduler's.
  assert.equal(runs[0], "node scripts/database-pool-budget.ts");
  assert.deepEqual(
    new Set(runs.slice(1)),
    new Set(["node src/migrate.ts", "node ensure-pool-database.ts"]),
  );
  assert.equal(runs.length, 3);
  // Every row the apply recorded is set; the plan fixture reads State as rows.
  return { plan: result.plan, rows: result.rows as Record<string, ResourceState> };
}

const node = (plan: Plan.Plan, fqn: string) => {
  const found = plan.resources[fqn] as unknown as
    | { action: string; downstream: string[]; props: { env?: Record<string, unknown> } }
    | undefined;
  assert.ok(found, `${fqn} is in the plan`);
  return found;
};

const readiness = (plan: Plan.Plan) => node(plan, "PoolWorker").props.env?.POOL_DATABASE_READY;

const readinessCause = (plan: Plan.Plan) =>
  plannedReasons(plan, "PoolWorker").filter((reason) => reason.includes("POOL_DATABASE_READY"));

test("a release that changes only the hosted sources leaves the pool database command and its readiness unchanged", async (context) => {
  const first = await applied(context);
  // The same commit again: every database command is noop and the pool Worker reads a known value.
  for (const fqn of databaseCommands) assert.equal(node(first.plan, fqn).action, "noop", fqn);
  assert.equal(readiness(first.plan), "ready");
  assert.deepEqual(readinessCause(first.plan), []);

  // A release whose hosted sources changed: the tools migration re-runs, the pool's inputs did not.
  const release = await makePlan(context, {
    rows: first.rows,
    declared: { poolDatabase: { toolsSource: "b" } },
    commandRuns: [],
  });
  assert.equal(node(release.plan, "Migrations").action, "update");
  assert.equal(node(release.plan, "RuntimeDatabaseBudget").action, "noop");
  assert.equal(node(release.plan, "PoolDatabase").action, "noop");
  assert.equal(
    readiness(release.plan),
    "ready",
    "the pool Worker's readiness is known at plan time",
  );
  assert.deepEqual(readinessCause(release.plan), []);
});

test("a changed pool size input or pool migration re-runs the pool database command before the pool Worker", async (context) => {
  const first = await applied(context);
  const waitsOnPoolDatabase = (plan: Plan.Plan, cause: string) => {
    assert.equal(node(plan, "PoolDatabase").action, "update", cause);
    assert.ok(Output.isExpr(readiness(plan)), `${cause}: the pool Worker waits on the outcome`);
    assert.ok(node(plan, "PoolDatabase").downstream.includes("PoolWorker"), cause);
  };

  // The pool size command reads another database: it re-runs, and the pool database command after it.
  const budget = await makePlan(context, {
    rows: first.rows,
    declared: { poolDatabase: { budgetDatabase: "another-database" } },
    commandRuns: [],
  });
  assert.equal(node(budget.plan, "RuntimeDatabaseBudget").action, "update");
  assert.ok(node(budget.plan, "RuntimeDatabaseBudget").downstream.includes("PoolDatabase"));
  waitsOnPoolDatabase(budget.plan, "a changed pool size input");

  // State recorded the key of other migration sources than this checkout's.
  // (Copies keep each value as State holds it: a structured clone would lose the redacted ones.)
  const recorded = first.rows.PoolDatabase as unknown as { attr: { hash: object } };
  const rows = {
    ...first.rows,
    PoolDatabase: {
      ...recorded,
      attr: { ...recorded.attr, hash: { ...recorded.attr.hash, input: "0".repeat(64) } },
    } as unknown as ResourceState,
  };
  const migration = await makePlan(context, {
    rows,
    declared: { poolDatabase: {} },
    commandRuns: [],
  });
  waitsOnPoolDatabase(migration.plan, "a changed pool migration");

  // A stage that never ran them: the commands are created, the pool Worker after them.
  const fresh = await makePlan(context, {
    rows: startingRows(),
    declared: { poolDatabase: {} },
    commandRuns: [],
  });
  assert.equal(node(fresh.plan, "PoolDatabase").action, "create");
  assert.ok(node(fresh.plan, "RuntimeDatabaseBudget").downstream.includes("PoolDatabase"));
  assert.ok(node(fresh.plan, "PoolDatabase").downstream.includes("PoolWorker"));
});

test("a release that uploads the pool Worker with unchanged database inputs still waits for adoption before acceptance", async (context) => {
  const first = await applied(context);
  // Both commands have run in an earlier release, as in production.
  const rows = { ...first.rows };
  for (const fqn of ["PoolBackendBudgetRuntimeReady", "PoolBackendBudget"])
    rows[fqn] = { ...productionRows().PoolDatabase!, fqn, logicalId: fqn } as ResourceState;
  // The pool Worker updates for its own code; nothing the pool database command reads changed.
  const { plan } = await makePlan(context, {
    rows,
    declared: { poolDatabase: {} },
    commandRuns: [],
  });
  assert.equal(node(plan, "PoolDatabase").action, "noop");
  assert.equal(node(plan, "PoolWorker").action, "update");
  const ready = node(plan, "PoolBackendBudgetRuntimeReady");
  const acceptance = node(plan, "PoolBackendBudget");
  // Memo off: both run on every release, whatever the database commands do.
  assert.equal(ready.action, "update");
  assert.equal(acceptance.action, "update");
  // Readiness waits for the upload, acceptance for readiness and the upload.
  assert.ok(node(plan, "PoolWorker").downstream.includes("PoolBackendBudgetRuntimeReady"));
  assert.ok(node(plan, "PoolWorker").downstream.includes("PoolBackendBudget"));
  assert.ok(ready.downstream.includes("PoolBackendBudget"));
  assert.ok(Output.isExpr(ready.props.env?.DATABASE_BUDGET_DEPLOYMENT));
  assert.ok(Output.isExpr(acceptance.props.env?.DATABASE_BUDGET_READY_RECEIPT));
});

/**
 * Evaluates the stack's own production pool database declaration, as the release entry does
 * before it plans, and returns the resources it declares and what the pool Worker's readiness reads.
 * Evaluation reads no provider: the PlanetScale credentials name an address nothing listens on.
 */
async function productionDeclaration() {
  let readiness: unknown;
  const planetscale = Layer.effect(
    Planetscale.Providers,
    Provider.collection([Planetscale.PostgresDatabase, Planetscale.PostgresRole]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(Planetscale.PostgresDatabaseProvider(), Planetscale.PostgresRoleProvider()),
    ),
    Layer.provideMerge(
      Planetscale.fromToken({
        tokenId: "synthetic",
        token: "synthetic",
        organization: "synthetic",
        apiBaseUrl: "http://planetscale.invalid",
      }),
    ),
    Layer.provideMerge(FetchHttpClient.layer),
  );
  const memory = await Effect.runPromise(InMemoryService());
  const resources = await Effect.runPromise(
    evalStack(
      Stack(
        "basalt",
        {
          providers: Layer.mergeAll(planetscale, Command.providers()) as never,
          state: Layer.succeed(State, Effect.succeed(memory)),
        },
        Effect.gen(function* () {
          readiness = (yield* poolDatabaseInfrastructure).runtimeReady;
        }),
      ),
      (stack) => Effect.succeed(stack.resources as Record<string, { Props: object } | undefined>),
      { stage: "production" },
    ).pipe(
      provideFreshArtifactStore,
      Effect.provide(layerNonInteractive()),
      Effect.provide(AlchemyContextLive.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.provideService(State, Effect.succeed(memory)),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            PLANETSCALE_DATABASE_NAME: "synthetic-database",
            PLANETSCALE_CLUSTER_SIZE: "PS_10",
            PLANETSCALE_REGION: "eu-west",
            // The tools migration's declaration reads these, so a pool declaration that pulls it
            // in still evaluates, and the check below names the edge instead of a missing setting.
            BETTER_AUTH_URL: "https://cloud.example.invalid",
            BETTER_AUTH_SECRET: "synthetic-auth-secret-0000000000000000000000000000",
          }),
        ),
      ),
    ),
  );
  const upstream = (value: unknown) => Object.keys(Output.upstreamAny(value)).sort();
  return {
    pool: upstream(resources.PoolDatabase?.Props),
    readiness: upstream(readiness),
  };
}

test("production's pool database command waits on the pool size command and its own roles only", async () => {
  const declared = await productionDeclaration();
  assert.deepEqual(declared.pool, ["MigrationRole", "PoolDatabaseRole", "RuntimeDatabaseBudget"]);
  assert.deepEqual(declared.readiness, ["PoolDatabase", "RuntimeDatabaseBudget"]);
});
