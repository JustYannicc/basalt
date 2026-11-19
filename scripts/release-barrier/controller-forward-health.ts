import type { BaselineController } from "./baseline-controller.ts";
import { imageDigest, type FrozenContainer } from "./container.ts";
import { BarrierRefusal, canonical } from "./manifest.ts";

export type ForwardControllerObservation = {
  workerVersions: readonly { versionId: string; percentage: number }[];
  instances: readonly { id: string; state: string; digest: string | null }[];
  digest: string;
};

/** The legacy root serves the baseline image on running instances only. */
export function assertBaselinePlacement(
  baseline: BaselineController,
  container: FrozenContainer,
  observation: ForwardControllerObservation,
) {
  if (
    container.id !== "PoolContainer" ||
    baseline.imageHash !== container.baselineInputHash ||
    observation.digest !== imageDigest(container.baseline.configuration.image) ||
    !observation.instances.length ||
    observation.instances.some(
      (instance) => instance.state !== "running" || instance.digest !== observation.digest,
    )
  )
    throw new BarrierRefusal("baseline-controller-placement-unconfirmed", "PoolWorker");
}

export async function controllerForwardHealth(input: {
  baseline: BaselineController;
  container: FrozenContainer;
  observation: ForwardControllerObservation;
  baselineHealth(): Promise<{ instanceId: string; bootId: string; checkedAt: number }>;
  candidateReady(): Promise<unknown>;
  candidateHealth(): Promise<{ instanceId: string; bootId: string; checkedAt: number }>;
}) {
  if (canonical(input.observation.workerVersions) === canonical(input.baseline.versions)) {
    assertBaselinePlacement(input.baseline, input.container, input.observation);
    const health = await input.baselineHealth();
    if (!input.observation.instances.some((instance) => instance.id === health.instanceId))
      throw new BarrierRefusal("baseline-controller-boot-instance-mismatch", "PoolWorker");
    return health;
  }
  // A partial release may already have installed candidate code. Prove that boundary before using its protocol.
  await input.candidateReady();
  return input.candidateHealth();
}
