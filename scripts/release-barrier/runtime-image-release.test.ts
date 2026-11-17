// Regression: release-phases-real-client (every phase drives the real release client, so health() and the witness readback run as in production)
// End-to-end proof of the first scale-out release: the production runner's deploy and image steps,
// releaseRuntimeImage through every phase, deployStack, Alchemy Plan/Apply and its Command provider,
// against a local Cloudflare and controller fake (test/runtime-release-world.ts). The modules that
// reach the live controller are stand-ins (test/runtime-release-standins.ts); the controller client
// is the real one over a fake pool-operations bridge with production's setup latency, and only its
// adopt and promote mutations go straight to the fake controller.
// Not covered: fleet bootstrap provisioning internals, container staging (runtimeImage prepare and
// verify), the client's promotion internals and startup abort, forward-resume after a failed
// phase, and the database phase with a real migration.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Cause, Config, ConfigProvider, Effect, Exit, Layer, Option, Redacted } from "effect";
import * as Apply from "alchemy/Apply";
import * as Command from "alchemy/Command";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack, evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import type { Worker } from "alchemy/Cloudflare";
import { WorkerUploadHook } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import { RuntimeImageReleasePlan } from "../../src/pool/image-release-plan.ts";
import { capturePoolImage } from "../deploy-safety/capture-pool-image.ts";
import { waitForPoolImage } from "../deploy-safety/pool-image.ts";
import { executeRelease, type CommandResult } from "../deploy-safety/release-runner.ts";
import type { ClassificationReport } from "../releases/types.ts";
import { attributes, preparedUpload } from "./fixture.ts";
import { BarrierRefusal } from "./refusal.ts";
import type { RuntimeReleaseWriter } from "./runtime-release-writer.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { readySqlSchemas } from "./sql-schema-fixture.ts";
import {
  accountId,
  candidate,
  candidateImage,
  candidateInput,
  createWorld,
  foreignImage,
  foreignInput,
  installWorld,
  origin,
  runtimeEnvironment,
  type World,
  type WorldOptions,
} from "./test/runtime-release-world.ts";

// Only runtime-image-release.ts's own imports of these modules are redirected; every other importer,
// including deployStack and the real fleet and image helpers, keeps the production module.
const release = new URL("./runtime-image-release.ts", import.meta.url).href;
const standins = new URL("./test/runtime-release-standins.ts", import.meta.url).href;
const redirected = new Set([
  "./runtime-provider-observation.ts",
  "./migration-activation-state.ts",
  "./provisioning-stack.ts",
  "./release-state-version.ts",
  "./forward-resume.ts",
  "./runtime-release-state.ts",
  "./runtime-release-desired.ts",
  "./runtime-release-journal.ts",
  "./runtime-release-client.ts",
  "./runtime-release-bootstrap.ts",
  "./runtime-release-readiness.ts",
  "./baseline-controller.ts",
]);
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === release && redirected.has(specifier))
      return { url: standins, shortCircuit: true };
    return next(specifier, context);
  },
});
const { releaseRuntimeImage } = await import("./runtime-image-release.ts");
const standin = await import("./test/runtime-release-standins.ts");

interface FixtureWorker extends Resource<
  "Cloudflare.Worker",
  { revision: string; env: Record<string, string> },
  Worker["Attributes"],
  Worker["Binding"]
> {}
const FixtureWorker = Resource<FixtureWorker>("Cloudflare.Worker");
const unwrap = (env: Record<string, unknown> = {}): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? String(Redacted.value(value)) : String(value),
    ]),
  );

/**
 * A production-shaped release graph: PoolWorker, the database and budget Commands, and the
 * publication receipt Command declared as src/pool/deployment.ts:120-142 declares it.
 * Its receipt names the root PoolContainer application, as deployment.ts:132 does.
 */
function releaseGraph(w: World, receipts: { runs: number; seeding: boolean }, isolate: boolean) {
  const memory = Effect.runSync(InMemoryService());
  const state = Layer.succeed(State, Effect.succeed(memory));
  standin.installProvisioningState(memory);
  const workers = Provider.succeed(FixtureWorker, {
    precreate: ({ id }) => Effect.succeed(attributes(id)),
    read: (input) => Effect.succeed(input.output),
    diff: () => Effect.succeed({ action: "update" }),
    reconcile: (input) =>
      Effect.gen(function* () {
        const result = attributes(input.id);
        const hook = yield* Effect.serviceOption(WorkerUploadHook);
        if (Option.isNone(hook)) return result;
        return yield* hook.value.capture({
          ...preparedUpload(input.id),
          proposed: result,
          activate: () =>
            Effect.sync(() => {
              w.activatePoolWorker();
              return result;
            }),
        });
      }),
    delete: () => Effect.die("Unexpected deletion"),
  });
  // Alchemy's real Command provider owns diff and memo; only the child process is in-process.
  const commands = Command.ExecProvider().pipe(
    Layer.provide(
      Layer.succeed(Command.CommandExecutor, {
        spawn: () => Effect.die("No child processes in the release proof"),
        run: (news) =>
          Effect.promise(async () => {
            w.events.push(`command:${news.command}`);
            if (news.command === "node capture-pool-image.ts" && !receipts.seeding) {
              receipts.runs++;
              const env = unwrap(news.env);
              // Isolation removes the previous phase's receipt first, so the image check runs regardless.
              if (isolate) rmSync(env.BASALT_POOL_IMAGE_RECEIPT!, { force: true });
              // `node capture-pool-image.ts` in scripts/deploy-safety runs exactly this with its env.
              await capturePoolImage(env, w.fetch);
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      }),
    ),
  );
  const stack = Stack(
    "basalt",
    { providers: Layer.mergeAll(workers, commands), state },
    Effect.gen(function* () {
      const plan = yield* RuntimeImageReleasePlan;
      // The stack evaluated with `build` publishes the candidate image to that inactive application.
      if (plan?.build) w.buildInactive(plan.build);
      yield* Command.Exec("PoolDatabase", { command: "node ensure-pool-database.ts", memo: false });
      // The runtime settings deployStack's preserveRuntimeInputs retains from the baseline.
      const worker = yield* FixtureWorker("PoolWorker", {
        revision: "candidate",
        env: runtimeEnvironment(w.root.input),
      });
      yield* Command.Exec("PoolBackendBudgetRuntimeReady", {
        command: "node verify-database-budget.ts --ready",
        memo: false,
      });
      yield* Command.Exec("PoolBackendBudget", {
        command: "node verify-database-budget.ts",
        memo: false,
      });
      const receiptPath = yield* Config.String("BASALT_POOL_IMAGE_RECEIPT").pipe(
        Config.withDefault(""),
      );
      if (receiptPath)
        yield* Command.Exec("PoolImagePublicationReceipt", {
          command: "node capture-pool-image.ts",
          cwd: fileURLToPath(new URL("../deploy-safety/", import.meta.url)),
          env: {
            BASALT_POOL_IMAGE_RECEIPT: receiptPath,
            GITHUB_SHA: candidate,
            CLOUDFLARE_ACCOUNT_ID: accountId,
            CLOUDFLARE_API_TOKEN: Redacted.make("synthetic-api-token"),
            POOL_APPLICATION_ID: w.root.id,
            POOL_IMAGE_INPUT_HASH: w.root.input,
            POOL_IMAGE_DIGEST: w.root.image.digest,
            POOL_IMAGE_REF: w.root.image.ref,
            POOL_WORKER_READY: worker.workerName,
          },
          memo: false,
          timeout: "1 minute",
        });
      return {};
    }),
  );
  return stack;
}
const report: ClassificationReport = {
  schemaVersion: 1,
  base: { gitCommit: "1".repeat(40), pins: {} as ClassificationReport["base"]["pins"] },
  candidate: { gitCommit: candidate, pins: {} as ClassificationReport["candidate"]["pins"] },
  databaseChanged: false,
  workflowChanged: false,
  evidence: {
    database: { state: "unchanged", sources: [] },
    workflow: { state: "unchanged", sources: [] },
  },
};

/** One first scale-out release, driven through the production runner's deploy and image steps. */
async function firstScaleOutRelease(
  options: {
    isolateReceipt?: boolean;
    beforeImageCheck?: (w: World) => void;
    world?: WorldOptions;
  } = {},
) {
  const w = createWorld(options.world);
  installWorld(w);
  standin.resetJournal();
  const scratch = mkdtempSync(join(tmpdir(), "runtime-image-release-"));
  const network = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`Release proof refused a real network call to ${new Request(input).url}`);
  };
  const event = {
    GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
    GITHUB_REF: process.env.GITHUB_REF,
  };
  try {
    const directory = join(scratch, "barrier");
    // release-runner.ts:220-225: one receipt path for the whole `npm run deploy`.
    const receiptPath = join(
      mkdtempSync(join(scratch, "basalt-pool-publication-")),
      "receipt.json",
    );
    const receipts = { runs: 0, seeding: true };
    const stack = releaseGraph(w, receipts, options.isolateReceipt ?? false);
    const config = ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          BASALT_POOL_IMAGE_RECEIPT: receiptPath,
          GITHUB_SHA: candidate,
          EXECUTOR_ENCRYPTION_KEY: "b".repeat(64),
          CLOUDFLARE_API_TOKEN: "synthetic-api-token",
        },
      }),
    );
    const provide = <A, E>(effect: Effect.Effect<A, E, never>) =>
      Effect.runPromiseExit(effect.pipe(Effect.provide(config)));
    // The previous release's native state, so every resource plans as an update.
    const seeded = await provide(
      evalStack(
        stack,
        (compiled) =>
          Effect.gen(function* () {
            return yield* Apply.apply(yield* Plan.make(compiled));
          }),
        { stage: "production" },
      ).pipe(withReleaseRuntime),
    );
    assert.ok(Exit.isSuccess(seeded), Exit.isFailure(seeded) ? Cause.pretty(seeded.cause) : "");
    receipts.seeding = false;
    w.events.length = 0;

    const failures: string[] = [];
    let verified: Awaited<ReturnType<typeof waitForPoolImage>> | undefined;
    const marks: string[] = [];
    // Every consumer of the exclusive release writer here is a stand-in, which ignores it.
    const writer = {} as RuntimeReleaseWriter;
    let now = 0;
    // assertReleaseMode reads the GitHub event: an automatic release from a push to main.
    Object.assign(process.env, { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" });
    const outcome = await executeRelease(report, "automatic", {
      validateCredentials: () => {},
      assertBackup: async () => {
        throw new Error("No database change in this release");
      },
      begin: async () => 1,
      mark: async (_id, value) => {
        marks.push(value);
      },
      deploy: async (): Promise<CommandResult> => {
        // release-runner.ts:249-251 removes the receipt once, before the one deploy command.
        rmSync(receiptPath, { force: true });
        const exit = await provide(
          releaseRuntimeImage(stack, {
            candidate,
            directory,
            writer,
            encryptionKey: "b".repeat(64),
            forwardEncryptionKey: "b".repeat(64),
            record: async () => {},
            manifest: async () => {},
            io: {
              sqlSchemas: async () => readySqlSchemas(candidate),
              placements: (_worker, baseline) =>
                Effect.succeed(
                  baseline.map(({ versionId }) => ({
                    id: versionId,
                    placement: undefined,
                    bindings: [{ name: "POOL_IMAGE_HASH", type: "plain_text", text: w.root.input }],
                  })),
                ),
              baseline: () => Effect.succeed([{ versionId: "previous", percentage: 100 }]),
              upload: (worker) =>
                Effect.succeed({ versionId: `accepted-${worker.id}`, startupTimeMs: 100 }),
            },
          }).pipe(withReleaseRuntime),
        );
        if (Exit.isSuccess(exit)) return { started: true, exitCode: 0 };
        const error = Cause.squash(exit.cause);
        // A refusal's delta names the refused command and the controller's closed reason.
        const delta =
          error instanceof BarrierRefusal
            ? (error.delta?.changed ?? [])
                .map((row) => ` ${row.path}=${"new" in row ? String(row.new) : "changed"}`)
                .join("")
            : "";
        failures.push(`deploy: ${String(error)}${delta}`);
        return { started: true, exitCode: 1 };
      },
      assertImages: async (): Promise<CommandResult> => {
        // assert-pool-image.ts, with the fixture network and a virtual clock for its 240 s budget.
        options.beforeImageCheck?.(w);
        try {
          verified = await waitForPoolImage(
            JSON.parse(readFileSync(receiptPath, "utf8")),
            candidate,
            { accountId, apiToken: "synthetic-api-token" },
            origin,
            w.fetch,
            {
              // assert-pool-image.ts computes this from the candidate's own pool image source.
              candidateImageInput: candidateInput,
              now: () => now,
              sleep: async (ms: number) => void (now += ms),
            },
          );
          return { started: true, exitCode: 0 };
        } catch (error) {
          failures.push(`assertImages: ${String(error)}`);
          return { started: true, exitCode: 1 };
        }
      },
      smoke: async () => ({ started: true, exitCode: 0 }),
      dispose: () => rmSync(dirname(receiptPath), { recursive: true, force: true }),
      log: () => {},
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    );
    return { w, outcome, failures, marks, receipts, verified, journal: standin.readJournal() };
  } finally {
    globalThis.fetch = network;
    rmSync(scratch, { recursive: true, force: true });
    for (const [name, value] of Object.entries(event))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

const explain = (result: Awaited<ReturnType<typeof firstScaleOutRelease>>) =>
  JSON.stringify(
    { outcome: result.outcome, failures: result.failures, events: result.w.events },
    null,
    2,
  );

test("a first scale-out release runs every phase, retires the root runtime and is marked deployed", async () => {
  const result = await firstScaleOutRelease();
  // The memo:false receipt Command re-runs in every deployStack phase of one deploy command, so
  // each later phase must overwrite the receipt the earlier one wrote.
  assert.deepEqual(
    result.failures.filter((line) => line.startsWith("deploy:")),
    [],
    explain(result),
  );
  assert.equal(result.journal?.complete, true);
  assert.ok(result.receipts.runs >= 1, "the receipt was captured");
  const green = result.w.byColor("green")!;
  assert.equal(result.w.root.instances.length, 0, "retirement destroyed the root runtime");
  assert.deepEqual(
    green.instances.map((row) => row.image),
    [candidateImage.ref],
  );
  assert.equal(result.w.controller.selection?.active.target.imageInput, candidateInput);
  assert.equal(result.w.controller.selection?.draining, undefined);
  const order = [
    "adopt:legacy",
    "create:application-blue",
    "create:application-green",
    "build:application-green",
    "promote:application-green",
    "destroy:application-root:controller-root",
  ];
  assert.deepEqual(
    result.w.events.filter((event) => order.includes(event)),
    order,
    explain(result),
  );
  // The runner's image check must then accept the release.
  assert.deepEqual(result.failures, [], explain(result));
  assert.deepEqual(
    result.outcome,
    { ok: true, value: { state: "deployed", deploymentId: 1 } },
    explain(result),
  );
  assert.deepEqual(result.marks, ["success"]);
});

test("the post-deploy image check accepts the fleet a completed release leaves behind", async () => {
  // Removing the prior receipt before each capture isolates the image check from the receipt write.
  const result = await firstScaleOutRelease({ isolateReceipt: true });
  assert.equal(result.journal?.complete, true, explain(result));
  assert.equal(result.w.root.instances.length, 0);
  // The receipt names the root application, which retirement left without an instance.
  assert.deepEqual(result.failures, [], explain(result));
  assert.deepEqual(result.marks, ["success"]);
  // The check verified the promoted primary through the fleet, on the candidate's image.
  const green = result.w.byColor("green")!;
  assert.equal(result.verified?.verifiedPath, "bound-fleet");
  assert.deepEqual(
    result.verified?.instances,
    green.instances.map((row) => row.id),
  );
  const served = result.verified?.fleet?.find((app) => app.imageInput === candidateInput);
  assert.equal(served?.digest, candidateImage.digest, "the serving fleet runs the candidate image");
  assert.deepEqual(
    green.instances.map((row) => row.image),
    [candidateImage.ref],
  );
});

test("the post-deploy image check still fails a release whose promoted primary is not running", async () => {
  const result = await firstScaleOutRelease({
    isolateReceipt: true,
    beforeImageCheck: (w) => {
      for (const row of w.byColor("green")!.instances) row.state = "stopped";
    },
  });
  assert.equal(result.journal?.complete, true, explain(result));
  assert.deepEqual(result.marks, ["failure"], explain(result));
  assert.equal(result.outcome.ok, false);
  assert.match(result.failures.join("\n"), /^assertImages: /m);
  // It failed on the fleet it inspected, not because it never looked past the retired root.
  assert.ok(result.w.instanceReads.includes("application-green"), explain(result));
});

test("the post-deploy image check fails a release whose fleet serves an image other than the candidate's", async () => {
  const result = await firstScaleOutRelease({
    isolateReceipt: true,
    beforeImageCheck: (w) => {
      // The promoted application, its running instance and its PoolWorker binding all moved to an
      // unrelated build, so no fleet application serves this candidate's image input.
      const green = w.byColor("green")!;
      green.image = foreignImage;
      green.input = foreignInput;
      for (const row of green.instances) row.image = foreignImage.ref;
      w.activatePoolWorker();
    },
  });
  assert.equal(result.journal?.complete, true, explain(result));
  assert.deepEqual(result.marks, ["failure"], explain(result));
  assert.equal(result.outcome.ok, false);
  assert.match(result.failures.join("\n"), /^assertImages: /m);
  // It failed on the fleet it inspected, not because it never looked past the retired root.
  assert.ok(result.w.instanceReads.includes("application-green"), explain(result));
});

test("the fixture's receipt Command matches the one the production stack declares", () => {
  // The release graph above copies src/pool/deployment.ts's receipt declaration. A change there must
  // change the copy, or this proof stops describing production.
  const source = readFileSync(new URL("../../src/pool/deployment.ts", import.meta.url), "utf8");
  const start = source.indexOf('Command.Exec("PoolImagePublicationReceipt"');
  assert.ok(start >= 0, "deployment.ts declares the receipt Command");
  const block = source.slice(start, source.indexOf("});", start));
  for (const line of [
    'command: "node capture-pool-image.ts"',
    "POOL_APPLICATION_ID: application.applicationId",
    'POOL_IMAGE_DIGEST: application.hash.pipe(Output.map((hash) => hash?.digest ?? ""))',
    "POOL_WORKER_READY: worker.workerName",
    "memo: false",
  ])
    assert.ok(block.includes(line), `deployment.ts receipt Command changed: ${line}`);
  // The fake PoolWorker binds the candidate's desired input on every activation; production does
  // only while deployment.ts binds it fresh and preserveRuntimeInputs does not retain the baseline's.
  assert.ok(source.includes("POOL_DESIRED_IMAGE_INPUT: yield* desiredPoolImageInput"));
  const retained = readFileSync(new URL("./preserve-runtime-plan.ts", import.meta.url), "utf8");
  assert.ok(!retained.includes('"POOL_DESIRED_IMAGE_INPUT"'), "the desired input is not retained");
});

// Regression: finalize-health-bridge-latency
test("release health over a bridge whose setup outlasts the health lease does not expire", async () => {
  // Every runtime command opens a fresh bridge, and from a CI runner its setup alone outlasts the
  // controller's 1,500 ms active-health lease (test/bridge-latency.ts).
  const result = await firstScaleOutRelease();
  assert.doesNotMatch(
    result.failures.join("\n"),
    /runtime-release-health-expired/,
    explain(result),
  );
  assert.equal(result.journal?.complete, true, explain(result));
  assert.deepEqual(result.marks, ["success"], explain(result));
});

// Regression: adopted-root-witness-under-new-controller
test("a controller-only release over a root an earlier controller adopted promotes a fleet primary", async () => {
  // The root already serves this candidate's image, so the release asks selectedCurrent about the
  // adopted legacy slot; its readback is pinned to the controller that adopted it, not this one.
  const result = await firstScaleOutRelease({ world: { root: "prior-controller" } });
  assert.doesNotMatch(
    result.failures.join("\n"),
    /handoff\.command\.action=witness/,
    explain(result),
  );
  assert.equal(result.journal?.complete, true, explain(result));
  assert.ok(result.w.events.includes("promote:application-green"), explain(result));
  assert.equal(result.w.controller.selection?.active.target.applicationId, "application-green");
  assert.deepEqual(result.marks, ["success"], explain(result));
});
