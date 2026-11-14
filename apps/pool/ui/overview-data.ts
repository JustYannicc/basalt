import type { PoolUsageSeriesResult } from "../usage-series-contract.ts";
import type { Result } from "../index.ts";
import type { SeriesQuery, SeriesRead } from "./series-model.ts";

export type RangeDays = 7 | 30 | 90;

/** The same UTC hour boundary and end instant drive every answer in one refresh. */
export function seriesRange(
  days: RangeDays,
  now: number,
): Pick<SeriesQuery, "from" | "to" | "bucket"> {
  return {
    from: new Date(Math.floor((now - days * 86_400_000) / 3_600_000) * 3_600_000).toISOString(),
    to: new Date(now).toISOString(),
    bucket: "day",
  };
}

export const managersOnly = (result: Result<unknown> | undefined) =>
  result !== undefined &&
  !result.ok &&
  result.error === "unauthorized" &&
  /managers only/i.test(result.message);

export function seriesRead(result: PoolUsageSeriesResult): SeriesRead {
  return {
    groups: result.groups,
    coverage: result.coverage,
    asOf: result.asOf,
    asOfChanged: false,
    truncated: result.next !== null,
  };
}
