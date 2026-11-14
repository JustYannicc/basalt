import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readDeploymentLedger, readLedgerEnvironment } from "../deploy-safety/github-ledger.ts";
import { assertNoReleaseHold } from "../deploy-safety/runtime.ts";
import { validateMainCandidate } from "../release-merge/main-candidate.ts";
import { BarrierRefusal } from "./manifest.ts";

export function migrationActivationInput(source: Record<string, string | undefined>) {
  try {
    assertNoReleaseHold(source);
  } catch {
    throw new BarrierRefusal("migration-activation-release-held", "PRODUCTION_RELEASE_HOLD");
  }
  const candidate = source.BASALT_RELEASE_CANDIDATE ?? "";
  const mode = source.MIGRATION_ACTIVATION_MODE ?? "";
  if (!/^[a-f0-9]{40}$/u.test(candidate))
    throw new BarrierRefusal("migration-activation-candidate-required", "candidate");
  if (mode !== "plan" && mode !== "inspect" && !/^[a-f0-9]{64}$/u.test(mode))
    throw new BarrierRefusal("migration-activation-mode-invalid", "migration_activation");
  if (
    source.GITHUB_ACTIONS !== "true" ||
    source.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    source.GITHUB_REF !== "refs/heads/main" ||
    source.GITHUB_WORKFLOW_REF !==
      `${source.GITHUB_REPOSITORY}/.github/workflows/release-main.yml@refs/heads/main`
  )
    throw new BarrierRefusal("migration-activation-trusted-workflow-required", "release-main.yml");
  if (source.BASALT_HOME_SCHEMA_RETRY_INTENT?.trim())
    throw new BarrierRefusal(
      "migration-activation-conflicting-input",
      "home_migration_retry_intent",
    );
  return { candidate, mode };
}

export function exactMigrationRelease(
  candidate: string,
  ledger: {
    state: "ready" | "uninitialized" | "unresolved";
    gitCommit?: string;
    deploymentId?: number;
  },
) {
  const deploymentId = ledger.deploymentId;
  if (
    ledger.state !== "ready" ||
    ledger.gitCommit !== candidate ||
    typeof deploymentId !== "number" ||
    !Number.isSafeInteger(deploymentId) ||
    deploymentId <= 0
  )
    throw new BarrierRefusal("migration-activation-wrong-production-candidate", "production", {
      fqn: "production",
      type: "GitHub.Deployment",
      changed: [
        {
          path: "gitCommit",
          old: candidate,
          new:
            ledger.state === "uninitialized"
              ? "uninitialized"
              : (ledger.gitCommit ?? "unavailable"),
        },
      ],
    });
  return deploymentId;
}

/** The trusted workflow validates the requested SHA exactly, without the normal newest chooser. */
export async function migrationActivationGate(source = process.env) {
  const input = migrationActivationInput(source);
  const environment = readLedgerEnvironment(source);
  const checkedOut = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await validateMainCandidate(
    environment.repository,
    environment.token,
    checkedOut,
    input.candidate,
  );
  const deploymentId = exactMigrationRelease(
    input.candidate,
    await readDeploymentLedger(environment),
  );
  return { ...input, deploymentId };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const gate = await migrationActivationGate();
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `head=${gate.candidate}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof BarrierRefusal ? error.message : "migration-activation-gate-failed"}\n`,
    );
    process.exitCode = 1;
  }
}
