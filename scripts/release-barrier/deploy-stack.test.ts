import assert from "node:assert/strict";
import { test } from "node:test";
import { Stack, evalStack } from "alchemy/Stack";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { WorkerUploadHook } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import { Context, Effect, Exit, Layer, Option } from "effect";
import type { Worker } from "alchemy/Cloudflare";
import { withReleaseRuntime } from "./runtime.ts";
import { deployStack } from "./deploy-stack.ts";
import { attributes, preparedUpload } from "./fixture.ts";
import type { BarrierReceipt } from "./barrier.ts";

interface FixtureWorker extends Resource<
  "Cloudflare.Worker",
  { revision: string; peer?: string },
  Worker["Attributes"]
> {}
const FixtureWorker = Resource<FixtureWorker>("Cloudflare.Worker");

const fixture = (
  options: {
    reject?: boolean;
    omitCapture?: boolean;
    newResource?: boolean;
    interrupted?: boolean;
  } = {},
) => {
  const events: string[] = [],
    receipts: BarrierReceipt[] = [];
  let writes = 0;
  let failOrdinary = false;
  let seededStatus: string | undefined;
  const workers = Provider.succeed(FixtureWorker, {
    diff: () => Effect.succeed({ action: "update" }),
    reconcile: (input) =>
      Effect.gen(function* () {
        const hook = yield* Effect.serviceOption(WorkerUploadHook);
        const result = {
          ...attributes(input.id),
          hash: { ...attributes(input.id).hash!, input: input.news.revision },
        };
        if (Option.isSome(hook)) {
          if (options.omitCapture && input.id === "Router") return result;
          return yield* hook.value.capture({
            ...preparedUpload(input.id),
            proposed: result,
            activate: (version) =>
              Effect.sync(() => {
                events.push(`activate:${input.id}:${version}`);
                return result;
              }),
          });
        }
        if (failOrdinary && input.id === "Api") throw new Error("interrupted upload");
        events.push(`ordinary-upload:${input.id}`);
        return result;
      }),
    delete: () => Effect.void,
  });
  const state = Layer.effect(
    State,
    Effect.gen(function* () {
      const memory = yield* InMemoryService();
      return Effect.succeed({
        ...memory,
        set: (input) =>
          Effect.sync(() => {
            writes++;
          }).pipe(Effect.andThen(memory.set(input))),
        setOutput: (input) =>
          Effect.sync(() => {
            writes++;
          }).pipe(Effect.andThen(memory.setOutput(input))),
      });
    }),
  );
  const commands = Command.ExecProvider().pipe(
    Layer.provide(
      Layer.succeed(Command.CommandExecutor, {
        spawn: () => Effect.die("No child processes in the barrier proof"),
        run: (news) =>
          Effect.sync(() => {
            events.push(`command:${news.command}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      }),
    ),
  );
  const stack = Stack(
    "fixture",
    { providers: Layer.mergeAll(workers, commands), state },
    Effect.gen(function* () {
      yield* Command.Exec("PoolDatabase", { command: "database", memo: false });
      const api = yield* FixtureWorker("Api", { revision: "candidate" });
      yield* Command.Exec("ToolsBackendBudget", {
        command: "tools-budget",
        memo: false,
        env: { READY: api.hash.pipe(Output.map((hash) => hash?.input ?? "")) },
      });
      yield* FixtureWorker("Router", { revision: "candidate", peer: api.workerName });
      return { api: api.workerName };
    }),
  );
  const effect = evalStack(
    stack,
    (compiled) =>
      Effect.gen(function* () {
        yield* Apply.apply(yield* Plan.make(compiled));
        if (options.interrupted) {
          failOrdinary = true;
          const failed = yield* Effect.exit(Apply.apply(yield* Plan.make(compiled)));
          assert.ok(Exit.isFailure(failed));
          failOrdinary = false;
          const store = yield* yield* State;
          seededStatus = (yield* store.get({
            stack: compiled.name,
            stage: compiled.stage,
            fqn: "Api",
          }))?.status;
        }
        events.length = 0;
        writes = 0;
        if (options.newResource) {
          const state = yield* yield* State;
          yield* state.delete({ stack: compiled.name, stage: compiled.stage, fqn: "Router" });
        }
        return yield* deployStack(compiled, {
          candidate: "a".repeat(40),
          record: async (receipt) => {
            receipts.push(receipt);
          },
          manifest: async () => {},
          io: {
            baseline: () => Effect.succeed([{ versionId: "previous", percentage: 100 }]),
            upload: (worker) =>
              Effect.sync(() => {
                events.push(`validate:${worker.id}`);
                if (options.reject && worker.id === "Router")
                  throw new Error("provider refuses Router");
                return { versionId: `accepted-${worker.id}`, startupTimeMs: 100 };
              }),
          },
        }).pipe(Effect.provideContext(compiled.services));
      }).pipe(Effect.provideService(State, Context.get(compiled.services, State))),
    { stage: "production" },
  ).pipe(withReleaseRuntime);
  return { effect, events, receipts, writes: () => writes, seededStatus: () => seededStatus };
};

test("real Alchemy graph refuses a late upload without activating, executing Commands or committing live state", async () => {
  const proof = fixture({ reject: true });
  await assert.rejects(Effect.runPromise(proof.effect), /upload-rejected-or-unconfirmed/);
  assert.deepEqual(proof.events, ["validate:Api", "validate:Router"]);
  assert.equal(proof.writes(), 0);
  assert.deepEqual(proof.receipts.at(-1)?.activated, []);
});

test("real Alchemy graph activates accepted IDs before the Api.hash-dependent live verifier", async () => {
  const proof = fixture();
  await Effect.runPromise(proof.effect);
  assert.deepEqual(proof.events, [
    "validate:Api",
    "validate:Router",
    "command:database",
    "activate:Api:accepted-Api",
    "activate:Router:accepted-Router",
    "command:tools-budget",
  ]);
  assert.ok(proof.writes() > 0);
});

for (const options of [{ newResource: true }, { omitCapture: true }]) {
  test(`incomplete preparation ${JSON.stringify(options)} never reaches upload or activation`, async () => {
    const proof = fixture(options);
    await assert.rejects(Effect.runPromise(proof.effect));
    assert.deepEqual(proof.events, []);
    assert.equal(proof.writes(), 0);
  });
}

for (const reject of [false, true]) {
  test(`an existing interrupted in-place update resumes through the barrier (rejected=${reject})`, async () => {
    const proof = fixture({ interrupted: true, reject });
    if (reject)
      await assert.rejects(Effect.runPromise(proof.effect), /upload-rejected-or-unconfirmed/);
    else await Effect.runPromise(proof.effect);
    assert.equal(proof.seededStatus(), "updating");
    if (reject) {
      assert.equal(proof.writes(), 0);
      assert.deepEqual(proof.events, ["validate:Api", "validate:Router"]);
    } else assert.equal(proof.receipts.at(-1)?.phase, "complete");
  });
}
