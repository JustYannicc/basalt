import type { RecoveryReport } from "./run.ts";
import { RecoveryWorkflowRefusal, type RecoveryPlan } from "./plan.ts";

export function recoverySummary(
  plan: RecoveryPlan | undefined,
  digest: string,
  result: RecoveryReport | RecoveryWorkflowRefusal,
) {
  const outcome =
    result instanceof RecoveryWorkflowRefusal ? `REFUSED: ${result.reason}` : result.outcome;
  const lines = [
    "## Exact runtime recovery",
    "",
    `Outcome: **${outcome}**`,
    "",
    `Reviewed plan SHA-256: \`${digest}\``,
  ];
  if (plan)
    lines.push(
      "",
      "| Pin | Reviewed value |",
      "| --- | --- |",
      ...Object.entries({
        operationId: plan.operationId,
        worker: plan.worker,
        release: plan.release,
        deploymentId: plan.deploymentId,
        workerVersion: plan.workerVersion,
        applicationId: plan.applicationId,
        applicationVersion: plan.applicationVersion,
        imageDigest: plan.imageDigest,
        instanceId: plan.instanceId,
        imageHash: plan.imageHash,
        bootId: plan.bootId,
        ...plan.resources,
      }).map(([key, value]) => `| ${key} | \`${value}\` |`),
    );
  if (result instanceof RecoveryWorkflowRefusal) {
    if (result.drift.length)
      lines.push(
        "",
        "| Resource | Property | Expected | Observed |",
        "| --- | --- | --- | --- |",
        ...result.drift.map(
          (d) => `| ${d.resource} | ${d.property} | \`${d.expected}\` | \`${d.observed}\` |`,
        ),
      );
    lines.push(
      "",
      "No further submission is permitted by this run. Retain the submission marker and inspect the operation receipt if a request may have been sent.",
    );
  } else {
    if (result.receipt)
      lines.push(
        "",
        `Durable receipt: **${result.receipt.status}**.`,
        `Previous boot: \`${result.receipt.previousBootId}\`; recorded replacement boot: \`${result.receipt.bootId ?? "unavailable"}\`.`,
      );
    lines.push(
      "",
      result.outcome === "ready"
        ? "One reviewed restart completed. The receipt is ready, the boot changed, and provider/runtime pins passed post-restart verification."
        : result.outcome === "dry-run"
          ? "Dry run passed. No restart was submitted by this step."
          : "Receipt inspection only after an existing or uncertain operation. This step did not submit another restart.",
    );
    if (result.outcome === "uncertain" || result.receipt?.status === "started")
      lines.push(
        "The outcome remains uncertain. Inspect this same operation; do not create a new operation or repeat its POST.",
      );
  }
  return `${lines.join("\n")}\n`;
}
