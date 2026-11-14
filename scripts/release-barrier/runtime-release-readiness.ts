import { openDeploymentReadiness, bounded } from "../database-budget-readiness.ts";
import { containerCodeAdoptionMs, waitForContainerCode } from "./container-adoption.ts";
import { servingClock, type ServingClock } from "./serving-clock.ts";
import type { RuntimeReleaseClient } from "./runtime-release-client.ts";
import type { RuntimeReleaseState } from "./runtime-release-state.ts";
import type { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import { BarrierRefusal } from "./refusal.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";

export async function releaseCodeReady(state: RuntimeReleaseState, code: ControllerCode) {
  const connection = await openDeploymentReadiness({
    ...state.target,
    key: state.deploymentKey,
    target: { ...code, imageHash: state.applications.root.image.inputHash },
  });
  const deadline = servingClock.deadline(containerCodeAdoptionMs);
  try {
    return await waitForContainerCode(
      connection,
      { ...code, imageHash: state.applications.root.image.inputHash },
      servingClock,
      servingClock.now() + containerCodeAdoptionMs,
      deadline.signal,
    );
  } finally {
    deadline.dispose();
    await connection.close();
  }
}

/** Only passive reads repeat. A failed or unknown mutation never enters this loop. */
export async function waitReleaseObservation<A>(
  read: () => Promise<A>,
  accepted: (value: A) => boolean,
  resource: string,
  milliseconds = 30 * 60_000,
  clock: ServingClock = servingClock,
) {
  const end = clock.now() + milliseconds;
  const deadline = clock.deadline(milliseconds);
  try {
    for (;;) {
      const value = await bounded(read(), deadline.signal);
      if (clock.now() < end && accepted(value)) return value;
      if (clock.now() >= end)
        throw new BarrierRefusal("runtime-release-observation-deadline", resource);
      await bounded(clock.sleep(Math.min(1_000, end - clock.now())), deadline.signal);
    }
  } finally {
    deadline.dispose();
  }
}

export async function releaseSelectedReady(
  state: RuntimeReleaseState,
  code: ControllerCode,
  client: RuntimeReleaseClient,
  desiredInput: string,
) {
  const before = await client.inspect();
  if (
    before.selection?.active.target.imageInput !== desiredInput ||
    before.selection.active.fenced ||
    before.selection.active.retirement
  )
    throw new BarrierRefusal("runtime-release-selected-image-not-current", "PoolWorker");
  await client.health();
  const connection = await openDeploymentReadiness({
    ...state.target,
    key: state.deploymentKey,
    target: { ...code, imageHash: state.applications.root.image.inputHash },
  });
  try {
    const ready = await bounded(
      connection.ready(AbortSignal.timeout(15_000)),
      AbortSignal.timeout(15_000),
    );
    sameProvisioningValue(
      "runtime-release-final-ready-identity",
      before.selection.active.identity,
      { ...before.selection.active.target, bootId: ready.bootId, instanceId: ready.instanceId },
    );
    const after = await client.inspect();
    sameProvisioningValue("runtime-release-final-selection", before.selection, after.selection);
    sameProvisioningValue("runtime-release-final-policy", before.digest, after.digest);
    return ready;
  } finally {
    await connection.close();
  }
}
