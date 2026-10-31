export interface ExpectedScan {
  name: string;
  maximumAgeMinutes: number;
}
export interface ScanRun {
  workflow: string;
  at: number;
  status: string;
  outcome?: string;
  delivery?: string;
}
export interface DeliveryState {
  status: string;
  at: number;
}
const deliveryFailed = (status: string | undefined) =>
  status === "uncertain" ||
  status === "refused" ||
  status === "delivery-uncertain" ||
  status === "delivery-refused";

/** A human wait is valid. The separately scheduled scans must still keep running. */
export function workflowHealthCondition(
  now: number,
  configuredAt: number,
  expected: readonly ExpectedScan[],
  runs: readonly ScanRun[],
  deliveries: readonly DeliveryState[],
): "healthy" | "action" | "unknown" {
  if (
    deliveries.some(
      (value) =>
        deliveryFailed(value.status) ||
        (["claimed", "submitted"].includes(value.status) && now - value.at > 60000),
    )
  )
    return "action";
  if (!expected.length || configuredAt <= 0 || configuredAt > now) return "unknown";
  let unknown = false;
  for (const scan of expected) {
    const maximumAge = scan.maximumAgeMinutes * 60000;
    if (
      !scan.name ||
      !Number.isFinite(maximumAge) ||
      maximumAge < 60000 ||
      maximumAge > 7 * 86400000
    )
      return "unknown";
    const history = runs.filter(
      (run) => run.workflow === scan.name && run.at >= configuredAt && run.at <= now,
    );
    const latest = history
      .filter((run) => ["complete", "errored"].includes(run.status))
      .sort((a, b) => b.at - a.at)[0];
    if (
      latest?.status === "errored" ||
      deliveryFailed(latest?.outcome) ||
      deliveryFailed(latest?.delivery)
    )
      return "action";
    const successful = history.filter(
      (run) =>
        run.status === "complete" &&
        run.outcome !== undefined &&
        !["unknown", "unconfigured", "configuration-changed"].includes(run.outcome) &&
        !deliveryFailed(run.outcome) &&
        !deliveryFailed(run.delivery),
    );
    const lastSuccess = Math.max(configuredAt, ...successful.map((run) => run.at));
    if (now - lastSuccess > maximumAge) return "action";
    if (!successful.length) unknown = true;
  }
  return unknown ? "unknown" : "healthy";
}
