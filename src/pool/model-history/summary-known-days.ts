import type { SeriesCoverage } from "./series-contract.ts";
import type { HomeCaptureCoverage } from "./capture-coverage.ts";
import { historyObject, timestamp } from "./record.ts";
import { addUsageDays, usageDay, usageDayStart } from "../usage-calendar.ts";

function frozenRange(source: SeriesCoverage["sources"][number]) {
  if (source.kind !== "import" || source.backfillComplete !== true || !("completion" in source))
    return;
  try {
    const proof = historyObject(source.completion);
    const from = timestamp(proof.frozenFrom),
      to = timestamp(proof.frozenTo);
    return from <= to ? { from, to } : undefined;
  } catch {
    return;
  }
}

/** Import completion proves its frozen interval; native source reconciliation may cover other days. */
export function summaryKnownDays(
  from: string,
  to: string,
  coverage: SeriesCoverage,
  capture: HomeCaptureCoverage,
) {
  const start = timestamp(from),
    end = timestamp(to);
  const home = coverage.sources.find((source) => source.kind === "home");
  const native = home?.backfillComplete === true && capture.incompleteHours !== null;
  const missing = new Set(
    [...(capture.incompleteHours ?? [])].map((at) => usageDay(Date.parse(at))),
  );
  const imports = coverage.sources.filter((source) => source.kind === "import").map(frozenRange);
  const known = new Set<string>(),
    gaps: string[] = [];
  const today = usageDay(Date.parse(to));
  for (let day = usageDay(Date.parse(from)); day <= today; day = addUsageDays(day, 1)) {
    const lower = [start, timestamp(new Date(usageDayStart(day)).toISOString())].sort().at(-1)!;
    const upper = [
      end,
      timestamp(new Date(usageDayStart(addUsageDays(day, 1))).toISOString()),
    ].sort()[0]!;
    const certified =
      imports.length > 0 &&
      imports.every((range) => range !== undefined && range.from <= lower && range.to >= upper);
    if ((native && !missing.has(day)) || certified) known.add(day);
    else gaps.push(day);
  }
  return { known, gaps };
}
