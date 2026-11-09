import { probeWorkerSettings } from "./settings-probe.ts";
import { settingsFromDeclarations } from "./candidate-settings.ts";
import { recordedContainer } from "./forward-model.ts";
import { containerKey } from "./forward-journal.ts";
import { retiredPlacements } from "./placement-retirement.ts";
import { reportBaselineProbe } from "./baseline-probe-report.ts";
import { releaseEvidence } from "./evidence.ts";
import { reportRefusal, refusalTable } from "./refusal-report.ts";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evalStack } from "alchemy/Stack";
import { State, type StateService } from "alchemy/State/State";
import { Cause, ConfigProvider, Context, Effect, Exit, Logger } from "effect";
import { FetchHttpClient } from "effect/http";
import { deployEnvironment } from "../environment.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { resumeForwardRelease } from "./forward-resume.ts";
import { readOnlyProbeFetch } from "./probe-network.ts";
import { BarrierRefusal } from "./manifest.ts";
import { safeProviderFailure } from "./operation-failure.ts";
import {
  readForwardStateObservation,
  type ForwardStateObservation,
} from "./forward-state-observation.ts";

if (process.env.GITHUB_ACTIONS !== "true")
  throw new Error("Forward reconciliation probe runs only in Actions");
const directory = resolve(new URL("../../.local/forward-probe/", import.meta.url).pathname);
const nativeFetch = globalThis.fetch;
const guarded = readOnlyProbeFetch(process.env.CLOUDFLARE_ACCOUNT_ID ?? "", nativeFetch);
let report: unknown;
let table: string;
let nativeState: ForwardStateObservation | undefined;
try {
  const environment = deployEnvironment();
  globalThis.fetch = guarded;
  const exit = await Effect.runPromiseExit(
    Effect.promise(
      async () => (await import(new URL("../../alchemy.run.ts", import.meta.url).href)).default,
    ).pipe(
      Effect.flatMap((root) =>
        evalStack(
          root,
          (compiled) =>
            Effect.gen(function* () {
              const actual = yield* yield* State;
              const deny = () =>
                Effect.die(new BarrierRefusal("forward-probe-state-write-refused"));
              const readOnly: StateService = {
                ...actual,
                set: deny,
                delete: deny,
                deleteStack: deny,
                setOutput: deny,
              };
              nativeState = yield* readForwardStateObservation(actual, compiled);
              const { identity } = recordedContainer(yield* actual.get(containerKey(compiled)));
              const retired = yield* retiredPlacements(actual, compiled);
              const preparation = yield* Effect.promise(() =>
                probeWorkerSettings(
                  environment.CLOUDFLARE_ACCOUNT_ID!,
                  environment.CLOUDFLARE_API_TOKEN!,
                  environment,
                  undefined,
                  async (workers) =>
                    Effect.runPromise(
                      settingsFromDeclarations(compiled, workers).pipe(
                        Effect.map((rows) =>
                          rows.map((row) => ({
                            ...row,
                            retiredPlacement: retired.includes(row.role),
                          })),
                        ),
                        Effect.provideContext(compiled.services),
                      ),
                    ),
                  undefined,
                  identity.hash.image,
                ),
              );
              yield* Effect.promise(() =>
                reportBaselineProbe(
                  preparation,
                  resolve(directory, "preparation.json"),
                  process.env.GITHUB_STEP_SUMMARY,
                ),
              );
              if (preparation.some((row) => !row.ok))
                throw new BarrierRefusal("preparation-probe-refused");
              const reconciliation = yield* resumeForwardRelease(compiled, {
                dryRun: true,
                directory,
              }).pipe(Effect.provideService(State, Effect.succeed(readOnly)));
              return {
                schemaVersion: 1,
                nativeSchemaVersion: nativeState.nativeSchemaVersion,
                nativeState,
                readOnly: true,
                reconciliation: reconciliation ?? { disposition: "completed-journal" },
              };
            }).pipe(
              Effect.provideContext(compiled.services),
              Effect.provideService(State, Context.get(compiled.services, State)),
            ),
          { stage: "production" },
        ),
      ),
      withReleaseRuntime,
      Effect.provide(Logger.layer([])),
      Effect.provideService(FetchHttpClient.Fetch, guarded),
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
    ),
  );
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  report = exit.value;
  const fields = {
    schemaVersion: exit.value.schemaVersion,
    nativeSchemaVersion: exit.value.nativeSchemaVersion,
    readOnly: true,
    nativeState: exit.value.nativeState,
    ...exit.value.reconciliation,
  };
  table = `| Field | Observed / proposed |\n| --- | --- |\n${Object.entries(fields)
    .map(([field, value]) => `| ${field} | ${JSON.stringify(value).replaceAll("|", "&#124;")} |`)
    .join("\n")}`;
} catch (error) {
  const evidence = releaseEvidence(directory, process.env.GITHUB_SHA ?? "0".repeat(40));
  const detail = await evidence.failure(error);
  await reportRefusal(detail, process.env.GITHUB_STEP_SUMMARY);
  const failure = safeProviderFailure(error);
  report = { ...detail, readOnly: true, ok: false, nativeState, ...failure };
  table = refusalTable(detail);
  process.exitCode = 1;
} finally {
  globalThis.fetch = nativeFetch;
}
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(resolve(directory, "probe.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Read-only forward reconciliation\n\n${table}\n\n`,
  );
