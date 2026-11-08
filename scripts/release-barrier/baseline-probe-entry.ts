import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BaselineInventoryError, baselineProbeTable, probeBaselines } from "./baseline-probe.ts";
import { safeProviderFailure } from "./operation-failure.ts";

if (process.env.GITHUB_ACTIONS !== "true")
  throw new Error("The live baseline probe runs only in GitHub Actions");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken)
  throw new Error("The baseline probe requires the release's Cloudflare credentials");
const output = ".local/baseline-probe.json";
try {
  const rows = await probeBaselines(accountId, apiToken);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(rows, null, 2) + "\n");
  const table = baselineProbeTable(rows);
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, table + "\n");
  if (rows.some((row) => !row.ok)) process.exitCode = 1;
} catch (error) {
  const failure = safeProviderFailure(error);
  console.error(
    "Baseline probe failed:",
    JSON.stringify(
      error instanceof BaselineInventoryError
        ? { role: error.role, type: "BaselineInventoryError", reason: error.reason }
        : {
            role: "(inventory)",
            type: failure.type,
            reason: failure.reason,
            status: failure.status,
          },
    ),
  );
  process.exitCode = 1;
}
