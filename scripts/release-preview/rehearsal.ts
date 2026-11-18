import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  lifecycleEnvironment,
  materializeSmokeSecrets,
  validateSmokeIdentity,
  validateSmokeSecrets,
} from "./credentials.ts";
import { manifestPath } from "./checkpoint.ts";
import { privateOperation } from "./process.ts";
import { runPreview } from "./lifecycle.ts";
import {
  rehearsalReceipt,
  rehearsalSteps,
  type RehearsalHooks,
  type ReleaseRequest,
} from "./rehearsal-plan.ts";
import {
  adoptedSnapshot,
  releaseInput,
  releaseOutcome,
  releaseWaits,
} from "./rehearsal-release.ts";
import { rehearsalInfraOnly, rehearsalScenario } from "./rehearsal-stage.ts";
import {
  seedRehearsalPools,
  verifyRehearsalPolicies,
  type RehearsalPolicy,
  type RehearsalPoolAccess,
} from "./rehearsal-seed.ts";
import { holdModelSocket, modelTraffic } from "./rehearsal-traffic.ts";
import { rehearsalReleaseEnvironment } from "./rehearsal-environment.ts";
import {
  requireSettlementApplied,
  settlementPacket,
  settlementPlanRequest,
} from "./rehearsal-settlement.ts";
import { poolWorkerRevision } from "../pool-worker-revision.ts";
import { parseSubjectArgument, stageNames, type StageSubject } from "../preview/subject.ts";
import { readPreviewManifest } from "../preview/manifest.ts";
import { applyRehearsalFixture, withStageBuild } from "../preview/lifecycle.ts";
import { singleWriterSteps } from "./rehearsal-single-writer.ts";
import { singleWriterHooks } from "./rehearsal-single-writer-hooks.ts";
import { resumeSteps, rollbackSteps } from "./rehearsal-recovery.ts";
import { PreviewClient } from "../pool-acceptance/preview-client.ts";
import { previewConfigFromEnvironment } from "../pool-acceptance/preview-config.ts";

const head = (root: string) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

/** The GitHub identity the exclusive release writer checks, and nothing else of the runner's. */
const writerInputs = [
  "GITHUB_ACTIONS",
  "GITHUB_REF",
  "GITHUB_JOB",
  "GITHUB_REPOSITORY",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "RELEASE_REHEARSAL_SENTRY_DSN",
] as const;

/** Set once the first provider-touching step starts; before that, the stage holds nothing. */
export type RehearsalProgress = { deployed: boolean };

export async function executeRehearsal(
  root: string,
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  progress: RehearsalProgress = { deployed: false },
) {
  if (source.GITHUB_ACTIONS !== "true")
    throw new Error("Release rehearsals run only in GitHub Actions");
  if (subject.kind !== "rehearsal") throw new Error("A release rehearsal needs a rehearsal stage");
  if (source.PREVIEW_MANIFEST_CHECKPOINTED !== "1")
    throw new Error("The encrypted cleanup checkpoint must be uploaded before deployment");
  // Only this run's own receipt may reach the uploaded artifact.
  await rm(join(root, "rehearsal-receipt.json"), { force: true });
  const scenario = rehearsalScenario(source.REHEARSAL_SCENARIO);
  const infraOnly = rehearsalInfraOnly(source.REHEARSAL_INFRA_ONLY, scenario);
  if (infraOnly && source.GITHUB_STEP_SUMMARY)
    await writeFile(
      source.GITHUB_STEP_SUMMARY,
      "**Infra-only rehearsal:** no subscription accounts, pool stream or native serving check.\n",
      { flag: "a" },
    );
  if (infraOnly) validateSmokeIdentity(source);
  else validateSmokeSecrets(source);
  const previousRoot = resolve(source.REHEARSAL_PREVIOUS_ROOT ?? "");
  const candidate = head(root);
  // A step-4 rehearsal releases later commits in the same checkout; every operation follows it.
  let current = candidate;
  const parent = (commit: string) =>
    execFileSync("git", ["rev-parse", `${commit}^`], {
      cwd: previousRoot,
      encoding: "utf8",
    }).trim();
  // Three commits as production has them: an older baseline, the previous candidate on it, this one.
  const baseline = head(previousRoot);
  const previous = source.REHEARSAL_PREVIOUS_SHA ?? "";
  // A single change is rehearsed against its merge's first parent, which carries no previous candidate.
  const firstParent = execFileSync("git", ["rev-parse", `${candidate}^1`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (
    baseline !== source.REHEARSAL_BASELINE_SHA ||
    (scenario.startsWith("single-writer")
      ? baseline !== firstParent || previous !== ""
      : parent(baseline) !== candidate ||
        !/^[a-f0-9]{40}$/u.test(previous) ||
        parent(previous) !== baseline)
  )
    throw new Error(
      "The baseline and previous candidate are not this candidate's rehearsal commits",
    );
  const { stage, slug } = stageNames(subject);
  const privateRoot = await mkdtemp(
    join(source.RUNNER_TEMP ?? tmpdir(), "basalt-release-rehearsal-"),
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let sequence = 0;
  const deployEnvironment = lifecycleEnvironment(source, "deploy");
  const cleanupEnvironment = lifecycleEnvironment(source, "cleanup");
  const operation = (
    label: string,
    directory: string,
    script: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
    minutes = 60,
    command = process.execPath,
  ) =>
    privateOperation({
      label,
      command,
      args: [script, ...args],
      directory,
      environment: { ...environment, GITHUB_OUTPUT: undefined, GITHUB_ENV: undefined },
      logPath: join(privateRoot, `${++sequence}-${label}.log`),
      timeoutMs: minutes * 60_000,
      signal: label === "destroy" || label === "verify-absence" ? undefined : controller.signal,
    });
  let access: RehearsalPoolAccess | undefined;
  /** The rehearsal writer's identity for the candidate, before the stage's own keys are derived. */
  const writerEnvironment = () => {
    const writer: NodeJS.ProcessEnv = {
      ...deployEnvironment,
      ALCHEMY_STAGE: stage,
      BASALT_RELEASE_CANDIDATE: current,
    };
    for (const name of writerInputs) if (source[name]) writer[name] = source[name];
    return writer;
  };
  /** The stage's own keys and the rehearsal writer's identity, for operations on the candidate. */
  const candidateEnvironment = () => rehearsalReleaseEnvironment(writerEnvironment());
  let cleanPool = "";
  let model = "";
  let emptyPools: readonly string[] = [];
  const built = new Set<string>();
  const runner: NodeJS.ProcessEnv = {};
  try {
    // Infra-only has no subscription logins to materialize; the runner keeps only the smoke identity.
    const materialized = infraOnly
      ? source
      : await materializeSmokeSecrets(source, join(privateRoot, "credentials"));
    for (const name of [
      "PATH",
      "LANG",
      "RUNNER_TEMP",
      "PREVIEW_SMOKE_EMAIL",
      "PREVIEW_SMOKE_PASSWORD",
      "PREVIEW_CLAUDE_AUTH_FILE",
      "PREVIEW_CODEX_SUBSCRIPTION_AUTH_FILE",
      "PREVIEW_CODEX_CLI_AUTH_FILE",
      "PREVIEW_CLAUDE_MODEL",
      "PREVIEW_CODEX_MODEL",
    ] as const)
      runner[name] = materialized[name];
    const release = async (request: ReleaseRequest) => {
      const which = request.candidate === "previous" ? previousRoot : root;
      const commit = request.candidate === "previous" ? previous : (request.commit ?? current);
      const imageReceipt = join(privateRoot, `pool-image-${sequence + 1}.json`);
      const environment: NodeJS.ProcessEnv = {
        ...deployEnvironment,
        ALCHEMY_STAGE: stage,
        PREVIEW_AUTH_SEED_OUTPUT: join(privateRoot, `seed-${sequence + 1}.json`),
        ...(await releaseInput(which, request, commit)),
      };
      for (const name of writerInputs) if (source[name]) environment[name] = source[name];
      // As production's release runner does: the deploy publishes a receipt for the image it serves.
      Object.assign(environment, {
        GITHUB_SHA: commit,
        BASALT_POOL_IMAGE_RECEIPT: imageReceipt,
        // Response shapes the release saw, uploaded with the barrier receipts.
        BASALT_REHEARSAL_CAPTURE_DIR: join(which, ".local", "release-barrier"),
      });
      let outcome: Awaited<ReturnType<typeof releaseOutcome>> | undefined;
      const run = async () => {
        let exited = true;
        await operation(
          `release-${request.candidate}`,
          which,
          "scripts/deploy.ts",
          [],
          environment,
          180,
        ).catch(() => {
          exited = false;
        });
        outcome = await releaseOutcome(join(which, ".local", "release-barrier"), exited);
        await captureRuntimeRows(
          subject,
          cleanupEnvironment,
          join(which, ".local", "release-barrier"),
        ).catch(() => {});
        if (!outcome.ok) return;
        // Production's post-deploy checks, against the stage's own host while its brand is in place.
        // The public-site smoke isn't rehearsed: a disposable stage has no public site.
        await operation(
          "assert-pool-image",
          which,
          "scripts/deploy-safety/assert-pool-image.ts",
          [],
          environment,
          10,
        );
        // The pool stream is a model turn; an infra-only rehearsal has no account to stream it with.
        if (infraOnly) return;
        await operation(
          "pool-stream",
          which,
          "scripts/verify-pool-stream.ts",
          [],
          {
            ...environment,
            POOL_ACCEPTANCE_KEY: access?.modelKey,
            POOL_ACCEPTANCE_MODEL: model,
          },
          10,
        );
      };
      // Each checkout bundles Workers as the stage's own brand; the candidate builds once here.
      if (request.candidate === "previous" && head(previousRoot) !== previous) {
        // The baseline deployed from this checkout; prepared again, it names the previous candidate.
        execFileSync("git", ["checkout", "-q", "--detach", previous], { cwd: previousRoot });
        await operation(
          "previous-prepare",
          previousRoot,
          "run",
          ["prepare:upstream"],
          deployEnvironment,
          30,
          "npm",
        );
        built.delete(previousRoot);
      }
      // Each checkout bundles Workers as the stage's own brand and builds once per commit.
      await withStageBuild(which, subject, deployEnvironment, run, undefined, {
        build: !built.has(which),
      });
      built.add(which);
      if (!outcome) throw new Error("The rehearsed release recorded no outcome");
      return outcome;
    };
    const hooks: RehearsalHooks = {
      deployBaseline: async () => {
        // The previous candidate's checkout deploys the stage the ordinary way, as production once did.
        const planned = manifestPath(root, subject);
        const copied = manifestPath(previousRoot, subject);
        await mkdir(dirname(copied), { recursive: true, mode: 0o700 });
        await copyFile(planned, copied);
        try {
          await operation(
            "baseline-deploy",
            previousRoot,
            "scripts/preview/lifecycle.ts",
            ["deploy", slug],
            deployEnvironment,
            90,
          );
        } finally {
          await copyFile(copied, planned);
        }
      },
      seedPools: async () => {
        const path = manifestPath(root, subject);
        const manifest = await readPreviewManifest(path, subject);
        if (
          manifest.phase !== "seeded" ||
          typeof manifest.organizationId !== "string" ||
          typeof manifest.poolAppId !== "string"
        )
          throw new Error("The baseline deploy did not seed its native app context");
        Object.assign(runner, {
          ALCHEMY_STAGE: stage,
          TEST_STAGE_DOMAIN: source.TEST_STAGE_DOMAIN,
          POOL_ACCEPTANCE_ORIGIN: manifest.origin,
          POOL_ACCEPTANCE_PREVIEW_MANIFEST_FILE: path,
          PREVIEW_SMOKE_REHEARSAL: String(subject.number),
          PREVIEW_SMOKE_ORGANIZATION_ID: manifest.organizationId,
          PREVIEW_SMOKE_POOL_APP_ID: manifest.poolAppId,
          POOL_ACCEPTANCE_ACCOUNTS_FILE: join(privateRoot, "provider-accounts.json"),
        });
        // Infra-only: an account-less clean pool, which the promotion gate's candidate probe still uses.
        const accounts = infraOnly
          ? []
          : await (async () => {
              await operation(
                "provider-account-setup",
                root,
                "scripts/pool-acceptance/preview-accounts.ts",
                [],
                runner,
                30,
              );
              const config = await previewConfigFromEnvironment(runner);
              model = config.models.codex;
              return config.accounts;
            })();
        const seed = await seedRehearsalPools({
          infraOnly,
          origin: manifest.origin,
          email: source.PREVIEW_SMOKE_EMAIL!,
          password: source.PREVIEW_SMOKE_PASSWORD!,
          organizationId: manifest.organizationId,
          poolAppId: manifest.poolAppId,
          accounts,
        });
        access = seed.access;
        cleanPool = seed.cleanPool;
        emptyPools = [manifest.poolAppId, ...seed.emptyPools];
        // The previous release's controller phase runs repair ticks before adopt reads them.
        await applyRehearsalFixture(subject, cleanupEnvironment, {
          organization: manifest.organizationId,
          pools: emptyPools,
        });
        return { cleanPool };
      },
      release,
      verifyAdopted: async () => {
        const { policies } = await adoptedSnapshot(join(previousRoot, ".local", "release-barrier"));
        verifyRehearsalPolicies(policies as RehearsalPolicy[], { cleanPool, emptyPools });
      },
      settle: async () => {
        const environment = candidateEnvironment();
        const step = async (mode: "plan" | "apply", packet: unknown) => {
          const directory = join(privateRoot, `settlement-${mode}`);
          await operation(
            `settlement-${mode}`,
            root,
            "scripts/release-barrier/provisioning-entry.ts",
            [],
            {
              ...environment,
              POOL_PROVISIONING_MODE: mode,
              POOL_PROVISIONING_PACKET: JSON.stringify(packet),
              POOL_PROVISIONING_OUTPUT_DIRECTORY: directory,
            },
            15,
            "bun",
          );
          const receipt = await readFile(join(directory, "receipt.json"), "utf8");
          // Kept with the barrier receipts the workflow uploads.
          await mkdir(join(root, ".local", "release-barrier"), { recursive: true });
          await writeFile(
            join(root, ".local", "release-barrier", `settlement-${mode}.json`),
            receipt,
            { mode: 0o600 },
          );
          return JSON.parse(receipt) as unknown;
        };
        // The previous controller reports the revision its own checkout was prepared with.
        const workerInput = poolWorkerRevision(previousRoot);
        const planned = await step(
          "plan",
          settlementPlanRequest({ previous, workerInput, number: subject.number, now: Date.now() }),
        );
        const packet = settlementPacket(planned, Date.now());
        requireSettlementApplied(await step("apply", packet), packet.go.manifest);
      },
      restart: async () => {
        const path = join(privateRoot, "restart.json");
        let ran = true;
        await operation(
          "restart-check",
          root,
          "scripts/release-preview/rehearsal-restart.ts",
          [],
          {
            ...candidateEnvironment(),
            REHEARSAL_MODEL_URL: access?.modelUrl,
            REHEARSAL_MODEL_KEY: access?.modelKey,
            REHEARSAL_MODEL: model,
            REHEARSAL_RESTART_RESULT: path,
          },
          25,
          "bun",
        ).catch(() => {
          ran = false;
        });
        const text = await readFile(path, "utf8").catch(() => "{}");
        await mkdir(join(root, ".local", "release-barrier"), { recursive: true });
        await writeFile(join(root, ".local", "release-barrier", "rehearsal-restart.json"), text, {
          mode: 0o600,
        });
        const result = JSON.parse(text) as Record<string, unknown>;
        if (!ran || "refused" in result || typeof result.cellConcurrency !== "number")
          throw new Error(
            `The restart check refused: ${typeof result.refused === "string" ? result.refused : "no result"}`,
          );
        return result as unknown as Awaited<ReturnType<RehearsalHooks["restart"]>>;
      },
      holdConnection: async () => holdModelSocket(access!),
      startTraffic: () => modelTraffic(access!, model, controller.signal),
      waits: () => releaseWaits(join(root, ".local", "release-barrier")),
      serve: async () => {
        if (infraOnly) return { skipped: "infra-only" };
        const resultPath = join(privateRoot, "smoke-result.json");
        await operation(
          "native-smoke",
          root,
          "scripts/pool-acceptance.ts",
          [],
          {
            ...runner,
            PREVIEW_CLAUDE_AUTH_FILE: undefined,
            PREVIEW_CODEX_SUBSCRIPTION_AUTH_FILE: undefined,
            POOL_ACCEPTANCE_MODE: "preview",
            POOL_ACCEPTANCE_RESULT_PATH: resultPath,
          },
          40,
        );
        return JSON.parse(await readFile(resultPath, "utf8")) as unknown;
      },
    };
    const singleWriter = singleWriterHooks({
      root,
      subject,
      privateRoot,
      operation,
      deployEnvironment,
      writerEnvironment,
      hooks,
      current: () => current,
      advance: (commit) => {
        current = commit;
        built.delete(root);
      },
    });
    const steps =
      scenario === "single-writer"
        ? singleWriterSteps(singleWriter.forward)
        : scenario === "single-writer-resume"
          ? resumeSteps(singleWriter.recovery)
          : scenario === "single-writer-rollback"
            ? rollbackSteps(singleWriter.recovery)
            : rehearsalSteps(scenario, hooks);
    const outcome = await runPreview({
      prepare: async () => {
        await readFile(manifestPath(root, subject));
        if (controller.signal.aborted) throw new Error("Rehearsal cancelled");
      },
      deploy: async () => {
        progress.deployed = true;
        await steps.deploy();
      },
      seed: steps.seed,
      smoke: async () => {
        try {
          return await steps.smoke();
        } finally {
          if (access) await revokeTraffic(runner, cleanPool, access).catch(() => {});
        }
      },
      // Infra-only runs no native serving check; its smoke must say so and nothing else.
      ...(infraOnly
        ? {
            requireSmoke: (result: unknown) => {
              if (JSON.stringify(result) !== JSON.stringify({ skipped: "infra-only" }))
                throw new Error("The infra-only rehearsal ran a serving check it cannot prove");
            },
          }
        : {}),
      destroy: () =>
        operation(
          "destroy",
          root,
          "scripts/preview/lifecycle.ts",
          ["destroy", slug],
          cleanupEnvironment,
          15,
        ),
      verifyAbsent: () =>
        operation(
          "verify-absence",
          root,
          "scripts/preview/lifecycle.ts",
          ["verify", slug],
          cleanupEnvironment,
          15,
        ),
    });
    const receipt =
      "steps" in steps.record
        ? {
            version: 1,
            candidate,
            finalCandidate: current,
            baseline,
            stage,
            ...steps.record,
            infraOnly,
            serving: !infraOnly,
            teardown: outcome.teardown,
          }
        : rehearsalReceipt(steps.record, { candidate, previous, stage }, outcome.teardown);
    await writeFile(join(root, "rehearsal-receipt.json"), `${JSON.stringify(receipt)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log("Release rehearsal and remote teardown passed");
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await rm(privateRoot, { recursive: true, force: true });
  }
}

/**
 * What the stage's State holds for each fleet runtime after a release: the key names and types of
 * its attributes, and whether its configuration kept the desired `instanceType` or the resolved form.
 */
async function captureRuntimeRows(
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  directory: string,
) {
  const { stageCleanupEnvironment } = await import("../environment.ts");
  const { alchemyPreviewStateReader } = await import("../preview/inventory.ts");
  const { shapeOf } = await import("../release-barrier/rehearsal-shape-capture.ts");
  const config = stageCleanupEnvironment(subject, source);
  const stacks = await alchemyPreviewStateReader({ environment: config.providers }).read(
    config.stage,
  );
  const rows = Object.values(stacks)
    .flat()
    .filter((entry) => /PoolRuntime(?:Blue|Green)/u.test(entry.path))
    .map((entry) => {
      const attr = (entry.value as { attr?: { configuration?: Record<string, unknown> } } | null)
        ?.attr;
      return {
        row: entry.path.split("/").slice(2).join("/"),
        attr: shapeOf(attr),
        configurationHasInstanceType: attr?.configuration
          ? "instanceType" in attr.configuration
          : null,
      };
    });
  await writeFile(
    join(directory, `state-runtime-rows-${Date.now()}.json`),
    `${JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)}\n`,
  );
}

/** A stage that never reached a provider step: cleanup and verify accept it as torn down. */
export const nothingDeployedReceipt = (subject: StageSubject) => ({
  version: 1,
  stage: stageNames(subject).stage,
  deployed: false,
  teardown: true,
});

/** The traffic computer is the rehearsal's own credential; it goes before the stack does. */
async function revokeTraffic(
  runner: NodeJS.ProcessEnv,
  cleanPool: string,
  access: RehearsalPoolAccess,
) {
  const config = await previewConfigFromEnvironment(runner);
  const client = new PreviewClient({ ...config, poolAppId: cleanPool });
  await client.signIn();
  try {
    await client.revokeComputer(access.computerId);
  } finally {
    await client.signOut();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const progress: RehearsalProgress = { deployed: false };
  let subject: StageSubject | undefined;
  try {
    subject = parseSubjectArgument(process.argv[2]);
    await executeRehearsal(process.cwd(), subject, process.env, progress);
  } catch (error) {
    // Child output stays private; these messages are the runner's own fixed, credential-free labels.
    const messages = error instanceof AggregateError ? error.errors : [error];
    for (const item of messages)
      console.error(
        `::error::${item instanceof Error ? item.message : "Release rehearsal failed"}`,
      );
    process.exitCode = 1;
    if (subject?.kind === "rehearsal" && !progress.deployed) {
      // Failed before its first provider step: the stage holds nothing, so there is nothing to tear down.
      await writeFile(
        join(process.cwd(), "rehearsal-receipt.json"),
        `${JSON.stringify(nothingDeployedReceipt(subject))}\n`,
        { mode: 0o600 },
      );
      console.error(
        "Release rehearsal failed before deploying anything; its receipt records that the stage holds nothing.",
      );
    } else
      console.error(
        "Release rehearsal failed; no rehearsal receipt was written. Release cleanup recovers any remaining stage.",
      );
  }
}
