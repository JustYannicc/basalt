import { fileURLToPath } from "node:url";
import {
  baselineProbeOutput,
  reportBaselineProbe,
} from "../release-barrier/baseline-probe-report.ts";
import type { BaselineProbeRow } from "../release-barrier/baseline-probe.ts";
import { rehearsalJobCandidate } from "../release-barrier/release-stage.ts";
import { probeWorkerSettings } from "../release-barrier/settings-probe.ts";
import { rehearsalReleaseEnvironment } from "./rehearsal-environment.ts";
import { describeError, redactor } from "./redact.ts";

/**
 * Release-main's baseline probe, run by a rehearsal against its own stage: the same
 * `probeWorkerSettings` the backup job runs, with the stage's derived environment. Production's
 * entry stays untouched; this one refuses anything but the rehearsal job on its candidate.
 */
export async function rehearsalBaselineProbe(
  source: NodeJS.ProcessEnv,
  root: string,
): Promise<BaselineProbeRow[]> {
  const refused = (reason: string): BaselineProbeRow[] => [
    { role: "(probe)", ok: false, reason, status: null, bytes: 0, ms: 0, attempts: 0 },
  ];
  if (source.GITHUB_ACTIONS !== "true" || !rehearsalJobCandidate(source, root))
    return refused("untrusted-rehearsal-context");
  const accountId = source.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = source.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return refused("missing-release-credentials");
  try {
    return await probeWorkerSettings(accountId, apiToken, rehearsalReleaseEnvironment(source));
  } catch (error) {
    return refused(describeError(error, redactor(source)).split("\n")[0]!.slice(0, 300));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = await rehearsalBaselineProbe(
    process.env,
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  await reportBaselineProbe(rows, baselineProbeOutput, process.env.GITHUB_STEP_SUMMARY);
  if (rows.some((row) => !row.ok)) process.exitCode = 1;
}
