import type { PoolUsageSummaryInput } from "../../../apps/pool/usage-overview-contract.ts";
import { addUsageDays, usageDay, usageDayStart, usageMonday } from "../usage-calendar.ts";
import { historyObject, invalidHistory, timestamp } from "./record.ts";
import { nanos } from "./series-input.ts";

const day = 86_400_000_000_000n;

export function summaryInput(raw: unknown) {
  const value = historyObject(raw);
  if (
    Object.keys(value).some((key) => !["pool", "from", "to", "by", "authority"].includes(key)) ||
    typeof value.pool !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,511}$/.test(value.pool) ||
    (value.by !== undefined && value.by !== "provider" && value.by !== "model")
  )
    return invalidHistory();
  const from = timestamp(value.from),
    to = timestamp(value.to);
  if (from >= to || nanos(to) - nanos(from) > 400n * day) return invalidHistory();
  const firstDay = usageDay(Date.parse(from));
  const lastDay = usageDay(Date.parse(to));
  const days = Math.max(
    1,
    Math.ceil(
      (Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000,
    ),
  );
  const wholeDays =
    nanos(from) === BigInt(usageDayStart(firstDay)) * 1_000_000n &&
    nanos(to) === BigInt(usageDayStart(lastDay)) * 1_000_000n;
  const previousNanos = wholeDays
    ? BigInt(usageDayStart(addUsageDays(firstDay, -days))) * 1_000_000n
    : 2n * nanos(from) - nanos(to);
  if (previousNanos < 0n) return invalidHistory();
  const previousFrom = `${new Date(Number(previousNanos / 1_000_000_000n) * 1_000).toISOString().slice(0, 19)}.${(previousNanos % 1_000_000_000n).toString().padStart(9, "0")}Z`;
  const trainingFrom = new Date(
    usageDayStart(addUsageDays(usageMonday(lastDay), -84)),
  ).toISOString();
  const monthFrom = new Date(usageDayStart(`${lastDay.slice(0, 7)}-01`)).toISOString();
  const heatmapFrom = new Date(usageDayStart(addUsageDays(lastDay, -56))).toISOString();
  const input: PoolUsageSummaryInput = { from, to, by: value.by ?? "provider" };
  return {
    input,
    pool: value.pool,
    previous: { from: timestamp(previousFrom), to: from },
    readFrom: [
      from,
      timestamp(previousFrom),
      timestamp(trainingFrom),
      timestamp(monthFrom),
    ].sort()[0]!,
    heatmapFrom: timestamp(heatmapFrom),
  };
}
