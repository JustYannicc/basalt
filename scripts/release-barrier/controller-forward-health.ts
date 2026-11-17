import type { BaselineController } from "./baseline-controller.ts";
import { imageDigest, type FrozenContainer } from "./container.ts";
import { BarrierRefusal, canonical } from "./manifest.ts";

export type ForwardControllerObservation = {
  workerVersions: readonly { versionId: string; percentage: number }[];
  instances: readonly { id: string; state: string; digest: string | null }[];
  digest: string;
};

export async function controllerForwardHealth(input: {
  baseline: BaselineController;
  container: FrozenContainer;
  observation: ForwardControllerObservation;
  baselineHealth(): Promise<{ instanceId: string; bootId: string; checkedAt: number }>;
  candidateReady(): Promise<unknown>;
  candidateHealth(): Promise<{ instanceId: string; bootId: string; checkedAt: number }>;
}) {
  if (canonical(input.observation.workerVersions) === canonical(input.baseline.versions)) {
    if (
      input.container.id !== "PoolContainer" ||
      input.baseline.imageHash !== input.container.baselineInputHash ||
      input.observation.digest !== imageDigest(input.container.baseline.configuration.image) ||
      !input.observation.instances.length ||
      input.observation.instances.some(
        (instance) => instance.state !== "running" || instance.digest !== input.observation.digest,
      )
    )
      throw new BarrierRefusal("baseline-controller-placement-unconfirmed", "PoolWorker");
    const health = await input.baselineHealth();
    if (!input.observation.instances.some((instance) => instance.id === health.instanceId))
      throw new BarrierRefusal("baseline-controller-boot-instance-mismatch", "PoolWorker");
    return health;
  }
  // A partial release may already have installed candidate code. Prove that boundary before using its protocol.
  await input.candidateReady();
  return input.candidateHealth();
}
