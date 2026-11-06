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
import { cloudflareArtifactsApi } from "../ensure-artifacts.ts";
import type { BarrierReceipt } from "./barrier.ts";

interface FixtureWorker extends Resource<
  "Cloudflare.Worker",
  { revision: string; peer?: string; ready?: string },
  Worker["Attributes"]
> {}
const FixtureWorker = Resource<FixtureWorker>("Cloudflare.Worker");

const fixture = (
  options: {
    reject?: boolean;
    omitCapture?: boolean;
    newResource?: boolean;
    interrupted?: boolean;
    namespace?: "eu" | "missing" | "wrong" | "drift";
    unknownCommand?: boolean;
    orphanedDatabaseCommand?: boolean;
  } = {},
) => {
  const events: string[] = [],
    receipts: BarrierReceipt[] = [];
  let writes = 0;
  let failOrdinary = false;
  let seededStatus: string | undefined;
  let namespaceReads = 0;
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
      const namespace = options.namespace
        ? yield* Command.Exec("AppSourceNamespace", {
            command: "node ensure-artifacts.ts",
            memo: false,
            env: {
              CLOUDFLARE_ACCOUNT_ID: "fixture",
              CLOUDFLARE_API_TOKEN: "fixture",
              CLOUD_SOURCE_NAMESPACE: "sources",
            },
          })
        : undefined;
      if (options.unknownCommand)
        yield* Command.Exec("UnsupportedProvisioning", {
          command: "node unmodeled.ts",
          memo: false,
        });
      yield* Command.Exec("PoolDatabase", { command: "node ensure-pool-database.ts", memo: false });
      if (options.orphanedDatabaseCommand)
        yield* Command.Exec("Migrations", { command: "node src/migrate.ts", memo: false });
      const api = yield* FixtureWorker("Api", { revision: "candidate" });
      yield* Command.Exec("ToolsBackendBudget", {
        command: "node verify-database-budget.ts",
        memo: false,
        env: { READY: api.hash.pipe(Output.map((hash) => hash?.input ?? "")) },
      });
      yield* FixtureWorker("Router", {
        revision: "candidate",
        peer: api.workerName,
        ready: namespace?.hash.pipe(Output.map(() => "eu")),
      });
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
            namespace: (account, token) =>
              cloudflareArtifactsApi(account, token, async (_input, init) => {
                assert.equal(init?.method, "GET");
                namespaceReads++;
                events.push("namespace:read");
                const missing =
                  options.namespace === "missing" ||
                  (options.namespace === "drift" && namespaceReads > 1);
                return Response.json({
                  success: true,
                  result: missing
                    ? []
                    : [
                        {
                          namespace: "sources",
                          jurisdiction: options.namespace === "wrong" ? "global" : "eu",
                        },
                      ],
                });
              }),
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
    "command:node ensure-pool-database.ts",
    "activate:Api:accepted-Api",
    "activate:Router:accepted-Router",
    "command:node verify-database-budget.ts",
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

for (const namespace of ["missing", "wrong", "drift"] as const) {
  test(`namespace ${namespace} refuses before any Worker activation or provisioning`, async () => {
    const proof = fixture({ namespace });
    await assert.rejects(Effect.runPromise(proof.effect), /source-namespace/);
    assert.ok(
      !proof.events.some((event) => event.startsWith("activate:") || event.startsWith("command:")),
    );
    if (namespace !== "drift") {
      assert.ok(!proof.events.some((event) => event.startsWith("validate:")));
      assert.equal(proof.writes(), 0);
    }
  });
}
test("existing EU namespace is admitted before uploads and rechecked before activation without running its provisioning Command", async () => {
  const proof = fixture({ namespace: "eu" });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.events[0], "namespace:read");
  const second = proof.events.indexOf("namespace:read", 1);
  assert.ok(second > proof.events.indexOf("validate:Router"));
  assert.ok(second < proof.events.findIndex((event) => event.startsWith("activate:")));
  assert.ok(!proof.events.some((event) => event.includes("command:node ensure-artifacts.ts")));
});
test("an unsupported Command cannot be deferred through preparation", async () => {
  const proof = fixture({ unknownCommand: true });
  await assert.rejects(Effect.runPromise(proof.effect), /unsupported-command/);
  assert.deepEqual(proof.events, []);
  assert.equal(proof.writes(), 0);
});

test("database Commands outside the explicit database dependency plan cannot run after activation", async () => {
  const proof = fixture({ orphanedDatabaseCommand: true });
  await assert.rejects(Effect.runPromise(proof.effect), /unsafe-database-selection/);
  assert.deepEqual(proof.events, ["validate:Api", "validate:Router"]);
  assert.equal(proof.writes(), 0);
});
