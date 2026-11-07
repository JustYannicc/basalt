import { Config, Effect, Redacted } from "effect";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import { openDeploymentReadiness, bounded, liveDeadline } from "../database-budget-readiness.ts";
import { waitForContainerImage } from "../deploy-safety/pool-image.ts";
import { verifyContainerHealth } from "./container-health.ts";
import { BarrierRefusal } from "./manifest.ts";
import type { FrozenContainer } from "./container.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import type { Fetcher } from "../deploy-safety/http.ts";
import { brand } from "../../brand.ts";

export const verifyServingContainer = (
  container: FrozenContainer,
  worker: PoolOperationsTarget,
  candidate: string,
  fetcher: Fetcher = fetch,
) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    const key = yield* Config.Redacted("POOL_DEPLOYMENT_KEY");
    return yield* Effect.tryPromise({
      try: async () => {
        // Move the existing 240-second image verification before native commit. Keep readiness within its existing 180-second bound.
        const origin = `https://${brand.host}`;
        const deadline = liveDeadline(240_000);
        const started = Date.now();
        const opening = openDeploymentReadiness({
          ...worker,
          key: Redacted.value(key),
          target: { candidate, workerInput: poolWorkerRevision, imageHash: container.inputHash },
        });
        let connection: Awaited<typeof opening> | undefined;
        try {
          const startup = AbortSignal.any([deadline.signal, AbortSignal.timeout(180_000)]);
          connection = await bounded(opening, startup);
          const ready = await bounded(connection.ready(startup), startup);
          const remaining = 240_000 - (Date.now() - started);
          if (remaining <= 0) throw new Error();
          const health = await bounded(
            waitForContainerImage(
              {
                applicationId: container.baseline.applicationId,
                accountId: container.baseline.accountId,
                digest: container.imageDigest,
              },
              { accountId: container.baseline.accountId, apiToken: Redacted.value(token) },
              `https://${brand.host}`,
              fetcher,
              { timeoutMs: remaining },
              (signal) => verifyContainerHealth(worker, container.inputHash, signal),
            ),
            deadline.signal,
          );
          if (!health || health.bootId !== ready.bootId || health.instanceId !== ready.instanceId)
            throw new Error();
          for (const [path, expected] of [
            ["/health", 200],
            ["/v1/models", 401],
          ] as const) {
            const response = await bounded(
              fetcher(`${origin}${path}`, {
                method: "GET",
                redirect: "manual",
                signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(15_000)]),
              }),
              deadline.signal,
            );
            await response.body?.cancel();
            if (response.status !== expected) throw new Error();
          }
          return {
            candidate,
            applicationVersion: container.baseline.version,
            digest: container.imageDigest,
            inputHash: container.inputHash,
            bootId: ready.bootId,
            instanceId: ready.instanceId,
            workerInput: ready.workerInput,
            checkedAt: Date.now(),
            unsignedHealth: 200 as const,
            unsignedModels: 401 as const,
          };
        } finally {
          try {
            if (connection) await bounded(connection.close(), deadline.signal);
            else void opening.then((value) => value.close()).catch(() => {});
          } finally {
            deadline.dispose();
          }
        }
      },
      catch: () => new BarrierRefusal("container-serving-not-verified", container.id),
    });
  });

export type ServingContainer = Effect.Success<ReturnType<typeof verifyServingContainer>>;
