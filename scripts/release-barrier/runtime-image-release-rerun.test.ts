// A same-candidate rerun of a release that stopped after its image phase. The rerun is what
// production does next: a new runner (fresh barrier directory) over the same Alchemy state, release
// journal, controller and Cloudflare. releaseRuntimeImage, deployStack, Alchemy Plan/Apply,
// configureReleaseFleet and the reviewed class path are real, against the same local Cloudflare and
// controller fake as runtime-image-release.test.ts (test/runtime-release-world.ts); the modules
// that reach the live controller are its stand-ins (test/runtime-release-standins.ts).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option } from "effect";
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
import type { FleetConfiguration } from "../../src/pool/runtime-fleet/configuration.ts";
import {
  deleteClassClone,
  deployClassExpansion,
  readClassClone,
  readClassContent,
  readDeclaredClass,
  stageClassClone,
} from "./class-cloudflare.ts";
import type { ClassProvider } from "./declared-class-contract.ts";
import { decodeDeclaredChanges } from "./declared-change-schema.ts";
import { productionPoolWorker } from "./test/production-pool-worker.ts";
import { poolWorkerClassEntry, repositoryDeclarations } from "./test/repository-declarations.ts";
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
  installWorld,
  runtimeEnvironment,
  workerName,
  type World,
} from "./test/runtime-release-world.ts";

type ProductionWorker = ReturnType<typeof productionPoolWorker>;
const target = { accountId, scriptName: workerName };
const classProvider = (worker: ProductionWorker): ClassProvider => {
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
const repository = await repositoryDeclarations();
const poolWorkerEntry = await poolWorkerClassEntry();
const fleetClasses = ["PoolRuntimeBlue", "PoolRuntimeGreen"];

/** The container classes alchemy links for a phase, from the real fleet declarations. */
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

/** PoolWorker's upload as alchemy builds it from the live Worker (runtime-image-release.test.ts). */
async function alchemyUpload(worker: ProductionWorker, plan: ImageReleasePlan | undefined) {
  const live = await classProvider(worker).read(target);
  const known = getDurableObjectTagMap(live.settings.tags ?? []);
  const bound = (live.settings.bindings ?? []).map((binding) => binding.name);
  const hosted = ["PoolContainer", ...fleetClasses];
  const containers = await declaredContainerClasses(plan);
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

// runtime-image-release.ts's live-controller imports go to the stand-ins, as in
// runtime-image-release.test.ts. configureReleaseFleet stays real; only its wait runs on the
// stand-in's virtual clock, so a binding wait that can never pass costs no wall time.
const release = new URL("./runtime-image-release.ts", import.meta.url).href;
const fleet = new URL("./runtime-release-fleet.ts", import.meta.url).href;
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
    if (
      (context.parentURL === release && redirected.has(specifier)) ||
      (context.parentURL === fleet && specifier === "./runtime-release-readiness.ts")
    )
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

/** PoolWorker and the database and budget Commands; the receipt Command is not in this proof. */
function releaseGraph(w: World, production: ProductionWorker) {
  let plan: ImageReleasePlan | undefined;
  const poolAttributes = (id: string) => ({
    ...attributes(id),
    accountId,
    workerName: id,
    tags: [...production.settings().tags],
    durableObjectNamespaces: production.classes(),
  });
  const memory = Effect.runSync(InMemoryService());
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
              production.deployCode(plannedContainerClasses(phase));
              return poolAttributes(input.id);
            }),
        });
      }),
    delete: () => Effect.die("Unexpected deletion"),
  });
  const commands = Command.ExecProvider().pipe(
    Layer.provide(
      Layer.succeed(Command.CommandExecutor, {
        spawn: () => Effect.die("No child processes in the release proof"),
        run: (news) =>
          Effect.sync(() => {
            w.events.push(`command:${news.command}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      }),
    ),
  );
  return Stack(
    "basalt",
    {
      providers: Layer.mergeAll(workers, commands),
      state: Layer.succeed(State, Effect.succeed(memory)),
    },
    Effect.gen(function* () {
      plan = yield* RuntimeImageReleasePlan;
      if (plan?.build) w.buildInactive(plan.build);
      yield* Command.Exec("PoolDatabase", { command: "node ensure-pool-database.ts", memo: false });
      yield* FixtureWorker("PoolWorker", {
        revision: "candidate",
        env: runtimeEnvironment(w.root.input),
      });
      yield* Command.Exec("PoolBackendBudget", {
        command: "node verify-database-budget.ts",
        memo: false,
      });
      return {};
    }),
  );
}

/**
 * One production with its Alchemy state, release journal and controller, released by `run`, which
 * is one `npm run deploy` of the candidate on a fresh runner.
 */
async function releaseProduction(t: { after: (fn: () => void) => void }) {
  const w = createWorld();
  installWorld(w);
  const production = productionPoolWorker(target);
  standin.installProductionWorker(production);
  standin.resetBootstrap();
  standin.resetJournal();
  const scratch = mkdtempSync(join(tmpdir(), "runtime-image-release-rerun-"));
  const network = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`Release proof refused a real network call to ${new Request(input).url}`);
  };
  t.after(() => {
    globalThis.fetch = network;
    rmSync(scratch, { recursive: true, force: true });
  });
  const stack = releaseGraph(w, production);
  const config = ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        GITHUB_SHA: candidate,
        EXECUTOR_ENCRYPTION_KEY: "b".repeat(64),
        CLOUDFLARE_API_TOKEN: "synthetic-api-token",
      },
    }),
  );
  const provide = <A, E>(effect: Effect.Effect<A, E, never>) =>
    Effect.runPromiseExit(effect.pipe(Effect.provide(config)));
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
  w.events.length = 0;
  let runs = 0;
  const run = async () => {
    const exit = await provide(
      releaseRuntimeImage(stack, {
        candidate,
        directory: mkdtempSync(join(scratch, `barrier-${++runs}-`)),
        writer: {} as RuntimeReleaseWriter,
        encryptionKey: "b".repeat(64),
        forwardEncryptionKey: "b".repeat(64),
        record: async () => {},
        manifest: async () => {},
        declarations: decodeDeclaredChanges({ ...repository, changes: [poolWorkerEntry] }),
        declared: async () => {},
        declaredReadiness: async () => {},
        expansion: async () => {},
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
    return Exit.isSuccess(exit) ? undefined : Cause.squash(exit.cause);
  };
  return { w, production, run };
}

/** The controller loses the connection once, before it commits this configuration. */
function failConfigureOnce(w: World, operationId: string) {
  const configure = w.configure;
  let failed = false;
  w.configure = (id: string, configuration: FleetConfiguration) => {
    if (id === operationId && !failed) {
      failed = true;
      throw new TypeError("fetch failed");
    }
    return configure(id, configuration);
  };
}

test("a release killed after the inactive image's Worker activation is finished by a rerun", async (t) => {
  const { w, production, run } = await releaseProduction(t);
  const imageConfigure = `image-configure-${candidate}`;
  failConfigureOnce(w, imageConfigure);

  assert.match(String(await run()), /fetch failed/u);
  // The image phase activated PoolWorker with the candidate's pins for the inactive application,
  // so live bindings no longer match the configuration the controller retained before it.
  const stopped = standin.readJournal()!;
  const configure = stopped.configurations[`configure-${candidate}`]!;
  const inactive = configure.active === "blue" ? "green" : "blue";
  assert.notEqual(
    configure.applications.find((app) => app.color === inactive)?.imageInput,
    candidateInput,
  );
  assert.ok(
    w
      .fleet()
      .bindings.some(
        (binding) => binding.color === inactive && binding.imageInput === candidateInput,
      ),
  );
  assert.equal(w.controller.permissions.has(imageConfigure), false);
  assert.equal(stopped.complete, false);

  const failure = await run();
  assert.equal(failure, undefined, JSON.stringify({ failure: String(failure), events: w.events }));
  assert.equal(standin.readJournal()?.complete, true);
  // The retained configuration was read back, not sent again; only the image one was sent.
  assert.deepEqual(
    w.events.filter((event) => event.startsWith("fleet-configure:")),
    [`fleet-configure:configure-${candidate}`, `fleet-configure:${imageConfigure}`],
  );
  assert.equal(w.controller.selection?.active.target.imageInput, candidateInput);
  assert.deepEqual(
    w.byColor(inactive)!.instances.map((row) => row.image),
    [candidateImage.ref],
  );
  assert.deepEqual(production.log.refusals, []);
});

test("a rerun whose controller retained a different configuration under its operation refuses before sending", async (t) => {
  const { w, run } = await releaseProduction(t);
  failConfigureOnce(w, `image-configure-${candidate}`);
  assert.match(String(await run()), /fetch failed/u);
  const operationId = `configure-${candidate}`;
  const retained = w.controller.permissions.get(operationId)!;
  w.controller.permissions.set(operationId, {
    ...retained,
    configuration: { ...retained.configuration, maximum: retained.configuration.maximum + 1 },
  });
  const sent = w.events.filter((event) => event.startsWith("fleet-configure:")).length;

  const refusal = await run();
  assert.ok(refusal instanceof BarrierRefusal, String(refusal));
  assert.equal(refusal.reason, "provisioning-input-drift");
  assert.deepEqual(
    refusal.delta?.changed.map((change) => change.path),
    ["runtime-release.fleet-retained-configuration"],
  );
  assert.equal(w.events.filter((event) => event.startsWith("fleet-configure:")).length, sent);
  assert.equal(standin.readJournal()?.complete, false);
});
