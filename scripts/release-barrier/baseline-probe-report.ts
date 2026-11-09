import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { baselineProbeTable, type BaselineProbeRow } from "./baseline-probe.ts";
import type { SettingsProbeRow } from "./settings-probe.ts";
import { reportRefusal } from "./refusal-report.ts";

export async function reportBaselineProbe(
  rows: readonly (BaselineProbeRow | SettingsProbeRow)[],
  output: string,
  summary: string | undefined,
  log: Pick<Console, "log" | "error"> = console,
) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(rows, null, 2) + "\n");
  const settings = rows.filter((row): row is SettingsProbeRow => "settings" in row);
  const table =
    baselineProbeTable(rows) +
    (settings.length
      ? "\n\n" +
        [
          "| Worker | Settings HTTP | Settings bytes | Settings ms | Settings attempts | Version HTTP | Version bytes | Version ms | Version attempts | Compared fields | Differences |",
          "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |",
          ...settings.map(
            (row) =>
              `| ${row.role} | ${row.settings.status ?? ""} | ${row.settings.bytes} | ${row.settings.ms} | ${row.settings.attempts} | ${row.placements.status ?? ""} | ${row.placements.bytes} | ${row.placements.ms} | ${row.placements.attempts} | ${row.compared.join(", ")} | ${row.pendingPlacementRepair ? `pending-placement-repair: {} → targeted39/aws:eu-central-1${row.pendingPlacementRepair.limits ? "; limits.subrequests: null → 50000" : ""}` : row.differences.length} |`,
          ),
        ].join("\n")
      : "");
  const inputs = settings.flatMap((row) =>
    row.preparation?.containerInput ? [{ role: row.role, ...row.preparation.containerInput }] : [],
  );
  const pairing = inputs.length
    ? "\n\n| Worker | Container baseline input | Latest-upload settings input | Serving input | Serving version prefixes | Latest version prefix | Latest version input | Settings match latest |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n" +
      inputs
        .map(
          (input) =>
            `| ${input.role} | ${input.baseline} | ${input.settings} | ${input.serving} | ${input.versions.join(", ")} | ${input.latestVersion} | ${input.latestInput} | ${input.settingsMatchLatest} |`,
        )
        .join("\n")
    : "";
  log.log(table + pairing);
  if (summary) await appendFile(summary, table + pairing + "\n");
  for (const row of rows.filter((row) => !row.ok))
    log.error(
      `::error::Baseline ${row.role}: ${row.type ?? "unknown"}; ${row.reason ?? "read-failed"}; HTTP ${row.status ?? "none"}; ${row.bytes} bytes; ${row.ms} ms; ${row.attempts} attempts`,
    );
  for (const row of settings.filter((row) => !row.ok && row.differences.length))
    await reportRefusal(
      {
        reason: row.reason ?? "script-settings-drift",
        worker: row.role,
        delta: { fqn: row.role, type: "Cloudflare.Worker", changed: [...row.differences] },
      },
      summary,
      (message) => log.error(message),
    );
}
