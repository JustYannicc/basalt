import { BarrierRefusal, canonical } from "./manifest.ts";
import {
  assertConfiguredContainer,
  describeContainer,
  sameContainerState,
  type ContainerAttributes,
  type FrozenContainer,
} from "./container.ts";
import type { ContainerHealth } from "./container-health.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import type { ContainerRollout } from "./container-cloudflare.ts";
import {
  readFrozenContainers,
  type readRecoveryProgress,
  type RecoveryAdmission,
  type RecoveryManifest,
} from "./recovery-manifest.ts";
import type { RecoveryReceipt } from "./recovery.ts";

export interface ContainerRecoveryProvider {
  read(container: FrozenContainer): Promise<ContainerAttributes>;
  rollout(container: FrozenContainer): Promise<ContainerRollout>;
  wait(
    container: FrozenContainer,
    rollout: ContainerRollout,
    restored: boolean,
  ): Promise<ContainerAttributes>;
  advance(container: FrozenContainer, rollout: ContainerRollout): Promise<void>;
  observePromotion(container: FrozenContainer, rollout: ContainerRollout): Promise<void>;
  verify(container: FrozenContainer): Promise<ContainerHealth>;
}
export interface ContainerRecoveryOptions {
  frozen: unknown;
  databaseCompatible: boolean;
  provider: ContainerRecoveryProvider;
  previous?: ReturnType<typeof readRecoveryProgress>;
  connect?: PoolOperationsTarget["connect"];
}

function isRestored(current: ContainerAttributes, container: FrozenContainer) {
  return sameContainerState(current, { ...container.baseline, version: current.version });
}

/** All Worker targets are preflighted by the caller before any container recovery write. */
export async function recoverContainers(
  manifest: RecoveryManifest,
  admitted: RecoveryAdmission,
  options: ContainerRecoveryOptions,
  progress: RecoveryReceipt,
  save: () => Promise<void>,
) {
  if (!("containers" in manifest) || manifest.containers.length !== 1)
    throw new BarrierRefusal("invalid-container-recovery-manifest");
  const frozen = readFrozenContainers(options.frozen);
  if (
    frozen.candidate !== manifest.candidate ||
    frozen.stack !== manifest.stack ||
    frozen.stage !== manifest.stage ||
    canonical(frozen.containers.map(describeContainer)) !== canonical(manifest.containers) ||
    frozen.containers[0]?.id !== "PoolContainer"
  )
    throw new BarrierRefusal("private-container-manifest-mismatch");
  if (!options.databaseCompatible)
    throw new BarrierRefusal("recovery-database-compatibility-unknown");
  const container = frozen.containers[0]!;
  const previous = options.previous;
  if (
    previous &&
    (previous.candidate !== progress.candidate ||
      previous.manifest !== progress.manifest ||
      previous.containers?.some((item) => item.container !== container.id) ||
      (previous.pendingContainer && previous.pendingContainer.container !== container.id))
  )
    throw new BarrierRefusal("container-recovery-progress-mismatch");
  progress.containers = previous?.containers?.map((item) => ({ ...item })) ?? [];
  if (previous?.pendingContainer)
    progress.pendingContainer = structuredClone(previous.pendingContainer);
  // A POST may have committed before its response was lost. Matching image bytes cannot attribute it.
  if (
    progress.pendingContainer?.phase === "rollout" ||
    admitted.pendingContainer?.phase === "rollout"
  )
    throw new BarrierRefusal("container-recovery-version-unconfirmed", container.id);
  let current = await options.provider.read(container);
  const recovered = progress.containers.find((item) => item.container === container.id);
  const activation = admitted.containers?.find((item) => item.container === container.id);
  if (recovered) {
    if (!recovered.rolloutId && recovered.version !== container.baseline.version)
      throw new BarrierRefusal("container-recovery-version-unconfirmed", container.id);
    if (recovered.rolloutId) {
      if (!activation)
        throw new BarrierRefusal("container-recovery-version-unconfirmed", container.id);
      const rollout = {
        id: recovered.rolloutId,
        currentVersion: activation.version,
        targetVersion: recovered.version,
      };
      if (!recovered.promoted) {
        await options.provider.observePromotion(container, rollout);
        recovered.promoted = true;
        await save();
      }
      current = await options.provider.wait(container, rollout, true);
    }
    if (current.version !== recovered.version || !isRestored(current, container))
      throw new BarrierRefusal("container-recovery-readback-drift", container.id);
  } else if (
    (activation && !activation.unchanged) ||
    !sameContainerState(current, container.baseline)
  ) {
    if (!activation?.rolloutId || activation.unchanged)
      throw new BarrierRefusal("container-recovery-version-unconfirmed", container.id);
    const originalRollout = {
      id: activation.rolloutId,
      currentVersion: container.baseline.version,
      targetVersion: activation.version,
    };
    if (!activation.promoted) await options.provider.observePromotion(container, originalRollout);
    current = await options.provider.wait(container, originalRollout, false);
    assertConfiguredContainer(current, container);
    if (current.version !== activation.version || current.activeRolloutId)
      throw new BarrierRefusal("container-recovery-version-unconfirmed", container.id);
    progress.pendingContainer = { container: container.id, phase: "rollout" };
    await save();
    const rollout = await options.provider.rollout(container);
    if (
      !rollout.id ||
      rollout.currentVersion !== current.version ||
      !Number.isSafeInteger(rollout.targetVersion) ||
      rollout.targetVersion <= current.version
    )
      throw new BarrierRefusal("container-recovery-rollout-unconfirmed", container.id);
    progress.containers = [
      {
        container: container.id,
        version: rollout.targetVersion,
        rolloutId: rollout.id,
        promoted: false,
      },
    ];
    progress.pendingContainer = {
      container: container.id,
      phase: "advance",
      version: rollout.targetVersion,
      rolloutId: rollout.id,
    };
    await save();
    await options.provider.advance(container, rollout);
    progress.containers[0]!.promoted = true;
    progress.pendingContainer.phase = "verification";
    await save();
    current = await options.provider.wait(container, rollout, true);
    if (current.version !== rollout.targetVersion || !isRestored(current, container))
      throw new BarrierRefusal("container-recovery-readback-drift", container.id);
  }
  progress.pendingContainer = {
    container: container.id,
    phase: "verification",
    version: current.version,
  };
  await save();
  const health = await options.provider.verify(container);
  const verified = await options.provider.read(container);
  if (verified.version !== current.version || !isRestored(verified, container))
    throw new BarrierRefusal("container-recovery-verification-drift", container.id);
  const result = progress.containers.find((item) => item.container === container.id);
  if (result) Object.assign(result, { verified: true, health });
  else
    progress.containers.push({
      container: container.id,
      version: current.version,
      verified: true,
      health,
    });
  delete progress.pendingContainer;
  await save();
  return { container, observed: verified };
}
