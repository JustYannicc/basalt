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
    lines.push(
      "",
      result.submissionAttempted
        ? "This step attempted one signed restart POST. It will not submit again."
        : "This step submitted no restart.",
    );
    if (result.receipt) {
      lines.push(
        "",
        `Durable receipt: **${result.receipt.status}**.`,
        `Previous boot: \`${result.receipt.previousBootId}\`; recorded replacement boot: \`${result.receipt.bootId ?? "unavailable"}\`.`,
      );
      if (result.receipt.failure) lines.push(`Recorded failure: \`${result.receipt.failure}\`.`);
    }
    lines.push(
      "",
      result.outcome === "ready"
        ? "One reviewed restart completed. The receipt is ready, the boot changed, and provider/runtime pins passed post-restart verification."
        : result.outcome === "dry-run"
          ? "Dry run passed. No restart was submitted by this step."
          : result.receipt
            ? "The operation receipt is retained. Receipt inspection does not establish full post-restart verification."
            : "No durable receipt was found. Keep the submission marker and inspect the same operation; do not submit again.",
    );
    if (result.issues?.length) {
      for (const issue of result.issues) {
        lines.push("", `Incomplete verification: **${issue.reason}**.`);
        if (issue.drift.length)
          lines.push(
            "| Resource | Property | Expected | Observed |",
            "| --- | --- | --- | --- |",
            ...issue.drift.map(
              (d) => `| ${d.resource} | ${d.property} | \`${d.expected}\` | \`${d.observed}\` |`,
            ),
          );
      }
      lines.push(
        "Do not resubmit. Retain the operation and inspect its receipt; a ready receipt alone does not establish post-restart verification.",
      );
    }
    if (result.outcome === "uncertain" || result.receipt?.status === "started")
      lines.push(
        "The outcome remains uncertain. Inspect this same operation; do not create a new operation or repeat its POST.",
      );
  }
  return `${lines.join("\n")}\n`;
}
