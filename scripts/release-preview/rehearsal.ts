import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lifecycleEnvironment, materializeSmokeSecrets, validateSmokeSecrets } from "./credentials.ts";
import { manifestPath } from "./checkpoint.ts";
import { privateOperation } from "./process.ts";
import { runPreview } from "./lifecycle.ts";
import { rehearsalReceipt, rehearsalSteps, type RehearsalHooks, type ReleaseRequest } from "./rehearsal-plan.ts";
import { adoptedSnapshot, releaseInput, releaseOutcome, releaseWaits } from "./rehearsal-release.ts";
import { rehearsalScenario } from "./rehearsal-stage.ts";
import {
  seedRehearsalPools,
  verifyRehearsalPolicies,
  type RehearsalPolicy,
  type RehearsalPoolAccess,
} from "./rehearsal-seed.ts";
import { holdModelSocket, modelTraffic } from "./rehearsal-traffic.ts";
import { parseSubjectArgument, stageNames, type StageSubject } from "../preview/subject.ts";
import { readPreviewManifest } from "../preview/manifest.ts";
import { applyRehearsalFixture, withStageBuild } from "../preview/lifecycle.ts";
import { PreviewClient } from "../pool-acceptance/preview-client.ts";
import { previewConfigFromEnvironment } from "../pool-acceptance/preview-config.ts";

const head = (root: string) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

/** The GitHub identity the exclusive release writer checks, and nothing else of the runner's. */
const writerInputs = [
  "GITHUB_ACTIONS", "GITHUB_REF", "GITHUB_JOB", "GITHUB_REPOSITORY", "GITHUB_WORKFLOW_REF",
  "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "RELEASE_REHEARSAL_SENTRY_DSN",
] as const;

export async function executeRehearsal(root: string, subject: StageSubject, source: NodeJS.ProcessEnv) {
  if (source.GITHUB_ACTIONS !== "true") throw new Error("Release rehearsals run only in GitHub Actions");
  if (subject.kind !== "rehearsal") throw new Error("A release rehearsal needs a rehearsal stage");
  if (source.PREVIEW_MANIFEST_CHECKPOINTED !== "1")
    throw new Error("The encrypted cleanup checkpoint must be uploaded before deployment");
  validateSmokeSecrets(source);
  const scenario = rehearsalScenario(source.REHEARSAL_SCENARIO);
  const previousRoot = resolve(source.REHEARSAL_PREVIOUS_ROOT ?? "");
  const candidate = head(root);
  const previous = head(previousRoot);
  if (previous !== source.REHEARSAL_PREVIOUS_SHA || execFileSync("git", ["rev-parse", "HEAD^"], { cwd: previousRoot, encoding: "utf8" }).trim() !== candidate)
    throw new Error("The previous candidate is not this candidate's rehearsal commit");
  const { stage, slug } = stageNames(subject);
  const privateRoot = await mkdtemp(join(source.RUNNER_TEMP ?? tmpdir(), "basalt-release-rehearsal-"));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let sequence = 0;
  const deployEnvironment = lifecycleEnvironment(source, "deploy");
  const cleanupEnvironment = lifecycleEnvironment(source, "cleanup");
  const operation = (label: string, directory: string, script: string, args: string[], environment: NodeJS.ProcessEnv, minutes = 60) =>
    privateOperation({
      label, command: process.execPath, args: [script, ...args], directory,
      environment: { ...environment, GITHUB_OUTPUT: undefined, GITHUB_ENV: undefined },
      logPath: join(privateRoot, `${++sequence}-${label}.log`), timeoutMs: minutes * 60_000,
      signal: label === "destroy" || label === "verify-absence" ? undefined : controller.signal,
    });
  let access: RehearsalPoolAccess | undefined;
  let cleanPool = "";
  let model = "";
  let emptyPools: readonly string[] = [];
  let built = false;
  const runner: NodeJS.ProcessEnv = {};
  try {
    const materialized = await materializeSmokeSecrets(source, join(privateRoot, "credentials"));
    for (const name of ["PATH", "LANG", "RUNNER_TEMP", "PREVIEW_SMOKE_EMAIL", "PREVIEW_SMOKE_PASSWORD",
      "PREVIEW_CLAUDE_AUTH_FILE", "PREVIEW_CODEX_SUBSCRIPTION_AUTH_FILE", "PREVIEW_CODEX_CLI_AUTH_FILE",
      "PREVIEW_CLAUDE_MODEL", "PREVIEW_CODEX_MODEL"] as const)
      runner[name] = materialized[name];
    const release = async (request: ReleaseRequest) => {
      const which = request.candidate === "previous" ? previousRoot : root;
      const commit = request.candidate === "previous" ? previous : candidate;
      const environment: NodeJS.ProcessEnv = {
        ...deployEnvironment,
        ALCHEMY_STAGE: stage,
        PREVIEW_AUTH_SEED_OUTPUT: join(privateRoot, `seed-${sequence + 1}.json`),
        ...(await releaseInput(which, request, commit)),
      };
      for (const name of writerInputs) if (source[name]) environment[name] = source[name];
      let exited = true;
      const run = () => operation(`release-${request.candidate}`, which, "scripts/deploy.ts", [], environment, 180)
        .catch(() => { exited = false; });
      // Each checkout bundles Workers as the stage's own brand; the candidate builds once here.
      if (which === root && !built) {
        await withStageBuild(root, subject, deployEnvironment, run);
        built = true;
      } else await withStageBuild(which, subject, deployEnvironment, run, undefined, { build: false });
      return releaseOutcome(join(which, ".local", "release-barrier"), exited);
    };
    const hooks: RehearsalHooks = {
      deployBaseline: async () => {
        // The previous candidate's checkout deploys the stage the ordinary way, as production once did.
        const planned = manifestPath(root, subject);
        const copied = manifestPath(previousRoot, subject);
        await mkdir(dirname(copied), { recursive: true, mode: 0o700 });
        await copyFile(planned, copied);
        try {
          await operation("baseline-deploy", previousRoot, "scripts/preview/lifecycle.ts", ["deploy", slug], deployEnvironment, 90);
        } finally {
          await copyFile(copied, planned);
        }
      },
      seedPools: async () => {
        const path = manifestPath(root, subject);
        const manifest = await readPreviewManifest(path, subject);
        if (manifest.phase !== "seeded" || typeof manifest.organizationId !== "string" || typeof manifest.poolAppId !== "string")
          throw new Error("The baseline deploy did not seed its native app context");
        Object.assign(runner, {
          ALCHEMY_STAGE: stage, TEST_STAGE_DOMAIN: source.TEST_STAGE_DOMAIN, POOL_ACCEPTANCE_ORIGIN: manifest.origin,
          POOL_ACCEPTANCE_PREVIEW_MANIFEST_FILE: path, PREVIEW_SMOKE_REHEARSAL: String(subject.number),
          PREVIEW_SMOKE_ORGANIZATION_ID: manifest.organizationId, PREVIEW_SMOKE_POOL_APP_ID: manifest.poolAppId,
          POOL_ACCEPTANCE_ACCOUNTS_FILE: join(privateRoot, "provider-accounts.json"),
        });
        await operation("provider-account-setup", root, "scripts/pool-acceptance/preview-accounts.ts", [], runner, 30);
        const config = await previewConfigFromEnvironment(runner);
        model = config.models.codex;
        const seed = await seedRehearsalPools({
          origin: manifest.origin, email: source.PREVIEW_SMOKE_EMAIL!, password: source.PREVIEW_SMOKE_PASSWORD!,
          organizationId: manifest.organizationId, poolAppId: manifest.poolAppId, accounts: config.accounts,
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
      holdConnection: async () => holdModelSocket(access!),
      startTraffic: () => modelTraffic(access!, model, controller.signal),
      waits: () => releaseWaits(join(root, ".local", "release-barrier")),
      serve: async () => {
        const resultPath = join(privateRoot, "smoke-result.json");
        await operation("native-smoke", root, "scripts/pool-acceptance.ts", [], {
          ...runner, PREVIEW_CLAUDE_AUTH_FILE: undefined, PREVIEW_CODEX_SUBSCRIPTION_AUTH_FILE: undefined,
          POOL_ACCEPTANCE_MODE: "preview", POOL_ACCEPTANCE_RESULT_PATH: resultPath,
        }, 40);
        return JSON.parse(await readFile(resultPath, "utf8")) as unknown;
      },
    };
    const steps = rehearsalSteps(scenario, hooks);
    const outcome = await runPreview({
      prepare: async () => {
        await readFile(manifestPath(root, subject));
        if (controller.signal.aborted) throw new Error("Rehearsal cancelled");
      },
      deploy: steps.deploy,
      seed: steps.seed,
      smoke: async () => {
        try {
          return await steps.smoke();
        } finally {
          if (access) await revokeTraffic(runner, cleanPool, access).catch(() => {});
        }
      },
      destroy: () => operation("destroy", root, "scripts/preview/lifecycle.ts", ["destroy", slug], cleanupEnvironment, 15),
      verifyAbsent: () => operation("verify-absence", root, "scripts/preview/lifecycle.ts", ["verify", slug], cleanupEnvironment, 15),
    });
    const receipt = rehearsalReceipt(steps.record, { candidate, previous, stage }, outcome.teardown);
    await writeFile(join(root, "rehearsal-receipt.json"), `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    console.log("Release rehearsal and remote teardown passed");
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await rm(privateRoot, { recursive: true, force: true });
  }
}

/** The traffic computer is the rehearsal's own credential; it goes before the stack does. */
async function revokeTraffic(runner: NodeJS.ProcessEnv, cleanPool: string, access: RehearsalPoolAccess) {
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
  try {
    await executeRehearsal(process.cwd(), parseSubjectArgument(process.argv[2]), process.env);
  } catch (error) {
    // Child output stays private; these messages are the runner's own fixed, credential-free labels.
    const messages = error instanceof AggregateError ? error.errors : [error];
    for (const item of messages) console.error(`::error::${item instanceof Error ? item.message : "Release rehearsal failed"}`);
    console.error("Release rehearsal failed; no rehearsal receipt was written. Release cleanup recovers any remaining stage.");
    process.exitCode = 1;
  }
}
