import assert from "node:assert/strict";
import { test } from "node:test";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack, evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Context, Effect, Layer } from "effect";
import { ReleaseOperationFailure } from "./operation-failure.ts";
import { planStack } from "./plan-stack.ts";
import { withReleaseRuntime } from "./runtime.ts";

interface Target extends Resource<"Fixture.PlanTarget", { value: number }, { value: number }> {}
const Target = Resource<Target>("Fixture.PlanTarget");

for (const rejected of [false, true])
  test(`filtered planning preserves selection and safe provider failures (rejected=${rejected})`, async () => {
    let seeded = false;
    let writes = 0;
    const visited: string[] = [];
    const provider = Provider.succeed(Target, {
      diff: (input) => {
        if (seeded) visited.push(input.fqn);
        return seeded && rejected
          ? Effect.fail(
              Object.assign(new Error("private-provider-message"), {
                _tag: "Unauthorized",
                status: 401,
              }),
            )
          : Effect.succeed({ action: "update" });
      },
      reconcile: (input) => Effect.succeed(input.news),
      delete: () => Effect.void,
    });
    const state = Layer.effect(
      State,
      Effect.gen(function* () {
        const memory = yield* InMemoryService();
        return Effect.succeed({
          ...memory,
          set: (input) => {
            if (seeded) writes++;
            return memory.set(input);
          },
        });
      }),
    );
    const stack = Stack(
      "fixture",
      { providers: provider, state },
      Effect.gen(function* () {
        yield* Target("Database", { value: 1 });
        yield* Target("Worker", { value: 1 });
      }),
    );
    const effect = evalStack(
      stack,
      (compiled) =>
        Effect.gen(function* () {
          yield* Apply.apply(yield* Plan.make(compiled));
          seeded = true;
          return yield* planStack(compiled, { include: ["Database"] });
        }).pipe(
          Effect.provideContext(compiled.services),
          Effect.provideService(State, Context.get(compiled.services, State)),
        ),
      { stage: "production" },
    ).pipe(withReleaseRuntime);
    if (rejected)
      await assert.rejects(Effect.runPromise(effect), (error) => {
        assert.ok(error instanceof ReleaseOperationFailure);
        assert.equal(error.worker, "Database");
        assert.equal(error.operation, "plan-diff-resource");
        assert.deepEqual(error.provider, { type: "Unauthorized", status: 401 });
        assert.ok(!JSON.stringify(error).includes("private-provider-message"));
        return true;
      });
    else {
      const plan = await Effect.runPromise(effect);
      assert.deepEqual(Object.keys(plan.resources), ["Database"]);
    }
    assert.deepEqual(visited, ["Database"]);
    assert.equal(writes, 0);
  });
