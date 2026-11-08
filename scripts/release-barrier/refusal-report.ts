import type { ServingDiagnostic } from "./serving-failure.ts";
import { appendFile } from "node:fs/promises";
import type { ReleaseOperationFailure } from "./operation-failure.ts";
import type { PlanRefusal } from "./manifest.ts";
import type { ResourceDelta } from "./prop-diff.ts";

interface Failure {
  reason: string;
  serving?: ServingDiagnostic;
  operation?: ReleaseOperationFailure["operation"];
  provider?: ReleaseOperationFailure["provider"];
  worker?: string;
  delta?: ResourceDelta;
  refusals?: readonly PlanRefusal[];
}

const cell = (value: string) =>
  value
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replaceAll("<", "&lt;")
    .replace(/[\r\n]/g, " ");

/** Accept only the already-redacted receipt, never native props or provider errors. */
export function refusalTable(failure: Failure) {
  const refusals = failure.refusals ?? [
    failure.delta ? { reason: failure.reason, ...failure.delta } : { reason: failure.reason },
  ];
  const rows = refusals.flatMap((refusal) => {
    const resource = "fqn" in refusal ? refusal.fqn : (failure.worker ?? "(plan)");
    const changes = "changed" in refusal ? refusal.changed : [];
    const details = changes.map((change) => [
      resource,
      change.path,
      "old" in change
        ? `${JSON.stringify(change.old)} → ${JSON.stringify(change.new)}`
        : "changed (redacted)",
    ]);
    if ("why" in refusal && refusal.why?.length)
      details.push([resource, "$plan", refusal.why.join("; ")]);
    return details.length ? details : [[resource, "$plan", refusal.reason]];
  });
  if (failure.operation)
    rows.push([
      failure.worker ?? "(plan)",
      "$operation",
      [
        failure.operation,
        failure.provider?.type,
        failure.provider?.reason,
        failure.provider?.status === undefined ? undefined : `status=${failure.provider.status}`,
        failure.provider?.codes?.length ? `codes=${failure.provider.codes.join(",")}` : undefined,
      ]
        .filter((value) => value !== undefined)
        .join("; "),
    ]);
  if (failure.serving) {
    const value = failure.serving;
    rows.push([
      failure.worker ?? "PoolContainer",
      `$serving.${value.check}`,
      `${value.cause}; status=${value.status ?? "none"}; elapsedMs=${value.elapsedMs ?? "none"}; last=${JSON.stringify(value.observation ?? null)}`,
    ]);
  }
  return [
    "| Resource | Property | Old → new |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

export async function reportRefusal(
  failure: Failure,
  summaryPath?: string,
  error: (message: string) => void = console.error,
) {
  const table = refusalTable(failure);
  const message = `Release barrier refused: ${failure.reason}\n${table}`;
  error(message);
  error(
    `::error title=Release barrier refused::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
  );
  if (summaryPath) await appendFile(summaryPath, `## Release barrier refused\n\n${table}\n\n`);
}
