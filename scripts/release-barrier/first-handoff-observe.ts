import { Effect } from "effect";
import type { SlotIdentity } from "../../src/pool/runtime-slots/contract.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import type { Fetcher } from "../deploy-safety/http.ts";
import { openDeploymentReadiness, withinDeadline } from "../database-budget-readiness.ts";
import { containerCodeAdoptionMs, waitForContainerCode } from "./container-adoption.ts";
import { servingClock } from "./serving-clock.ts";
import { verifyContainerHealth } from "./container-health.ts";
import { readRuntimeProviderProof } from "./runtime-slot-provider-proof.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";
import type { FirstHandoffManifest } from "./first-handoff-contract.ts";

interface ObservationInput {
  manifest: FirstHandoffManifest;
  signingKey: string;
  target: PoolOperationsTarget;
  fetcher?: Fetcher;
  now?: () => number;
}

async function readiness<A>(
  input: ObservationInput,
  role: "legacy" | "candidate",
  read: (connection: Awaited<ReturnType<typeof openDeploymentReadiness>>) => Promise<A>,
) {
  const runtime = input.manifest[role];
  const opening = openDeploymentReadiness({
    ...input.target,
    key: input.signingKey,
    target: { ...runtime.controllerCode, imageHash: runtime.target.imageInput },
  });
  let connection: Awaited<typeof opening> | undefined;
  try {
    connection = await withinDeadline(opening, 15_000);
    return await read(connection);
  } finally {
    if (connection) await withinDeadline(connection.close(), 15_000);
    else void opening.then((connection) => connection.close()).catch(() => {});
  }
}

/** Before adoption there is no selected capsule. Afterward the exact ACK/readback owns same-boot health. */
export const observeFirstHandoffLegacy = (input: ObservationInput, phase: "baseline" | "code") =>
  Effect.gen(function* () {
    const { legacy, legacyBootId } = input.manifest;
    yield* readRuntimeProviderProof(legacy, "runtime", input.fetcher, input.now);
    return yield* Effect.tryPromise({
      try: async () => {
        if (phase === "baseline") {
          const health = await verifyContainerHealth(
            input.target,
            legacy.target.imageInput,
            AbortSignal.timeout(15_000),
          );
          sameProvisioningValue(
            "firstHandoff.legacy.boot",
            { instanceId: legacy.target.instanceId, bootId: legacyBootId },
            { instanceId: health.instanceId, bootId: health.bootId },
          );
        } else
          await readiness(input, "legacy", async (connection) => {
            const deadline = servingClock.deadline(containerCodeAdoptionMs);
            try {
              await waitForContainerCode(
                connection,
                { ...legacy.controllerCode, imageHash: legacy.target.imageInput },
                servingClock,
                servingClock.now() + containerCodeAdoptionMs,
                deadline.signal,
              );
            } finally {
              deadline.dispose();
            }
          });
      },
      catch: (error: unknown) => error,
    });
  });

export const observeFirstHandoffSelected = (input: ObservationInput, identity: SlotIdentity) =>
  Effect.gen(function* () {
    yield* readRuntimeProviderProof(input.manifest.candidate, "runtime", input.fetcher, input.now);
    return yield* Effect.tryPromise({
      try: () =>
        readiness(input, "candidate", async (connection) => {
          const ready = await withinDeadline(connection.ready(AbortSignal.timeout(15_000)), 15_000);
          sameProvisioningValue(
            "firstHandoff.selected.ready",
            { instanceId: identity.instanceId, bootId: identity.bootId },
            { instanceId: ready.instanceId, bootId: ready.bootId },
          );
        }),
      catch: (error: unknown) => error,
    });
  });
