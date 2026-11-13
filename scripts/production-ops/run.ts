import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brand } from "../../brand.ts";
import { retainedInventory } from "./inventory-pagination.ts";
import { productionOperation } from "./client.ts";
import { failure, failureReceipt, OperationFailure, type FailureReceipt } from "./failure.ts";

const output = resolve(process.env.OPS_OUTPUT_DIRECTORY ?? ".generated/production-ops");
let phase: FailureReceipt["phase"] = "config";

try {
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
  )
    throw new Error("Main workflow dispatch required");
  const action = process.env.OPS_ACTION ?? "";
  const mode = process.env.OPS_MODE ?? "";
  const source = process.env.OPS_SOURCE_RUN ?? "";
  let previous: unknown;
  if (
    (action === "migrate" && mode === "apply") ||
    (action === "prepare" && process.env.OPS_SELECTION === "home-agent-import-recovery-v1")
  ) {
    if (
      !/^[1-9][0-9]{0,19}$/.test(source) ||
      !process.env.GITHUB_TOKEN ||
      !process.env.GITHUB_REPOSITORY
    )
      throw new Error("Missing source run");
    const response = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${source}`,
      {
        headers: {
          authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error("Source run unavailable");
    const run: unknown = await response.json();
    if (
      typeof run !== "object" ||
      run === null ||
      !("path" in run) ||
      run.path !== ".github/workflows/production-ops.yml" ||
      !("head_branch" in run) ||
      run.head_branch !== "main" ||
      !("event" in run) ||
      run.event !== "workflow_dispatch" ||
      !("conclusion" in run) ||
      run.conclusion !== "success"
    )
      throw new Error("Source run is not a completed ops dispatch on main");
    previous = JSON.parse(
      readFileSync(join(process.env.OPS_PREVIOUS_DIRECTORY ?? "", "operation.json"), "utf8"),
    );
  }
  phase = "request";
  const input = {
    target: `https://${brand.host}`,
    signingKey: process.env.POOL_APP_SIGNING_KEY ?? "",
    action,
    mode,
    selection: process.env.OPS_SELECTION ?? "",
    request: process.env.OPS_REQUEST ?? "{}",
    recipient: process.env.OPS_RECIPIENT ?? "",
    planSha256: process.env.OPS_PLAN_SHA256 ?? "",
    go: process.env.OPS_GO ?? "",
    ...(previous === undefined ? {} : { previous }),
  };
  const result: Record<string, unknown> =
    action === "inventory" && input.selection === "retained-frameworks"
      ? await retainedInventory(input, fetch, (page, index) => {
          mkdirSync(join(output, "pages"), { recursive: true, mode: 0o700 });
          writeFileSync(
            join(output, "pages", `${String(index).padStart(5, "0")}.json`),
            `${JSON.stringify(page)}\n`,
            { mode: 0o600, flag: "wx" },
          );
        })
      : await productionOperation(input);
  phase = "receipt";
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(join(output, "operation.json"), `${JSON.stringify(result)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const artifact = result.artifact;
  const planSha256 =
    artifact && typeof artifact === "object" && "sha256" in artifact
      ? artifact.sha256
      : result.planSha256;
  const summary = {
    action: result.action,
    pages: result.pages,
    builds: result.builds,
    complete: result.complete,
    rows: result.rows,
    changes: result.changes,
    planSha256,
    backupSha256: result.backupSha256,
    repeated: result.repeated,
    verification: result.verification,
  };
  writeFileSync(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\nProduction operation completed. Inventory and backup contents are encrypted.\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
    );
  process.stdout.write(
    "Production operation completed; encrypted artifact and safe summary saved.\n",
  );
} catch (error) {
  const receipt =
    error instanceof OperationFailure
      ? (failureReceipt(error.receipt) ?? failure("unknown", "receipt"))
      : failure(phase === "config" ? "config" : "unknown", phase);
  // Numeric HTTP status comes from fetch, never from an untrusted response field.
  const safe =
    error instanceof OperationFailure && error.receipt.httpStatus !== undefined
      ? { ...receipt, httpStatus: error.receipt.httpStatus }
      : receipt;
  try {
    mkdirSync(output, { recursive: true, mode: 0o700 });
    writeFileSync(join(output, "failure.json"), `${JSON.stringify(safe)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    if (safe.retainedRead) {
      const work = safe.retainedRead.work;
      const counts =
        work === undefined
          ? ""
          : ` Work: ${work.references} references, ${work.builds} builds, ${work.metadataAttempts} metadata attempts, ${work.metadataPages} pages, ${work.metadataObjects} metadata objects, ${work.recordAttempts} record attempts, ${work.completedBuilds} completed builds.`;
      const detail = `Retained frameworks refused at ${safe.retainedRead.objectClass}/${safe.retainedRead.readPhase} after ${safe.retainedRead.elapsedMs} ms.${safe.reasonCode ? ` Reason: ${safe.reasonCode}.` : ""}${counts}`;
      process.stderr.write(`::error::${detail}\n`);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${detail}\n`);
    }
  } catch {
    process.stderr.write("Safe failure receipt could not be saved.\n");
  }
  if (safe.reasonCode && !safe.retainedRead) {
    const detail = `Production operation refused: ${safe.reasonCode}.`;
    process.stderr.write(`::error::${detail}\n`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${detail}\n`);
  }
  process.stderr.write(
    safe.reason === "stale_plan"
      ? "Production plan is stale; run a fresh dry run.\n"
      : safe.reason === "operation_busy"
        ? "Production operation is busy. Inspect failure.json and the saved apply receipt before retrying.\n"
        : safe.reason === "organization_removing"
          ? "Production operation refused: organization_removing. Inspect failure.json; retryable is false.\n"
          : "Production operation failed. Inspect failure.json and the saved apply receipt before retrying.\n",
  );
  process.exitCode = 1;
}
