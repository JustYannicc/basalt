export interface ExpectedScan {
  name: string;
  maximumAgeMinutes: number;
}
export interface ScanHealth {
  workflow: string;
  checkedAt: number;
  successfulAt: number;
  known: number;
}
export interface DeliveryState {
  status: string;
  at: number;
}
const deliveryFailed = (status: string) => status === "uncertain" || status === "refused";

/** Human waits do not prevent subsequent scans from refreshing these timestamps. */
export function workflowHealthCondition(
  now: number,
  configuredAt: number,
  expected: readonly ExpectedScan[],
  scans: readonly ScanHealth[],
  deliveries: readonly DeliveryState[],
  complete = true,
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
  let unknown = !complete;
  for (const scan of expected) {
    const maximumAge = scan.maximumAgeMinutes * 60000;
    if (
      !scan.name ||
      !Number.isFinite(maximumAge) ||
      maximumAge < 60000 ||
      maximumAge > 7 * 86400000
    )
      return "unknown";
    const current = scans.find((value) => value.workflow === scan.name);
    const successfulAt = Math.max(configuredAt, current?.successfulAt ?? 0);
    if (successfulAt > now || (current?.checkedAt ?? 0) > now) return "unknown";
    if (now - successfulAt > maximumAge) return "action";
    if (!current || current.successfulAt < configuredAt || current.known !== 1) unknown = true;
  }
  return unknown ? "unknown" : "healthy";
}
