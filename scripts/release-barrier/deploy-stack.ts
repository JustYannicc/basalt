import { operationFailure, withOperation } from "./operation-failure.ts";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import type { CompiledStack } from "alchemy/Stack";
import type { Worker } from "alchemy/Cloudflare";
import { Effect } from "effect";
import { verificationAdmissions, type VerificationAdmission } from "./plan-admission.ts";
import { preparePlan, finishPlan } from "./alchemy-plan.ts";
import { readBaseline, uploadVersion } from "./cloudflare.ts";
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
import { prepareDeclaredBuckets } from "./declared-bucket-plan.ts";
import { preserveDeclarationHistory } from "./declared-history.ts";
import {
  assertBaselineWorkerInput,
  inspectContainer,
  type ContainerAttributes,
} from "./container.ts";
import {
  observeContainer,
  decodeContainerRollout,
  waitForContainerVersion,
} from "./container-cloudflare.ts";

export interface DeployStackOptions {
  candidate: string;
  declarations?: DeclaredChanges;
  declared?(progress: BucketProgress): Promise<void>;
  declaredReadiness?(value: DeclaredReadiness): Promise<void>;
  record(receipt: BarrierReceipt): Promise<void>;
  manifest(value: ReleaseManifest): Promise<void>;
  publication?(container: FrozenContainer, normalization?: BaselineNormalization): Promise<void>;
  admission?(verifications: readonly VerificationAdmission[]): Promise<void>;
  serving?(container: ServingContainer): Promise<void>;
  io?: {
    buckets?: BucketProvider;
    baseline: typeof readBaseline;
    upload: typeof uploadVersion;
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
    const evaluatedPlan = yield* Plan.make(stack).pipe(withOperation("(plan)", "plan-stack"));
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
    const prerequisites = (phase: DeclaredReadiness["phase"]) =>
      recordDeclaredReadiness(
        plan,
        options.declarations,
        scope,
        buckets,
        phase,
        options.declaredReadiness,
      );
    const declaredBuckets = yield* prepareDeclaredBuckets(
      evaluatedPlan,
      options.declarations,
      stack.name,
      stack.stage,
      buckets,
    );
    const plan = {
      ...evaluatedPlan,
      resources: Object.fromEntries(
        Object.entries(evaluatedPlan.resources).map(([fqn, node]) => [
          fqn,
          declaredBuckets.get(fqn)?.resume && node.action === "create"
            ? { ...node, state: declaredBuckets.get(fqn)!.native }
            : node,
        ]),
      ),
    };
    yield* prerequisites("before-upload");
    for (const bucket of declaredBuckets.values())
      yield* Effect.promise(() =>
        options.declared!({ bucket, lifecycle: "planned", outcome: "not-started" }),
      );
    const prepared = yield* preparePlan(
      stack,
      plan,
      options.io?.namespace,
      options.io?.container,
      options.publication,
      options.declarations,
      declaredBuckets,
    );
    const recordAdmission = options.admission;
    if (recordAdmission) yield* Effect.promise(() => recordAdmission(verificationAdmissions(plan)));
    for (const { frozen } of prepared.containers.values())
      assertBaselineWorkerInput(frozen, prepared.captured.get("PoolWorker")?.previousSettings);
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
                return await freezeUpload(upload, baseline);
              } catch (error) {
                throw operationFailure(error, upload.fqn, "freeze-worker-upload");
              }
            }),
        ),
      ),
    };
    yield* Effect.promise(() => options.manifest(manifest));
    yield* prerequisites("before-upload");
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
      for (const fqn of declaredBuckets.keys()) {
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
          record: options.record,
          beforeActivate: () => run(database),
          provider: {
            upload: (worker) => run(io.upload(worker)),
            baseline: (worker) => run(io.baseline(worker)),
            async activate(worker, versionId) {
              const upload = prepared.captured.get(worker.id);
              if (!upload) throw new BarrierRefusal("missing-prepared-worker", worker.id);
              activated.set(worker.id, await run(upload.activate(versionId)));
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
    return yield* preserveDeclarationHistory(
      finishPlan(prepared, activated, databaseFqns, activatedContainers),
      { stack: stack.name, stage: stack.stage },
    );
  });
