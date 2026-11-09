import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { nodePoolOperations } from "../pool-operations-node.ts";
import { providerPins } from "./inventory.ts";
import { RecoveryWorkflowRefusal, recoveryPlanDigest, type RecoveryPlan } from "./plan.ts";
import { automaticEvidence } from "../../src/pool/automatic-recovery.ts";
import {
  AutomaticEvidence,
  automaticOperationId,
  automaticTargetDigest,
  collectAutomaticEvidence,
  reviewedAutomaticTarget,
} from "./automatic.ts";
import { recordRecoveryIssue, runReviewedRecovery, type RecoveryReport } from "./run.ts";
import { recoverySummary } from "./summary.ts";

const [mode, file] = process.argv.slice(2);
if (mode === "digest" && file) {
  try {
    const { AutomaticTarget } = await import("./automatic.ts");
    const target = Schema.decodeUnknownSync(AutomaticTarget, { onExcessProperty: "error" })(
      JSON.parse(await readFile(file, "utf8")),
    );
    console.log(automaticTargetDigest(target));
  } catch {
    console.error("Automatic recovery target is invalid");
    process.exitCode = 1;
  }
} else {
  const directory = resolve(
    process.env.RECOVERY_OUTPUT_DIRECTORY ?? ".generated/automatic-recovery",
  );
  let plan: RecoveryPlan | undefined;
  let platform: Awaited<ReturnType<typeof nodePoolOperations>> | undefined;
  let result: RecoveryReport | RecoveryWorkflowRefusal = new RecoveryWorkflowRefusal(
    "operation-unavailable",
  );
  let observed = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
    if (
      process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.GITHUB_EVENT_NAME !== "schedule" ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      !["observe", "apply"].includes(mode ?? "")
    )
      throw new RecoveryWorkflowRefusal("protected-main-schedule-required");
    const target = reviewedAutomaticTarget(
      process.env.AUTOMATIC_RECOVERY_TARGET_JSON ?? "",
      process.env.AUTOMATIC_RECOVERY_TARGET_SHA256 ?? "",
    );
    if (target.accountId !== process.env.CLOUDFLARE_ACCOUNT_ID)
      throw new RecoveryWorkflowRefusal("cloudflare-account-drift");
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) throw new RecoveryWorkflowRefusal("cloudflare-credential-unavailable");
    const selection = automaticTargetDigest(target);
    const { pool, ...pins } = target;
    const selected = {
      ...pins,
      operationId: automaticOperationId(process.env.GITHUB_RUN_ID ?? "", selection),
    };
    plan = selected;
    platform = await nodePoolOperations(target.accountId, target.worker);
    const deps = {
      operations: platform.env.POOL_OPERATIONS,
      provider: () => providerPins(selected, token),
      directory,
    };
    if (attempt > 1) {
      result = await runReviewedRecovery(selected, "inspect", deps);
    } else if (mode === "observe") {
      const evidence = await collectAutomaticEvidence(target, selected, deps);
      await writeFile(join(directory, "automatic-evidence.json"), JSON.stringify(evidence), {
        mode: 0o600,
        flag: "wx",
      });
      observed = true;
      result = {
        outcome: "dry-run",
        plan: selected,
        planSha256: recoveryPlanDigest(selected),
        submissionAttempted: false,
      };
    } else {
      const evidence = Schema.decodeUnknownSync(AutomaticEvidence, { onExcessProperty: "error" })(
        JSON.parse(await readFile(join(directory, "automatic-evidence.json"), "utf8")),
      );
      if (
        evidence.pool !== pool ||
        evidence.selection !== selection ||
        automaticEvidence(evidence.samples, Date.now()) !== "eligible"
      )
        throw new RecoveryWorkflowRefusal("automatic-evidence-invalid");
      result = await runReviewedRecovery(selected, "apply", {
        ...deps,
        signingKey: process.env.POOL_APP_SIGNING_KEY,
        automatic: evidence,
      });
    }
  } catch (error) {
    result =
      error instanceof RecoveryWorkflowRefusal
        ? error
        : new RecoveryWorkflowRefusal("operation-unavailable");
  } finally {
    try {
      await platform?.dispose();
    } catch {
      const issue = new RecoveryWorkflowRefusal("bridge-teardown-unconfirmed");
      result =
        result instanceof RecoveryWorkflowRefusal ? result : recordRecoveryIssue(result, issue);
    }
  }
  const summary =
    (observed ? "Three read-only observations passed. No restart submitted.\n\n" : "") +
    recoverySummary(plan, plan ? recoveryPlanDigest(plan) : "invalid", result);
  await writeFile(
    join(directory, "automatic-report.json"),
    JSON.stringify(
      result instanceof RecoveryWorkflowRefusal
        ? {
            outcome: "refused",
            reason: result.reason,
            drift: result.drift,
            ...(plan ? { plan } : {}),
          }
        : result,
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  await writeFile(join(directory, "automatic-summary.md"), summary, { mode: 0o600 });
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (
    result instanceof RecoveryWorkflowRefusal ||
    result.outcome === "uncertain" ||
    !!result.issues?.length ||
    (result.outcome === "inspection" && result.receipt?.status !== "ready")
  )
    process.exitCode = 1;
}
