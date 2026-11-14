import type { UsageForecast } from "../usage-forecast-contract.ts";
import type { Metric } from "./summary-model.ts";
import { formatDay, plural } from "./summary-format.ts";

const unknown: Record<Metric, string> = {
  cost: "unknown cost",
  tokens: "unknown tokens",
  requests: "unknown request totals",
};

export function forecastUnavailableText(
  forecast: Extract<UsageForecast, { status: "unavailable" }>,
  metric: Metric,
) {
  if (forecast.reason === "invalid-input") return "This range can't be forecast.";
  if (forecast.reason === "insufficient-use") return "Too little use to forecast.";
  const gaps = forecast.historyGaps?.map((gap) => {
    const reasons = [
      gap.missingDays.length > 0 &&
        plural(gap.missingDays.length, "day with no records", "days with no records"),
      gap.unknownDays.length > 0 &&
        `${plural(gap.unknownDays.length, "day", "days")} with ${unknown[metric]}`,
    ].filter(Boolean);
    return `Week of ${formatDay(gap.week)} has ${reasons.join(" and ")}.`;
  });
  return ["No forecast yet. It needs the last 4 full weeks in a row.", ...(gaps ?? [])].join(" ");
}
