import {
  d1Account,
  preflightDeclaredD1,
  declaredD1Exists,
  createDeclaredD1,
  readDeclaredD1,
} from "./d1-cloudflare.ts";
import { createDeclaredDatabases } from "./declared-d1.ts";
import type { D1Provider, D1Progress } from "./declared-d1-types.ts";
import { assertJournaledBaselineInput, type ForwardInputProof } from "./forward-worker-input.ts";
import { State } from "alchemy/State/State";
import { beginForwardJournal } from "./forward-journal.ts";
import { verifyRepairBaseline } from "./repair-baseline.ts";
import { operationFailure, withOperation } from "./operation-failure.ts";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import type { CompiledStack } from "alchemy/Stack";
import type { Worker } from "alchemy/Cloudflare";
import { Effect } from "effect";
import { verificationAdmissions, type VerificationAdmission } from "./plan-admission.ts";
import { finishPlan } from "./alchemy-plan.ts";
import { planStack } from "./plan-stack.ts";
import {
  readActivePlacements,
  readBaseline,
  readScriptSettings,
  uploadVersion,
} from "./cloudflare.ts";
import { assertRepairedPlacement, assertRepairedVersionPlacement } from "./pending-placement.ts";
import { readVersionPlacement } from "./active-placement-read.ts";
import { retirePlacement } from "./placement-retirement.ts";
import { releaseWorkers, type BarrierReceipt } from "./barrier.ts";
import { BarrierRefusal, type ReleaseManifest } from "./manifest.ts";
import { cloudflareArtifactsApi } from "../ensure-artifacts.ts";
import { verifyNativeState } from "./native-state.ts";
import type { BaselineNormalization, FrozenContainer } from "./container.ts";
import { verifyServingContainer, type ServingContainer } from "./container-serving.ts";
import { advanceContainer } from "./container-promotion.ts";
import { freezeUpload } from "./version-request.ts";
import { recordDeclaredReadiness, type DeclaredReadiness } from "./declared-prerequisites.ts";
import type { DeclaredChanges } from "./declared-change-schema.ts";
import {
  createDeclaredBuckets,
  type BucketProvider,
  type BucketProgress,
} from "./declared-buckets.ts";
import {
  bucketAccount,
  readDeclaredBucket,
  createDeclaredBucket,
  configureDeclaredBucket,
} from "./bucket-cloudflare.ts";
import { assertSupportedPlan } from "./plan-admission.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { preserveDeclarationHistory } from "./declared-history.ts";
import { preserveClassHistory } from "./class-history.ts";
import { prepareDeclaredRelease } from "./prepare-declared.ts";
import {
  readDeclaredClass,
  readClassContent,
  deployClassExpansion,
  stageClassClone,
  readClassClone,
  deleteClassClone,
} from "./class-cloudflare.ts";
import type { ClassProvider, ClassProgress } from "./declared-class-contract.ts";
import { declaredChecks } from "./declared-checks.ts";
import { observeClassReadiness } from "./class-readiness.ts";
import { inspectContainer, type ContainerAttributes } from "./container.ts";
import {
  observeContainer,
  decodeContainerRollout,
  waitForContainerVersion,
} from "./container-cloudflare.ts";

export interface DeployStackOptions {
  candidate: string;
  declarations?: DeclaredChanges;
  declared?(progress: BucketProgress | D1Progress): Promise<void>;
  declaredReadiness?(value: DeclaredReadiness): Promise<void>;
  expansion?(value: ClassProgress): Promise<void>;
  forwardInput?: ForwardInputProof;
  forwardEncryptionKey?: string;
  record(receipt: BarrierReceipt): Promise<void>;
  manifest(value: ReleaseManifest): Promise<void>;
  publication?(container: FrozenContainer, normalization?: BaselineNormalization): Promise<void>;
  admission?(verifications: readonly VerificationAdmission[]): Promise<void>;
  serving?(container: ServingContainer): Promise<void>;
  io?: {
    buckets?: BucketProvider;
    d1?: D1Provider;
    classes?: ClassProvider;
    baseline: typeof readBaseline;
    upload: typeof uploadVersion;
    placements?: typeof readActivePlacements;
    namespace?: typeof cloudflareArtifactsApi;
    container?: typeof inspectContainer;
    observeContainer?: typeof observeContainer;
    advanceContainer?: typeof advanceContainer;
    serving?: typeof verifyServingContainer;
  };
}

type Services = Effect.Services<ReturnType<typeof readBaseline> | ReturnType<typeof Apply.apply>>;

/** The ordinary release entry uses this full-stack path, including transitive Commands. */
export const deployStack = (stack: CompiledStack, options: DeployStackOptions) =>
  Effect.gen(function* () {
    const evaluatedPlan = yield* planStack(stack);
    assertSupportedPlan(evaluatedPlan, new Map(), options.declarations);
    const context = yield* Effect.context<Services>();
    const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
      Effect.runPromise(effect.pipe(Effect.provideContext(context)));
    const buckets =
      options.io?.buckets ??
      ({
        accountId: () => run(bucketAccount),
        read: (target, fqn) => run(readDeclaredBucket(target, fqn)),
        create: (target) => run(createDeclaredBucket(target)),
        configure: (target) => run(configureDeclaredBucket(target)),
      } satisfies BucketProvider);
    const d1 =
      options.io?.d1 ??
      ({
        accountId: () => run(d1Account),
        preflight: (accountId) => run(preflightDeclaredD1(accountId)),
        exists: (target) => run(declaredD1Exists(target)),
        create: (target) => run(createDeclaredD1(target)),
        read: (target, id, fqn) => run(readDeclaredD1(target, id, fqn)),
      } satisfies D1Provider);
    const scope = { stack: stack.name, stage: stack.stage };
    if (options.declarations && (!options.declared || !options.declaredReadiness))
      throw declaredMismatch(
        "declared-evidence-required",
        "release-declarations.json",
        { creationEvidence: "configured", readinessEvidence: "configured" },
        {
          creationEvidence: options.declared ? "configured" : null,
          readinessEvidence: options.declaredReadiness ? "configured" : null,
        },
      );
    const classes =
      options.io?.classes ??
      ({
        read: (target) => run(readDeclaredClass(target)),
        content: (target, version) => run(readClassContent(target, version)),
        deploy: (request) => run(deployClassExpansion(request)),
        stageClone: (request) => run(stageClassClone(request)),
        clone: (target, version) => run(readClassClone(target, version)),
        removeClone: (target, version) => run(deleteClassClone(target, version)),
      } satisfies ClassProvider);
    const { plan, prepared, declaredBuckets, declaredDatabases, declaredStorage, workerBaselines } =
      yield* prepareDeclaredRelease(stack, evaluatedPlan, options, buckets, classes, d1);
    const prerequisites = (phase: DeclaredReadiness["phase"]) =>
      declaredChecks([
        {
          fqn: "(declared storage)",
          check: recordDeclaredReadiness(
            plan,
            options.declarations,
            scope,
            buckets,
            phase,
            options.declaredReadiness,
            d1,
          ).pipe(Effect.asVoid),
        },
        {
          fqn: "(declared classes)",
          type: "Cloudflare.Worker",
          check: observeClassReadiness(
            plan,
            options.declarations,
            scope,
            classes,
            phase,
            options.expansion,
          ),
        },
      ]);
    const recordAdmission = options.admission;
    if (recordAdmission) yield* Effect.promise(() => recordAdmission(verificationAdmissions(plan)));
    const state = yield* yield* State;
    const io = options.io ?? { baseline: readBaseline, upload: uploadVersion };
    const manifest: ReleaseManifest = {
      candidate: options.candidate,
      stack: stack.name,
      stage: stack.stage,
      ...(prepared.containers.size
        ? ({
            schemaVersion: 2,
            containers: [...prepared.containers.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, value]) => value.frozen),
          } as const)
        : {}),
      workers: yield* Effect.promise(() =>
        Promise.all(
          [...prepared.captured.values()]
            .sort((a, b) => a.fqn.localeCompare(b.fqn))
            .map(async (upload) => {
              try {
                const proof = workerBaselines.get(upload.fqn)!;
                return await freezeUpload(upload, proof.baseline, proof.versions, proof.repair);
              } catch (error) {
                throw operationFailure(error, upload.fqn, "freeze-worker-upload");
              }
            }),
        ),
      ),
    };
    for (const { frozen } of prepared.containers.values())
      assertJournaledBaselineInput(
        frozen,
        {
          bindings: [
            {
              name: "POOL_IMAGE_HASH",
              type: "plain_text",
              text: manifest.workers.find((worker) => worker.id === "PoolWorker")
                ?.baselineImageHash,
            },
          ],
        },
        manifest.workers.find((worker) => worker.id === "PoolWorker"),
        options.forwardInput,
      );
    yield* Effect.promise(() => options.manifest(manifest));
    yield* prerequisites("before-upload");
    const journal = options.forwardEncryptionKey
      ? yield* beginForwardJournal(stack, manifest, options.forwardEncryptionKey)
      : undefined;
    const activated = new Map<string, Worker["Attributes"]>();
    const activatedContainers = new Map<string, ContainerAttributes>(
      [...prepared.containers].map(([id, staged]) => [id, staged.publication.proposed]),
    );
    const databaseFqns = new Set<string>();
    const databaseChanges = new Set<string>();
    const database = Effect.gen(function* () {
      for (const admit of prepared.admissions)
        yield* Effect.tryPromise({ try: admit, catch: (error) => error });
      yield* verifyNativeState(plan, stack.name, stack.stage);
      yield* createDeclaredBuckets(
        plan,
        declaredBuckets,
        { stack: stack.name, stage: stack.stage },
        buckets,
        options.candidate,
        options.declared!,
      );
      yield* createDeclaredDatabases(
        plan,
        declaredDatabases,
        scope,
        d1,
        options.candidate,
        options.declared!,
      );
      for (const fqn of declaredStorage.keys()) {
        databaseFqns.add(fqn);
        databaseChanges.add(fqn);
      }
      const databasePlan = yield* Plan.make(stack, { include: ["PoolDatabase"] });
      if (
        Object.values(databasePlan.resources).some(
          (node) => node.resource.Type === "Cloudflare.Worker",
        ) ||
        Object.keys(databasePlan.deletions).length ||
        Object.keys(databasePlan.actions).length ||
        [...prepared.databaseCommands].some((fqn) => !Object.hasOwn(databasePlan.resources, fqn)) ||
        Object.entries(databasePlan.resources).some(([fqn, node]) =>
          node.resource.Type === "Command.Exec"
            ? !prepared.databaseCommands.has(fqn)
            : node.action !== "noop",
        )
      )
        throw new BarrierRefusal("unsafe-database-selection");
      for (const [fqn, node] of Object.entries(databasePlan.resources)) {
        databaseFqns.add(fqn);
        if (node.action !== "noop") databaseChanges.add(fqn);
      }
      yield* Apply.apply(databasePlan);
      yield* verifyNativeState(plan, stack.name, stack.stage, databaseChanges);
      yield* prerequisites("before-activation");
    });
    yield* Effect.tryPromise({
      try: () =>
        releaseWorkers(manifest, {
          record: async (receipt) => {
            if (journal) await run(journal.record(receipt));
            await options.record(receipt);
          },
          beforeActivate: () => run(database),
          provider: {
            upload: (worker) => run(io.upload(worker)),
            baseline: (worker) => run(io.baseline(worker)),
            async activate(worker, versionId) {
              const upload = prepared.captured.get(worker.id);
              if (!upload) throw new BarrierRefusal("missing-prepared-worker", worker.id);
              if (worker.pendingPlacementRepair) {
                const version = await run(
                  readVersionPlacement(worker.accountId, worker.scriptName, versionId),
                );
                assertRepairedVersionPlacement(
                  worker.id,
                  versionId,
                  version,
                  worker.pendingPlacementRepair,
                );
                await run(
                  verifyRepairBaseline(
                    worker,
                    upload.request.metadata,
                    worker.pendingPlacementRepair,
                  ),
                );
              }
              activated.set(worker.id, await run(upload.activate(versionId)));
              if (worker.pendingPlacementRepair) {
                const version = await run(
                  readVersionPlacement(worker.accountId, worker.scriptName, versionId),
                );
                const settings = await run(readScriptSettings(worker));
                assertRepairedPlacement(
                  worker.id,
                  versionId,
                  version,
                  settings,
                  worker.pendingPlacementRepair,
                );
                await run(retirePlacement(state, stack, worker.id));
              }
            },
          },
          containers: {
            async verifySource(container) {
              const staged = prepared.containers.get(container.id);
              if (!staged) throw new BarrierRefusal("missing-prepared-container", container.id);
              await Effect.runPromise(staged.publication.verifySource);
            },
            async read(container) {
              const staged = prepared.containers.get(container.id);
              if (!staged) throw new BarrierRefusal("missing-prepared-container", container.id);
              return run((options.io?.observeContainer ?? observeContainer)(container.baseline));
            },
            async rollout(container) {
              const staged = prepared.containers.get(container.id);
              if (!staged) throw new BarrierRefusal("missing-prepared-container", container.id);
              return decodeContainerRollout(await Effect.runPromise(staged.publication.rollout()));
            },
            advance: (container, rollout) =>
              run((options.io?.advanceContainer ?? advanceContainer)(container.baseline, rollout)),
            async wait(container, rollout) {
              const staged = prepared.containers.get(container.id);
              if (!staged) throw new BarrierRefusal("missing-prepared-container", container.id);
              const observed = await run(
                waitForContainerVersion(
                  { ...container.baseline, configuration: container.configuration },
                  rollout,
                  () => (options.io?.observeContainer ?? observeContainer)(container.baseline),
                ),
              );
              return observed;
            },
            async verify(container, observed) {
              const staged = prepared.containers.get(container.id);
              if (!staged) throw new BarrierRefusal("missing-prepared-container", container.id);
              const worker = prepared.captured.get("PoolWorker")?.request;
              if (!worker) throw new BarrierRefusal("missing-pool-serving-target");
              const serving = await run(
                (options.io?.serving ?? verifyServingContainer)(
                  container,
                  { worker: worker.scriptName, accountId: worker.accountId },
                  options.candidate,
                  undefined,
                  { applicationVersion: observed.version },
                ),
              );
              if (options.serving)
                await options.serving({ ...serving, applicationVersion: observed.version });
              activatedContainers.set(container.id, {
                ...staged.publication.proposed,
                ...observed,
                hash: staged.publication.proposed.hash,
                dev: staged.publication.proposed.dev,
              });
            },
          },
        }),
      catch: (error) =>
        error instanceof BarrierRefusal ? error : new BarrierRefusal("release-operation-failed"),
    });
    const finalizing = preserveClassHistory(
      preserveDeclarationHistory(
        finishPlan(prepared, activated, databaseFqns, activatedContainers),
        scope,
      ),
      scope,
    );
    const finished = yield* journal
      ? finalizing.pipe(Effect.provideService(State, Effect.succeed(journal.finalizingState)))
      : finalizing;
    if (journal) yield* journal.finish();
    return finished;
  });
