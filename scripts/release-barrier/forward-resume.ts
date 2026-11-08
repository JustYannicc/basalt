import { containerDrift } from "./container-diagnostics.ts";
import { State } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import type { CompiledStack } from "alchemy/Stack";
import { Config, Effect, Redacted, Schema } from "effect";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import {
  encodedRecordHash,
  forwardAdoption,
  verifyForwardWorkers,
  type ForwardPacket,
} from "./forward-model.ts";
import { containerKey, readForwardJournal, writeForwardJournal } from "./forward-journal.ts";
import { forwardSeed } from "./forward-seed.ts";
import { readBaseline } from "./cloudflare.ts";
import { observeContainer } from "./container-cloudflare.ts";
import { readManualRollout } from "./container-promotion.ts";
import { verifyContainerHealth } from "./container-health.ts";
import { readServingObservation } from "./serving-observation.ts";
import { sealRecovery } from "./recovery-envelope.ts";

export const resumeForwardRelease = (
  stack: CompiledStack,
  options: { dryRun?: boolean; directory: string },
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const key = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY");
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    const journal = yield* readForwardJournal(stack, Redacted.value(key));
    if (journal?.complete) return undefined;
    const saved = yield* state.get(containerKey(stack));
    const seed = !journal
      ? yield* Effect.tryPromise({
          try: () => forwardSeed(saved, Redacted.value(key)),
          catch: (error) => error,
        })
      : undefined;
    const packet: ForwardPacket = journal && !journal.complete ? journal.packet : seed!.packet;
    if (packet.manifest.stack !== stack.name || packet.manifest.stage !== stack.stage)
      throw new BarrierRefusal("forward-stack-drift");
    const live = new Map<
      string,
      { target: string; versions: { versionId: string; percentage: number }[] }
    >();
    let pool: { accountId: string; scriptName: string } | undefined;
    for (const worker of packet.manifest.workers) {
      const resource = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: worker.id });
      if (
        !resource ||
        !("resourceType" in resource) ||
        resource.resourceType !== "Cloudflare.Worker"
      )
        throw new BarrierRefusal("forward-worker-target-invalid", worker.id);
      const attr = resource.status === "updating" ? resource.old.attr : resource.attr;
      const identity = Schema.decodeUnknownSync(
        Schema.Struct({ accountId: Schema.String, workerName: Schema.String }),
      )(attr);
      const target = { accountId: identity.accountId, scriptName: identity.workerName };
      const versions = yield* readBaseline(target);
      live.set(worker.id, { target: digest(canonical(target)), versions });
      if (worker.id === "PoolWorker") pool = target;
    }
    verifyForwardWorkers(packet, live);
    const container = packet.frozen.containers[0]!;
    const observed = yield* observeContainer(container.baseline);
    const adoption = forwardAdoption(packet, saved, observed);
    const activation = packet.receipt.containers?.find((item) => item.container === container.id);
    if (adoption.receipt.disposition !== "baseline" && activation?.rolloutId) {
      const rollout = yield* readManualRollout(container.baseline, {
        id: activation.rolloutId,
        currentVersion: container.baseline.version,
        targetVersion: activation.version,
      });
      if (rollout.status !== "completed") throw new BarrierRefusal("forward-rollout-not-complete");
    }
    const placements = yield* Effect.tryPromise({
      try: () =>
        readServingObservation(
          { ...container.baseline, version: observed.version, digest: adoption.receipt.digest },
          Redacted.value(token),
          AbortSignal.timeout(15_000),
        ),
      catch: (error) => error,
    });
    if (
      placements.version !== observed.version ||
      placements.digest !== adoption.receipt.digest ||
      placements.activeRolloutId
    )
      throw containerDrift(
        "forward-application-observation-drift",
        { version: observed.version, digest: adoption.receipt.digest, activeRolloutId: null },
        {
          version: placements.version,
          digest: placements.digest,
          activeRolloutId: placements.activeRolloutId ?? null,
        },
      );
    if (
      !pool ||
      !placements.instances.length ||
      placements.instances.some(
        (instance) => instance.state !== "running" || instance.digest !== adoption.receipt.digest,
      )
    )
      throw new BarrierRefusal("forward-instance-not-serving");
    const health = yield* Effect.tryPromise({
      try: () =>
        verifyContainerHealth(
          { worker: pool!.scriptName, accountId: pool!.accountId },
          adoption.receipt.inputHash,
          AbortSignal.timeout(30_000),
          true,
        ),
      catch: (error) => error,
    });
    if (!placements.instances.some((instance) => instance.id === health.instanceId))
      throw new BarrierRefusal("forward-boot-instance-mismatch");
    const report = {
      ...adoption.receipt,
      readOnly: !!options.dryRun,
      instanceId: health.instanceId,
      bootId: health.bootId,
      instances: placements.instances,
      workers: [...live].map(([worker, value]) => ({ worker, versions: value.versions })),
      undo: { requiresCurrentHash: adoption.receipt.after, restoreHash: adoption.receipt.before },
    };
    const backup =
      report.disposition === "already-adopted" && packet.adoption
        ? packet.adoption.backup
        : sealRecovery(
            {
              schemaVersion: 1,
              before: encodeState(adoption.before),
              after: encodeState(adoption.after),
              receipt: report,
            },
            Redacted.value(key),
            packet.manifest.candidate,
            packet.receipt.manifest,
          );
    yield* Effect.promise(async () => {
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      await writeFile(
        resolve(options.directory, "forward-native-backup.sealed.json"),
        JSON.stringify(backup),
        { mode: 0o600 },
      );
      await writeFile(
        resolve(options.directory, "forward-reconciliation.json"),
        JSON.stringify(report, null, 2),
        { mode: 0o600 },
      );
    });
    if (options.dryRun) return report;
    if (seed && (seed.approvedBefore !== report.before || seed.approvedAfter !== report.after))
      throw new BarrierRefusal("forward-seed-awaits-reviewed-hashes");
    const current = yield* state.get(containerKey(stack));
    if (encodedRecordHash(current) !== report.before)
      throw new BarrierRefusal("forward-native-before-drift", "PoolContainer");
    if (report.disposition === "already-adopted") {
      yield* writeForwardJournal(state, stack, Redacted.value(key), packet, true, packet.adoption);
      return report;
    }
    // Persist the exact backup and write intent before the only resource record write.
    yield* writeForwardJournal(state, stack, Redacted.value(key), packet, false, {
      before: report.before,
      after: report.after,
      backup,
    });
    if (report.before !== report.after)
      yield* state.set({ ...containerKey(stack), value: adoption.after });
    const after = yield* state.get(containerKey(stack));
    if (encodedRecordHash(after) !== report.after)
      throw new BarrierRefusal("forward-native-write-unconfirmed", "PoolContainer");
    yield* writeForwardJournal(state, stack, Redacted.value(key), packet, true, {
      before: report.before,
      after: report.after,
      backup,
    });
    return report;
  });
