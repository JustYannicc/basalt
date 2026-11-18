import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Cause, ConfigProvider, Effect, Exit, Logger } from "effect";
import { FetchHttpClient } from "effect/http";
import { State } from "alchemy/State/State";
import { evalStack } from "alchemy/Stack";
import { BarrierRefusal } from "./refusal.ts";
import {
  assertPreflightContext,
  preflightRefusal,
  preflightRunner,
  type PreflightMode,
} from "./release-preflight.ts";
import { releaseReceiptCodes } from "./release-preflight-live.ts";
import { createPreflightBridgeCounters } from "./release-preflight-guard.ts";
import { preflightReport, preflightSummary } from "./release-preflight-report.ts";
import { preflightSteps, type ControllerAttempt } from "./release-preflight-steps.ts";
import {
  countReadOnlyProbeFetch,
  countReadOnlyState,
  createRehearsalCounters,
} from "./release-resume-rehearsal.ts";
import { releaseStateStack } from "./release-state-stack.ts";
import { withReleaseRuntime } from "./runtime.ts";

const directory = resolve(".local/release-preflight");
const env = process.env;
const counters = createRehearsalCounters();
const bridge = createPreflightBridgeCounters();
const runner = preflightRunner();
const nativeFetch = globalThis.fetch;
let candidate: string | undefined;
let mode: PreflightMode | undefined;
let receiptCandidates: string[] = [];
const controllerAttempts: ControllerAttempt[] = [];
let fatal: string | undefined;

try {
  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"))
    : undefined;
  ({ candidate, mode } = assertPreflightContext(env, event, process.cwd()));
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const encryptionKey = env.EXECUTOR_ENCRYPTION_KEY;
  if (!accountId || !apiToken || !encryptionKey)
    throw new BarrierRefusal("release-preflight-credentials-unavailable", "PoolWorker");
  const receipts = await releaseReceiptCodes(env.BASALT_PREFLIGHT_RECEIPTS);
  receiptCandidates = [...new Set(receipts.map((code) => code.candidate))];
  const guarded = countReadOnlyProbeFetch(accountId, counters, nativeFetch);
  globalThis.fetch = guarded;
  const exit = await Effect.runPromiseExit(
    evalStack(
      releaseStateStack,
      (compiled) =>
        Effect.gen(function* () {
          yield* preflightSteps(compiled, {
            candidate: candidate!,
            state: countReadOnlyState(yield* yield* State, counters),
            fetch: guarded,
            bridge,
            runner,
            credentials: { accountId, apiToken, encryptionKey },
            directory,
            receipts,
            attempts: controllerAttempts,
          });
        }).pipe(Effect.provideContext(compiled.services)),
      { stage: "production" },
    ).pipe(
      withReleaseRuntime,
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
} catch (error) {
  fatal = preflightRefusal(error).reason;
} finally {
  globalThis.fetch = nativeFetch;
}

const report = preflightReport({
  candidate,
  mode,
  receiptCandidates,
  controllerAttempts,
  steps: runner.results,
  fatal,
  state: counters,
  bridge,
});
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
});
const summary = preflightSummary(report);
console.log(summary);
if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `\n${summary}\n`);
if (report.status !== "pass") process.exitCode = 1;
