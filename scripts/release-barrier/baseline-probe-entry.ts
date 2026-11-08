import { BaselineInventoryError, type BaselineProbeRow } from "./baseline-probe.ts";
import { reportBaselineProbe } from "./baseline-probe-report.ts";
import { probeWorkerSettings } from "./settings-probe.ts";
import { deployEnvironment, requiredSecrets } from "../environment.ts";
import { safeProviderFailure } from "./operation-failure.ts";

if (process.env.GITHUB_ACTIONS !== "true")
  throw new Error("The live baseline probe runs only in GitHub Actions");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const output = ".local/baseline-probe.json";
const start = performance.now();
let rows: BaselineProbeRow[];
try {
  if (!accountId || !apiToken)
    throw new BaselineInventoryError([
      {
        role: "(credentials)",
        reason: `missing-release-credentials; ${[!accountId ? "CLOUDFLARE_ACCOUNT_ID" : "", !apiToken ? "CLOUDFLARE_API_TOKEN" : ""].filter(Boolean).join(", ")}`,
      },
    ]);
  rows = await probeWorkerSettings(accountId, apiToken, deployEnvironment());
} catch (error) {
  const failure = safeProviderFailure(error);
  const missing =
    error instanceof Error
      ? /^Missing GitHub Actions secret: ([A-Z_]+)$/.exec(error.message)?.[1]
      : undefined;
  rows = (
    error instanceof BaselineInventoryError
      ? error.refusals
      : [
          {
            role: "(inventory)",
            reason:
              missing && requiredSecrets.some((name) => name === missing)
                ? `missing-release-credentials; ${missing}`
                : (failure.reason ?? "candidate-settings-read-failed"),
          },
        ]
  ).map((item) => ({
    ...item,
    ok: false,
    type: error instanceof BaselineInventoryError ? "BaselineInventoryError" : failure.type,
    status: failure.status ?? null,
    bytes: 0,
    ms: Math.round(performance.now() - start),
    attempts: 0,
  }));
}
await reportBaselineProbe(rows, output, process.env.GITHUB_STEP_SUMMARY);
if (rows.some((row) => !row.ok)) process.exitCode = 1;
