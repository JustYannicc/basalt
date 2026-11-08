import { Config, Effect, Redacted } from "effect";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import { openDeploymentReadiness, bounded } from "../database-budget-readiness.ts";
import { verifyContainerHealth } from "./container-health.ts";
import type { FrozenContainer } from "./container.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import type { Fetcher } from "../deploy-safety/http.ts";
import { brand } from "../../brand.ts";
import { servingClock, type ServingClock } from "./serving-clock.ts";
import { readServingObservation } from "./serving-observation.ts";
import {
  ServingFailure,
  servingFailure,
  type ServingCheck,
  type ServingObservation,
} from "./serving-failure.ts";

export const containerStartupMs = 180_000;
export const containerServingMs = 240_000;
// Called after waitForContainerVersion has observed rollout completion. Instance adoption keeps its existing 240-second budget.
export const containerAllocationMs = containerServingMs;
const retryable = (error: ServingFailure) =>
  (error.serving.status !== undefined &&
    (error.serving.status >= 500 || error.serving.status === 429)) ||
  ["TypeError", "TimeoutError", "AbortError", "not-running", "not-ready"].includes(
    error.serving.cause,
  );

export const verifyServingContainer = (
  container: FrozenContainer,
  worker: PoolOperationsTarget,
  candidate: string,
  fetcher: Fetcher = fetch,
  options: { clock?: ServingClock; applicationVersion?: number } = {},
) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    const key = yield* Config.Redacted("POOL_DEPLOYMENT_KEY");
    return yield* Effect.tryPromise({
      try: async () => {
        const clock = options.clock ?? servingClock;
        const began = clock.now();
        const allocation = clock.deadline(containerAllocationMs);
        let runtime: ReturnType<ServingClock["deadline"]> | undefined;
        let startup: ReturnType<ServingClock["deadline"]> | undefined;
        let connection: Awaited<ReturnType<typeof openDeploymentReadiness>> | undefined;
        let observation: ServingObservation | undefined;
        let allocationFailure: ServingFailure | undefined;
        const kickAbort = new AbortController();
        const target = {
          accountId: container.baseline.accountId,
          applicationId: container.baseline.applicationId,
          version: options.applicationVersion ?? container.baseline.version,
          digest: container.imageDigest,
        };
        const check = async <A>(stage: ServingCheck, work: () => Promise<A>) => {
          try {
            return await work();
          } catch (error) {
            throw servingFailure(stage, error);
          }
        };
        const observe = async (signal: AbortSignal) => {
          observation = await readServingObservation(
            target,
            Redacted.value(token),
            signal,
            fetcher,
          );
          return observation;
        };
        const atTarget = () =>
          observation?.version === target.version &&
          !observation.activeRolloutId &&
          observation.digest === target.digest;
        const pause = async (end: number, signal: AbortSignal) => {
          const remaining = end - clock.now();
          if (remaining > 0) await bounded(clock.sleep(Math.min(5_000, remaining)), signal);
        };
        const opening = openDeploymentReadiness({
          ...worker,
          key: Redacted.value(key),
          target: { candidate, workerInput: poolWorkerRevision, imageHash: container.inputHash },
        });
        const verify = async () => {
          try {
            connection = await check("bridge-open", () => bounded(opening, allocation.signal));
            // This signed request can start/adopt the instance. Scheduling is observed separately;
            // a slow warm response must not consume the instance's own startup budget.
            let kickFailure: ServingFailure | undefined;
            void connection
              .ready(AbortSignal.any([allocation.signal, kickAbort.signal]))
              .catch((error) => {
                kickFailure = servingFailure("deployment-readiness", error);
              });
            const allocationEnd = began + containerAllocationMs;
            while (clock.now() < allocationEnd) {
              if (
                kickFailure?.serving.status !== undefined &&
                kickFailure.serving.status < 500 &&
                kickFailure.serving.status !== 429
              )
                throw kickFailure;
              try {
                await observe(allocation.signal);
              } catch (error) {
                const failure = servingFailure("instance-start", error);
                if (!retryable(failure)) throw failure;
                allocationFailure = failure;
              }
              if (
                atTarget() &&
                observation?.instances.length &&
                observation.instances.every(
                  (instance) => instance.digest === target.digest && instance.state === "running",
                )
              )
                break;
              if (observation?.version !== undefined && observation.version > target.version)
                throw new ServingFailure({ check: "application-image", cause: "version-drift" });
              try {
                await pause(allocationEnd, allocation.signal);
              } catch {
                break;
              }
            }
            if (clock.now() >= allocationEnd)
              throw (
                allocationFailure ??
                new ServingFailure({ check: "instance-start", cause: "instance-deadline" })
              );
            kickAbort.abort();
            allocation.dispose();
            const instanceObservedAt = clock.now();
            runtime = clock.deadline(containerServingMs);
            startup = clock.deadline(containerStartupMs);
            const startupEnd = instanceObservedAt + containerStartupMs;
            let ready: Awaited<ReturnType<typeof connection.ready>> | undefined;
            let last = new ServingFailure({ check: "deployment-readiness", cause: "not-ready" });
            while (clock.now() < startupEnd) {
              try {
                ready = await check("deployment-readiness", () =>
                  bounded(connection!.ready(startup!.signal), startup!.signal),
                );
                if (clock.now() >= startupEnd) break;
                break;
              } catch (error) {
                last = servingFailure("deployment-readiness", error);
                if (!retryable(last)) throw last;
                try {
                  await pause(startupEnd, startup.signal);
                } catch {
                  break;
                }
              }
            }
            if (!ready || clock.now() >= startupEnd) throw last;
            const servingEnd = instanceObservedAt + containerServingMs;
            while (clock.now() < servingEnd) {
              try {
                await observe(runtime.signal);
                if (!atTarget())
                  throw new ServingFailure({ check: "application-image", cause: "target-drift" });
                if (
                  !observation?.instances.length ||
                  observation.instances.some(
                    (instance) => instance.digest !== target.digest || instance.state !== "running",
                  )
                )
                  throw new ServingFailure({ check: "instance-image", cause: "not-running" });
                const health = await check("runtime-health", () =>
                  verifyContainerHealth(worker, container.inputHash, runtime!.signal, true),
                );
                if (
                  health.bootId !== ready.bootId ||
                  health.instanceId !== ready.instanceId ||
                  !observation.instances.some((instance) => instance.id === health.instanceId)
                ) {
                  if (startup.signal.aborted)
                    throw new ServingFailure({
                      check: "boot-identity",
                      cause: "identity-mismatch",
                    });
                  ready = await check("deployment-readiness", () =>
                    bounded(connection!.ready(startup!.signal), startup!.signal),
                  );
                  throw new ServingFailure({ check: "boot-identity", cause: "not-ready" });
                }
                for (const [path, expected, stage] of [
                  ["/health", 200, "unsigned-health"],
                  ["/v1/models", 401, "unsigned-model-auth"],
                ] as const) {
                  await check(stage, async () => {
                    const response = await bounded(
                      fetcher(`https://${brand.host}${path}`, {
                        method: "GET",
                        redirect: "manual",
                        signal: AbortSignal.any([runtime!.signal, AbortSignal.timeout(15_000)]),
                      }),
                      runtime!.signal,
                    );
                    await bounded(response.body?.cancel() ?? Promise.resolve(), runtime!.signal);
                    if (response.status !== expected)
                      throw new ServingFailure({
                        check: stage,
                        cause: "http-status",
                        status: response.status,
                        expectedStatus: expected,
                      });
                  });
                }
                if (clock.now() >= servingEnd) break;
                return {
                  candidate,
                  applicationVersion: target.version,
                  digest: container.imageDigest,
                  inputHash: container.inputHash,
                  bootId: ready.bootId,
                  instanceId: ready.instanceId,
                  workerInput: ready.workerInput,
                  checkedAt: clock.now(),
                  instanceObservedAt,
                  unsignedHealth: 200 as const,
                  unsignedModels: 401 as const,
                };
              } catch (error) {
                last = servingFailure("runtime-health", error);
                if (!retryable(last)) throw last;
                try {
                  await pause(servingEnd, runtime.signal);
                } catch {
                  break;
                }
              }
            }
            throw last;
          } catch (error) {
            const failure = servingFailure("instance-start", error);
            failure.serving.elapsedMs = Math.max(0, clock.now() - began);
            if (observation)
              failure.serving.observation = {
                ...observation,
                instances: observation.instances.slice(0, 20),
              };
            throw failure;
          }
        };
        const outcome = await verify().then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        kickAbort.abort();
        let cleanupFailure: unknown;
        try {
          if (connection)
            await check("bridge-close", () =>
              bounded(connection!.close(), runtime?.signal ?? allocation.signal),
            );
          else void opening.then((value) => value.close()).catch(() => {});
        } catch (error) {
          cleanupFailure = error;
        } finally {
          allocation.dispose();
          startup?.dispose();
          runtime?.dispose();
        }
        if (!outcome.ok) throw outcome.error;
        if (cleanupFailure) {
          const failure = servingFailure("bridge-close", cleanupFailure);
          failure.serving.elapsedMs = Math.max(0, clock.now() - began);
          if (observation) failure.serving.observation = observation;
          throw failure;
        }
        return outcome.value;
      },
      catch: (error) => servingFailure("instance-start", error),
    });
  });

export type ServingContainer = Effect.Success<ReturnType<typeof verifyServingContainer>>;
