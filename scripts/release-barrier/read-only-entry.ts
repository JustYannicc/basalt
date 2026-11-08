import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Exit, Redacted } from "effect";
import { evalStack } from "alchemy/Stack";
import { assertReadOnlyPlanContext, readOnlyFetch } from "./read-only-runtime.ts";
import { withReadOnlyPlanState } from "./read-only-state.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { readOnlyPlan } from "./read-only-plan.ts";
import { releaseEvidence } from "./evidence.ts";
import { reportRefusal } from "./refusal-report.ts";
import { readOnlyFailure } from "./read-only-failure.ts";
import type { BarrierRefusal } from "./manifest.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
assertReadOnlyPlanContext(process.env, candidate);
if (process.env.ALCHEMY_STAGE !== "production" || process.env.CI !== "true")
  throw new Error("Read-only preflight requires the production stage and CI credentials");
const stateUrl = process.env.BASALT_PREFLIGHT_STATE_URL;
const token = process.env.BASALT_PREFLIGHT_STATE_TOKEN;
if (!stateUrl || !token) throw new Error("Read-only state credentials are missing");
const stateOrigin = new URL(stateUrl).origin;
const network: BarrierRefusal[] = [];
globalThis.fetch = readOnlyFetch(stateOrigin, globalThis.fetch, (refusal) => network.push(refusal));
const evidence = releaseEvidence(
  fileURLToPath(new URL("../../.local/release-plan/", import.meta.url)),
  candidate,
);
process.chdir(fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url)));
const result = await Effect.runPromiseExit(
  Effect.promise(
    async () => (await import(new URL("../../alchemy.run.ts", import.meta.url).href)).default,
  ).pipe(
    Effect.flatMap((stack) =>
      evalStack(
        stack,
        (compiled) => readOnlyPlan(compiled).pipe(Effect.provideContext(compiled.services)),
        { stage: "production" },
      ),
    ),
    withReleaseRuntime,
    withReadOnlyPlanState({
      url: stateUrl,
      authToken: Redacted.make(token),
      stack: "basalt",
      stage: "production",
      expectedVersion: 8,
    }),
  ),
);
if (Exit.isFailure(result)) {
  const failure = await evidence.failure(readOnlyFailure(Cause.squash(result.cause), network));
  await reportRefusal(failure, process.env.GITHUB_STEP_SUMMARY);
  process.exitCode = 1;
} else {
  const message = `Read-only release plan passed for ${result.value.resources} resources at ${candidate}.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
}
