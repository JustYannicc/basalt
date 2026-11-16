import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRecoveryProgress } from "../release-barrier/recovery-manifest.ts";
import { SafetyGateError } from "./contracts.ts";
import { readLedgerEnvironment } from "./github-ledger.ts";
import { runRecordedRecovery } from "./recorded-recovery.ts";
import { assertBarrierSource, runCommand } from "./release-runner.ts";

export function recoveryInvocation(source: NodeJS.ProcessEnv) {
  if (
    source.GITHUB_ACTIONS !== "true" ||
    source.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    source.GITHUB_REF !== "refs/heads/main" ||
    source.RECOVERY_MODE !== "recorded-versions" ||
    source.GITHUB_WORKFLOW_REF !==
      `${source.GITHUB_REPOSITORY}/.github/workflows/release-rollback.yml@refs/heads/main`
  )
    throw new SafetyGateError("Recorded recovery requires its trusted main rollback workflow");
  if (!source.RUNNER_TEMP || !isAbsolute(source.RUNNER_TEMP) || source.RESTORED_BACKUP?.trim())
    throw new SafetyGateError(
      "Recorded recovery requires RUNNER_TEMP and cannot select a database restore",
    );
  if (!["true", "false"].includes(source.RECOVERY_DATABASE_COMPATIBLE ?? ""))
    throw new SafetyGateError(
      "Recorded recovery requires an explicit database compatibility decision",
    );
  return {
    candidate: source.RECOVERY_CANDIDATE ?? "",
    sourceRun: source.RECOVERY_SOURCE_RUN ?? "",
    pairSha256: source.RECOVERY_PAIR_SHA256 ?? "",
    databaseCompatible: source.RECOVERY_DATABASE_COMPATIBLE === "true",
    ...(source.RECOVERY_PROGRESS_RUN ? { progressRun: source.RECOVERY_PROGRESS_RUN } : {}),
  };
}

async function main() {
  const summary: string[] = ["## Recorded-version recovery", ""];
  try {
    const request = recoveryInvocation(process.env);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const directory = join(root, ".local/recorded-version-recovery");
    await runRecordedRecovery(request, {
      directory,
      environment: readLedgerEnvironment(),
      fetcher: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }),
      async prepare(candidate) {
        const target = join(process.env.RUNNER_TEMP!, "recorded-candidate");
        execFileSync("git", ["fetch", "--no-tags", "origin", candidate], {
          cwd: root,
          stdio: "ignore",
        });
        execFileSync("git", ["worktree", "add", "--detach", target, candidate], {
          cwd: root,
          stdio: "ignore",
        });
        if (
          execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).trim() !==
          candidate
        )
          throw new SafetyGateError("Recovery candidate checkout differs from its recorded SHA");
        assertBarrierSource(target);
        for (const args of [
          ["run", "prepare:upstream"],
          ["run", "build"],
        ]) {
          const result = await runCommand("npm", args, target);
          if (!result.started || result.exitCode !== 0)
            throw new SafetyGateError(
              `Recovery candidate ${args[1]} failed; no recovery command was started`,
            );
        }
        execFileSync("git", ["diff", "--quiet", "HEAD"], { cwd: target, stdio: "ignore" });
        return target;
      },
      async execute(candidate, args, compatible) {
        const result = await runCommand("npm", args, candidate, {
          ...process.env,
          BASALT_RECOVERY_DATABASE_COMPATIBLE: String(compatible),
        });
        if (!result.started || result.exitCode !== 0)
          throw new SafetyGateError(
            "Recorded recovery command failed; retain its progress and do not retry the failed release",
          );
      },
    });
    const progress = readRecoveryProgress(
      JSON.parse(readFileSync(join(directory, "recovery.json"), "utf8")),
    );
    summary.push(
      `Candidate: ${request.candidate}`,
      `Source run: ${request.sourceRun}`,
      `Pair SHA-256: ${request.pairSha256}`,
      `Restored Workers: ${progress.restored.length}`,
      `Recorded container recoveries: ${progress.containers?.length ?? 0}`,
      "",
      "Recorded-version recovery completed. No database migration or restore ran. The production release ledger remains failed; verify the live app separately.",
    );
  } catch (error) {
    const message =
      error instanceof SafetyGateError
        ? error.message
        : "Recorded recovery failed. Inspect retained evidence; no retry was attempted.";
    process.stderr.write(`::error::${message}\n`);
    summary.push(message);
    process.exitCode = 1;
  } finally {
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
