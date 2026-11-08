import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { releaseEvidence } from "../evidence.ts";
import { reportRefusal } from "../refusal-report.ts";
import { operationFailure } from "../operation-failure.ts";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { Cause, ConfigProvider, Effect, Exit } from "effect";
import { FetchHttpClient } from "effect/http";
import { withReleaseRuntime } from "../runtime.ts";
import { assertReleaseStateVersion } from "../release-state-version.ts";
import { BarrierRefusal } from "../manifest.ts";
import { retirementFixture } from "./candidate-retirement-fixture.mjs";

export async function releaseStateProof(settings, declarations, mode) {
  const phase = mode === "forward-state-v7" ? "forward-probe" : "release";
  const http = await retirementFixture(declarations, mode === "release-state-v8" ? 8 : 7);
  globalThis.fetch = http.fetch;
  const { default: root } = await import(
    pathToFileURL(join(process.env.NATIVE_STACK_ROOT, "alchemy.run.ts")).href
  );
  let enteredState = false;
  const result = await Effect.runPromiseExit(
    evalStack(
      root,
      (compiled) =>
        assertReleaseStateVersion(compiled, http.fetch, phase).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              enteredState = true;
              // This is the same lazy native State access used before deployStack in the release entry.
              yield* yield* State;
            }),
          ),
        ),
      { stage: "production" },
    ).pipe(
      withReleaseRuntime,
      Effect.provideService(FetchHttpClient.Fetch, http.fetch),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: settings }))),
    ),
  );
  declarations.assertAllowed();
  if (Exit.isSuccess(result)) return { ok: true, enteredState, stateRequests: http.requests };
  const error = Cause.squash(result.cause);
  if (!(error instanceof BarrierRefusal)) throw new Error("Release State fixture failed");
  const directory = await mkdtemp(join(tmpdir(), "state-version-proof-"));
  const failure = await releaseEvidence(directory, "a".repeat(40)).failure(
    operationFailure(error, "(plan)", "release-stack"),
  );
  const logs = [];
  const summaryPath = join(directory, "summary.md");
  await reportRefusal(failure, summaryPath, (line) => logs.push(line));
  const saved = JSON.parse(await readFile(join(directory, "failure.json"), "utf8"));
  const summary = await readFile(summaryPath, "utf8");
  return {
    ok: false,
    failure: saved,
    logs,
    summary,
    enteredState,
    reason: error.reason,
    delta: error.delta,
    stateRequests: http.requests,
  };
}
