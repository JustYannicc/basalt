import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Command from "alchemy/Command";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack, evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Effect, Layer } from "effect";
import { releaseEvidence } from "./evidence.ts";
import { reportRefusal } from "./refusal-report.ts";
import { assertSupportedPlan, verificationAdmissions } from "./plan-admission.ts";
import { changedProps } from "./prop-diff.ts";
import { BarrierRefusal } from "./manifest.ts";
import { withReleaseRuntime } from "./runtime.ts";

const id = "PoolBackendBudgetRuntimeReady";
const command = "node verify-database-budget.ts --ready";

function interruptedPlan(
  change:
    | "none"
    | "command"
    | "memo"
    | "shell"
    | "other"
    | "cwd"
    | "timeout"
    | "outside-env"
    | "recorded-command",
  lifecycle: "absent" | "creating" | "created" = "creating",
) {
  const env: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: "private-old-deployment-value",
    DATABASE_BUDGET_WORKER: "private-old-deployment-value",
    GITHUB_SHA: "private-old-deployment-value",
    POOL_DEPLOYMENT_KEY: "private-old-deployment-value",
    DATABASE_BUDGET_IMAGE_HASH: "private-old-deployment-value",
    DATABASE_BUDGET_WORKER_INPUT: "private-old-deployment-value",
    DATABASE_BUDGET_RECEIPT: "private-old-deployment-value",
    DATABASE_BUDGET_DEPLOYMENT: "deployed",
  };
  const props = {
    command: change === "recorded-command" ? "node mutate.ts" : command,
    memo: false,
    shell: false,
    cwd: "/synthetic/scripts",
    timeout: 185000,
    env,
  };
  const stack = Stack(
    "fixture",
    {
      providers: Command.ExecProvider().pipe(
        Layer.provide(
          Layer.succeed(Command.CommandExecutor, {
            spawn: () => Effect.die("Unexpected spawn"),
            run: () =>
              lifecycle === "created"
                ? Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
                : Effect.die("Synthetic interrupted first create"),
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
          if (lifecycle !== "absent") yield* Effect.exit(Apply.apply(yield* Plan.make(compiled)));
          for (const key of Object.keys(env))
            if (key !== "DATABASE_BUDGET_DEPLOYMENT") env[key] = "private-new-deployment-value";
          if (change === "command") props.command = "node mutate.ts";
          if (change === "memo") props.memo = true;
          if (change === "shell") props.shell = true;
          if (change === "cwd") props.cwd = "/different/scripts";
          if (change === "timeout") props.timeout++;
          if (change === "outside-env") env.NODE_OPTIONS = "--import=./unexpected.mjs";
          if (change === "recorded-command") props.command = command;
          const plan = yield* Plan.make(compiled);
          const node = plan.resources[change === "other" ? "PoolBackendBudget" : id];
          assert.equal(node.action, lifecycle === "created" ? "update" : "create");
          assert.equal(node.state?.status, lifecycle === "absent" ? undefined : lifecycle);
          if (lifecycle !== "created") assert.equal(node.state?.attr, undefined);
          if (change === "none" && lifecycle !== "absent") {
            assert.ok(node.state);
            assert.equal(changedProps(node.state.props, node.resource.Props).length, 7);
          }
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

for (const change of [
  "command",
  "memo",
  "shell",
  "other",
  "cwd",
  "timeout",
  "outside-env",
  "recorded-command",
] as const)
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
        error.delta?.why?.includes("recorded lifecycle is creating; planned action is create"),
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

test("a creating readiness command under a different FQN refuses", async () => {
  const plan = await interruptedPlan("none");
  const node = plan.resources[id]!;
  assert.ok(node.action === "create" && node.state?.status === "creating");
  const fqn = `Other/${id}`;
  const other = {
    ...node,
    resource: { ...node.resource, FQN: fqn },
    state: { ...node.state, fqn },
  };
  assert.throws(
    () => assertSupportedPlan({ ...plan, resources: { [fqn]: other } }),
    BarrierRefusal,
  );
});

for (const lifecycle of ["absent", "created"] as const)
  test(`exact readiness preserves its ${lifecycle} behavior with deployment env changes`, async () => {
    const plan = await interruptedPlan("none", lifecycle);
    assert.doesNotThrow(() => assertSupportedPlan(plan));
  });

for (const field of ["fqn", "resourceType"] as const)
  test(`a creating row with different recorded ${field} identity refuses`, async () => {
    const plan = await interruptedPlan("none");
    const node = plan.resources[id]!;
    assert.ok(node.action === "create" && node.state?.status === "creating");
    const state = { ...node.state, [field]: "OtherResource" };
    assert.throws(
      () => assertSupportedPlan({ ...plan, resources: { [id]: { ...node, state } } }),
      BarrierRefusal,
    );
  });

interface OtherResource extends Resource<"Fixture.Other", { revision: string }, { id: string }> {}
const OtherResource = Resource<OtherResource>("Fixture.Other");
for (const lifecycle of ["absent", "created"] as const)
  test(`other resources with ${lifecycle} state and changed props still refuse`, async () => {
    const props = { revision: "old" };
    const stack = Stack(
      "fixture",
      {
        providers: Provider.succeed(OtherResource, {
          diff: () => Effect.succeed({ action: "update" }),
          reconcile: () => Effect.succeed({ id: "other" }),
          delete: () => Effect.void,
        }),
        state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
      },
      OtherResource("OtherResource", props),
    );
    const plan = await Effect.runPromise(
      evalStack(
        stack,
        (compiled) =>
          Effect.gen(function* () {
            if (lifecycle === "created") yield* Apply.apply(yield* Plan.make(compiled));
            props.revision = "candidate";
            return yield* Plan.make(compiled);
          }),
        { stage: "production" },
      ).pipe(withReleaseRuntime),
    );
    assert.throws(() => assertSupportedPlan(plan), BarrierRefusal);
  });

test("admission and refusal artifacts expose lifecycle and env names without values", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "readiness-admission-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = releaseEvidence(directory, "a".repeat(40));
  for (const lifecycle of ["absent", "creating", "created"] as const) {
    const plan = await interruptedPlan("none", lifecycle);
    assertSupportedPlan(plan);
    const admissions = verificationAdmissions(plan);
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0]?.lifecycle, lifecycle);
    assert.equal(admissions[0]?.envChanges.length, lifecycle === "absent" ? 8 : 7);
    assert.ok(admissions[0]?.envChanges.includes("DATABASE_BUDGET_IMAGE_HASH"));
    await evidence.admission(admissions);
    const admitted = await readFile(join(directory, "admission.json"), "utf8");
    assert.deepEqual(JSON.parse(admitted).verifications, admissions);
    assert.ok(!admitted.includes("private-old-deployment-value"));
    assert.ok(!admitted.includes("private-new-deployment-value"));
  }
  const plan = await interruptedPlan("timeout");
  let refusal: BarrierRefusal | undefined;
  try {
    assertSupportedPlan(plan);
  } catch (error) {
    assert.ok(error instanceof BarrierRefusal);
    refusal = error;
  }
  assert.ok(refusal);
  const failure = await evidence.failure(refusal);
  const messages: string[] = [];
  const summaryPath = join(directory, "summary.md");
  await reportRefusal(failure, summaryPath, (value) => messages.push(value));
  for (const text of [
    await readFile(join(directory, "failure.json"), "utf8"),
    await readFile(summaryPath, "utf8"),
    ...messages,
  ]) {
    assert.ok(text.includes("creating"));
    assert.ok(text.includes("DATABASE_BUDGET_IMAGE_HASH"));
    assert.ok(text.includes("DATABASE_BUDGET_WORKER_INPUT"));
    assert.ok(!text.includes("private-old-deployment-value"));
    assert.ok(!text.includes("private-new-deployment-value"));
  }
});
