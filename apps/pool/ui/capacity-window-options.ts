import type { CapacityLine } from "./capacity-model.ts";

export function capacityWindowOptions(windowLines: readonly CapacityLine[]) {
  return windowLines.map((entry) => ({
    id: entry.key,
    label: windowLines.some((other) => other.key !== entry.key && other.label === entry.label)
      ? `${entry.label} (${entry.unit.id})`
      : entry.label,
  }));
}
