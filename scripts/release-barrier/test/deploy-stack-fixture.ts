import { placementRepairFixture } from "./placement-repair-fixture.ts";
import { readActivePlacements, uploadVersion } from "../cloudflare.ts";
import { CloudflareHttpError } from "@distilled.cloud/cloudflare/Errors";
import assert from "node:assert/strict";
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
import { withReleaseRuntime } from "../runtime.ts";
import { deployStack, type DeployStackOptions } from "../deploy-stack.ts";
import { attributes, preparedUpload } from "../fixture.ts";
import { cloudflareArtifactsApi } from "../../ensure-artifacts.ts";
import type { BarrierReceipt } from "../barrier.ts";

interface FixtureWorker extends Resource<
  "Cloudflare.Worker",
  { revision: string; peer?: string; ready?: string },
  Worker["Attributes"]
> {}
const FixtureWorker = Resource<FixtureWorker>("Cloudflare.Worker");

export const fixture = (
  options: {
    placementRepair?: boolean;
    latestSettings?: boolean;
    previousUpload?: boolean;
    settingsDrift?: boolean;
    deploymentDrift?: boolean;
    baselineError?: CloudflareHttpError;
    baseline?: typeof import("../cloudflare.ts").readBaseline;
    extraWorkers?: readonly string[];
    evidence?: Pick<DeployStackOptions, "record" | "manifest">;
    preparationError?: unknown;
    freezeError?: unknown;
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
  const repair = options.placementRepair ? placementRepairFixture(events, options) : undefined;
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
          if (options.preparationError && input.id === "Api")
            return yield* Effect.fail(options.preparationError);
          const initialUpload = preparedUpload(input.id);
          const upload = repair
            ? yield* repair.prepare(initialUpload).pipe(Effect.provide(repair.services))
            : initialUpload;
          if (options.freezeError && input.id === "Api") {
            const file = new File(["fixture"], "main.js");
            file.arrayBuffer = async () => {
              throw options.freezeError;
            };
            upload.request.files = [file];
          }
          if (options.omitCapture && input.id === "Router") return result;
          return yield* hook.value.capture({
            ...upload,
            proposed: result,
            activate: (version) =>
              Effect.sync(() => {
                repair?.activate(input.id);
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
    { providers: Layer.mergeAll(workers, commands, repair?.services ?? Layer.empty), state },
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
      for (const id of options.extraWorkers ?? [])
        yield* FixtureWorker(id, { revision: "candidate" });
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
            await options.evidence?.record(receipt);
          },
          manifest: options.evidence?.manifest ?? (async () => {}),
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
            placements: (worker, baseline) =>
              worker.scriptName === "PoolWorker"
                ? Effect.succeed(
                    baseline.map(({ versionId }) => ({
                      id: versionId,
                      placement: undefined,
                      bindings: [
                        { name: "POOL_IMAGE_HASH", type: "plain_text", text: "a".repeat(16) },
                      ],
                    })),
                  )
                : readActivePlacements(worker, baseline),
            baseline:
              options.baseline ??
              ((worker) =>
                options.baselineError && worker.scriptName === "Api"
                  ? Effect.fail(options.baselineError)
                  : Effect.succeed(
                      repair?.baseline(worker.scriptName) ?? [
                        { versionId: "previous", percentage: 100 },
                      ],
                    )),
            upload: (worker) =>
              Effect.gen(function* () {
                events.push(`validate:${worker.id}`);
                if (options.reject && worker.id === "Router")
                  throw new Error("provider refuses Router");
                if (repair && options.latestSettings && worker.id === "Api")
                  return yield* uploadVersion(worker);
                return { versionId: `accepted-${worker.id}`, startupTimeMs: 100 };
              }),
          },
        }).pipe(Effect.provideContext(compiled.services));
      }).pipe(Effect.provideService(State, Context.get(compiled.services, State))),
    { stage: "production" },
  ).pipe(withReleaseRuntime);
  return { effect, events, receipts, writes: () => writes, seededStatus: () => seededStatus };
};
