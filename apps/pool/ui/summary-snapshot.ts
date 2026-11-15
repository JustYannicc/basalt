import type { ChangeReceipt } from "apps/client";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { PoolUsageSummaryResult } from "../usage-overview-contract.ts";

export const topics = ["accounts", "apps", "membership", "session", "pool-usage", "pool-prices"];
export const capacityTopics = [...topics, "pool-readings", "pool-samples"];
export const versionOf = (receipt: ChangeReceipt) =>
  receipt.revisions
    .filter((hint) => topics.includes(hint.topic))
    .map((hint) => `${hint.topic}:${hint.resource}=${hint.revision}`)
    .sort()
    .join("\n");
/** Hourly requests ride along with the summary; an hour Home fully captured but empty is a zero. */
export function withRequests(capacity: PoolCapacityHistory, summary: PoolUsageSummaryResult) {
  const complete = new Set(summary.homeCapture.completeHours.map((at) => Date.parse(at)));
  const captured = summary.homeCapture.capturedAt
    ? Date.parse(summary.homeCapture.capturedAt)
    : null;
  const hourly = new Map(
    summary.requestsByHour.map((point) => [`${point.provider} ${Date.parse(point.at)}`, point]),
  );
  return {
    ...capacity,
    points: capacity.points.map((point) => {
      const read = hourly.get(`${point.provider} ${point.hour}`);
      const whole = complete.has(point.hour);
      return {
        ...point,
        requests: read?.requests ?? (whole ? 0 : null),
        coverage: read?.coverage ?? (whole ? 1 : null),
        sourceAt: read !== undefined || whole ? captured : null,
      };
    }),
  };
}
