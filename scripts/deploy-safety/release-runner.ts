import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClassificationReport } from "../releases/types.ts";
import { SafetyGateError, type RecordedBackup } from "./contracts.ts";
import { isScriptStartupCpuLimit, OutputTail, redactFailureOutput } from "./failure-output.ts";
import {
  beginReleaseDeployment,
  beginRollbackDeployment,
  finishDeployment,
  readLedgerEnvironment,
  releaseBackup,
  type DeploymentLedger,
} from "./github-ledger.ts";
import { PlanetScaleSafety } from "./planetscale-safety.ts";
import { rollForwardTo } from "./release-plan.ts";
import { assertWorkflowsDrained, inspectWorkflowChange } from "./cloudflare.ts";
import {
  assertNoReleaseHold,
  requireCloudflareEnvironment,
  requirePlanetScaleEnvironment,
} from "./runtime.ts";
import { poolImageReceipt } from "./pool-image.ts";

export type ReleaseMode = "automatic" | "manual";

/**
 * `scriptStartupCpuLimit` is set when a failed command's output shows Cloudflare's startup CPU
 * rejection. `outputHeld` is set when the command exited but something it started still held its
 * output past the grace period, so part of it may still be running.
 */
export type CommandResult = {
  started: boolean;
  exitCode: number | null;
  scriptStartupCpuLimit?: true;
  outputHeld?: true;
};

export type ReleaseDependencies = {
  validateCredentials(): void;
  /** Verifies the protected backup and returns it so the deployment record can carry its metadata. */
  assertBackup(report: ClassificationReport): Promise<RecordedBackup>;
  begin(report: ClassificationReport, backup?: RecordedBackup): Promise<number>;
  mark(deploymentId: number, state: "success" | "failure"): Promise<void>;
  deploy(): Promise<CommandResult>;
  assertImages(): Promise<CommandResult>;
  smoke(): Promise<CommandResult>;
  dispose?(): void;
  /** Where the runner notes a deploy retry; stderr by default. */
  log?(text: string): void;
};

export type ManualRollbackDependencies = {
  assertBackup(report: ClassificationReport): Promise<void>;
  /** Rolling back also crosses the Workflow identity boundary, so the same drain gate applies. */
  assertDrained(report: ClassificationReport): Promise<void>;
  prepare(): Promise<void>;
  validateCredentials(): void;
  begin(report: ClassificationReport, expectedDeploymentId: number): Promise<number>;
  mark(deploymentId: number, state: "success" | "failure"): Promise<void>;
  deploy(): Promise<CommandResult>;
  assertImages(): Promise<CommandResult>;
  smoke(): Promise<CommandResult>;
  dispose?(): void;
  log?(text: string): void;
};

export type ReleaseResult = {
  state: "deployed";
  deploymentId: number;
};

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function assertDeployedImages(
  deploymentId: number,
  dependencies: Pick<ReleaseDependencies, "assertImages" | "mark">,
): Promise<void> {
  try {
    const result = await dependencies.assertImages();
    if (!result.started || result.exitCode !== 0) throw new Error("Image assertion failed");
  } catch {
    await dependencies.mark(deploymentId, "failure");
    throw new SafetyGateError(
      "Pool publication or running image could not be verified; stopped without automatic rollback",
    );
  }
}

export async function executeRelease(
  report: ClassificationReport,
  mode: ReleaseMode,
  dependencies: ReleaseDependencies,
): Promise<ReleaseResult> {
  try {
    assertReleaseMode(report, mode);
    dependencies.validateCredentials();
    const backup = report.databaseChanged ? await dependencies.assertBackup(report) : undefined;

    const deploymentId = await dependencies.begin(report, backup);
    const deploy = await dependencies.deploy();
    if (!deploy.started) {
      await dependencies.mark(deploymentId, "failure");
      throw new SafetyGateError(
        "Production deployment process did not start; no rollback was attempted",
      );
    }
    if (deploy.exitCode !== 0) {
      return await failReleaseAttempt(dependencies, deploymentId, "deployment command failed");
    }

    await assertDeployedImages(deploymentId, dependencies);
    const smoke = await dependencies.smoke();
    if (!smoke.started || smoke.exitCode !== 0) {
      await assertDeployedImages(deploymentId, dependencies);
      return await failReleaseAttempt(dependencies, deploymentId, "production smoke check failed");
    }

    await dependencies.mark(deploymentId, "success");
    return { state: "deployed", deploymentId };
  } finally {
    dependencies.dispose?.();
  }
}

export async function executeManualRollback(
  report: ClassificationReport,
  expectedDeploymentId: number,
  dependencies: ManualRollbackDependencies,
  eventName = process.env.GITHUB_EVENT_NAME,
  ref = process.env.GITHUB_REF,
  workflowRef = process.env.GITHUB_WORKFLOW_REF,
  repository = process.env.GITHUB_REPOSITORY,
): Promise<{ state: "rolled-back"; deploymentId: number }> {
  try {
    if (
      eventName !== "workflow_dispatch" ||
      ref !== "refs/heads/main" ||
      !repository ||
      workflowRef !== `${repository}/.github/workflows/release-rollback.yml@refs/heads/main`
    )
      throw new SafetyGateError("Manual rollback requires workflow_dispatch from trusted main");
    if (!Number.isSafeInteger(expectedDeploymentId) || expectedDeploymentId < 1)
      throw new SafetyGateError(
        "Manual rollback requires the exact planned production deployment id",
      );
    if (!report.databaseChanged && !report.workflowChanged)
      throw new SafetyGateError(
        "Manual rollback is reserved for database or Workflow-identity releases",
      );

    if (report.databaseChanged) await dependencies.assertBackup(report);
    if (report.workflowChanged) await dependencies.assertDrained(report);
    await dependencies.prepare();
    dependencies.validateCredentials();

    const deploymentId = await dependencies.begin(report, expectedDeploymentId);
    const deploy = await dependencies.deploy();
    if (!deploy.started || deploy.exitCode !== 0) {
      await dependencies.mark(deploymentId, "failure");
      throw new SafetyGateError(
        "Previous production release deployment failed; rollback remains unresolved",
      );
    }

    await assertDeployedImages(deploymentId, dependencies);
    const smoke = await dependencies.smoke();
    if (!smoke.started || smoke.exitCode !== 0) {
      await dependencies.mark(deploymentId, "failure");
      throw new SafetyGateError(
        "Previous production release public smoke failed; rollback remains unresolved",
      );
    }

    await dependencies.mark(deploymentId, "success");
    return { state: "rolled-back", deploymentId };
  } finally {
    dependencies.dispose?.();
  }
}

export function assertReleaseMode(
  report: ClassificationReport,
  mode: ReleaseMode,
  eventName = process.env.GITHUB_EVENT_NAME,
  ref = process.env.GITHUB_REF,
  workflowRef = process.env.GITHUB_WORKFLOW_REF,
  repository = process.env.GITHUB_REPOSITORY,
): void {
  const manualRequired = report.databaseChanged || report.workflowChanged;
  if (manualRequired && mode !== "manual")
    throw new SafetyGateError(
      "Database-changing and Workflow-identity releases require manual release mode",
    );
  if (mode === "manual" && (eventName !== "workflow_dispatch" || ref !== "refs/heads/main"))
    throw new SafetyGateError("Manual release mode requires workflow_dispatch from trusted main");
  // Deploy runs on `workflow_run` after Check passes on main; only main's own Deploy workflow may use it.
  const trustedDeployRun =
    eventName === "workflow_run" &&
    !!repository &&
    workflowRef === `${repository}/.github/workflows/deploy.yml@refs/heads/main`;
  if (
    mode === "automatic" &&
    ((eventName !== "push" && eventName !== "workflow_dispatch" && !trustedDeployRun) ||
      ref !== "refs/heads/main")
  )
    throw new SafetyGateError(
      "Automatic release mode is available only to main branch push, the main Deploy workflow or bootstrap dispatch workflows",
    );
}

export function productionReleaseDependencies(
  sourceRoot = repositoryRoot,
  candidateCommit?: string,
): ReleaseDependencies {
  const github = readLedgerEnvironment();
  const planetscale = new PlanetScaleSafety(requirePlanetScaleEnvironment());
  const receiptPath = join(mkdtempSync(join(tmpdir(), "basalt-pool-publication-")), "receipt.json");
  const imageEnvironment = {
    ...process.env,
    GITHUB_SHA: candidateCommit ?? process.env.GITHUB_SHA,
    BASALT_POOL_IMAGE_RECEIPT: receiptPath,
  };
  return {
    dispose: () => rmSync(dirname(receiptPath), { recursive: true, force: true }),
    validateCredentials: () => {
      validateCandidateSource(sourceRoot, candidateCommit);
      assertBarrierSource(sourceRoot);
    },
    assertBackup: async (report) => {
      const { backup, metadata } = await planetscale.assertBackupReady(report);
      if (backup.state !== "success" || !backup.protected)
        throw new SafetyGateError("PlanetScale rollback backup is not both complete and protected");
      return { name: backup.name, metadata };
    },
    begin: (report, backup) => {
      assertNoReleaseHold();
      return beginReleaseDeployment(
        report,
        github,
        fetch,
        backup,
        rollForwardTo(report.candidate.gitCommit),
      );
    },
    mark: (deploymentId, state) => finishDeployment(deploymentId, state, github),
    deploy: () => {
      rmSync(receiptPath, { force: true });
      return runCommand("npm", ["run", "deploy"], sourceRoot, imageEnvironment);
    },
    assertImages: () => {
      // Retain publication evidence in the workflow log even when verification fails.
      try {
        const receipt = poolImageReceipt(
          JSON.parse(readFileSync(receiptPath, "utf8")),
          imageEnvironment.GITHUB_SHA ?? "",
        );
        console.log(
          JSON.stringify({
            poolImagePublication: {
              candidate: receipt.candidate,
              platform: receipt.platform,
              inputHash: receipt.inputHash,
              digest: receipt.digest,
              configDigest: receipt.configDigest,
              capabilityLabel: receipt.capabilityLabel,
            },
          }),
        );
      } catch {
        // The assertion reports a missing or invalid receipt and stops recovery.
      }
      return runCommand(
        "node",
        ["scripts/deploy-safety/assert-pool-image.ts"],
        sourceRoot,
        imageEnvironment,
      );
    },
    smoke: () => runCommand("node", ["scripts/smoke.ts"], repositoryRoot),
  };
}

export function resolveCandidateSourceRoot(
  mode: ReleaseMode,
  candidateCommit: string,
  requestedRoot?: string,
  runnerTemp = process.env.RUNNER_TEMP,
): string {
  if (mode === "automatic") {
    if (requestedRoot)
      throw new SafetyGateError("Automatic releases use the checked-out main source");
    const sourceRoot = realpathSync(process.cwd());
    validateCandidateSource(sourceRoot, candidateCommit);
    const workflowSha = process.env.GITHUB_SHA?.trim().toLowerCase();
    if (workflowSha && workflowSha !== candidateCommit.toLowerCase())
      throw new SafetyGateError("Automatic release candidate does not match GitHub's push SHA");
    return sourceRoot;
  }
  if (!runnerTemp) throw new SafetyGateError("Manual candidate validation requires RUNNER_TEMP");
  let candidateRoot: string;
  let allowedRoot: string;
  try {
    candidateRoot = realpathSync(requestedRoot ?? process.cwd());
    allowedRoot = realpathSync(runnerTemp);
  } catch {
    throw new SafetyGateError("Manual candidate source directory is unavailable");
  }
  if (!candidateRoot.startsWith(`${allowedRoot}/`))
    throw new SafetyGateError("Manual candidate source must be inside RUNNER_TEMP");
  validateCandidateSource(candidateRoot, candidateCommit);
  return candidateRoot;
}

function validateCandidateSource(sourceRoot: string, candidateCommit?: string): void {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw new SafetyGateError("Production deployment runs only in GitHub Actions");
  let head: string;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .toLowerCase();
  } catch {
    throw new SafetyGateError("Candidate source directory is not a Git worktree");
  }
  if (!/^[a-f0-9]{40}$/.test(head) || (candidateCommit && head !== candidateCommit.toLowerCase()))
    throw new SafetyGateError("Candidate source HEAD does not match the classified commit");

  const validation = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      'import { deployEnvironment } from "./scripts/environment.ts"; deployEnvironment();',
    ],
    { cwd: sourceRoot, env: process.env, stdio: "ignore" },
  );
  if (validation.error || validation.status !== 0)
    throw new SafetyGateError(
      "Candidate deployment credentials or configuration failed validation",
    );
}

export function productionManualRollbackDependencies(
  sourceRoot: string,
  rollbackCommit: string,
  ledger: DeploymentLedger,
): ManualRollbackDependencies {
  const environment = readLedgerEnvironment();
  const planetscale = new PlanetScaleSafety(requirePlanetScaleEnvironment());
  const release = productionReleaseDependencies(sourceRoot, rollbackCommit);
  return {
    assertBackup: async (report) => {
      const target = await planetscale.manualRollbackTarget(report, releaseBackup(ledger));
      if (!target.manualRestoreRequired)
        throw new SafetyGateError(
          "Database rollback backup is not available for the classified release",
        );
    },
    assertDrained: async (report) =>
      assertWorkflowsDrained(await inspectWorkflowChange(report, requireCloudflareEnvironment())),
    prepare: () => prepareRollbackSource(sourceRoot),
    validateCredentials: release.validateCredentials,
    begin: (report, expectedDeploymentId) =>
      beginRollbackDeployment(report, environment, fetch, expectedDeploymentId),
    mark: (deploymentId, state) => finishDeployment(deploymentId, state, environment),
    dispose: () => release.dispose?.(),
    deploy: release.deploy,
    assertImages: release.assertImages,
    smoke: () => runCommand("node", ["scripts/smoke.ts"], repositoryRoot),
  };
}

async function prepareRollbackSource(sourceRoot: string): Promise<void> {
  assertBarrierSource(sourceRoot);
  const commands: Array<[string, string[], string]> = [
    ["node", ["scripts/prepare-upstream.ts"], "upstream preparation"],
    ["npm", ["run", "check:upstream"], "upstream checks"],
    ["npm", ["run", "build"], "build"],
    ["npm", ["run", "check:build"], "build checks"],
    ["npm", ["run", "typecheck"], "typecheck"],
  ];
  for (const [command, args, label] of commands) {
    const result = await runCommand(command, args, sourceRoot);
    if (!result.started || result.exitCode !== 0)
      throw new SafetyGateError(
        `Previous production release ${label} failed; rollback deployment was not started`,
      );
  }
}

async function failReleaseAttempt(
  dependencies: Pick<ReleaseDependencies, "mark">,
  deploymentId: number,
  reason: string,
): Promise<never> {
  await dependencies.mark(deploymentId, "failure");
  throw new SafetyGateError(
    `Production ${reason}; inspect the barrier receipts and use explicit recorded-version recovery. No automatic rollback was attempted`,
  );
}

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  report: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let started = false;
    let settled = false;
    const stdout = new OutputTail();
    const stderr = new OutputTail();
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("spawn", () => {
      started = true;
    });
    child.once("error", () => {
      if (!settled) {
        settled = true;
        resolve({ started, exitCode: null });
      }
    });
    // Settle on exit: a descendant that inherited the pipes must not hold the release open. Remaining
    // output gets a short grace period to drain before the pipes are closed.
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      let finished = false;
      const finish = (closed: boolean) => {
        if (finished) return;
        finished = true;
        child.stdout.destroy();
        child.stderr.destroy();
        const held = closed ? {} : { outputHeld: true as const };
        if (code === 0) {
          resolve({ started, exitCode: code, ...held });
          return;
        }
        const commandLine = redactFailureOutput([command, ...args].join(" "), env);
        const sections = [
          ["stdout", stdout.text()],
          ["stderr", stderr.text()],
        ] as const;
        const output = sections
          .map(([name, text]) => `--- ${name}\n${redactFailureOutput(text, env)}`)
          .join("\n");
        report(
          `${commandLine} exited with ${code ?? signal}. Last output lines, credentials removed:\n${output}\n`,
        );
        const startupCpuLimit = isScriptStartupCpuLimit(
          sections.map(([, text]) => text).join("\n"),
        );
        resolve({
          started,
          exitCode: code,
          ...(startupCpuLimit ? { scriptStartupCpuLimit: true as const } : {}),
          ...held,
        });
      };
      const grace = setTimeout(() => finish(false), 2000);
      child.once("close", () => {
        clearTimeout(grace);
        finish(true);
      });
    });
  });
}

export function assertBarrierSource(sourceRoot: string): void {
  if (!existsSync(join(sourceRoot, "scripts/release-barrier/entry.ts")))
    throw new SafetyGateError(
      "Release source predates the Worker version barrier; use recorded-version recovery instead of an ordinary upload",
    );
}
