import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acceptanceOperation, AcceptanceRefusal, type AcceptanceFailure } from "./client.ts";
import { targetOf } from "./target.ts";

const output = resolve(process.env.ACCEPTANCE_OUTPUT_DIRECTORY ?? ".generated/acceptance-pool");
const write = (name: string, value: unknown) => {
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
};
const summarize = (text: string) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
};

async function sourceRun(source: string): Promise<unknown> {
  if (
    !/^[1-9][0-9]{0,19}$/u.test(source) ||
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
    run.path !== ".github/workflows/acceptance-pool.yml" ||
    !("head_branch" in run) ||
    run.head_branch !== "main" ||
    !("event" in run) ||
    run.event !== "workflow_dispatch" ||
    !("conclusion" in run) ||
    run.conclusion !== "success"
  )
    throw new Error("Source run is not a completed acceptance-pool dispatch on main");
  return JSON.parse(
    readFileSync(join(process.env.ACCEPTANCE_PREVIOUS_DIRECTORY ?? "", "operation.json"), "utf8"),
  );
}

try {
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
  )
    throw new Error("Main workflow dispatch required");
  const kind = process.env.ACCEPTANCE_KIND ?? "";
  const action = process.env.ACCEPTANCE_ACTION ?? "";
  const target = targetOf(process.env.ACCEPTANCE_TARGET ?? "");
  const previous =
    action === "apply" ? await sourceRun(process.env.ACCEPTANCE_SOURCE_RUN ?? "") : undefined;
  const result = await acceptanceOperation({
    target: target.origin,
    signingKey: target.signingKey ?? "",
    kind,
    action,
    request: process.env.ACCEPTANCE_REQUEST ?? "{}",
    recipient: process.env.ACCEPTANCE_RECIPIENT ?? "",
    planSha256: process.env.ACCEPTANCE_PLAN_SHA256 ?? "",
    go: process.env.ACCEPTANCE_GO ?? "",
    ...(process.env.EMULATED_UPSTREAM_ORIGIN
      ? { upstreamOrigin: process.env.EMULATED_UPSTREAM_ORIGIN }
      : {}),
    ...(process.env.EMULATED_UPSTREAM_KEY
      ? { upstreamKey: process.env.EMULATED_UPSTREAM_KEY }
      : {}),
    ...(previous === undefined ? {} : { previous }),
  });
  // The server never echoes the key or the origin; the plan is encrypted to the recipient.
  write("operation.json", result);
  const summary = {
    action: result.action,
    kind: result.kind,
    planSha256: result.planSha256,
    steps: result.steps,
    writes: result.writes,
    upstreamConfigured: result.upstreamConfigured,
    repeated: result.repeated,
    resumed: result.resumed,
    completed: result.completed,
    verification: result.verification,
  };
  write("summary.json", summary);
  summarize(
    `\nAcceptance pool ${String(result.kind)} ${String(result.action)} completed.\n\n` +
      (result.upstreamConfigured === undefined
        ? ""
        : `upstream host configured: ${String(result.upstreamConfigured)}\n\n`) +
      `\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
  );
  process.stdout.write("Acceptance pool operation completed; summary saved.\n");
} catch (error) {
  const failure: AcceptanceFailure =
    error instanceof AcceptanceRefusal
      ? error.failure
      : { format: "basalt-acceptance-pool-failure-v1", reason: "config", retryable: false };
  try {
    write("failure.json", failure);
  } catch {
    process.stderr.write("Failure receipt could not be saved.\n");
  }
  const detail = `Acceptance pool operation refused: ${failure.reason}${failure.step === undefined ? "" : ` at step ${failure.step}`}${failure.httpStatus === undefined ? "" : ` (HTTP ${failure.httpStatus})`}.`;
  process.stderr.write(`::error::${detail}\n`);
  summarize(`\n${detail}\n`);
  process.stderr.write(
    failure.reason === "stale_plan"
      ? "The plan is stale; run a fresh dry run.\n"
      : failure.retryable
        ? "Another apply holds this plan; retry the same plan and GO once it has finished or its lease has run out.\n"
        : "Inspect failure.json and the saved receipt before retrying.\n",
  );
  process.exitCode = 1;
}
