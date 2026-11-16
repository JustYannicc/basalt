import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Stack, evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Context, Effect, Layer } from "effect";
import { finishPlan } from "./alchemy-finalize.ts";
import type { PreparedPlan } from "./alchemy-plan.ts";
import { withReleaseRuntime } from "./runtime.ts";

for (const overBudget of [false, true])
  test(`phased finalization defers the readiness producer and budget consumer together, then verifies their actual output and receipt dependency (overBudget=${overBudget})`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "phased-budget-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const receipt = join(directory, "ready.json");
    const events: string[] = [];
    const memory = await Effect.runPromise(InMemoryService());
    const stack = Stack(
      "synthetic",
      {
        state: Layer.succeed(State, Effect.succeed(memory)),
        providers: Provider.succeed(Command.Exec, {
          diff: () => Effect.succeed({ action: "update" }),
          reconcile: ({ fqn, news }) =>
            Effect.tryPromise(async () => {
              events.push(fqn);
              if (fqn === "PoolBackendBudgetRuntimeReady")
                await writeFile(receipt, JSON.stringify({ ready: "exact-current-runtime" }));
              if (fqn === "PoolBackendBudget") {
                assert.equal(news.env?.DATABASE_BUDGET_READY_RECEIPT, receipt);
                assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), {
                  ready: "exact-current-runtime",
                });
                if (overBudget) throw new Error("synthetic backend count over budget");
              }
              return { hash: { input: fqn } };
            }),
          delete: () => Effect.die("Phased release must not delete verification state"),
        }),
      },
      Effect.gen(function* () {
        const ready = yield* Command.Exec("PoolBackendBudgetRuntimeReady", {
          command: "synthetic ready",
          memo: false,
        });
        yield* Command.Exec("PoolBackendBudget", {
          command: "synthetic budget",
          memo: false,
          env: { DATABASE_BUDGET_READY_RECEIPT: ready.hash.pipe(Output.map(() => receipt)) },
        });
        yield* Command.Exec("UnrelatedVerification", { command: "synthetic other", memo: false });
      }),
    );
    const effect = evalStack(
      stack,
      (compiled) =>
        Effect.gen(function* () {
          const prepare = (plan: Plan.Plan): PreparedPlan => ({
            captured: new Map(),
            containers: new Map(),
            inputs: new Map(),
            builds: new Map(),
            checkedCommands: new Map(),
            admissions: [],
            databaseCommands: new Set(),
            stack: compiled.name,
            stage: compiled.stage,
            original: plan,
            plan,
          });
          yield* finishPlan(
            prepare(yield* Plan.make(compiled)),
            new Map(),
            new Set(),
            new Map(),
            true,
          );
          assert.deepEqual(events, ["UnrelatedVerification"]);
          for (const fqn of ["PoolBackendBudgetRuntimeReady", "PoolBackendBudget"])
            assert.equal(
              yield* memory.get({ stack: compiled.name, stage: compiled.stage, fqn }),
              undefined,
            );
          yield* finishPlan(prepare(yield* Plan.make(compiled)), new Map(), new Set());
        }).pipe(
          Effect.provideContext(compiled.services),
          Effect.provideService(State, Context.get(compiled.services, State)),
        ),
      { stage: "production" },
    ).pipe(withReleaseRuntime);
    if (overBudget)
      await assert.rejects(Effect.runPromise(effect), (error) => {
        assert.ok(error instanceof Error && error.cause instanceof Error);
        assert.equal(error.cause.message, "synthetic backend count over budget");
        return true;
      });
    else await Effect.runPromise(effect);
    assert.ok(
      events.indexOf("PoolBackendBudgetRuntimeReady") < events.indexOf("PoolBackendBudget"),
    );
    assert.equal(events.filter((event) => event === "PoolBackendBudgetRuntimeReady").length, 1);
    assert.equal(events.filter((event) => event === "PoolBackendBudget").length, 1);
  });
