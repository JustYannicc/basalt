import assert from "node:assert/strict";
import { test } from "node:test";
import * as Command from "alchemy/Command";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import { Stack, evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Effect, Layer } from "effect";
import { assertSupportedPlan } from "./plan-admission.ts";
import { changedProps } from "./prop-diff.ts";
import { BarrierRefusal } from "./manifest.ts";
import { withReleaseRuntime } from "./runtime.ts";

const id = "PoolBackendBudgetRuntimeReady";
const command = "node verify-database-budget.ts --ready";

function interruptedPlan(change: "none" | "command" | "memo" | "shell" | "other") {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "old",
    DATABASE_BUDGET_WORKER: "old",
    GITHUB_SHA: "old",
    POOL_DEPLOYMENT_KEY: "old",
    DATABASE_BUDGET_IMAGE_HASH: "old",
    DATABASE_BUDGET_WORKER_INPUT: "old",
    DATABASE_BUDGET_RECEIPT: "old",
    DATABASE_BUDGET_DEPLOYMENT: "deployed",
  };
  const props = { command, memo: false, shell: false, env };
  const stack = Stack(
    "fixture",
    {
      providers: Command.ExecProvider().pipe(
        Layer.provide(
          Layer.succeed(Command.CommandExecutor, {
            spawn: () => Effect.die("Unexpected spawn"),
            run: () => Effect.die("Synthetic interrupted first create"),
          }),
        ),
      ),
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    Effect.gen(function* () {
      yield* Command.Exec(change === "other" ? "PoolBackendBudget" : id, props);
    }),
  );
  return Effect.runPromise(
    evalStack(
      stack,
      (compiled) =>
        Effect.gen(function* () {
          yield* Effect.exit(Apply.apply(yield* Plan.make(compiled)));
          for (const key of Object.keys(env))
            if (key !== "DATABASE_BUDGET_DEPLOYMENT") env[key as keyof typeof env] = "candidate";
          if (change === "command") props.command = "node mutate.ts";
          if (change === "memo") props.memo = true;
          if (change === "shell") props.shell = true;
          const plan = yield* Plan.make(compiled);
          const node = plan.resources[change === "other" ? "PoolBackendBudget" : id];
          assert.equal(node.action, "create");
          assert.equal(node.state?.status, "creating");
          assert.equal(node.state?.attr, undefined);
          if (change === "none")
            assert.equal(changedProps(node.state.props, node.resource.Props).length, 7);
          return plan;
        }),
      { stage: "production" },
    ).pipe(withReleaseRuntime),
  );
}

test("a never-completed native Command.Exec create admits only the exact readiness check", async () => {
  const plan = await interruptedPlan("none");
  assert.doesNotThrow(() => assertSupportedPlan(plan));
});

for (const change of ["command", "memo", "shell", "other"] as const)
  test(`a never-completed create refuses changed ${change}`, async () => {
    const plan = await interruptedPlan(change);
    assert.throws(
      () => assertSupportedPlan(plan),
      (error) => {
        assert.ok(error instanceof BarrierRefusal);
        assert.equal(error.reason, "new-or-unsettled-resource");
        return true;
      },
    );
  });

test("an unsettled refusal retains its lifecycle explanation alongside changed env paths", async () => {
  const plan = await interruptedPlan("other");
  assert.throws(
    () => assertSupportedPlan(plan),
    (error) => {
      assert.ok(error instanceof BarrierRefusal);
      assert.ok(error.delta?.changed.length);
      assert.ok(
        error.delta?.why?.includes("recorded lifecycle is creating; reconciliation is incomplete"),
      );
      return true;
    },
  );
});

test("the creating exception refuses prior attributes, renames and other resource types", async () => {
  const plan = await interruptedPlan("none");
  const node = plan.resources[id]!;
  assert.ok(node.action === "create" && node.state?.status === "creating");
  for (const invalid of [
    { ...node, state: { ...node.state, attr: { hash: {} } } },
    { ...node, renamedFrom: ["FormerReadiness"] },
    { ...node, resource: { ...node.resource, Type: "Cloudflare.Worker" } },
  ])
    assert.throws(
      () => assertSupportedPlan({ ...plan, resources: { [id]: invalid } }),
      BarrierRefusal,
    );
});
