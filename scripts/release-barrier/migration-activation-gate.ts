import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readDeploymentLedger, readLedgerEnvironment } from "../deploy-safety/github-ledger.ts";
import { assertNoReleaseHold } from "../deploy-safety/runtime.ts";
import { validateMainCandidate } from "../release-merge/main-candidate.ts";
import { BarrierRefusal } from "./refusal.ts";
import { reportRefusal } from "./refusal-report.ts";

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

const ineligible = [
  "main does not contain the release candidate",
  "the main release candidate has no successful push Check",
  "the release candidate is a release update; release it through Manual release with its pull request",
];

/** Only the validator's own fixed sentences and a bare HTTP status reach the job output. */
export function candidateEligibilityRefusal(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const status = /^GitHub request for the main release candidate failed with HTTP (\d{3})$/u.exec(
    message,
  )?.[1];
  const change = status
    ? { path: "github.status", old: 200, new: Number(status) }
    : ineligible.includes(message)
      ? { path: "eligibility", old: "eligible", new: message }
      : undefined;
  return change
    ? new BarrierRefusal("migration-activation-candidate-ineligible", "candidate", {
        fqn: "candidate",
        type: "Git.Commit",
        changed: [change],
      })
    : undefined;
}

/** The client that touches production is the dispatched main commit, never another checkout. */
export function trustedActivationTooling(source: Record<string, string | undefined>, head: string) {
  if (!/^[a-f0-9]{40}$/u.test(head) || head !== source.GITHUB_SHA)
    throw new BarrierRefusal("migration-activation-trusted-tooling-required", "tooling", {
      fqn: "tooling",
      type: "Git.Commit",
      changed: [{ path: "HEAD", old: source.GITHUB_SHA ?? "unavailable", new: head }],
    });
  return head;
}

/** The trusted workflow validates the requested SHA exactly, without the normal newest chooser. */
export async function migrationActivationGate(source = process.env) {
  const input = migrationActivationInput(source);
  const environment = readLedgerEnvironment(source);
  // This file's own checkout, so the working directory cannot stand in for the running client.
  const checkedOut = trustedActivationTooling(
    source,
    execFileSync(
      "git",
      ["-C", fileURLToPath(new URL("../../", import.meta.url)), "rev-parse", "HEAD"],
      {
        encoding: "utf8",
      },
    ).trim(),
  );
  await validateMainCandidate(
    environment.repository,
    environment.token,
    checkedOut,
    input.candidate,
  ).catch((error: unknown) => {
    throw candidateEligibilityRefusal(error) ?? error;
  });
  const deploymentId = exactMigrationRelease(
    input.candidate,
    await readDeploymentLedger(environment),
  );
  return { ...input, deploymentId, tooling: checkedOut };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const gate = await migrationActivationGate();
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `head=${gate.candidate}\n`);
  } catch (error) {
    // Before the client exists, this step is the only place its refusal can name what changed.
    if (error instanceof BarrierRefusal)
      await reportRefusal(
        {
          reason: error.reason,
          ...(error.worker ? { worker: error.worker } : {}),
          ...(error.delta ? { delta: error.delta } : {}),
        },
        process.env.GITHUB_STEP_SUMMARY,
      );
    else process.stderr.write("migration-activation-gate-failed\n");
    process.exitCode = 1;
  }
}
