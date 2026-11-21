/**
 * The only way anything in this account is applied or destroyed: Alchemy's own plan, the checks no
 * tool provides, then Alchemy's own apply of the same snapshot. `alchemy deploy` makes the same
 * calls (Cli/commands/deploy.ts:192-228), but its `--yes` also sets `updateStateStore`, so a short
 * `/version` failure could redeploy the shared State store and rotate its token. Here that is
 * always false, and the run stops before planning unless a store bootstrap provably cannot happen.
 *
 *   bun scripts/release/deploy.ts plan     --stage <s> [--config <f>] [--policy <f>] [--include <fqn>]...
 *   bun scripts/release/deploy.ts apply    --stage <s> [--config <f>] [--policy <f>] [--include <fqn>]... --plan-digest <sha256> --attempt <id>
 *   bun scripts/release/deploy.ts deploy   --stage test-… [--config <f>] [--policy <f>] [--include <fqn>]...  (plan, check, apply in one run)
 *   bun scripts/release/deploy.ts destroy  --stage test-… [--config <f>]
 *   bun scripts/release/deploy.ts teardown --stage test-rehearsal-<n> [--verify-only]
 *   bun scripts/release/deploy.ts backup   --stage production --name <backup name>
 *   bun scripts/release/deploy.ts snapshot --stage <s> --out <file>
 *   bun scripts/release/deploy.ts compare  --before <file> --after <file>
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { StateService } from "alchemy/State/State";
import type { StageScope } from "./stage-writes.ts";
import type * as Fx from "effect/Effect";
import type { Snapshot } from "./plan-summary.ts";
import { resolvePathFlags } from "./entry-paths.ts";
import { assignEnvironment } from "./process-env.ts";
import { failureReport, progressTracker } from "./public-report.ts";
import { isRehearsalStage } from "./rehearsal-stage.ts";
import { safeJson } from "./safe-json.ts";
import { stackConfig } from "./stack-config.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cloud = resolve(root, ".upstream/apps/hosted/cloud");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    stage: { type: "string" },
    config: { type: "string" },
    policy: { type: "string" },
    include: { type: "string", multiple: true },
    "plan-digest": { type: "string" },
    attempt: { type: "string" },
    name: { type: "string" },
    out: { type: "string" },
    before: { type: "string" },
    after: { type: "string" },
    fqn: { type: "string" },
    from: { type: "string" },
    expect: { type: "string" },
    light: { type: "boolean" },
    to: { type: "string" },
    "root-boot": { type: "string" },
    admitted: { type: "string" },
    apply: { type: "string" },
    serving: { type: "string" },
    "allow-not-serving": { type: "boolean" },
    "verify-only": { type: "boolean" },
  },
});
// Before the entry moves into the cloud app (below): a relative path names a file in the directory
// the command was started in, not one inside the cloud app. `--config` is not here: stackConfig
// resolves it, with its own fallback to the repo root.
resolvePathFlags(
  values,
  ["policy", "out", "before", "after", "from", "root-boot", "admitted", "serving"],
  process.cwd(),
);
const command = positionals[0] ?? "";
const stage = values.stage ?? "";
const { config, scaleStack } = stackConfig(values.config, root, process.cwd());

if (command !== "compare") {
  if (stage === "production") {
    if (
      process.env.GITHUB_ACTIONS !== "true" ||
      !/^[a-f0-9]{40}$/u.test(process.env.BASALT_RELEASE_CANDIDATE ?? "")
    )
      throw new Error("Production releases run only in GitHub Actions on an immutable candidate");
    if (command === "destroy" || command === "teardown")
      throw new Error("Production is never destroyed");
    if (command === "deploy") throw new Error("Production applies only a reviewed plan digest");
  } else if (scaleStack ? !/^scale-[0-9]+$/u.test(stage) : !/^test-[a-z0-9-]+$/u.test(stage)) {
    throw new Error(
      "Use --stage production, a disposable test-* stage, or scale-<n> for the scale stack",
    );
  } else if (stage.includes("rehearsal") && !isRehearsalStage(stage)) {
    // A teardown finds a rehearsal stage's leftovers by names that carry its stage whole; a stage
    // like test-rehearsal-2-x or test-x-test-rehearsal-2 would make those names ambiguous.
    throw new Error("A rehearsal stage is exactly test-rehearsal-<n>, n from 1 to 9");
  }
}
// A teardown deletes by the stage token in names, which only a rehearsal stage's names carry.
if (command === "teardown" && !isRehearsalStage(stage))
  throw new Error("A teardown runs only on a test-rehearsal-<n> stage");

/**
 * Keeps text that may name hosts, ids or values off public logs and artifacts: in plain under the
 * gitignored .local, in the stage runner's own sealed output when it gives one, and sealed with the
 * deployment key next to the uploaded records on production.
 */
const keepPrivate = async (name: string, detail: string) => {
  await mkdir(resolve(root, ".local/release"), { recursive: true });
  await writeFile(resolve(root, `.local/release/${name}.txt`), `${detail}\n`);
  if (process.env.BASALT_STAGE_OUTPUT_DIR)
    await appendFile(
      resolve(process.env.BASALT_STAGE_OUTPUT_DIR, `release-${name}.txt`),
      `${detail}\n`,
    );
  const key = process.env.EXECUTOR_ENCRYPTION_KEY;
  if (stage === "production" && key)
    try {
      const { sealRecord } = await import("./legacy-records.ts");
      await writeFile(
        resolve(root, `.local/release/${name}.sealed.json`),
        safeJson(sealRecord(detail, key, `release-${name}`)),
      );
    } catch (error) {
      console.error(`The ${name} detail could not be sealed (${failureReport(error).publicText})`);
    }
};
const summary = async (text: string) => {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  console.log(text);
};
const output = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${safeJson(value, 2)}\n`);
};
// What the run was doing when it stopped, by the names in our own source.
const tracker = progressTracker();
tracker.setPhase(command || "start");
/** Every stop says where and what in public; names, ids and raw messages stay private. */
const stop = async (error: unknown) => {
  const report = failureReport(error, tracker.context());
  console.error(report.publicText);
  await summary(report.publicText);
  await keepPrivate("failure", report.detail);
  process.exitCode = 1;
};

if (command === "compare") {
  try {
    const { Effect, Schema } = await import("effect");
    const { compareSnapshots, DatabaseSnapshot } = await import("./database-safety.ts");
    const read = async (path: string | undefined) =>
      Schema.decodeUnknownSync(DatabaseSnapshot)(
        JSON.parse(await readFile(resolve(path ?? ""), "utf8")),
      );
    await Effect.runPromise(compareSnapshots(await read(values.before), await read(values.after)));
    await summary("Database counts: unchanged or grown; Home's schema version unchanged.");
    process.exit(0);
  } catch (error) {
    await stop(error);
    process.exit(1);
  }
}

if (command === "boot" || command === "accept") {
  try {
    // Plain HTTP through the public pool; needs no Alchemy and touches nothing it could change.
    const { Schema } = await import("effect");
    const {
      acceptanceExit,
      awaitRecoveryReady,
      bootBeforeApply,
      healingOutcome,
      healingWait,
      NOT_SERVING,
      runAcceptance,
    } = await import("./acceptance.ts");
    const { acceptanceCredential, refusalFix } = await import("./acceptance-device.ts");
    const { PoolAcceptanceClient } = await import("../pool-acceptance/client.ts");
    const client = process.env.POOL_ACCEPTANCE_ORIGIN
      ? new PoolAcceptanceClient({ origin: process.env.POOL_ACCEPTANCE_ORIGIN })
      : new PoolAcceptanceClient();
    // Every model call signs its own short assertion for the registered acceptance device.
    const credential = acceptanceCredential(process.env);
    if (command === "boot") {
      // Read before the apply: the root serves alone until a fleet is enabled.
      // Only a release that declares a root restart may start on a pool that does not serve the read.
      const boot = await bootBeforeApply(credential, client, values["allow-not-serving"] === true);
      await output(resolve(values.out ?? ""), { boot });
      await summary(
        boot === NOT_SERVING
          ? "The pool did not serve the boot read before the apply (no answer, an error status, or a 429). This release declares a root restart, so it goes on, but without that boot acceptance cannot confirm the root restarted."
          : "The root's boot is recorded before the apply.",
      );
      process.exit(0);
    }
    const bootRecord = async (path: string | undefined) =>
      path
        ? Schema.decodeUnknownSync(Schema.Struct({ boot: Schema.String }))(
            JSON.parse(await readFile(resolve(path), "utf8")),
          ).boot
        : undefined;
    let rootBoot = await bootRecord(values["root-boot"]);
    // What a healing release's outcome compares with, before rootBoot becomes its new boot.
    const bootBefore = rootBoot ?? NOT_SERVING;
    // The boot read writes its record only when the pool did not refuse the device (a refusal stops
    // the run there): it served the device, or for a declared restart did not serve at all. So
    // after the apply a 401 or 403 is the release's. `--admitted` passes that record without
    // requiring its boot, for the rollback's read of the version it put back.
    const admitted = rootBoot !== undefined || (await bootRecord(values.admitted)) !== undefined;
    const expect = values.expect ?? "same-boot";
    if (!["same-boot", "two-runtimes", "any", "restart"].includes(expect))
      throw new Error(`Unknown --expect ${expect}`);
    if (rootBoot === NOT_SERVING && expect !== "restart")
      throw new Error(
        "The pool did not serve the boot read before the apply, and this release declares no restart",
      );
    let restart: Record<string, unknown> | undefined;
    // Which bound a healing release waited within, named in its summary line.
    let bound: { name: string; seconds: number } | undefined;
    let verdict: Awaited<ReturnType<typeof awaitRecoveryReady>> | undefined;
    // How the stuck runtime was stopped, read from the pool Worker's log when it did not heal.
    let stopPathsOf: (() => Promise<unknown>) | undefined;
    const startedAt = Date.now();
    if (expect === "restart") {
      // The bound comes from the controller's own named constants: the fix acts, stops the runtime
      // gracefully, and the controller's recovery starts a new one inside its own startup budget.
      if (!rootBoot || !values.serving)
        throw new Error("--expect restart needs --root-boot and --serving <serving.json>");
      const within = healingWait(values.apply);
      bound = within;
      // `/v1/models` answers while model calls are still refused; the controller's recovery `ready`
      // is the signal. The new controller answers a signed read-only `inspect` once it has adopted
      // its code; until then it refuses on identity, which reads as not ready yet.
      const { observeSender } = await import("../pool-crash-dispatch.ts");
      const generated = async (path: string, name: string) => {
        const value = new RegExp(`export const ${name} = "([0-9a-f]+)"`, "u").exec(
          await readFile(resolve(root, path), "utf8"),
        )?.[1];
        if (!value) throw new Error(`${name} is missing from the prepared tree`);
        return value;
      };
      // The identity the deployed Worker embeds (src/pool/worker.ts), from the same generated files.
      const controllerCode = {
        candidate: await generated(
          ".upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts",
          "productionOpsRelease",
        ),
        workerInput: await generated(
          ".upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts",
          "poolWorkerRevision",
        ),
      };
      const serving = JSON.parse(await readFile(resolve(values.serving), "utf8")) as {
        workers?: { fqn: string; script?: string }[];
      };
      const worker = serving.workers?.find((entry) => entry.fqn === "PoolWorker")?.script;
      if (!worker) throw new Error("The serving record names no PoolWorker script");
      const observe = observeSender();
      stopPathsOf = async () => {
        const { readStopPaths } = await import("./stop-path.ts");
        // The forced stop runs after the apply, which ran just before this step.
        return readStopPaths({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
          token: process.env.CLOUDFLARE_API_TOKEN ?? "",
          script: worker,
          from: startedAt - 30 * 60_000,
        });
      };
      verdict = await awaitRecoveryReady({
        inspect: async () =>
          (
            (await observe(
              "inspect",
              controllerCode,
              { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", worker },
              // The pool Worker opens handoff envelopes with its deployment key (`runtimeHandoff`),
              // as the crash dispatcher signs them; the app signing key signs pool tokens.
              process.env.POOL_DEPLOYMENT_KEY ?? "",
            )) as { result?: unknown } | undefined
          )?.result,
        before: rootBoot,
        withinMs: within.seconds * 1_000,
      });
      restart = {
        bound,
        ready: verdict.ready,
        waitedMs: verdict.waitedMs,
        reads: verdict.reads,
        ...(verdict.ready ? {} : { reason: verdict.reason, last: verdict.last }),
      };
      if (!verdict.boot) {
        // No new boot is selected, so no model call could show the release healed the pool.
        const view = { outcome: "not-serving", restart, stopPaths: await stopPathsOf() };
        if (values.out) await output(resolve(values.out), view);
        await summary(
          `NOT SERVING after the healing release, waited up to ${bound?.seconds} s (${bound?.name}): ${safeJson(view)}`,
        );
        process.exit(1);
      }
      rootBoot = verdict.boot;
    }
    const result = await runAcceptance({
      credential,
      ...(process.env.POOL_ACCEPTANCE_MODEL ? { model: process.env.POOL_ACCEPTANCE_MODEL } : {}),
      // After a declared restart, every request must be served by the one new boot.
      expect: (expect === "restart" ? "same-boot" : expect) as "same-boot",
      ...(rootBoot ? { rootBoot } : {}),
      admitted,
      client,
    }).catch(async (error: unknown) => {
      if (!verdict) throw error;
      // The model calls could not run at all (the catalog failed): a healing release that did not
      // serve. Its record is kept; the cause can name hosts, so it stays in the private detail.
      await keepPrivate("acceptance", error instanceof Error ? error.message : String(error));
      const view = {
        outcome: "not-serving",
        failed: "the model calls could not run",
        restart,
        ...(stopPathsOf ? { stopPaths: await stopPathsOf() } : {}),
      };
      if (values.out) await output(resolve(values.out), view);
      await summary(`NOT SERVING after the healing release: ${safeJson(view)}`);
      process.exit(1);
    });
    // A healing release ends healed, serving but needing a person or with its restart unconfirmed,
    // could not test, or not serving.
    const outcome = verdict
      ? healingOutcome(verdict, result, bootBefore)
      : result.couldNotTest
        ? "could-not-test"
        : undefined;
    // Failure messages can name hosts; the public record keeps counts and timings only.
    const view = {
      passed: result.passed,
      requests: result.requests,
      failed: result.failures.length,
      ...(result.refused.length ? { refused: result.refused } : {}),
      runtimes: result.boots.length,
      firstByteMs: result.firstByteMs,
      ...(outcome ? { outcome } : {}),
      ...(restart ? { restart } : {}),
      // How the stuck runtime was stopped, if it was: the evidence a person reads for either.
      ...((outcome === "not-serving" || outcome === "serving-restart-unconfirmed") && stopPathsOf
        ? { stopPaths: await stopPathsOf() }
        : {}),
    };
    if (values.out) await output(resolve(values.out), view);
    const waited = bound ? ` Bound: ${bound.seconds} s (${bound.name}).` : "";
    await summary(
      (outcome === "serving-restart-unconfirmed"
        ? `SERVING, RESTART UNCONFIRMED: the root's boot before the release could not be read, so nothing shows the release restarted the root. Every model call served${verdict?.ready ? "" : `; the controller's recovery ${String(restart?.reason)}`}. Nothing was undone; a person reads the stop path with the pool serving. ${safeJson(view)}`
        : outcome === "serving-needs-person"
          ? `SERVING, NEEDS A PERSON: every model call served on the new boot, but the controller's recovery ${String(restart?.reason)}. Nothing was undone; a person looks at it with the pool serving. ${safeJson(view)}`
          : outcome === "could-not-test"
            ? `ACCEPTANCE COULD NOT TEST: ${refusalFix(result.refused)}. Nothing was undone. ${safeJson(view)}`
            : outcome === "not-serving"
              ? `NOT SERVING after the healing release: ${safeJson(view)}`
              : `Acceptance ${result.passed ? "passed" : "FAILED"}: ${safeJson(view)}`) + waited,
    );
    if (!result.passed) await keepPrivate("acceptance", safeJson(result, 2));
    process.exit(acceptanceExit(outcome, result.passed));
  } catch (error) {
    await stop(error);
    // A refused or misnamed acceptance device tested nothing, so it is never a failure to undo.
    const { AcceptanceDeviceRefused, COULD_NOT_TEST_EXIT } = await import("./acceptance-device.ts");
    process.exit(error instanceof AcceptanceDeviceRefused ? COULD_NOT_TEST_EXIT : 1);
  }
}

if (command === "db-load") {
  try {
    const { Effect, Redacted } = await import("effect");
    const { FetchHttpClient } = await import("effect/http");
    const { assertPrimaryCpuBelow } = await import("./database-safety.ts");
    const { previewPoolDatabaseBranch } = await import("../../src/pool/database-settings.ts");
    // The database the stage's own declaration names: production's, or a test stage's branch.
    const where =
      stage === "production"
        ? { database: process.env.PLANETSCALE_DATABASE_NAME || "basalt", branch: "main" }
        : {
            database: process.env.TEST_STAGE_DATABASE ?? "",
            branch: previewPoolDatabaseBranch(stage),
          };
    if (!where.database) throw new Error("db-load on a test stage needs TEST_STAGE_DATABASE");
    const reading = await Effect.runPromise(
      assertPrimaryCpuBelow({
        organization: process.env.PLANETSCALE_ORGANIZATION ?? "",
        tokenId: Redacted.make(process.env.PLANETSCALE_API_TOKEN_ID ?? ""),
        token: Redacted.make(process.env.PLANETSCALE_API_TOKEN ?? ""),
        ...where,
        ceiling: 60,
        now: Date.now(),
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    await summary(
      `Pool database primary CPU ${reading.cpuPercent.toFixed(1)}% at ${reading.at}: under 60%.`,
    );
    process.exit(0);
  } catch (error) {
    await stop(error);
    process.exit(1);
  }
}

// The PoolDatabase command re-runs per attempt, so plan and apply share one attempt id.
const attempt = values.attempt ?? (command === "apply" ? "" : randomUUID());
if (command === "apply" && !/^[0-9a-f-]{36}$/u.test(attempt))
  throw new Error("--attempt <id printed by the plan run> is required");
if (stage === "production") {
  const { deployEnvironment } = await import("../environment.ts");
  assignEnvironment(process.env, deployEnvironment());
}
// CI makes every State store bootstrap branch die rather than prompt (StateStore/State.ts:231-238).
Object.assign(process.env, { BASALT_RELEASE_ATTEMPT: attempt, ALCHEMY_STAGE: stage, CI: "true" });

// Alchemy captures the working directory once, when its first module loads (alchemy/Util/Node.ts
// `initialCwd`), and resolves every command's relative cwd from it. The stack's commands are
// declared relative to the cloud app, so the entry moves there before anything loads Alchemy.
const policyPath = values.policy;
process.chdir(cloud);
const { decodeReleasePolicy } = await import("./policy.ts");
const { initialCwd } = await import("alchemy/Util/Node");
if (initialCwd !== process.cwd())
  throw new Error(
    "Alchemy loaded before the entry moved into the cloud app, so the stack's command directories would resolve elsewhere",
  );
const policy = policyPath
  ? decodeReleasePolicy(JSON.parse(await readFile(policyPath, "utf8")))
  : undefined;
for (const [name, value] of Object.entries(policy?.env ?? {}))
  if (value !== undefined) process.env[name] = value;
const include: string[] = values.include?.length ? values.include : [...(policy?.include ?? [])];
// Only planning reads the policy; the read-only and rollback commands never plan.
if (stage === "production" && !policy && ["plan", "apply"].includes(command))
  throw new Error("Production plans and applies only under a policy");

const { Effect, Logger } = await import("effect");
const { Redacted } = await import("effect");
const WireGuard = await import("./wire-guard.ts");
const { checkPlan, decodePlanPolicy, planDigest } = await import("./plan-check.ts");
const Alchemist = await import("alchemy/Alchemist");
const Session = await import("alchemy/Alchemist/Session");
const {
  ChangesRemainAfterApply,
  changedRows,
  destroyTargets,
  readinessCommand,
  remainingRows,
  updatesWorkerWithoutReadiness,
} = await import("./plan-summary.ts");
const { buildSteps, everyReleaseSteps, runReleaseStep } = await import("./release-steps.ts");
const { ownIdentities, stageRows } = await import("./stage-writes.ts");
const { storeCannotBootstrap } = await import("./state-store-guard.ts");
const { liveMainModuleSha256 } = await import("./live-module.ts");
const { servingBindingShapes } = await import("./fixed-bindings.ts");
const { rootPinMismatch, setRootPin } = await import("./root-pin.ts");
const { rollbackTo, servingVersion } = await import("./worker-version.ts");
const liveModules: { fqn: string; digest: string }[] = [];
const database = await import("./database-safety.ts");

// Alchemy's progress events, kept so every run's full sequence survives in the artifact. Only short
// identifying fields are kept; props and outputs never are.
const events: string[] = [];
const keep = [
  "_tag",
  "id",
  "fqn",
  "logicalId",
  "status",
  "phase",
  "action",
  "resourceType",
  "kind",
  "message",
];
const reporter = (event: unknown) =>
  Effect.sync(() => {
    tracker.track(event);
    const line = safeJson(
      Object.fromEntries(
        Object.entries(event as Record<string, unknown>)
          .filter(
            ([key, value]) =>
              keep.includes(key) && ["string", "number", "boolean"].includes(typeof value),
          )
          .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 300) : value]),
      ),
    );
    events.push(line);
    // The log is public; Alchemy's free-text messages (which can carry URLs) stay in the kept file.
    const { message: _message, ...shown } = JSON.parse(line) as Record<string, unknown>;
    console.log(safeJson(shown));
  });

let journal: ReadonlyArray<{ method: string; host: string; path: string }> = [];
// Filled by a destroy from its own plan, before anything is deleted.
const deletable: { kind: string; id: string }[] = [];
const run = <A>(effect: Fx.Effect<A, unknown, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Installed before any Alchemy layer is built: Effect caches the default fetch on first read.
        // The class change must re-upload the live code byte for byte (R2); the guard compares it.
        // Script names carry the stage, so policies name FQNs and the State rows supply the names.
        const wire = {
          sqliteClasses: {} as Record<string, ReadonlyArray<string>>,
          mainModuleSha256: {} as Record<string, string>,
          fixedBindings: {} as Record<string, ReadonlyArray<string>>,
          // A fresh disposable stage creates every class on its first deploy; production never does.
          anyNewSqliteClass: stage !== "production" && !policy,
          rootApplications: [] as string[],
          rootApplicationNames: [] as string[],
          // Production keeps the root from the first request on: until both its id and its name
          // are pushed below, no container application write leaves.
          rootRequired: stage === "production",
          deletable,
          stage: undefined as StageScope | undefined,
          // Reads of production send nothing but reads; the guard refuses anything else.
          readOnly:
            stage === "production" &&
            ["plan", "preflight", "snapshot", "serving"].includes(command),
        };
        const guard = yield* WireGuard.install(wire);
        journal = guard.journal;
        const guarded = Effect.gen(function* () {
          yield* WireGuard.selfTest();
          yield* storeCannotBootstrap;
          // A disposable stage shares the account, token and State store with production: from here
          // on every write it sends must target what its own State rows record or this run creates.
          if (stage !== "production") {
            const store = yield* Alchemist.State.store({
              backend: "configured",
              ...target,
            } as never) as unknown as Fx.Effect<StateService, unknown, never>;
            const stack = yield* stackName();
            const label = stage.replace(/^test-/u, "");
            wire.stage = {
              stack,
              stage,
              label,
              ...(process.env.TEST_STAGE_DOMAIN ? { domain: process.env.TEST_STAGE_DOMAIN } : {}),
              // Only the stage's own database, by the name its stack derives; anything else none.
              databases:
                process.env.TEST_STAGE_DATABASE === `basalt-preview-${label}`
                  ? [process.env.TEST_STAGE_DATABASE]
                  : [],
              owned: ownIdentities(
                yield* stageRows(store as never, stack, stage) as Fx.Effect<
                  unknown[],
                  unknown,
                  never
                >,
              ),
              // Deletes by the stage token in names; no other command sets it, and the check alone
              // (`--verify-only`) never does, so the wire refuses any delete it sends.
              ...(command === "teardown" && !values["verify-only"] ? { teardown: true } : {}),
              accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
            };
          }
          for (const [fqn, classes] of Object.entries(policy?.wire.sqliteClasses ?? {}))
            wire.sqliteClasses[yield* scriptName(fqn)] = classes;
          for (const fqn of policy?.wire.expectLiveModule ?? []) {
            const script = yield* scriptName(fqn);
            const digest = yield* liveMainModuleSha256({
              accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
              token: Redacted.make(process.env.CLOUDFLARE_API_TOKEN ?? ""),
              script,
            });
            wire.mainModuleSha256[script] = digest;
            liveModules.push({ fqn, digest });
          }
          // A Worker admitted as code only uploads exactly what its serving version binds.
          for (const fqn of policy?.wire.fixedBindings ?? []) {
            const script = yield* scriptName(fqn);
            wire.fixedBindings[script] = yield* servingBindingShapes({
              accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
              token: Redacted.make(process.env.CLOUDFLARE_API_TOKEN ?? ""),
              script,
            });
          }
          // Every reviewed release, and every production command, leaves the root application as
          // recorded; previews roll it freely. A stage under a policy keeps its root by the same
          // rules once its State row records one, so a rehearsal runs them as production does.
          const rootFqn =
            policy?.check?.poolContainer.fqn ??
            (stage === "production" ? "PoolContainer" : undefined);
          if (rootFqn) {
            const root = yield* recordedApplication(rootFqn);
            if (root) {
              wire.rootApplications.push(root.id);
              wire.rootRequired = true;
              if (root.name) wire.rootApplicationNames.push(root.name);
              else
                yield* Effect.promise(() =>
                  summary(
                    "Warning: the root's State row records no application name, so every container application write in this run is refused.",
                  ),
                );
            } else if (stage === "production" && policy?.check)
              return yield* Effect.die(new Error("No root application recorded on production"));
          }
          // A refused request fails the run at once instead of after the SDK's retries.
          return yield* Effect.raceFirst(
            effect.pipe(Effect.provideService(Alchemist.Progress, reporter)) as Fx.Effect<
              A,
              unknown,
              never
            >,
            guard.refused as Fx.Effect<never, unknown, never>,
          );
        });
        return yield* guarded.pipe(
          Effect.provide(Alchemist.layer()),
          Effect.provide(guard.layer),
          // Effect's default console logger would print Alchemy's own lines (script names, hosts)
          // into the public log. Replaced by none: Alchemy's session merges its private file log in.
          Effect.provide(Logger.layer([])),
        ) as Fx.Effect<A, unknown, never>;
      }),
    ) as Fx.Effect<A, unknown, never>,
  );

const target = { entrypoint: scaleStack ? config : resolve(root, config), stage };
let loadedStackName: string | undefined;
/**
 * The stack's own name, as its module declares it, loaded by Alchemy's own stack loader (the one
 * `Stack.plan` uses): production deploys `basalt`, a rehearsal stage deploys under its own stack
 * name. Every State read keys on it.
 */
const stackName = () =>
  Effect.gen(function* () {
    if (loadedStackName) return loadedStackName;
    // Its FileSystem and Path come from Alchemist.layer(), which every run provides.
    const stack = yield* Session.importStack(target.entrypoint) as unknown as Fx.Effect<
      { readonly stackName: string },
      unknown,
      never
    >;
    loadedStackName = stack.stackName;
    return stack.stackName;
  });
/** A Worker's live script name, from its State row (names carry the stage, policies name FQNs). */
const scriptName = (fqn: string) =>
  Effect.gen(function* () {
    const state = yield* Alchemist.State.store({
      backend: "configured",
      ...target,
    } as never) as unknown as Fx.Effect<StateService, unknown, never>;
    const row = (yield* state.get({ stack: yield* stackName(), stage, fqn })) as
      | { attr?: { workerName?: unknown } }
      | undefined;
    const script = row?.attr?.workerName;
    if (typeof script !== "string" || !script)
      return yield* Effect.die(new Error(`No live script name recorded for ${fqn}`));
    return script as string;
  });

/** The container application a State row records, if the row exists yet. */
const recordedApplication = (fqn: string) =>
  Effect.gen(function* () {
    const state = yield* Alchemist.State.store({
      backend: "configured",
      ...target,
    } as never) as unknown as Fx.Effect<StateService, unknown, never>;
    const row = (yield* state.get({ stack: yield* stackName(), stage, fqn })) as
      | { attr?: { applicationId?: unknown; applicationName?: unknown } }
      | undefined;
    const id = row?.attr?.applicationId;
    const name = row?.attr?.applicationName;
    return typeof id === "string" && id
      ? { id, name: typeof name === "string" && name ? name : undefined }
      : undefined;
  });

const planOf = (operation: "deploy" | "destroy") =>
  Alchemist.Stack.plan({
    target,
    operation,
    updateStateStore: false,
    ...(operation === "deploy" && include.length ? { include } : {}),
  } as never) as unknown as Fx.Effect<Snapshot, unknown, never>;

const checkPolicy = () => {
  if (!policy?.check) return undefined;
  const pin = process.env.POOL_ROOT_IMAGE ? JSON.parse(process.env.POOL_ROOT_IMAGE) : undefined;
  return {
    ...policy.check,
    poolContainer: {
      ...policy.check.poolContainer,
      image: pin?.image ?? "",
      ...(typeof pin?.input === "string" ? { input: pin.input } : {}),
    },
    ...(include.length ? { include } : {}),
  };
};

try {
  // The root pin's full reference carries the account, so it exists only in this process.
  setRootPin(process.env);
  if (command === "plan" || command === "apply" || command === "deploy") {
    const result = await run(
      Effect.gen(function* () {
        // The store's contract version is pinned: a different one means a deliberate upgrade first.
        const store = yield* Alchemist.State.store({
          backend: "configured",
          ...target,
        } as never) as unknown as Fx.Effect<StateService, unknown, never>;
        const version = yield* store.getVersion() as Fx.Effect<number, unknown, never>;
        if (version !== 8)
          return yield* Effect.die(
            new Error(`State store version ${version}, expected 8: upgrade it deliberately first`),
          );
        tracker.setPhase("plan");
        let snapshot = yield* planOf("deploy");
        // A build this job has not run plans as changed (its output is missing), and so does every
        // Worker bundled from it. Build first, then check the plan of what is really there.
        const builds = yield* buildSteps(snapshot.native);
        if (builds.length > 0) {
          tracker.setPhase("build");
          for (const step of builds) yield* runReleaseStep(step);
          tracker.setPhase("plan");
          snapshot = yield* planOf("deploy");
        }
        const checked = checkPolicy();
        if (checked) yield* checkPlan(snapshot.native, yield* decodePlanPolicy(checked));
        // After the plan check, which proves the recorded attachment the read relies on and names
        // every violation first. A rehearsal stage pinned to production's root image runs the same
        // read, so it is proven on a real application before production relies on it.
        if (
          checked &&
          command === "plan" &&
          (stage === "production" || /^test-rehearsal-[1-9][0-9]*$/u.test(stage))
        ) {
          // The provider decides at apply, after the pool Worker's upload, whether the root's row
          // modifies the application; the plan makes the same read and comparison first.
          const root = yield* Effect.promise(() => import("./root-settle-check.ts"));
          const settled = yield* root.rootSettles({
            node: snapshot.native.resources[checked.poolContainer.fqn],
            accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
            pin: checked.poolContainer.image,
            read: root.liveApplication(Redacted.make(process.env.CLOUDFLARE_API_TOKEN ?? "")),
          });
          if (settled) yield* Effect.promise(() => summary(settled));
        }
        const digest = planDigest(snapshot.native);
        if (policy && updatesWorkerWithoutReadiness(snapshot, policy.check.poolWorker))
          return yield* Effect.die(
            new Error(
              `The plan updates ${policy.check.poolWorker} without ${readinessCommand}, so nothing waits for the pool object to adopt the new code; include it`,
            ),
          );
        if (command === "plan" && stage === "production" && policy) {
          // Readiness refuses a runtime digest that differs from the selected runtime's seal only
          // after the upload; the plan compares first, or says loudly why it could not.
          const fingerprint = yield* Effect.promise(() => import("./fingerprint-check.ts"));
          const report = fingerprint.fingerprintReport(
            yield* fingerprint.checkRuntimeFingerprint(
              snapshot.native,
              policy.check.poolWorker,
              async () => fingerprint.identityUnknownBeforeUpload,
            ),
          );
          yield* Effect.promise(() => summary(report.summary));
          if (report.annotation) console.log(report.annotation);
        }
        if (command === "plan") return { snapshot, digest, planned: changedRows(snapshot) };
        if (command === "apply" && values["plan-digest"] !== digest)
          return yield* Effect.die(
            new Error(
              `The plan changed since review: reviewed ${values["plan-digest"]}, now ${digest}`,
            ),
          );
        const planned = changedRows(snapshot);
        // Checks keyed on their real inputs plan as noop when those are unchanged; they must still
        // pass on every release, so the entry runs them before anything is applied.
        tracker.setPhase("checks");
        for (const step of yield* everyReleaseSteps(snapshot.native)) yield* runReleaseStep(step);
        tracker.setPhase("apply");
        yield* Alchemist.Stack.apply(snapshot as never);
        tracker.setPhase("read-back");
        const after = yield* planOf("deploy");
        const remaining = remainingRows(after);
        if (remaining.length > 0) return yield* ChangesRemainAfterApply.of(remaining);
        return { snapshot, digest, planned };
      }),
    );
    const record = {
      liveModules,
      stage,
      config,
      include,
      attempt,
      digest: result.digest,
      summary: result.snapshot.summary,
      changes: result.planned,
    };
    await output(resolve(root, `.local/release/${command}.json`), record);
    await summary(
      `${command === "plan" ? "Planned" : "Applied; a fresh plan is all noop"}: digest \`${result.digest}\`, attempt \`${attempt}\``,
    );
    await summary(`\`\`\`json\n${safeJson(record.changes, 2)}\n\`\`\``);
  } else if (command === "destroy") {
    await run(
      Effect.gen(function* () {
        const plan = yield* planOf("destroy");
        deletable.push(...destroyTargets(plan.native));
        yield* Alchemist.Stack.apply(plan as never);
      }),
    );
    await summary(`Destroyed ${config} on stage ${stage}.`);
  } else if (command === "teardown") {
    const { teardownStage, TEARDOWN_NOT_CHECKED } = await import("./stage-teardown.ts");
    const result = await run(
      Effect.tryPromise(() =>
        teardownStage(
          values["verify-only"] ? "verify" : "delete",
          {
            accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
            token: process.env.CLOUDFLARE_API_TOKEN ?? "",
            stage,
          },
          // Read when the effect runs, inside `run`: the guard's fetch, never the bare one.
          globalThis.fetch,
        ),
      ),
    );
    // Names carry the stage and stay in the private record; the public summary keeps counts.
    await keepPrivate("teardown", safeJson(result, 2));
    await summary(
      values["verify-only"]
        ? `Checked stage ${stage}: none of its container applications or tagged registry images remain. ${TEARDOWN_NOT_CHECKED}`
        : `Tore down stage ${stage}: ${result.applications.length} container applications and ${result.manifests} registry manifests in ${result.repositories.length} repositories deleted; none tagged remain. ${TEARDOWN_NOT_CHECKED}`,
    );
  } else if (command === "backup") {
    if (stage !== "production") throw new Error("Backups are taken of production only");
    const backup = await run(
      database.takeBackup({
        organization: process.env.PLANETSCALE_ORGANIZATION ?? "",
        tokenId: Redacted.make(process.env.PLANETSCALE_API_TOKEN_ID ?? ""),
        token: Redacted.make(process.env.PLANETSCALE_API_TOKEN ?? ""),
        database: "basalt",
        branch: "main",
        name: values.name ?? "",
      }),
    );
    await summary(`PlanetScale backup complete: \`${backup.name}\``);
  } else if (command === "preflight") {
    // Read-only, once before the cutover: the State store version, every State row, the retired
    // layer's records exported sealed, no unresolved Home migration, and the root pin against State.
    const legacy = await import("./legacy-records.ts");
    const poolParameters = await import("./pool-parameters.ts");
    const result = await run(
      Effect.gen(function* () {
        const state = yield* Alchemist.State.store({
          backend: "configured",
          ...target,
        } as never) as unknown as Fx.Effect<StateService, unknown, never>;
        const version = yield* state.getVersion() as Fx.Effect<number, unknown, never>;
        if (version !== 8)
          return yield* Effect.die(
            new Error(`State store version ${version}, expected 8: upgrade deliberately first`),
          );
        const stack = yield* stackName();
        const rows = yield* legacy.stateRows(state, stack, stage);
        const key = process.env.EXECUTOR_ENCRYPTION_KEY ?? "";
        const exported = yield* legacy.exportLegacyRecords(
          state,
          stack,
          stage,
          resolve(root, ".local/release/legacy"),
          key,
          (process.env.BASALT_LEGACY_ARCHIVE_STACKS ?? "").split(",").filter(Boolean),
        );
        yield* legacy
          .assertNoUnresolvedHome(stack, stage, key)
          .pipe(Effect.provideService(legacy.State, Effect.succeed(state)));
        const rootRow = yield* state.get({
          stack: yield* stackName(),
          stage,
          fqn: "PoolContainer",
        }) as Fx.Effect<unknown, unknown, never>;
        const workerRow = yield* state.get({
          stack: yield* stackName(),
          stage,
          fqn: "PoolWorker",
        }) as Fx.Effect<unknown, unknown, never>;
        // Without both, the guard refuses every container application write of a release, the
        // class change's creates included; said in words before the pin is compared.
        const attr = (rootRow as { attr?: Record<string, unknown> } | undefined)?.attr;
        const present = (value: unknown) =>
          typeof value === "string" && value ? "present" : "absent";
        const rootRecord = `id ${present(attr?.applicationId)}, name ${present(attr?.applicationName)}`;
        yield* Effect.promise(() => summary(`root row: ${rootRecord}`));
        const mismatch = rootPinMismatch(process.env.POOL_ROOT_IMAGE, rootRow, workerRow);
        if (mismatch) return yield* Effect.fail(mismatch);
        // One GET of the branch's parameters, which the apply's first database step compares and,
        // when the pooler differs, patches. A difference or an unreadable answer is reported only.
        // Production only: its branch is fixed below, and only production's preflight is read-only.
        const pool =
          stage !== "production"
            ? ("not-production" as const)
            : yield* poolParameters
                .readPoolParameters({
                  organization: process.env.PLANETSCALE_ORGANIZATION ?? "",
                  tokenId: Redacted.make(process.env.PLANETSCALE_API_TOKEN_ID ?? ""),
                  token: Redacted.make(process.env.PLANETSCALE_API_TOKEN ?? ""),
                  database: "basalt",
                  branch: "main",
                })
                .pipe(
                  Effect.match({
                    onFailure: () => "unreadable" as const,
                    onSuccess: (report) => report,
                  }),
                );
        yield* Effect.promise(() =>
          summary(
            pool === "not-production"
              ? "Pool parameters: read on production only"
              : pool === "unreadable"
                ? "Pool parameters: unreadable; the apply's first database step is not predicted"
                : poolParameters.poolParameterLine(pool),
          ),
        );
        return {
          stateStoreVersion: version,
          rows,
          exported,
          rootRow: rootRecord,
          rootPin: "matches the State row",
          poolParameters: pool,
        };
      }),
    );
    await output(resolve(root, ".local/release/preflight.json"), result);
    await summary(`Preflight: ${safeJson({ ...result, rows: result.rows.length })}`);
  } else if (command === "serving" || command === "rollback") {
    // A code release records the serving version of every Worker its plan updates; on a failed apply
    // or acceptance it puts each of them back. `--fqn` names one Worker instead.
    const plan = values.from
      ? (JSON.parse(await readFile(resolve(values.from), "utf8")) as {
          changes?: { fqn: string; type: string; action: string }[];
          workers?: { fqn: string; version: string }[];
        })
      : undefined;
    const fqns =
      command === "serving"
        ? values.fqn
          ? [values.fqn]
          : (plan?.changes ?? [])
              .filter((change) => change.type === "Cloudflare.Worker" && change.action === "update")
              .map((change) => change.fqn)
        : [];
    const result = await run(
      Effect.gen(function* () {
        const at = (script: string) => ({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
          token: Redacted.make(process.env.CLOUDFLARE_API_TOKEN ?? ""),
          script,
        });
        if (command === "serving") {
          const workers: { fqn: string; version: string; script: string }[] = [];
          for (const fqn of fqns) {
            const script = yield* scriptName(fqn);
            workers.push({ fqn, version: yield* servingVersion(at(script)), script });
          }
          return { workers };
        }
        const targets =
          plan?.workers ??
          (values.fqn && values.to ? [{ fqn: values.fqn, version: values.to }] : []);
        if (!targets.length)
          return yield* Effect.die(
            new Error("rollback needs --from <serving.json> or --fqn and --to"),
          );
        const rolledBack: { fqn: string; version: string }[] = [];
        // Every Worker is tried: one that fails must not leave the rest on the failed release.
        const failed: { fqn: string; cause: unknown }[] = [];
        for (const target of targets) {
          const exit = yield* Effect.exit(
            Effect.gen(function* () {
              yield* rollbackTo(
                at(yield* scriptName(target.fqn)),
                target.version,
                `release rollback ${process.env.GITHUB_RUN_ID ?? "local"}`,
              );
            }),
          );
          if (exit._tag === "Success") rolledBack.push(target);
          else failed.push({ fqn: target.fqn, cause: exit.cause });
        }
        if (failed.length)
          return yield* Effect.die(
            new Error(
              `Rollback failed for ${failed.map(({ fqn }) => fqn).join(", ")}; rolled back ${rolledBack.map(({ fqn }) => fqn).join(", ") || "none"}`,
              { cause: failed },
            ),
          );
        return { workers: rolledBack, rolledBack: true };
      }),
    );
    if (values.out) await output(resolve(values.out), result);
    // Script names carry the stage; the public summary keeps the FQNs and versions only.
    await summary(
      `${command === "serving" ? "Serving" : "Rolled back to"}: ${safeJson({
        ...result,
        workers: result.workers.map(({ fqn, version }) => ({ fqn, version })),
      })}`,
    );
  } else if (command === "snapshot") {
    const snapshot = await run(
      Effect.gen(function* () {
        const state = yield* Alchemist.State.store({
          backend: "configured",
          ...target,
        } as never) as unknown as Fx.Effect<StateService, unknown, never>;
        const url = yield* database.poolDatabaseUrl(state, { name: yield* stackName(), stage });
        const session = yield* database.connect(url);
        return yield* database.readSnapshot(session, { history: !values.light });
      }),
    );
    await output(resolve(values.out ?? ""), snapshot);
    await summary(`Database counts: ${safeJson(snapshot)}`);
  } else {
    throw new Error(`Unknown command ${command || "(none)"}`);
  }
} catch (error) {
  await stop(error);
  process.exitCode = 1;
} finally {
  if (events.length) await mkdir(resolve(root, ".local/release"), { recursive: true });
  if (events.length)
    await writeFile(
      resolve(root, `.local/release/${command}-events.jsonl`),
      `${events.join("\n")}\n`,
    ).catch(() => {});
  if (journal.length) {
    // Vendor API hosts are public; any other host (an account subdomain, a custom domain) is not.
    const vendor = ["api.cloudflare.com", "api.planetscale.com", "registry.cloudflare.com"];
    await summary(
      `Outgoing requests:\n${journal.map((entry) => `${entry.method} ${vendor.includes(entry.host) ? entry.host : "{host}"}${entry.path}`).join("\n")}`,
    );
    await keepPrivate(
      "requests",
      journal.map((entry) => `${entry.method} ${entry.host}${entry.path}`).join("\n"),
    );
  }
}
