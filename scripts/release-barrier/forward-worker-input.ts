import type { BaselineWorkerSettings } from "./serving-worker-input.ts";
import {
  assertBaselineWorkerInput,
  containerSnapshot,
  type ContainerAttributes,
  type FrozenContainer,
} from "./container.ts";
import {
  BarrierRefusal,
  canonical,
  digest,
  describeWorker,
  type FrozenWorker,
} from "./manifest.ts";
import type { ForwardPacket } from "./forward-model.ts";

export interface ForwardInputProof {
  baseline: string;
  containerInputHash: string;
  workerInputHash: string;
  workerTarget: string;
  workerVersions: readonly { versionId: string; percentage: number }[];
}

/** Runtime recovery reports the deployed Worker's binding, independently of the container's image. */
export function forwardWorkerInput(
  packet: ForwardPacket,
  current:
    | { target: string; versions: readonly { versionId: string; percentage: number }[] }
    | undefined,
  observed: ContainerAttributes,
  containerInputHash: string,
) {
  const worker = packet.manifest.workers.find((worker) => worker.id === "PoolWorker");
  const container = packet.frozen.containers[0]!;
  const accepted = packet.receipt.accepted.find((worker) => worker.worker === "PoolWorker");
  if (!worker || !current || current.target !== worker.target)
    throw new BarrierRefusal("forward-worker-input-unconfirmed", "PoolWorker");
  const baseline = canonical(current.versions) === canonical(worker.baseline);
  if (
    !baseline &&
    (!accepted ||
      canonical(current.versions) !==
        canonical([{ versionId: accepted.versionId, percentage: 100 }]))
  )
    throw new BarrierRefusal("forward-worker-input-unconfirmed", "PoolWorker");
  const workerInputHash = baseline
    ? (worker.baselineImageHash ?? container.baselineInputHash)
    : container.inputHash;
  const continuation: ForwardInputProof | undefined =
    workerInputHash === containerInputHash
      ? undefined
      : {
          baseline: digest(canonical(containerSnapshot(observed))),
          containerInputHash,
          workerInputHash,
          workerTarget: current.target,
          workerVersions: current.versions,
        };
  return { workerInputHash, continuation };
}

/** A journal-proven mixed release permits only the exact observed binding and container baseline. */
export function assertJournaledBaselineInput(
  container: Pick<FrozenContainer, "baseline" | "baselineInputHash">,
  settings: BaselineWorkerSettings | undefined,
  worker: FrozenWorker | undefined,
  proof?: ForwardInputProof,
) {
  try {
    assertBaselineWorkerInput(container, settings);
    return;
  } catch (error) {
    const hashes =
      settings?.bindings?.filter((binding) => binding.name === "POOL_IMAGE_HASH") ?? [];
    if (
      !proof ||
      !worker ||
      worker.id !== "PoolWorker" ||
      hashes.length !== 1 ||
      hashes[0]?.type !== "plain_text" ||
      hashes[0].text !== proof.workerInputHash ||
      worker.baselineImageHash !== proof.workerInputHash ||
      describeWorker(worker).target !== proof.workerTarget ||
      canonical(worker.baseline) !== canonical(proof.workerVersions) ||
      container.baselineInputHash !== proof.containerInputHash ||
      digest(canonical(containerSnapshot(container.baseline))) !== proof.baseline
    )
      throw error;
  }
}
