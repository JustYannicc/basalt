import { Schema } from "effect";
import { BarrierRefusal } from "./release-barrier/refusal.ts";

// Live production sources for the crash dispatch: the run history and the native release target.

/** The account and PoolWorker script a crash command is sent to. */
export type ReleaseTarget = { accountId: string; worker: string };

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
      if (!response.ok) throw new Error(`Run list refused with HTTP ${response.status}`);
      const body = Schema.decodeUnknownSync(Page)(await response.json());
      runs.push(
        ...body.workflow_runs.map((run) => ({ id: run.id, displayTitle: run.display_title })),
      );
      if (body.workflow_runs.length < 100) return runs;
    }
    throw new Error("Run list exceeded its page limit");
  };

/** Native release provenance names the worker; every State write and non-GET fetch is refused. */
export async function readReleaseTarget(env: NodeJS.ProcessEnv): Promise<ReleaseTarget> {
  // Loaded lazily so refusals and offline tests never initialize the deployment SDK.
  const [{ Cause, ConfigProvider, Context, Effect, Exit, Logger }, { FetchHttpClient }] =
    await Promise.all([import("effect"), import("effect/http")]);
  const [{ State }, { evalStack }] = await Promise.all([
    import("alchemy/State/State"),
    import("alchemy/Stack"),
  ]);
  const rehearsal = await import("./release-barrier/release-resume-rehearsal.ts");
  const { runtimeReleaseState } = await import("./release-barrier/runtime-release-state.ts");
  const { releaseStateStack } = await import("./release-barrier/release-state-stack.ts");
  const { assertReleaseStateVersion } = await import("./release-barrier/release-state-version.ts");
  const { withReleaseRuntime } = await import("./release-barrier/runtime.ts");
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = env;
  const encryptionKey = env.EXECUTOR_ENCRYPTION_KEY;
  if (!accountId || !apiToken || !encryptionKey)
    throw new BarrierRefusal("crash-dispatch-release-state-credentials-unavailable", "PoolWorker");
  const counters = rehearsal.createRehearsalCounters();
  const nativeFetch = globalThis.fetch;
  const guarded = rehearsal.countReadOnlyProbeFetch(accountId, counters, nativeFetch);
  globalThis.fetch = guarded;
  try {
    const program = evalStack(
      releaseStateStack,
      (compiled) =>
        Effect.gen(function* () {
          yield* assertReleaseStateVersion(compiled, guarded, "forward-probe");
          const state = rehearsal.countReadOnlyState(yield* yield* State, counters);
          const services = Context.add(compiled.services, State, Effect.succeed(state));
          const baseline = yield* runtimeReleaseState(compiled).pipe(
            Effect.provideContext(services),
          );
          return { accountId: baseline.target.accountId, worker: baseline.target.worker };
        }).pipe(Effect.provideContext(compiled.services)),
      { stage: "production" },
    );
    const exit = await Effect.runPromiseExit(
      program.pipe(
        withReleaseRuntime,
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
    if (counters.state.writeAttempts || counters.fetch.blockedMutationAttempts)
      throw new BarrierRefusal("crash-dispatch-release-state-mutation-attempted", "PoolWorker");
    return exit.value;
  } finally {
    // The private operations bridge must not inherit the GET-only guard.
    globalThis.fetch = nativeFetch;
  }
}
