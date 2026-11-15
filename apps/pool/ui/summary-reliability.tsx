import type { PoolUsageSummaryResult } from "../usage-overview-contract.ts";
import { reliabilityNotificationMinimumRequests } from "../reliability-contract.ts";
import { formatCount, plural } from "./summary-format.ts";

/** Recorded reliability stays inspectable even when the notification sample is too small. */
export function SummaryReliability({ summary }: { summary: PoolUsageSummaryResult }) {
  const reliability = summary.reliability;
  if (!reliability)
    return <p className="mb-4 text-xs text-muted-foreground">Real-request success unavailable</p>;
  return (
    <section
      aria-label="Real-request success"
      className="mb-4 grid gap-1 text-xs text-muted-foreground"
    >
      <span className="font-medium">Recorded real-request success</span>
      {(["hour", "day"] as const).map((key) => {
        const counts = reliability[key].real;
        return (
          <p key={key}>
            {key === "hour" ? "Last hour" : "Last 24 hours"}:{" "}
            {counts.successRate === null ? "No requests" : `${counts.successRate.toFixed(2)}%`}
            {` · ${formatCount(counts.failed)} failed / ${plural(counts.requests, "request", "requests")}`}
            {counts.requests > 0 && counts.requests < reliabilityNotificationMinimumRequests
              ? ` · Low sample: fewer than ${reliabilityNotificationMinimumRequests} real requests`
              : ""}
          </p>
        );
      })}
    </section>
  );
}
