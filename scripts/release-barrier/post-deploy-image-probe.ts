import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Cause, ConfigProvider, Context, Effect, Exit, Logger } from "effect";
import { FetchHttpClient } from "effect/http";
import { State } from "alchemy/State/State";
import { evalStack } from "alchemy/Stack";
import { assertPoolImageTarget } from "../deploy-safety/pool-image.ts";
import { assertProbeCandidate } from "../ci/probe-candidate.ts";
import { assertReadOnlyRehearsalContext } from "./release-resume-rehearsal-receipt.ts";
import {
  countReadOnlyProbeFetch,
  countReadOnlyState,
  createRehearsalCounters,
} from "./release-resume-rehearsal.ts";
import { runtimeReleaseState } from "./runtime-release-state.ts";
import { releaseStateStack } from "./release-state-stack.ts";
import { assertReleaseStateVersion } from "./release-state-version.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { safeProviderFailure } from "./operation-failure.ts";

const counters = createRehearsalCounters();
const nativeFetch = globalThis.fetch;
const output = resolve(".local/post-deploy-image-probe.json");
let receipt: unknown;
let failed = false;
try {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const context = assertReadOnlyRehearsalContext(process.env, event);
  const pinned = assertProbeCandidate(process.cwd(), context.head);
  if (pinned.candidate !== context.candidate) throw new Error("Probe candidate drift");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const encryptionKey = process.env.EXECUTOR_ENCRYPTION_KEY;
  if (!accountId || !apiToken || !encryptionKey) throw new Error("Probe credentials unavailable");
  const guarded = countReadOnlyProbeFetch(accountId, counters, nativeFetch);
  globalThis.fetch = guarded;
  const program = evalStack(
    releaseStateStack,
    (compiled) =>
      Effect.gen(function* () {
        yield* assertReleaseStateVersion(compiled, guarded, "forward-probe");
        const state = countReadOnlyState(yield* yield* State, counters);
        const services = Context.add(compiled.services, State, Effect.succeed(state));
        const baseline = yield* runtimeReleaseState(compiled).pipe(Effect.provideContext(services));
        const root = baseline.applications.root.image;
        const observed = yield* Effect.promise(() =>
          assertPoolImageTarget(
            root,
            { workerName: baseline.target.worker, inputHash: root.inputHash },
            { accountId, apiToken },
            guarded,
          ),
        );
        return {
          rootInputHash: root.inputHash,
          rootDigest: root.digest,
          instanceCount: observed.instances.length,
          verifiedPath: observed.fleet ? "bound-fleet" : "root",
          fleet: observed.fleet?.map((app) => ({
            digest: app.digest,
            instanceCount: app.instances.length,
          })),
        };
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
    throw new Error("Read-only image probe attempted a mutation");
  receipt = {
    status: "complete",
    candidate: context.candidate,
    main: pinned.main,
    head: context.head,
    observation: exit.value,
    scope:
      "Current native production baseline through the real post-deploy verifier; not candidate activation or future fleet proof",
  };
} catch (error) {
  failed = true;
  const failure = safeProviderFailure(error);
  receipt = {
    status: "refused",
    phase: "post-deploy-image",
    type: failure.type,
    statusCode: failure.status ?? null,
  };
} finally {
  globalThis.fetch = nativeFetch;
}
await mkdir(resolve(".local"), { recursive: true });
await writeFile(
  output,
  JSON.stringify({
    receipt,
    counters,
    mutations: { state: 0, infrastructure: 0, runtime: 0 },
    observedAt: new Date().toISOString(),
  }),
  { mode: 0o600 },
);
if (process.env.GITHUB_STEP_SUMMARY)
  await import("node:fs/promises").then((fs) =>
    fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY!,
      `\nPost-deploy image read-path probe: ${failed ? "REFUSED" : "PASS"}. State writes: 0. Infrastructure/runtime mutations: 0.\n`,
    ),
  );
if (failed) process.exitCode = 1;
