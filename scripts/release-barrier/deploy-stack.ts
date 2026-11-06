import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import { havePropsChanged } from "alchemy/Diff";
import { State } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import type { Worker } from "alchemy/Cloudflare";
import { Effect } from "effect";
import { preparePlan, finishPlan } from "./alchemy-plan.ts";
import { readBaseline, uploadVersion } from "./cloudflare.ts";
import { releaseWorkers, type BarrierReceipt } from "./barrier.ts";
import { BarrierRefusal, describeWorker, type ReleaseManifest } from "./manifest.ts";
import { freezeUpload } from "./version-request.ts";

export interface DeployStackOptions {
  candidate: string;
  record(receipt: BarrierReceipt): Promise<void>;
  manifest(value: {
    candidate: string;
    stack: string;
    stage: string;
    workers: ReturnType<typeof describeWorker>[];
  }): Promise<void>;
  io?: { baseline: typeof readBaseline; upload: typeof uploadVersion };
}

type Services = Effect.Services<ReturnType<typeof readBaseline> | ReturnType<typeof Apply.apply>>;

/** The ordinary release entry uses this full-stack path, including transitive Commands. */
export const deployStack = (stack: CompiledStack, options: DeployStackOptions) =>
  Effect.gen(function* () {
    const plan = yield* Plan.make(stack);
    const prepared = yield* preparePlan(stack, plan);
    const context = yield* Effect.context<Services>();
    const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
      Effect.runPromise(effect.pipe(Effect.provideContext(context)));
    const io = options.io ?? { baseline: readBaseline, upload: uploadVersion };
    const manifest: ReleaseManifest = {
      candidate: options.candidate,
      stack: stack.name,
      stage: stack.stage,
      workers: yield* Effect.promise(() =>
        Promise.all(
          [...prepared.captured.values()]
            .sort((a, b) => a.fqn.localeCompare(b.fqn))
            .map(async (upload) => freezeUpload(upload, await run(io.baseline(upload.request)))),
        ),
      ),
    };
    yield* Effect.promise(() =>
      options.manifest({
        candidate: manifest.candidate,
        stack: manifest.stack,
        stage: manifest.stage,
        workers: manifest.workers.map(describeWorker),
      }),
    );
    const activated = new Map<string, Worker["Attributes"]>();
    const databaseFqns = new Set<string>();
    const database = Effect.gen(function* () {
      const state = yield* yield* State;
      const current = yield* Effect.all(
        Object.entries(plan.resources).map(([fqn, node]) =>
          state
            .get({ stack: stack.name, stage: stack.stage, fqn })
            .pipe(Effect.map((value) => ({ fqn, value, expected: node.state }))),
        ),
      );
      if (current.some(({ value, expected }) => havePropsChanged(value ?? {}, expected ?? {})))
        throw new BarrierRefusal("alchemy-state-drift");
      const databasePlan = yield* Plan.make(stack, { include: ["PoolDatabase"] });
      if (
        Object.values(databasePlan.resources).some(
          (node) => node.resource.Type === "Cloudflare.Worker",
        ) ||
        Object.keys(databasePlan.deletions).length ||
        Object.keys(databasePlan.actions).length
      )
        throw new BarrierRefusal("unsafe-database-selection");
      for (const fqn of Object.keys(databasePlan.resources)) databaseFqns.add(fqn);
      yield* Apply.apply(databasePlan);
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
        }),
      catch: (error) =>
        error instanceof BarrierRefusal ? error : new BarrierRefusal("release-operation-failed"),
    });
    return yield* finishPlan(prepared, activated, databaseFqns);
  });
