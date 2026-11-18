import { InMemoryService } from "alchemy/State/InMemoryState";
import { Effect, Redacted } from "effect";

/** In-memory native State with the PoolWorker row a release reads its baseline from. */
export async function nativeReleaseRows(
  scope: { name: string; stage: string },
  accountId: string,
  key: string,
) {
  const state = await Effect.runPromise(InMemoryService());
  const put = (fqn: string, resourceType: string, props: object, attr: object) =>
    Effect.runPromise(
      state.set({
        stack: scope.name,
        stage: scope.stage,
        fqn,
        value: {
          resourceType,
          fqn,
          logicalId: fqn,
          namespace: undefined,
          instanceId: "2".repeat(32),
          providerVersion: 0,
          status: "created",
          downstream: [],
          bindings: [],
          props,
          attr,
        },
      }),
    );
  await put(
    "PoolWorker",
    "Cloudflare.Worker",
    {
      env: {
        POOL_DATABASE_URL: Redacted.make("postgresql://synthetic-secret@database.invalid/pool"),
        POOL_MANAGEMENT_KEY: Redacted.make("synthetic-management-secret"),
        POOL_APP_SIGNING_KEY: Redacted.make(key),
        POOL_DEPLOYMENT_KEY: Redacted.make(key),
        POOL_IMAGE_HASH: "3".repeat(16),
      },
    },
    { accountId, workerName: "synthetic-worker" },
  );
  return { state, put };
}
