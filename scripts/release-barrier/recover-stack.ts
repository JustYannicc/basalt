import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { State } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Cause, Effect, Exit } from "effect";
import { readBaseline } from "./cloudflare.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import {
  recoverWorkers,
  readRecoveryManifest,
  type RecoveryReceipt,
  type RecoveryWorker,
} from "./recovery.ts";

const recoverDeployment = (
  target: { accountId: string; scriptName: string },
  worker: RecoveryWorker,
) =>
  Workers.createScriptDeployment({
    ...target,
    strategy: "percentage",
    versions: worker.baseline.map((version) => ({ ...version })),
  }).pipe(
    Retry.none,
    Effect.catchTag("CloudflareError", (error) =>
      Effect.fail(
        new BarrierRefusal(
          error.errors?.some((item) => item.code === 10220)
            ? "secret-change-refuses-rollback"
            : "recovery-provider-refused",
          worker.id,
        ),
      ),
    ),
  );

export const recoverStack = (
  stack: CompiledStack,
  manifest: unknown,
  receipt: unknown,
  record: (value: RecoveryReceipt) => Promise<void>,
) =>
  Effect.gen(function* () {
    const parsed = readRecoveryManifest(manifest);
    const ids = Object.values(stack.resources)
      .filter((resource) => resource.Type === "Cloudflare.Worker")
      .map((resource) => resource.FQN)
      .sort();
    if (
      parsed.stack !== stack.name ||
      parsed.stage !== stack.stage ||
      canonical(ids) !== canonical(parsed.workers.map((worker) => worker.id).sort())
    )
      throw new BarrierRefusal("recovery-stack-mismatch");
    const state = yield* yield* State;
    const context =
      yield* Effect.context<
        Effect.Services<ReturnType<typeof readBaseline> | ReturnType<typeof recoverDeployment>>
      >();
    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        Effect.Services<ReturnType<typeof readBaseline> | ReturnType<typeof recoverDeployment>>
      >,
    ) =>
      Effect.runPromiseExit(effect.pipe(Effect.provideContext(context))).then((exit) => {
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return exit.value;
      });
    const targets = new Map<string, { accountId: string; scriptName: string }>();
    for (const resource of Object.values(stack.resources).filter(
      (resource) => resource.Type === "Cloudflare.Worker",
    )) {
      const saved = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: resource.FQN });
      if (
        !saved ||
        !("attr" in saved) ||
        !saved.attr ||
        typeof saved.attr.accountId !== "string" ||
        typeof saved.attr.workerName !== "string"
      )
        throw new BarrierRefusal("missing-recovery-target", resource.FQN);
      targets.set(resource.FQN, {
        accountId: saved.attr.accountId,
        scriptName: saved.attr.workerName,
      });
    }
    const target = (worker: RecoveryWorker) => {
      const value = targets.get(worker.id);
      if (!value) throw new BarrierRefusal("unknown-recovery-worker", worker.id);
      return value;
    };
    return yield* Effect.tryPromise({
      try: () =>
        recoverWorkers(
          manifest,
          receipt,
          {
            async read(worker) {
              const resolved = target(worker);
              return {
                target: digest(canonical(resolved)),
                versions: await run(readBaseline(resolved)),
              };
            },
            restore: (worker) =>
              run(recoverDeployment(target(worker), worker)).then(() => undefined),
          },
          record,
        ),
      catch: (error) =>
        error instanceof BarrierRefusal ? error : new BarrierRefusal("recovery-unconfirmed"),
    });
  });
