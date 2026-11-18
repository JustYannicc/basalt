import { Schema } from "effect";
import { BarrierRefusal } from "./pool-fleet/refusal.ts";

// Live production sources for the crash dispatch: the run history and the native release target.

/** A refused run-list read; only its numeric status reaches the public result. */
export class RunListRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Run list refused with HTTP ${status}`);
    this.status = status;
  }
}

export type { ReleaseTarget, RootApplication } from "./pool-fleet/release-target.ts";

/** The dispatch title is the only durable record a fresh runner has of earlier nonces. */
export const workflowRunLister =
  (repository: string, token: string, fetcher = globalThis.fetch) =>
  async () => {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !token) throw new Error("No run list access");
    const Page = Schema.Struct({
      workflow_runs: Schema.Array(
        Schema.Struct({ id: Schema.Number, display_title: Schema.String }),
      ),
    });
    const runs: { id: number; displayTitle: string }[] = [];
    for (let page = 1; page <= 50; page++) {
      const response = await fetcher(
        `https://api.github.com/repos/${repository}/actions/workflows/pool-crash-operator.yml/runs?per_page=100&page=${page}`,
        {
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!response.ok) throw new RunListRefused(response.status);
      const body = Schema.decodeUnknownSync(Page)(await response.json());
      runs.push(
        ...body.workflow_runs.map((run) => ({ id: run.id, displayTitle: run.display_title })),
      );
      if (body.workflow_runs.length < 100) return runs;
    }
    throw new Error("Run list exceeded its page limit");
  };

/** Native release provenance names the worker; every State write and non-GET fetch is refused. */
export async function readReleaseTarget(env: NodeJS.ProcessEnv) {
  // Loaded lazily so refusals and offline tests never initialize the deployment SDK.
  const [{ Cause, ConfigProvider, Effect, Exit, Logger }, { FetchHttpClient }] = await Promise.all([
    import("effect"),
    import("effect/http"),
  ]);
  const [{ State }, { Stack, evalStack }, Cloudflare, { stackState }, target] = await Promise.all([
    import("alchemy/State/State"),
    import("alchemy/Stack"),
    import("alchemy/Cloudflare"),
    import("../.upstream/apps/hosted/cloud/src/infrastructure/state.ts"),
    import("./pool-fleet/release-target.ts"),
  ]);
  const { AlchemyContextLive } = await import("alchemy/AlchemyContext");
  const { layerNonInteractive } = await import("alchemy/Interaction");
  const { provideFreshArtifactStore } = await import("alchemy/Artifacts");
  const NodeServices = await import("@effect/platform-node/NodeServices");
  const { Layer } = await import("effect");
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = env;
  const encryptionKey = env.EXECUTOR_ENCRYPTION_KEY;
  if (!accountId || !apiToken || !encryptionKey)
    throw new BarrierRefusal("crash-dispatch-release-state-credentials-unavailable", "PoolWorker");
  // Observes saved rows only; it never plans or applies a declaration.
  const stack = Stack(
    "basalt",
    { providers: Cloudflare.providers(), state: stackState },
    Effect.succeed(undefined),
  );
  const nativeFetch = globalThis.fetch;
  const guarded = target.readOnlyFetch(accountId, nativeFetch);
  globalThis.fetch = guarded;
  try {
    const program = evalStack(
      stack,
      (compiled) =>
        Effect.gen(function* () {
          const state = target.readOnlyState(yield* yield* State);
          return yield* target.releaseTargetFromState(state, compiled.name, compiled.stage);
        }).pipe(Effect.provideContext(compiled.services)),
      { stage: "production" },
    );
    const exit = await Effect.runPromiseExit(
      program.pipe(
        provideFreshArtifactStore,
        Effect.provide(layerNonInteractive()),
        Effect.provide(AlchemyContextLive.pipe(Layer.provideMerge(NodeServices.layer))),
        // evalStack retains State in its type; the evaluated stack supplies its actual store.
        Effect.provideService(State, Effect.die(new Error("missing compiled state"))),
        Effect.timeout("2 minutes"),
        Effect.provide(Logger.layer([])),
        Effect.provideService(FetchHttpClient.Fetch, guarded),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                ALCHEMY_STAGE: "production",
                CI: "true",
                CLOUDFLARE_ACCOUNT_ID: accountId,
                CLOUDFLARE_API_TOKEN: apiToken,
                EXECUTOR_ENCRYPTION_KEY: encryptionKey,
              },
            }),
          ),
        ),
      ),
    );
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
    return exit.value;
  } finally {
    // The private operations bridge must not inherit the GET-only guard.
    globalThis.fetch = nativeFetch;
  }
}
