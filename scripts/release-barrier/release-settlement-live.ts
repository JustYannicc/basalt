import { State } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Config, Effect, Redacted, Schema } from "effect";
import { readBaseline } from "./cloudflare.ts";
import { observeContainer } from "./container-cloudflare.ts";
import type { FrozenContainer } from "./container.ts";
import type { ForwardControllerObservation } from "./controller-forward-health.ts";
import { containerKey } from "./forward-journal.ts";
import { forwardAdoption, verifyForwardWorkers, type ForwardPacket } from "./forward-model.ts";
import type { resumeForwardRelease } from "./forward-resume.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { readServingObservation } from "./serving-observation.ts";

type ForwardIo = NonNullable<Parameters<typeof resumeForwardRelease>[1]["io"]>;

/**
 * A finished controller phase leaves its forward head complete, so forward-resume has nothing to
 * reconcile and would read nothing. This reads the same live facts its baseline branch proves: the
 * journaled root record is the unchanged baseline, every Worker is on its accepted version, and the
 * root still serves the baseline image under the given health read.
 */
export const readActivatedLive = (
  stack: Pick<CompiledStack, "name" | "stage">,
  packet: ForwardPacket,
  io: { forward?: ForwardIo; container?: typeof observeContainer },
  health: (
    container: FrozenContainer,
    observation: ForwardControllerObservation,
  ) => Promise<{ instanceId: string; bootId: string }>,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    if (packet.manifest.stack !== stack.name || packet.manifest.stage !== stack.stage)
      throw new BarrierRefusal("forward-stack-drift");
    const live = new Map<
      string,
      { target: string; versions: { versionId: string; percentage: number }[] }
    >();
    for (const worker of packet.manifest.workers) {
      const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: worker.id });
      if (!row || !("resourceType" in row) || row.resourceType !== "Cloudflare.Worker")
        throw new BarrierRefusal("forward-worker-target-invalid", worker.id);
      const identity = Schema.decodeUnknownSync(
        Schema.Struct({ accountId: Schema.String, workerName: Schema.String }),
      )(row.attr);
      const target = { accountId: identity.accountId, scriptName: identity.workerName };
      const versions = yield* (io.forward?.baseline ?? readBaseline)(target);
      live.set(worker.id, { target: digest(canonical(target)), versions: [...versions] });
    }
    verifyForwardWorkers(packet, live);
    const container = packet.frozen.containers[0]!;
    const saved = yield* state.get(containerKey(stack, container.id));
    const observed = yield* (io.container ?? observeContainer)(container.baseline);
    const adoption = forwardAdoption(packet, saved, observed);
    if (
      adoption.receipt.disposition !== "baseline" ||
      adoption.receipt.before !== adoption.receipt.after
    )
      throw new BarrierRefusal("release-settlement-root-not-baseline", container.id);
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    const placements = yield* Effect.promise(() =>
      (io.forward?.observation ?? readServingObservation)(
        { ...container.baseline, version: observed.version, digest: adoption.receipt.digest },
        Redacted.value(token),
        AbortSignal.timeout(15_000),
      ),
    );
    if (
      placements.version !== observed.version ||
      placements.digest !== adoption.receipt.digest ||
      placements.activeRolloutId
    )
      throw new BarrierRefusal("release-settlement-root-not-baseline", container.id);
    const proven = yield* Effect.promise(() =>
      health(container, {
        workerVersions: live.get("PoolWorker")?.versions ?? [],
        instances: placements.instances,
        digest: adoption.receipt.digest,
      }),
    );
    return {
      instanceId: proven.instanceId,
      bootId: proven.bootId,
      native: adoption.receipt.before,
      workers: [...live].map(([worker, value]) => ({ worker, versions: value.versions })),
      evidence: { root: adoption.receipt, instances: placements.instances },
    };
  });
