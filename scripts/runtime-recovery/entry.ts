import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { nodePoolOperations } from "../pool-operations-node.ts";
import {
  reviewedPlan,
  recoveryPlanDigest,
  decodeRecoveryPlan,
  RecoveryWorkflowRefusal,
  type RecoveryPlan,
} from "./plan.ts";
import { providerPins } from "./inventory.ts";
import { runReviewedRecovery, type RecoveryReport } from "./run.ts";
import { recoverySummary } from "./summary.ts";

const [mode, file] = process.argv.slice(2);
if (mode === "digest" && file) {
  try {
    console.log(recoveryPlanDigest(decodeRecoveryPlan(JSON.parse(await readFile(file, "utf8")))));
  } catch {
    console.error("Runtime recovery plan is invalid");
    process.exitCode = 1;
  }
} else {
  const directory = resolve(process.env.RECOVERY_OUTPUT_DIRECTORY ?? ".generated/runtime-recovery");
  const digest = process.env.RECOVERY_PLAN_SHA256 ?? "";
  let plan: RecoveryPlan | undefined;
  let result: RecoveryReport | RecoveryWorkflowRefusal;
  let platform: Awaited<ReturnType<typeof nodePoolOperations>> | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (
      process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      !["dry-run", "apply", "inspect"].includes(mode ?? "")
    )
      throw new RecoveryWorkflowRefusal("protected-main-dispatch-required");
    plan = reviewedPlan(process.env.RECOVERY_PLAN_JSON ?? "", digest);
    if (plan.accountId !== process.env.CLOUDFLARE_ACCOUNT_ID)
      throw new RecoveryWorkflowRefusal("cloudflare-account-drift");
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) throw new RecoveryWorkflowRefusal("cloudflare-credential-unavailable");
    const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
    if (!Number.isSafeInteger(attempt) || attempt < 1)
      throw new RecoveryWorkflowRefusal("workflow-attempt-invalid");
    platform = await nodePoolOperations(plan.accountId, plan.worker);
    const selected = plan;
    result = await runReviewedRecovery(
      plan,
      mode === "inspect" || attempt > 1 ? "inspect" : mode === "apply" ? "apply" : "dry-run",
      {
        operations: platform.env.POOL_OPERATIONS,
        provider: () => providerPins(selected, token),
        signingKey:
          mode === "apply" && attempt === 1 ? process.env.POOL_APP_SIGNING_KEY : undefined,
        directory,
      },
    );
  } catch (error) {
    result =
      error instanceof RecoveryWorkflowRefusal
        ? error
        : new RecoveryWorkflowRefusal("operation-unavailable");
  } finally {
    try {
      await platform?.dispose();
    } catch {
      result = new RecoveryWorkflowRefusal("bridge-teardown-unconfirmed");
    }
  }
  const summary = recoverySummary(plan, /^[a-f0-9]{64}$/.test(digest) ? digest : "invalid", result);
  await writeFile(
    join(directory, "report.json"),
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
  await writeFile(join(directory, "summary.md"), summary, { mode: 0o600 });
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (
    result instanceof RecoveryWorkflowRefusal ||
    result.outcome === "uncertain" ||
    (result.outcome === "inspection" && result.receipt?.status !== "ready")
  )
    process.exitCode = 1;
}
