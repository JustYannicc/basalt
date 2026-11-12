export const dispatchTimingHeader = "X-Signalbox-Pool-Dispatch-Timing";

const stages = new Set(["authenticate", "selection", "admission", "reply_write", "ping", "rpop"]);
const outcomes = new Set(["ok", "error", "timeout", "cancelled"]);

/** Container diagnostics cross a trust boundary; only closed timing records reach Worker logs. */
export function logDispatchTiming(value: string | null): void {
  if (value === null || value.length > 2048) return;
  let metrics: unknown;
  try {
    metrics = JSON.parse(value);
  } catch {
    return;
  }
  if (!Array.isArray(metrics) || metrics.length > 6) return;
  const seen = new Set<string>();
  const records: { stage: string; duration_ms: number; outcome: string }[] = [];
  for (const metric of metrics) {
    if (typeof metric !== "object" || metric === null || Array.isArray(metric)) return;
    if (Object.keys(metric).sort().join(",") !== "duration_ms,outcome,stage") return;
    const { stage, duration_ms, outcome } = metric;
    if (typeof stage !== "string" || !stages.has(stage) || seen.has(stage)) return;
    if (typeof outcome !== "string" || !outcomes.has(outcome)) return;
    if (!Number.isInteger(duration_ms) || duration_ms < 0 || duration_ms > 86_400_000) return;
    seen.add(stage);
    records.push({ stage, duration_ms, outcome });
  }
  for (const record of records) console.info("POOL_DISPATCH_TIMING", record);
}
