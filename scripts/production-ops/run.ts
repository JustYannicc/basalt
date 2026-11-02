import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brand } from "../../brand.ts";
import { productionOperation } from "./client.ts";

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
  if (action === "migrate" && mode === "apply") {
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
  const result = await productionOperation({
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
  });
  const output = resolve(process.env.OPS_OUTPUT_DIRECTORY ?? ".generated/production-ops");
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
} catch {
  process.stderr.write(
    "Production operation failed. No credential-bearing error or response was logged. Inspect the saved receipt before retrying an apply.\n",
  );
  process.exitCode = 1;
}
