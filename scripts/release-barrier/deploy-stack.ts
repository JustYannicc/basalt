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
import { preparePlan, finishPlan } from "./alchemy-plan.ts";
import {
  readActivePlacements,
  readBaseline,
  readCurrentDeployment,
  readScriptSettings,
  uploadVersion,
} from "./cloudflare.ts";
import { readVersionPlacement } from "./active-placement-read.ts";
import {
  pendingPlacementRepair,
  placementRepairTargets,
  assertRepairedPlacement,
  assertRepairedVersionPlacement,
} from "./pending-placement.ts";
import { retiredPlacements, retirePlacement } from "./placement-retirement.ts";
import { needsPlacementProof } from "./script-placement.ts";
import { releaseWorkers, type BarrierReceipt } from "./barrier.ts";
import { BarrierRefusal, type ReleaseManifest } from "./manifest.ts";
import { cloudflareArtifactsApi } from "../ensure-artifacts.ts";
import { verifyNativeState } from "./native-state.ts";
import type { BaselineNormalization, FrozenContainer } from "./container.ts";
import { verifyServingContainer, type ServingContainer } from "./container-serving.ts";
import { advanceContainer } from "./container-promotion.ts";
import { freezeUpload } from "./version-request.ts";
import { inspectContainer, type ContainerAttributes } from "./container.ts";
import {
  observeContainer,
  decodeContainerRollout,
  waitForContainerVersion,
} from "./container-cloudflare.ts";

export interface DeployStackOptions {
  candidate: string;
  forwardInput?: ForwardInputProof;
  forwardEncryptionKey?: string;
  record(receipt: BarrierReceipt): Promise<void>;
  manifest(value: ReleaseManifest): Promise<void>;
  publication?(container: FrozenContainer, normalization?: BaselineNormalization): Promise<void>;
  admission?(verifications: readonly VerificationAdmission[]): Promise<void>;
  serving?(container: ServingContainer): Promise<void>;
  io?: {
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
    const plan = yield* Plan.make(stack).pipe(withOperation("(plan)", "plan-stack"));
    const prepared = yield* preparePlan(
      stack,
      plan,
      options.io?.namespace,
      options.io?.container,
      options.publication,
    );
    const recordAdmission = options.admission;
    if (recordAdmission) yield* Effect.promise(() => recordAdmission(verificationAdmissions(plan)));
    const context = yield* Effect.context<Services>();
    const state = yield* yield* State;
    const retired = yield* retiredPlacements(state, stack);
    const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
      Effect.runPromise(effect.pipe(Effect.provideContext(context)));
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
              const baseline = await run(
                io.baseline(upload.request).pipe(withOperation(upload.fqn, "read-worker-baseline")),
              );
              try {
                const repairTarget = placementRepairTargets.find(
                  (target) =>
                    target.role === upload.fqn &&
                    target.scriptName === upload.request.scriptName &&
                    baseline.some((version) => version.versionId === target.version),
                );
                const versions =
                  upload.fqn === "PoolWorker" ||
                  repairTarget ||
                  needsPlacementProof(upload.previousSettings?.placement)
                    ? await run((io.placements ?? readActivePlacements)(upload.request, baseline))
                    : [];
                const repair = repairTarget
                  ? pendingPlacementRepair({
                      role: upload.fqn,
                      scriptName: upload.request.scriptName,
                      deploymentId: (await run(readCurrentDeployment(upload.request))).id,
                      baseline,
                      active: versions[0]!,
                      prior: await run(
                        readVersionPlacement(
                          upload.request.accountId,
                          upload.request.scriptName,
                          repairTarget.prior,
                        ),
                      ),
                      metadata: upload.request.metadata,
                      settings: upload.previousSettings!,
                      retired: retired.includes(upload.fqn),
                    })
                  : undefined;
                return await freezeUpload(upload, baseline, versions, repair);
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
    const finalizing = finishPlan(prepared, activated, databaseFqns, activatedContainers);
    const finished = yield* journal
      ? finalizing.pipe(Effect.provideService(State, Effect.succeed(journal.finalizingState)))
      : finalizing;
    if (journal) yield* journal.finish();
    return finished;
  });
