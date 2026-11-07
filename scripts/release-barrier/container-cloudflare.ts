import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { Config, Effect, Redacted, Schema } from "effect";
import {
  cloudflareResult,
  encodePathSegment,
  withBearer,
  type Fetcher,
} from "../deploy-safety/http.ts";
import { waitForContainerImage } from "../deploy-safety/pool-image.ts";
import { BarrierRefusal } from "./manifest.ts";
import { imageDigest, type ContainerAttributes, type FrozenContainer } from "./container.ts";
import { brand } from "../../brand.ts";
import { verifyContainerHealth } from "./container-health.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import { waitForPoolStatus } from "../pool-readiness.ts";
import { sameContainerState, containerSnapshot, type ContainerSnapshot } from "./container.ts";

import { decodeApplication } from "./container-observation.ts";
import { containerDrift } from "./container-diagnostics.ts";
export { decodeApplication, containerAttributes } from "./container-observation.ts";

export const observeContainer = (
  target: { accountId: string; applicationId: string },
  fetcher: Fetcher = fetch,
) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    return yield* Effect.tryPromise({
      try: async () => {
        const response = await fetcher(
          `https://api.cloudflare.com/client/v4/accounts/${encodePathSegment(target.accountId)}/containers/applications/${encodePathSegment(target.applicationId)}`,
          {
            method: "GET",
            redirect: "error",
            headers: withBearer(Redacted.value(token)),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          throw new BarrierRefusal("container-observation-failed");
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 2_000_000) throw new BarrierRefusal("container-observation-too-large");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
        const result = decodeApplication(
          cloudflareResult(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
            "container observation",
          ).result,
        );
        if (result.accountId !== target.accountId || result.applicationId !== target.applicationId)
          throw containerDrift("container-observation-target-drift", target, {
            accountId: result.accountId,
            applicationId: result.applicationId,
          });
        return result;
      },
      catch: (error) =>
        error instanceof BarrierRefusal
          ? error
          : new BarrierRefusal("container-observation-failed"),
    });
  });

const rolloutReceipt = Schema.Struct({
  id: Schema.String,
  current_version: Schema.Number,
  target_version: Schema.Number,
});
export interface ContainerRollout {
  readonly id: string;
  readonly currentVersion: number;
  readonly targetVersion: number;
}

/** The pinned SDK returns these raw fields but incorrectly declares an Application response. */
export function decodeContainerRollout(value: unknown): ContainerRollout {
  try {
    const receipt = Schema.decodeUnknownSync(rolloutReceipt)(value);
    if (
      !receipt.id.trim() ||
      !Number.isSafeInteger(receipt.current_version) ||
      !Number.isSafeInteger(receipt.target_version) ||
      receipt.target_version <= receipt.current_version
    )
      throw new Error("Invalid rollout versions");
    return {
      id: receipt.id,
      currentVersion: receipt.current_version,
      targetVersion: receipt.target_version,
    };
  } catch {
    throw new BarrierRefusal("container-rollout-unconfirmed");
  }
}

export const waitForContainerVersion = (
  target: ContainerSnapshot,
  rollout: ContainerRollout,
  read = () => observeContainer(target),
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof read>>>();
    let result: ContainerAttributes | undefined;
    yield* Effect.tryPromise({
      try: () =>
        waitForPoolStatus("Container rollout version", 200, async () => {
          const current = await Effect.runPromise(read().pipe(Effect.provideContext(context)));
          if (current.activeRolloutId && current.activeRolloutId !== rollout.id)
            throw containerDrift(
              "container-rollout-drift",
              { activeRolloutId: rollout.id },
              { activeRolloutId: current.activeRolloutId },
            );
          if (
            current.version !== rollout.currentVersion &&
            current.version !== rollout.targetVersion
          )
            throw containerDrift(
              "container-version-drift",
              { version: rollout.targetVersion },
              { version: current.version },
            );
          if (
            !sameContainerState(
              {
                ...current,
                version: rollout.targetVersion,
                activeRolloutId: undefined,
                configuration: { ...current.configuration, image: target.configuration.image },
              },
              { ...target, version: rollout.targetVersion },
            )
          )
            throw containerDrift(
              "container-configuration-drift",
              { ...target, version: rollout.targetVersion },
              containerSnapshot(current),
            );
          if (!sameContainerState(current, { ...target, version: rollout.targetVersion })) {
            if (current.version === rollout.targetVersion && !current.activeRolloutId)
              throw containerDrift(
                "container-configuration-drift",
                { ...target, version: rollout.targetVersion },
                containerSnapshot(current),
              );
            return new Response(null, { status: 503 });
          }
          result = current;
          return new Response(null, { status: 200 });
        }),
      catch: (error) =>
        error instanceof BarrierRefusal
          ? error
          : new BarrierRefusal("container-rollout-not-adopted"),
    });
    if (!result) throw new BarrierRefusal("container-rollout-not-adopted");
    return result;
  });

export const rolloutRestoredContainer = (container: FrozenContainer) =>
  Containers.createContainerApplicationRollout({
    accountId: container.baseline.accountId,
    applicationId: container.baseline.applicationId,
    targetConfiguration: structuredClone(container.baseline.configuration),
    strategy: "rolling",
    kind: "full_manual",
    stepPercentage: 100,
    description: "Recorded container recovery",
  }).pipe(Retry.none, Effect.map(decodeContainerRollout));

export const verifyRestoredContainer = (
  container: FrozenContainer,
  worker: PoolOperationsTarget,
  workerImageHash: string,
) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    return yield* Effect.tryPromise({
      try: async () => {
        const health = await waitForContainerImage(
          {
            applicationId: container.baseline.applicationId,
            accountId: container.baseline.accountId,
            digest: imageDigest(container.baseline.configuration.image),
          },
          { accountId: container.baseline.accountId, apiToken: Redacted.value(token) },
          `https://${brand.host}`,
          fetch,
          {},
          (signal) => verifyContainerHealth(worker, workerImageHash, signal),
        );
        if (!health) throw new BarrierRefusal("container-recovery-runtime-unhealthy");
        return health;
      },
      catch: (error) =>
        error instanceof BarrierRefusal
          ? error
          : new BarrierRefusal("container-recovery-image-not-adopted", container.id),
    });
  });
