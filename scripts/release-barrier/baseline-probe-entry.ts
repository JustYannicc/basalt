import { BaselineInventoryError, type BaselineProbeRow } from "./baseline-probe.ts";
import { reportBaselineProbe } from "./baseline-probe-report.ts";
import { probeWorkerSettings } from "./settings-probe.ts";
import { deployEnvironment } from "../environment.ts";
import { safeProviderFailure } from "./operation-failure.ts";
import {
  CandidateSettingsReadFailure,
  candidateReadFailure,
  candidateFailureDetails,
} from "./candidate-failure.ts";

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
  let environment;
  try {
    environment = deployEnvironment();
  } catch (error) {
    throw candidateReadFailure(error, "environment");
  }
  rows = await probeWorkerSettings(accountId, apiToken, environment);
} catch (error) {
  const failure = safeProviderFailure(error);
  const candidate =
    error instanceof CandidateSettingsReadFailure
      ? error
      : failure.type === "Error" || failure.type === "unknown"
        ? candidateReadFailure(error, "inventory")
        : undefined;
  rows = (
    error instanceof BaselineInventoryError
      ? error.refusals
      : [
          {
            role: "(inventory)",
            reason: candidate?.message ?? failure.reason ?? "inventory-read-failed",
          },
        ]
  ).map((item) => ({
    ...item,
    ok: false,
    type:
      error instanceof BaselineInventoryError
        ? "BaselineInventoryError"
        : (candidate?._tag ?? failure.type),
    ...(candidate ? { candidateFailure: candidateFailureDetails(candidate) } : {}),
    status: failure.status ?? null,
    bytes: 0,
    ms: Math.round(performance.now() - start),
    attempts: 0,
  }));
}
await reportBaselineProbe(rows, output, process.env.GITHUB_STEP_SUMMARY);
if (rows.some((row) => !row.ok)) process.exitCode = 1;
