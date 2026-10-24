import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubApi } from "./github.ts";
import { repositoryFromOrigin, resetToLatestMain } from "./git.ts";
import { reconcileReleasePullRequest, type ReconcileResult } from "./reconcile.ts";
import { sanitizePublicPreparationFailure } from "./metadata.ts";
import { applyUpdatePlan, planUpdate, type UpdatePlan, type UpdateSource } from "./update.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export type ReleaseUpdateApi = Pick<GitHubApi, "get" | "request" | "compare" | "compareTrees">;
export type CommandRunner = (root: string, step: string, command: string, args: string[]) => void;

export type ReleaseUpdateDependencies = {
  api?: ReleaseUpdateApi;
  resetMain?: (root: string) => string;
  repository?: string;
  runCommand?: CommandRunner;
  reconcile?: typeof reconcileReleasePullRequest;
};

export type ReleaseUpdateRun = {
  schemaVersion: 1;
  source: UpdateSource;
  baseCommit: string;
  releaseKey: string;
  changedPaths: string[];
  preparationFailed: boolean;
  reconciliation: ReconcileResult;
};

const preparationCommands = [
  { step: "install architecture dependencies", command: "bun", args: ["install", "--cwd", "scripts/architecture", "--frozen-lockfile"] },
  { step: "prepare pinned upstream source", command: "npm", args: ["run", "prepare:upstream"] },
  { step: "check the pinned provider table", command: "npm", args: ["run", "check:providers"] },
  { step: "build the pinned hosted framework", command: "bun", args: ["run", "--cwd", ".upstream/apps/hosted/cloud", "framework:build"] },
  { step: "regenerate deployment architecture", command: "npm", args: ["run", "architecture:deployment"] },
  { step: "validate deployment architecture", command: "npm", args: ["run", "architecture:validate"] },
] as const;

export async function runReleaseUpdate(
  repositoryRoot: string,
  source: UpdateSource,
  token: string,
  dependencies: ReleaseUpdateDependencies = {},
): Promise<ReleaseUpdateRun> {
  if (!token) throw new Error("RELEASE_UPDATE_TOKEN is required for scheduled release updates");
  const baseCommit = (dependencies.resetMain ?? resetToLatestMain)(repositoryRoot);
  const api = dependencies.api ?? new GitHubApi(token);
  const plan = await planUpdate(repositoryRoot, source, api);
  applyUpdatePlan(repositoryRoot, plan);

  let preparationFailure: string | undefined;
  if (plan.changedPaths.length) {
    try {
      if (plan.providerTableGenerationFailed) throw new Error("Provider table generation failed");
      await prepareCandidate(repositoryRoot, dependencies.runCommand ?? runCommand);
    } catch (error) {
      preparationFailure = sanitizePublicPreparationFailure(error);
    }
  }

  const repository = dependencies.repository ?? repositoryFromOrigin(repositoryRoot);
  const reconciliation = await (dependencies.reconcile ?? reconcileReleasePullRequest)(
    repositoryRoot,
    repository,
    source,
    plan,
    token,
    preparationFailure,
    api,
  );
  return {
    schemaVersion: 1,
    source,
    baseCommit,
    releaseKey: plan.releaseKey,
    changedPaths: plan.changedPaths,
    preparationFailed: preparationFailure !== undefined,
    reconciliation,
  };
}

export function releaseBuildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|API[_-]?KEY)/i.test(key)));
}

async function prepareCandidate(repositoryRoot: string, run: CommandRunner): Promise<void> {
  for (const command of preparationCommands)
    run(repositoryRoot, command.step, command.command, [...command.args]);
}

function runCommand(repositoryRoot: string, step: string, command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: releaseBuildEnvironment(process.env),
  });
  if (result.error || result.status !== 0) throw new Error(`${step} failed`);
}

function sourceFromArgs(args: string[]): UpdateSource {
  const source = args.find((arg) => arg.startsWith("--source="))?.slice("--source=".length);
  if (source !== "tools" && source !== "home" && source !== "node")
    throw new Error("Usage: node scripts/releases/run.ts --source=tools|home|node");
  return source;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const token = process.env.RELEASE_UPDATE_TOKEN;
    if (!token) throw new Error("RELEASE_UPDATE_TOKEN is required for scheduled release updates");
    const result = await runReleaseUpdate(root, sourceFromArgs(process.argv.slice(2)), token);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.preparationFailed) process.exitCode = 1;
  } catch {
    process.stderr.write("Release updater failed before reconciliation. See this workflow run for details.\n");
    process.exitCode = 1;
  }
}
