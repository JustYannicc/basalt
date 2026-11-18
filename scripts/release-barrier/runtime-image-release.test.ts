// Regression: release-phases-real-client (every phase drives the real release client, so health() and the witness readback run as in production)
// End-to-end proof of the first scale-out release: the production runner's deploy and image steps,
// releaseRuntimeImage through every phase, deployStack, Alchemy Plan/Apply and its Command provider,
// against a local Cloudflare and controller fake (test/runtime-release-world.ts). The modules that
// reach the live controller are stand-ins (test/runtime-release-standins.ts); the controller client
// is the real one over a fake pool-operations bridge with production's setup latency, and only its
// adopt and promote mutations go straight to the fake controller.
// PoolWorker's classes go through the real reviewed class path (prepareDeclaredClasses and its
// SDK reads and PUT) against a production-shaped, untagged Worker (test/production-pool-worker.ts).
// Not covered: fleet bootstrap provisioning internals, container staging (runtimeImage prepare and
// verify), the client's promotion internals and startup abort, forward-resume after a failed
// phase, and the database phase with a real migration.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Cause, Config, ConfigProvider, Effect, Exit, Layer, Option, Redacted } from "effect";
import * as Apply from "alchemy/Apply";
import * as Command from "alchemy/Command";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack, evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import * as Cloudflare from "alchemy/Cloudflare";
import type { Worker } from "alchemy/Cloudflare";
import { WorkerUploadHook } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import { encodeDurableObjectTags, getDurableObjectTagMap } from "alchemy/Cloudflare/Workers";
import {
  RuntimeImageReleasePlan,
  type ImageReleasePlan,
} from "../../src/pool/image-release-plan.ts";
import {
  fleetBindings,
  fleetInfrastructure,
  plannedContainerClasses,
} from "../../src/pool/fleet-deployment.ts";
import {
  deleteClassClone,
  deployClassExpansion,
  readClassClone,
  readClassContent,
  readDeclaredClass,
  stageClassClone,
} from "./class-cloudflare.ts";
import type { ClassProvider, ClassProgress } from "./declared-class-contract.ts";
import { decodeDeclaredChanges } from "./declared-change-schema.ts";
import { productionPoolWorker } from "./test/production-pool-worker.ts";
import { poolWorkerClassEntry, repositoryDeclarations } from "./test/repository-declarations.ts";
import { capturePoolImage } from "../deploy-safety/capture-pool-image.ts";
import { waitForPoolImage } from "../deploy-safety/pool-image.ts";
import { executeRelease, type CommandResult } from "../deploy-safety/release-runner.ts";
import type { ClassificationReport } from "../releases/types.ts";
import { attributes, preparedUpload } from "./fixture.ts";
import { BarrierRefusal } from "./refusal.ts";
import type { RuntimeReleaseWriter } from "./runtime-release-writer.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { readySqlSchemas } from "./sql-schema-fixture.ts";
import {
  accountId,
  candidate,
  candidateImage,
  candidateInput,
  createWorld,
  foreignImage,
  foreignInput,
  installWorld,
  origin,
  runtimeEnvironment,
  workerName,
  type World,
  type WorldOptions,
} from "./test/runtime-release-world.ts";

type ProductionWorker = ReturnType<typeof productionPoolWorker>;
const target = { accountId, scriptName: workerName };
/** The reviewed class path's own Cloudflare calls, against the production-shaped PoolWorker. */
const classProvider = (worker: ProductionWorker): ClassProvider => {
  // The model's layer supplies the SDK's HTTP client, credentials and configuration.
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(worker.layer)) as Effect.Effect<A, E, never>);
  return {
    read: (value) => run(readDeclaredClass(value, worker.fetcher)),
    content: (value, version) => run(readClassContent(value, version, worker.fetcher)),
    deploy: (request) => run(deployClassExpansion(request)),
    stageClone: (request) => run(stageClassClone(request)),
    clone: (value, version) => run(readClassClone(value, version)),
    removeClone: (value, version) => run(deleteClassClone(value, version)),
  };
};
// The repository's reviewed PoolWorker class intent, on its own: storage entries need other providers.
const repository = await repositoryDeclarations();
const poolWorkerEntry = await poolWorkerClassEntry();
const poolWorkerDeclaration = () =>
  decodeDeclaredChanges({ ...repository, changes: [poolWorkerEntry] });
const fleetClasses = ["PoolRuntimeBlue", "PoolRuntimeGreen"];

/**
 * The container links alchemy derives for a phase, independently of plannedContainerClasses: each
 * Container the real fleet declarations bind for this plan contributes its class to the upload's
 * `containers` (alchemy WorkerAsyncBindings.ts:398, WorkerProvider.ts:4043), beside PoolContainer.
 */
async function declaredContainerClasses(plan: ImageReleasePlan | undefined) {
  const stack = Stack(
    "basalt",
    {
      providers: Layer.empty,
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    Effect.gen(function* () {
      return yield* Cloudflare.Worker("PoolWorker", {
        main: fileURLToPath(import.meta.url),
        env: fleetBindings(yield* fleetInfrastructure),
      });
    }),
  );
  const compiled = await Effect.runPromise(
    evalStack(stack, Effect.succeed, { stage: "production" }).pipe(
      Effect.provideService(Cloudflare.CloudflareEnvironment, Effect.succeed({ accountId })),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      Effect.provideService(RuntimeImageReleasePlan, plan),
      withReleaseRuntime,
    ),
  );
  return [
    "PoolContainer",
    ...Object.values(compiled.resources)
      .filter((resource) => resource.Type === "Cloudflare.Container")
      .map((resource) => (resource.Props as { className: string }).className),
  ].sort();
}

/**
 * PoolWorker's upload as alchemy builds it from the live Worker (WorkerProvider.ts): its four
 * reserved tags with the packed DO map and no migration tag, untagged migrations adding only the
 * classes the live tag map and bindings do not already name, and the plan's container links.
 */
async function alchemyUpload(worker: ProductionWorker, plan: ImageReleasePlan | undefined) {
  const live = await classProvider(worker).read(target);
  const known = getDurableObjectTagMap(live.settings.tags ?? []);
  const bound = (live.settings.bindings ?? []).map((binding) => binding.name);
  const hosted = ["PoolContainer", ...fleetClasses];
  const containers = await declaredContainerClasses(plan);
  // The preflight predicts the class step with plannedContainerClasses; a divergence here would
  // make that prediction wrong, so the release proof refuses it.
  assert.deepEqual(containers, plannedContainerClasses(plan), JSON.stringify(plan));
  const base = preparedUpload("PoolWorker");
  return {
    ...base,
    request: {
      ...base.request,
      accountId,
      scriptName: workerName,
      metadata: {
        ...base.request.metadata,
        bindings: [
          ...hosted.map((name) => ({
            type: "durable_object_namespace" as const,
            name,
            className: name,
          })),
          { type: "plain_text" as const, name: "POOL_PRESERVE_LEGACY_IMAGE", text: "true" },
        ],
        containers: containers.map((className) => ({ className })),
        migrations: {
          oldTag: undefined,
          newTag: undefined,
          newClasses: [],
          deletedClasses: [],
          renamedClasses: [],
          transferredClasses: [],
          newSqliteClasses: fleetClasses.filter(
            (name) => !Object.values(known).includes(name) && !bound.includes(name),
          ),
        },
        tags: [
          "alchemy:stack:basalt",
          "alchemy:stage:production",
          "alchemy:id:PoolWorker",
          ...encodeDurableObjectTags(hosted.map((name) => ({ logicalId: name, className: name }))),
        ],
      },
    },
    previousSettings: live.settings,
  };
}

// Only runtime-image-release.ts's own imports of these modules are redirected; every other importer,
// including deployStack and the real fleet and image helpers, keeps the production module.
const release = new URL("./runtime-image-release.ts", import.meta.url).href;
const standins = new URL("./test/runtime-release-standins.ts", import.meta.url).href;
const redirected = new Set([
  "./runtime-provider-observation.ts",
  "./migration-activation-state.ts",
  "./provisioning-stack.ts",
  "./release-state-version.ts",
  "./forward-resume.ts",
  "./runtime-release-state.ts",
  "./runtime-release-desired.ts",
  "./runtime-release-journal.ts",
  "./runtime-release-client.ts",
  "./runtime-release-bootstrap.ts",
  "./runtime-release-readiness.ts",
  "./baseline-controller.ts",
]);
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === release && redirected.has(specifier))
      return { url: standins, shortCircuit: true };
    return next(specifier, context);
  },
});
const { releaseRuntimeImage } = await import("./runtime-image-release.ts");
const standin = await import("./test/runtime-release-standins.ts");

interface FixtureWorker extends Resource<
  "Cloudflare.Worker",
  { revision: string; env: Record<string, string> },
  Worker["Attributes"],
  Worker["Binding"]
> {}
const FixtureWorker = Resource<FixtureWorker>("Cloudflare.Worker");
const unwrap = (env: Record<string, unknown> = {}): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? String(Redacted.value(value)) : String(value),
    ]),
  );

/**
 * A production-shaped release graph: PoolWorker, the database and budget Commands, and the
 * publication receipt Command declared as src/pool/deployment.ts:120-142 declares it.
 * Its receipt names the root PoolContainer application, as deployment.ts:132 does.
 */
function releaseGraph(
  w: World,
  receipts: { runs: number; seeding: boolean },
  isolate: boolean,
  production: ProductionWorker,
) {
  let plan: ImageReleasePlan | undefined;
  // Alchemy reports the live Worker after its upload: its tags and DO namespace ids.
  const poolAttributes = (id: string) => ({
    ...attributes(id),
    accountId,
    workerName: id,
    tags: [...production.settings().tags],
    durableObjectNamespaces: production.classes(),
  });
  const memory = Effect.runSync(InMemoryService());
  const state = Layer.succeed(State, Effect.succeed(memory));
  standin.installProvisioningState(memory);
  const workers = Provider.succeed(FixtureWorker, {
    precreate: ({ id }) => Effect.succeed(poolAttributes(id)),
    read: (input) => Effect.succeed(input.output),
    diff: () => Effect.succeed({ action: "update" }),
    reconcile: (input) =>
      Effect.gen(function* () {
        const result = poolAttributes(input.id);
        const hook = yield* Effect.serviceOption(WorkerUploadHook);
        if (Option.isNone(hook)) return result;
        const phase = plan;
        const upload = yield* Effect.promise(() => alchemyUpload(production, phase));
        return yield* hook.value.capture({
          ...upload,
          previous: poolAttributes(input.id),
          proposed: result,
          activate: () =>
            Effect.sync(() => {
              w.activatePoolWorker();
              // The code phase's ordinary upload links exactly the plan's container classes.
              production.deployCode(plannedContainerClasses(phase));
              return poolAttributes(input.id);
            }),
        });
      }),
    delete: () => Effect.die("Unexpected deletion"),
  });
  // Alchemy's real Command provider owns diff and memo; only the child process is in-process.
  const commands = Command.ExecProvider().pipe(
    Layer.provide(
      Layer.succeed(Command.CommandExecutor, {
        spawn: () => Effect.die("No child processes in the release proof"),
        run: (news) =>
          Effect.promise(async () => {
            w.events.push(`command:${news.command}`);
            if (news.command === "node capture-pool-image.ts" && !receipts.seeding) {
              receipts.runs++;
              const env = unwrap(news.env);
              // Isolation removes the previous phase's receipt first, so the image check runs regardless.
              if (isolate) rmSync(env.BASALT_POOL_IMAGE_RECEIPT!, { force: true });
              // `node capture-pool-image.ts` in scripts/deploy-safety runs exactly this with its env.
              await capturePoolImage(env, w.fetch);
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      }),
    ),
  );
  const stack = Stack(
    "basalt",
    { providers: Layer.mergeAll(workers, commands), state },
    Effect.gen(function* () {
      plan = yield* RuntimeImageReleasePlan;
      // The stack evaluated with `build` publishes the candidate image to that inactive application.
      if (plan?.build) w.buildInactive(plan.build);
      yield* Command.Exec("PoolDatabase", { command: "node ensure-pool-database.ts", memo: false });
      // The runtime settings deployStack's preserveRuntimeInputs retains from the baseline.
      const worker = yield* FixtureWorker("PoolWorker", {
        revision: "candidate",
        env: runtimeEnvironment(w.root.input),
      });
      yield* Command.Exec("PoolBackendBudgetRuntimeReady", {
        command: "node verify-database-budget.ts --ready",
        memo: false,
      });
      yield* Command.Exec("PoolBackendBudget", {
        command: "node verify-database-budget.ts",
        memo: false,
      });
      const receiptPath = yield* Config.String("BASALT_POOL_IMAGE_RECEIPT").pipe(
        Config.withDefault(""),
      );
      if (receiptPath)
        yield* Command.Exec("PoolImagePublicationReceipt", {
          command: "node capture-pool-image.ts",
          cwd: fileURLToPath(new URL("../deploy-safety/", import.meta.url)),
          env: {
            BASALT_POOL_IMAGE_RECEIPT: receiptPath,
            GITHUB_SHA: candidate,
            CLOUDFLARE_ACCOUNT_ID: accountId,
            CLOUDFLARE_API_TOKEN: Redacted.make("synthetic-api-token"),
            POOL_APPLICATION_ID: w.root.id,
            POOL_IMAGE_INPUT_HASH: w.root.input,
            POOL_IMAGE_DIGEST: w.root.image.digest,
            POOL_IMAGE_REF: w.root.image.ref,
            POOL_WORKER_READY: worker.workerName,
          },
          memo: false,
          timeout: "1 minute",
        });
      return {};
    }),
  );
  return stack;
}
const report: ClassificationReport = {
  schemaVersion: 1,
  base: { gitCommit: "1".repeat(40), pins: {} as ClassificationReport["base"]["pins"] },
  candidate: { gitCommit: candidate, pins: {} as ClassificationReport["candidate"]["pins"] },
  databaseChanged: false,
  workflowChanged: false,
  evidence: {
    database: { state: "unchanged", sources: [] },
    workflow: { state: "unchanged", sources: [] },
  },
};

/** One first scale-out release, driven through the production runner's deploy and image steps. */
async function firstScaleOutRelease(
  options: {
    isolateReceipt?: boolean;
    beforeImageCheck?: (w: World) => void;
    world?: WorldOptions;
    sourceController?: { candidate: string; workerInput: string };
    /** Omit the reviewed PoolWorker class intent: the code phase then creates no fleet class. */
    withoutClassIntent?: boolean;
  } = {},
) {
  const w = createWorld(options.world);
  installWorld(w);
  const production = productionPoolWorker(target);
  standin.installProductionWorker(production);
  standin.resetBootstrap();
  const expansions: ClassProgress[] = [];
  standin.resetJournal(options.sourceController);
  const scratch = mkdtempSync(join(tmpdir(), "runtime-image-release-"));
  const network = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`Release proof refused a real network call to ${new Request(input).url}`);
  };
  const event = {
    GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
    GITHUB_REF: process.env.GITHUB_REF,
  };
  try {
    const directory = join(scratch, "barrier");
    // release-runner.ts:220-225: one receipt path for the whole `npm run deploy`.
    const receiptPath = join(
      mkdtempSync(join(scratch, "basalt-pool-publication-")),
      "receipt.json",
    );
    const receipts = { runs: 0, seeding: true };
    const stack = releaseGraph(w, receipts, options.isolateReceipt ?? false, production);
    const config = ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          BASALT_POOL_IMAGE_RECEIPT: receiptPath,
          GITHUB_SHA: candidate,
          EXECUTOR_ENCRYPTION_KEY: "b".repeat(64),
          CLOUDFLARE_API_TOKEN: "synthetic-api-token",
        },
      }),
    );
    const provide = <A, E>(effect: Effect.Effect<A, E, never>) =>
      Effect.runPromiseExit(effect.pipe(Effect.provide(config)));
    // The previous release's native state, so every resource plans as an update.
    const seeded = await provide(
      evalStack(
        stack,
        (compiled) =>
          Effect.gen(function* () {
            return yield* Apply.apply(yield* Plan.make(compiled));
          }),
        { stage: "production" },
      ).pipe(withReleaseRuntime),
    );
    assert.ok(Exit.isSuccess(seeded), Exit.isFailure(seeded) ? Cause.pretty(seeded.cause) : "");
    receipts.seeding = false;
    w.events.length = 0;

    const failures: string[] = [];
    let verified: Awaited<ReturnType<typeof waitForPoolImage>> | undefined;
    const marks: string[] = [];
    // Every consumer of the exclusive release writer here is a stand-in, which ignores it.
    const writer = {} as RuntimeReleaseWriter;
    let now = 0;
    // assertReleaseMode reads the GitHub event: an automatic release from a push to main.
    Object.assign(process.env, { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" });
    const outcome = await executeRelease(report, "automatic", {
      validateCredentials: () => {},
      assertBackup: async () => {
        throw new Error("No database change in this release");
      },
      begin: async () => 1,
      mark: async (_id, value) => {
        marks.push(value);
      },
      deploy: async (): Promise<CommandResult> => {
        // release-runner.ts:249-251 removes the receipt once, before the one deploy command.
        rmSync(receiptPath, { force: true });
        const exit = await provide(
          releaseRuntimeImage(stack, {
            candidate,
            directory,
            writer,
            encryptionKey: "b".repeat(64),
            forwardEncryptionKey: "b".repeat(64),
            record: async () => {},
            manifest: async () => {},
            ...(options.withoutClassIntent
              ? {}
              : {
                  declarations: poolWorkerDeclaration(),
                  declared: async () => {},
                  declaredReadiness: async () => {},
                  expansion: async (value: ClassProgress) => {
                    expansions.push(value);
                  },
                }),
            io: {
              classes: classProvider(production),
              sqlSchemas: async () => readySqlSchemas(candidate),
              placements: (_worker, baseline) =>
                Effect.succeed(
                  baseline.map(({ versionId }) => ({
                    id: versionId,
                    placement: undefined,
                    bindings: [{ name: "POOL_IMAGE_HASH", type: "plain_text", text: w.root.input }],
                  })),
                ),
              baseline: () => Effect.succeed([{ versionId: "previous", percentage: 100 }]),
              upload: (worker) =>
                Effect.succeed({ versionId: `accepted-${worker.id}`, startupTimeMs: 100 }),
            },
          }).pipe(withReleaseRuntime),
        );
        if (Exit.isSuccess(exit)) return { started: true, exitCode: 0 };
        const error = Cause.squash(exit.cause);
        // A refusal's delta names the refused command and the controller's closed reason.
        const delta =
          error instanceof BarrierRefusal
            ? (error.delta?.changed ?? [])
                .map((row) => ` ${row.path}=${"new" in row ? String(row.new) : "changed"}`)
                .join("")
            : "";
        failures.push(`deploy: ${String(error)}${delta}`);
        return { started: true, exitCode: 1 };
      },
      assertImages: async (): Promise<CommandResult> => {
        // assert-pool-image.ts, with the fixture network and a virtual clock for its 240 s budget.
        options.beforeImageCheck?.(w);
        try {
          verified = await waitForPoolImage(
            JSON.parse(readFileSync(receiptPath, "utf8")),
            candidate,
            { accountId, apiToken: "synthetic-api-token" },
            origin,
            w.fetch,
            {
              // assert-pool-image.ts computes this from the candidate's own pool image source.
              candidateImageInput: candidateInput,
              now: () => now,
              sleep: async (ms: number) => void (now += ms),
            },
          );
          return { started: true, exitCode: 0 };
        } catch (error) {
          failures.push(`assertImages: ${String(error)}`);
          return { started: true, exitCode: 1 };
        }
      },
      smoke: async () => ({ started: true, exitCode: 0 }),
      dispose: () => rmSync(dirname(receiptPath), { recursive: true, force: true }),
      log: () => {},
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    );
    return {
      w,
      outcome,
      failures,
      marks,
      receipts,
      verified,
      journal: standin.readJournal(),
      production,
      expansions,
    };
  } finally {
    globalThis.fetch = network;
    rmSync(scratch, { recursive: true, force: true });
    for (const [name, value] of Object.entries(event))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

const explain = (result: Awaited<ReturnType<typeof firstScaleOutRelease>>) =>
  JSON.stringify(
    { outcome: result.outcome, failures: result.failures, events: result.w.events },
    null,
    2,
  );

test("a first scale-out release runs every phase, retires the root runtime and is marked deployed", async () => {
  const result = await firstScaleOutRelease();
  // The controller phase's class path sent alchemy's untagged migration once, keeping PoolContainer
  // linked; no later phase migrated a class again, and Cloudflare refused nothing.
  assert.deepEqual(
    result.production.log.puts.map((metadata) => ({
      migrations: metadata.migrations,
      containers: metadata.containers,
    })),
    [
      {
        migrations: { new_sqlite_classes: ["PoolRuntimeBlue", "PoolRuntimeGreen"] },
        containers: [{ class_name: "PoolContainer" }],
      },
    ],
    explain(result),
  );
  assert.deepEqual(result.production.log.refusals, []);
  // Each bootstrap attached to the class the code phase created and never wrote the Worker; each
  // bind phase then linked its container, and the class record stayed ready through both.
  assert.deepEqual(
    standin.bootstrapAttachments.map(({ className, namespaceId }) => [className, namespaceId]),
    [
      ["PoolRuntimeBlue", "poolruntimeblue-namespace"],
      ["PoolRuntimeGreen", "poolruntimegreen-namespace"],
    ],
    explain(result),
  );
  assert.equal(standin.bootstrapCalls.writes, 0);
  assert.deepEqual(result.production.containers(), [
    "PoolContainer",
    "PoolRuntimeBlue",
    "PoolRuntimeGreen",
  ]);
  assert.ok(
    result.expansions.some((value) => value.outcome === "ready"),
    explain(result),
  );
  // The memo:false receipt Command re-runs in every deployStack phase of one deploy command, so
  // each later phase must overwrite the receipt the earlier one wrote.
  assert.deepEqual(
    result.failures.filter((line) => line.startsWith("deploy:")),
    [],
    explain(result),
  );
  assert.equal(result.journal?.complete, true);
  assert.ok(result.receipts.runs >= 1, "the receipt was captured");
  const green = result.w.byColor("green")!;
  assert.equal(result.w.root.instances.length, 0, "retirement destroyed the root runtime");
  assert.deepEqual(
    green.instances.map((row) => row.image),
    [candidateImage.ref],
  );
  assert.equal(result.w.controller.selection?.active.target.imageInput, candidateInput);
  assert.equal(result.w.controller.selection?.draining, undefined);
  const order = [
    "adopt:legacy",
    "create:application-blue",
    "create:application-green",
    "build:application-green",
    "promote:application-green",
    "destroy:application-root:controller-root",
  ];
  assert.deepEqual(
    result.w.events.filter((event) => order.includes(event)),
    order,
    explain(result),
  );
  // The runner's image check must then accept the release.
  assert.deepEqual(result.failures, [], explain(result));
  assert.deepEqual(
    result.outcome,
    { ok: true, value: { state: "deployed", deploymentId: 1 } },
    explain(result),
  );
  assert.deepEqual(result.marks, ["success"]);
});

test("without the PoolWorker class intent, alchemy's class migration refuses in the code phase before any write", async () => {
  const result = await firstScaleOutRelease({ withoutClassIntent: true });
  assert.notEqual(result.outcome.ok, true, explain(result));
  // The ordinary version path admits no class migration; only the reviewed class path sends one.
  assert.match(explain(result), /durable-object-migration/u);
  assert.ok(!result.w.events.includes("create:application-blue"), explain(result));
  assert.deepEqual(standin.bootstrapAttachments, []);
  assert.equal(standin.bootstrapCalls.writes, 0);
  assert.deepEqual(result.production.log.puts, []);
});

test("a release after a settled or aborted prior candidate freezes that candidate's live controller", async () => {
  const sourceController = { candidate: "4".repeat(40), workerInput: "3".repeat(64) };
  const result = await firstScaleOutRelease({ sourceController });
  assert.equal(result.journal?.complete, true, explain(result));
  assert.deepEqual(result.journal?.baselineController?.code, sourceController);
});

test("the post-deploy image check accepts the fleet a completed release leaves behind", async () => {
  // Removing the prior receipt before each capture isolates the image check from the receipt write.
  const result = await firstScaleOutRelease({ isolateReceipt: true });
  assert.equal(result.journal?.complete, true, explain(result));
  assert.equal(result.w.root.instances.length, 0);
  // The receipt names the root application, which retirement left without an instance.
  assert.deepEqual(result.failures, [], explain(result));
  assert.deepEqual(result.marks, ["success"]);
  // The check verified the promoted primary through the fleet, on the candidate's image.
  const green = result.w.byColor("green")!;
  assert.equal(result.verified?.verifiedPath, "bound-fleet");
  assert.deepEqual(
    result.verified?.instances,
    green.instances.map((row) => row.id),
  );
  const served = result.verified?.fleet?.find((app) => app.imageInput === candidateInput);
  assert.equal(served?.digest, candidateImage.digest, "the serving fleet runs the candidate image");
  assert.deepEqual(
    green.instances.map((row) => row.image),
    [candidateImage.ref],
  );
});

test("the post-deploy image check still fails a release whose promoted primary is not running", async () => {
  const result = await firstScaleOutRelease({
    isolateReceipt: true,
    beforeImageCheck: (w) => {
      for (const row of w.byColor("green")!.instances) row.state = "stopped";
    },
  });
  assert.equal(result.journal?.complete, true, explain(result));
  assert.deepEqual(result.marks, ["failure"], explain(result));
  assert.equal(result.outcome.ok, false);
  assert.match(result.failures.join("\n"), /^assertImages: /m);
  // It failed on the fleet it inspected, not because it never looked past the retired root.
  assert.ok(result.w.instanceReads.includes("application-green"), explain(result));
});

test("the post-deploy image check fails a release whose fleet serves an image other than the candidate's", async () => {
  const result = await firstScaleOutRelease({
    isolateReceipt: true,
    beforeImageCheck: (w) => {
      // The promoted application, its running instance and its PoolWorker binding all moved to an
      // unrelated build, so no fleet application serves this candidate's image input.
      const green = w.byColor("green")!;
      green.image = foreignImage;
      green.input = foreignInput;
      for (const row of green.instances) row.image = foreignImage.ref;
      w.activatePoolWorker();
    },
  });
  assert.equal(result.journal?.complete, true, explain(result));
  assert.deepEqual(result.marks, ["failure"], explain(result));
  assert.equal(result.outcome.ok, false);
  assert.match(result.failures.join("\n"), /^assertImages: /m);
  // It failed on the fleet it inspected, not because it never looked past the retired root.
  assert.ok(result.w.instanceReads.includes("application-green"), explain(result));
});

test("the fixture's receipt Command matches the one the production stack declares", () => {
  // The release graph above copies src/pool/deployment.ts's receipt declaration. A change there must
  // change the copy, or this proof stops describing production.
  const source = readFileSync(new URL("../../src/pool/deployment.ts", import.meta.url), "utf8");
  const start = source.indexOf('Command.Exec("PoolImagePublicationReceipt"');
  assert.ok(start >= 0, "deployment.ts declares the receipt Command");
  const block = source.slice(start, source.indexOf("});", start));
  for (const line of [
    'command: "node capture-pool-image.ts"',
    "POOL_APPLICATION_ID: application.applicationId",
    'POOL_IMAGE_DIGEST: application.hash.pipe(Output.map((hash) => hash?.digest ?? ""))',
    "POOL_WORKER_READY: worker.workerName",
    "memo: false",
  ])
    assert.ok(block.includes(line), `deployment.ts receipt Command changed: ${line}`);
  // The fake PoolWorker binds the candidate's desired input on every activation; production does
  // only while deployment.ts binds it fresh and preserveRuntimeInputs does not retain the baseline's.
  assert.ok(source.includes("POOL_DESIRED_IMAGE_INPUT: yield* desiredPoolImageInput"));
  const retained = readFileSync(new URL("./preserve-runtime-plan.ts", import.meta.url), "utf8");
  assert.ok(!retained.includes('"POOL_DESIRED_IMAGE_INPUT"'), "the desired input is not retained");
});

// Regression: finalize-health-bridge-latency
test("release health over a bridge whose setup outlasts the health lease does not expire", async () => {
  // Every runtime command opens a fresh bridge, and from a CI runner its setup alone outlasts the
  // controller's 1,500 ms active-health lease (test/bridge-latency.ts).
  const result = await firstScaleOutRelease();
  assert.doesNotMatch(
    result.failures.join("\n"),
    /runtime-release-health-expired/,
    explain(result),
  );
  assert.equal(result.journal?.complete, true, explain(result));
  assert.deepEqual(result.marks, ["success"], explain(result));
});

// Regression: adopted-root-witness-under-new-controller
test("a controller-only release over a root an earlier controller adopted promotes a fleet primary", async () => {
  // The root already serves this candidate's image, so the release asks selectedCurrent about the
  // adopted legacy slot; its readback is pinned to the controller that adopted it, not this one.
  const result = await firstScaleOutRelease({ world: { root: "prior-controller" } });
  assert.doesNotMatch(
    result.failures.join("\n"),
    /handoff\.command\.action=witness/,
    explain(result),
  );
  assert.equal(result.journal?.complete, true, explain(result));
  assert.ok(result.w.events.includes("promote:application-green"), explain(result));
  assert.equal(result.w.controller.selection?.active.target.applicationId, "application-green");
  assert.deepEqual(result.marks, ["success"], explain(result));
});
