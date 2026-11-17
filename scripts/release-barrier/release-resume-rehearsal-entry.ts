import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Cause, ConfigProvider, Context, Effect, Exit, Logger, Schema } from "effect";
import { State } from "alchemy/State/State";
import { evalStack } from "alchemy/Stack";
import { FetchHttpClient } from "effect/http";
import { assertProbeCandidate } from "../ci/probe-candidate.ts";
import { nodePoolOperations } from "../pool-operations-node.ts";
import { safeProviderFailure } from "./operation-failure.ts";
import { readBaselineControllerKey } from "./baseline-controller.ts";
import { releaseStateStack } from "./release-state-stack.ts";
import { assertReleaseStateVersion } from "./release-state-version.ts";
import { collectReleaseSettlementProof } from "./release-settlement-proof.ts";
import { withReleaseRuntime } from "./runtime.ts";
import {
  assertNotApplicableRehearsalReadOnly,
  assertReadOnlyRehearsal,
  assertReadOnlyRehearsalContext,
  releaseRehearsalNotApplicableReceipt,
  releaseRehearsalReceipt,
  releaseRehearsalRefusalReceipt,
} from "./release-resume-rehearsal-receipt.ts";
import {
  countBaselineReadDeclaration,
  countReadOnlyBaselineConnect,
  countReadOnlyProbeFetch,
  countReadOnlyState,
  createRehearsalCounters,
} from "./release-resume-rehearsal.ts";
import { BarrierRefusal } from "./manifest.ts";
import { inspectReleaseRehearsalSource } from "./release-resume-rehearsal-source.ts";

const output = resolve(".local/release-resume-rehearsal/receipt.json");
const counters = createRehearsalCounters();
const nativeFetch = globalThis.fetch;
let candidate: string | undefined;
let sourceCandidate: string | undefined;
let receipt: unknown;
let failed = false;
let status = "refused";

const safeReason = (error: unknown) =>
  error instanceof BarrierRefusal ? error.reason : safeProviderFailure(error).type;

try {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new BarrierRefusal("release-rehearsal-event-unavailable", "PoolWorker");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const context = assertReadOnlyRehearsalContext(process.env, event);
  const candidateSha = context.candidate;
  candidate = candidateSha;
  const pinned = assertProbeCandidate(process.cwd(), context.head);
  if (pinned.candidate !== candidateSha)
    throw new BarrierRefusal("release-rehearsal-candidate-drift", "PoolWorker");

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const encryptionKey = process.env.EXECUTOR_ENCRYPTION_KEY;
  if (!accountId || !apiToken || !encryptionKey)
    throw new BarrierRefusal("release-rehearsal-credentials-unavailable", "PoolWorker");

  const guardedFetch = countReadOnlyProbeFetch(accountId, counters, nativeFetch);
  const runtimeEnvironment = {
    ALCHEMY_STAGE: "production",
    CI: "true",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: apiToken,
    EXECUTOR_ENCRYPTION_KEY: encryptionKey,
  };
  globalThis.fetch = guardedFetch;

  const run = evalStack(
    releaseStateStack,
    (compiled) =>
      Effect.gen(function* () {
        yield* assertReleaseStateVersion(compiled, guardedFetch, "forward-probe");
        const actual = yield* yield* State;
        const state = countReadOnlyState(actual, counters);
        const readOnlyServices = Context.add(compiled.services, State, Effect.succeed(state));
        const source = yield* inspectReleaseRehearsalSource(state, compiled, encryptionKey);
        sourceCandidate = source.sourceCandidate;
        if (source.disposition === "not-applicable")
          return { disposition: "not-applicable" as const, source };
        const sourceSha = source.sourceCandidate;
        sourceCandidate = sourceSha;
        const signingKey = yield* readBaselineControllerKey(compiled).pipe(
          Effect.provideContext(readOnlyServices),
        );
        const connect = countReadOnlyBaselineConnect(
          async (path) => {
            const config = Schema.decodeUnknownSync(
              Schema.Struct({
                account_id: Schema.String,
                services: Schema.Array(
                  Schema.Struct({
                    binding: Schema.Literal("POOL_OPERATIONS"),
                    service: Schema.String,
                    entrypoint: Schema.Literal("PoolOperations"),
                    remote: Schema.Literal(true),
                  }),
                ),
              }),
              { onExcessProperty: "ignore" },
            )(JSON.parse(await readFile(path, "utf8")));
            if (config.services.length !== 1)
              throw new BarrierRefusal("release-rehearsal-bridge-target-refused", "PoolWorker");
            return nodePoolOperations(config.account_id, config.services[0]!.service);
          },
          { key: signingKey, counters },
        );
        const result = yield* collectReleaseSettlementProof(
          compiled,
          sourceSha,
          encryptionKey,
          resolve(".local/release-resume-rehearsal"),
          {
            connect,
            runtimeRead: countBaselineReadDeclaration(counters),
          },
        ).pipe(Effect.provideContext(readOnlyServices));
        assertReadOnlyRehearsal(result.proof, counters);
        return {
          disposition: "rehearsed" as const,
          sourceCandidate: sourceSha,
          proof: result.proof,
        };
      }).pipe(Effect.provideContext(compiled.services)),
    { stage: "production" },
  );
  const exit = await Effect.runPromiseExit(
    run.pipe(
      withReleaseRuntime,
      Effect.provide(Logger.layer([])),
      Effect.provideService(FetchHttpClient.Fetch, guardedFetch),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: Object.fromEntries(
              Object.entries(runtimeEnvironment).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            ),
          }),
        ),
      ),
    ),
  );
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  sourceCandidate = exit.value.sourceCandidate;
  if (exit.value.disposition === "not-applicable") {
    assertNotApplicableRehearsalReadOnly(counters);
    status = "not-applicable";
    receipt = releaseRehearsalNotApplicableReceipt({
      candidate: candidate!,
      sourceCandidate,
      reason: exit.value.source.reason,
      heads: {
        image: { state: exit.value.source.image.state, digest: exit.value.source.image.digest },
        forward: {
          state: exit.value.source.forward.state,
          digest: exit.value.source.forward.digest,
        },
      },
      counters,
    });
  } else {
    status = "complete";
    receipt = releaseRehearsalReceipt({
      candidate: candidate!,
      sourceCandidate: exit.value.sourceCandidate,
      proof: exit.value.proof,
      counters,
    });
  }
} catch (error) {
  failed = true;
  const provider = safeProviderFailure(error);
  receipt = releaseRehearsalRefusalReceipt({
    candidate,
    sourceCandidate,
    failure: {
      reason: safeReason(error),
      type: provider.type,
      ...(provider.status === undefined ? {} : { status: provider.status }),
    },
    counters,
  });
} finally {
  globalThis.fetch = nativeFetch;
}

await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
const summary = {
  status: failed ? "refused" : status,
  stateGets: counters.fetch.stateGetAttempts,
  providerGets: counters.fetch.providerGetAttempts,
  edgePreviewAuthPosts: counters.fetch.edgePreviewAuthPosts,
  runtimeInspectPosts: counters.runtime.inspectPostDispatches,
  runtimeHealthGets: counters.runtime.healthGetDispatches,
  deniedStateWriteAttempts: counters.state.writeAttempts,
  blockedHttpMutations: counters.fetch.blockedMutationAttempts,
};
console.log(JSON.stringify(summary));
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Read-only release-resume rehearsal\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n\n`,
  );
if (failed) process.exitCode = 1;
