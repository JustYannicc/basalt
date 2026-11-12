import type { Json } from "./json.ts";

const unitSeconds = new Map([
  ["second", 1],
  ["minute", 60],
  ["hour", 3_600],
  ["day", 86_400],
  ["week", 604_800],
]);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Home reports some durations as unit/value only. Calendar months have no fixed duration. */
export function quotaWindowSeconds(window: Readonly<Json>): number | null {
  if (window.window_seconds !== null && window.window_seconds !== undefined)
    return positive(window.window_seconds) ? window.window_seconds : null;
  const scale =
    typeof window.period_unit === "string" ? unitSeconds.get(window.period_unit) : undefined;
  if (scale === undefined || !positive(window.period_value)) return null;
  const seconds = scale * window.period_value;
  return positive(seconds) ? seconds : null;
}
