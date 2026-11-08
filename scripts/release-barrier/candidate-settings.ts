import type { CompiledStack } from "alchemy/Stack";
import { evalStack } from "alchemy/Stack";
import { isWorker } from "alchemy/Cloudflare";
import type { Worker } from "alchemy/Cloudflare";
import { projectWorkerScriptSettings } from "alchemy/Cloudflare/Workers";
import type { ResourceBinding } from "alchemy/Resource";
import * as Output from "alchemy/Output";
import { Cause, ConfigProvider, Effect, Exit, Logger } from "effect";
import { FetchHttpClient } from "effect/http";
import { withReleaseRuntime } from "./runtime.ts";
import { BarrierRefusal } from "./manifest.ts";
import { baselineRoles } from "./baseline-probe.ts";
import { assertCandidateInputs, candidateReadFailure } from "./candidate-failure.ts";
import { State } from "alchemy/State/State";
import { retiredPlacements } from "./placement-retirement.ts";
import { readOnlyProbeFetch } from "./probe-network.ts";

export interface ProbeWorker {
  role: string;
  scriptName: string;
}

/** Evaluate only settings expressions against observed Worker identities; never read native state. */
export const settingsFromDeclarations = (stack: CompiledStack, workers: readonly ProbeWorker[]) =>
  Effect.gen(function* () {
    const declarations = Object.values(stack.resources).filter(isWorker);
    if (
      declarations.length !== baselineRoles.length ||
      declarations.some((resource) => !workers.some((worker) => worker.role === resource.FQN)) ||
      workers.some((worker) => !declarations.some((resource) => resource.FQN === worker.role))
    )
      throw new BarrierRefusal("candidate-worker-coverage");
    const upstream = Object.fromEntries(
      workers.map((worker) => [worker.role, { workerName: worker.scriptName }]),
    );
    return yield* Effect.forEach(declarations, (resource) =>
      Effect.gen(function* () {
        const worker = workers.find((worker) => worker.role === resource.FQN)!;
        const props = resource.Props;
        const settings = yield* Output.evaluate(
          {
            limits: props.limits,
            logpush: props.logpush,
            observability: props.observability,
            placement: props.placement,
            tags: props.tags,
            tailConsumers: props.tailConsumers,
            streamingTailConsumers: props.streamingTailConsumers,
          },
          upstream,
        );
        const registered: readonly ResourceBinding<Worker["Binding"]>[] =
          stack.bindings[resource.FQN] ?? [];
        const bindings = yield* Output.evaluate(
          registered.map((binding) => ({
            sid: binding.sid,
            data: {
              bindings: binding.data.bindings?.filter((item) => {
                if (item.type !== "durable_object_namespace") return false;
                const references = Object.keys(Output.upstreamAny(item.scriptName));
                if (references.some((id) => !isWorker(stack.resources[id])))
                  throw new BarrierRefusal("candidate-local-class-reference", worker.role);
                // Foreign classes do not contribute to this Worker's class set or Alchemy tags.
                return references.every((id) => id === resource.FQN);
              }),
              observability: binding.data.observability,
            },
          })),
          upstream,
        );
        return {
          ...worker,
          metadata: projectWorkerScriptSettings(settings, bindings, {
            id: resource.LogicalId,
            scriptName: worker.scriptName,
            stack: stack.name,
            stage: stack.stage,
          }).metadata,
        };
      }),
    );
  });

/** Project production declarations; the optional retirement read never runs Plan or Apply. */
export async function candidateScriptSettings(
  workers: readonly ProbeWorker[],
  environment: NodeJS.ProcessEnv,
  retirementFetch?: typeof fetch,
) {
  assertCandidateInputs();
  const program = Effect.promise(
    async () => (await import(new URL("../../alchemy.run.ts", import.meta.url).href)).default,
  ).pipe(
    Effect.catchCause((cause) => Effect.fail(candidateReadFailure(Cause.squash(cause), "import"))),
    Effect.flatMap((root) =>
      evalStack(
        root,
        (stack) =>
          Effect.gen(function* () {
            const rows = yield* settingsFromDeclarations(stack, workers);
            const retired = retirementFetch
              ? yield* Effect.gen(function* () {
                  const state = yield* yield* State;
                  return yield* retiredPlacements(state, stack);
                }).pipe(
                  Effect.provideContext(stack.services),
                  Effect.provideService(FetchHttpClient.Fetch, retirementFetch),
                )
              : [];
            return rows.map((row) => ({
              ...row,
              ...(retirementFetch ? { retiredPlacement: retired.includes(row.role) } : {}),
            }));
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.fail(candidateReadFailure(Cause.squash(cause), "projection")),
            ),
          ),
        { stage: "production" },
      ),
    ),
    withReleaseRuntime,
    Effect.provide(Logger.layer([])),
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: Object.fromEntries(
            Object.entries(environment).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
        }),
      ),
    ),
  );
  const exit = await Effect.runPromiseExit(program);
  if (Exit.isFailure(exit)) throw candidateReadFailure(Cause.squash(exit.cause), "evaluate");
  return exit.value;
}

export async function candidateSettingsWithRetirements(
  workers: readonly ProbeWorker[],
  environment: NodeJS.ProcessEnv,
  nativeFetch: typeof fetch,
) {
  const previous = globalThis.fetch;
  const guarded = readOnlyProbeFetch(environment.CLOUDFLARE_ACCOUNT_ID ?? "", nativeFetch);
  globalThis.fetch = guarded;
  try {
    return await candidateScriptSettings(workers, environment, guarded);
  } finally {
    globalThis.fetch = previous;
  }
}
