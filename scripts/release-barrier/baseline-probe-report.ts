import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { baselineProbeTable, type BaselineProbeRow } from "./baseline-probe.ts";

export async function reportBaselineProbe(
  rows: readonly BaselineProbeRow[],
  output: string,
  summary: string | undefined,
  log: Pick<Console, "log" | "error"> = console,
) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(rows, null, 2) + "\n");
  const table = baselineProbeTable(rows);
  log.log(table);
  if (summary) await appendFile(summary, table + "\n");
  for (const row of rows.filter((row) => !row.ok))
    log.error(
      `::error::Baseline ${row.role}: ${row.type ?? "unknown"}; ${row.reason ?? "read-failed"}; HTTP ${row.status ?? "none"}; ${row.bytes} bytes; ${row.ms} ms; ${row.attempts} attempts`,
    );
}
