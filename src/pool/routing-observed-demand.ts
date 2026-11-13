import type { CapacityDemandData, CapacityDemandPoint } from "./capacity/history.ts";
import type { RoutingDemandInput } from "./routing-demand-contract.ts";

const hour = 3_600_000;
const key = (point: {
  provider: string;
  windowSeconds: number;
  mode: string | null;
  unit: { id: string };
}) => JSON.stringify([point.provider, point.windowSeconds, point.mode, point.unit.id]);

/** Recent quota deltas already exclude refills. Request counts cannot supply missing quota units. */
export function observedRoutingDemand(
  data: CapacityDemandData,
  now: number,
  references: ReadonlyMap<string, string>,
): RoutingDemandInput[] {
  if (data.readAt === null || data.readAt > now || now - data.readAt > 6 * 60_000) return [];
  const through = Math.floor(now / hour) * hour;
  const cohorts = new Map<string, CapacityDemandPoint[]>();
  for (const point of data.points) {
    if (point.hour < through - 6 * hour || point.hour >= through) continue;
    const id = key(point);
    cohorts.set(id, [...(cohorts.get(id) ?? []), point]);
  }
  const inputs: RoutingDemandInput[] = [];
  for (const [cohort, points] of cohorts) {
    points.sort((a, b) => a.hour - b.hour);
    const last = points.at(-1)!;
    const recent = points.slice(-6);
    if (
      recent.length < 2 ||
      last.hour !== through - hour ||
      recent.some(
        (point, index) =>
          point.demand === null ||
          !Number.isFinite(point.demand) ||
          point.demand < 0 ||
          point.coverage < 0.9 ||
          point.censored ||
          point.membershipIncomplete ||
          (index > 0 && point.hour !== recent[index - 1]!.hour + hour),
      )
    )
      continue;
    if (data.unclassifiedProviders.includes(last.provider)) continue;
    if (last.windowSeconds !== 604800 && last.windowSeconds !== 18000) continue;
    if (last.mode !== "fixed" && last.mode !== "rolling") continue;
    const readings = data.latestReadings.filter((reading) => key(reading) === cohort);
    if (
      readings.length === 0 ||
      readings.length > 500 ||
      readings.some(
        (reading) =>
          !references.has(reading.account) ||
          !reading.knownWeight ||
          reading.full <= 0 ||
          reading.observedAt > now ||
          reading.staleAt === null ||
          reading.staleAt <= now,
      )
    )
      continue;
    const rate = recent.reduce((sum, point) => sum + point.demand!, 0) / recent.length;
    if (!(rate > 0)) continue;
    // A changed regime invalidates a long extrapolation instead of treating an
    // old rate as a current forecast. The next comparable hours can restore it.
    const latestRate = recent.slice(-2).reduce((sum, point) => sum + point.demand!, 0) / 2;
    if (latestRate < rate / 2 || latestRate > rate * 2) continue;
    const revision = `observed:${last.provider}:${through}`;
    inputs.push({
      revision,
      provider: last.provider,
      modelFamily: null,
      calculatedAt: new Date(now).toISOString(),
      validUntil: new Date(now + 15 * 60_000).toISOString(),
      source: "observed-quota-burn",
      confidence: "low",
      history: {
        from: new Date(recent[0]!.hour).toISOString(),
        through: new Date(through).toISOString(),
        coverageRatio: Math.min(...recent.map((point) => point.coverage)),
        censored: false,
        heldOutPeriods: 0,
        relativeError: null,
      },
      windows: [
        {
          seconds: last.windowSeconds,
          mode: last.mode,
          unit: { ...last.unit, revision: readings[0]!.revision },
          calibration: "quota-observed",
          calibrationRevision: readings[0]!.revision,
          intervals: [
            {
              from: new Date(now).toISOString(),
              to: new Date(now + 7 * 24 * hour).toISOString(),
              demand: { median: rate * 7 * 24, upper80: null },
            },
          ],
          accounts: readings.map((reading) => ({
            account: references.get(reading.account)!,
            full: reading.full,
            known: true,
            plan: reading.plan,
            weightRevision: reading.revision,
          })),
          candidatePlans: [
            ...new Map(
              readings
                .filter((reading) => reading.plan !== null)
                .map((reading) => [
                  reading.plan,
                  {
                    plan: reading.plan!,
                    full: reading.full,
                    weightRevision: reading.revision,
                    resetEverySeconds: last.windowSeconds,
                  },
                ]),
            ).values(),
          ],
        },
      ],
    });
  }
  const grouped = new Map<string, RoutingDemandInput>();
  const conflicting = new Set<string>();
  for (const input of inputs) {
    const old = grouped.get(input.provider);
    if (!old) {
      grouped.set(input.provider, input);
      continue;
    }
    if (old.windows.some((window) => window.seconds === input.windows[0]!.seconds)) {
      conflicting.add(input.provider);
      continue;
    }
    grouped.set(input.provider, {
      ...old,
      windows: [...old.windows, ...input.windows],
      history: {
        ...old.history,
        from: old.history.from > input.history.from ? old.history.from : input.history.from,
        coverageRatio: Math.min(old.history.coverageRatio, input.history.coverageRatio),
      },
    });
  }
  return [...grouped.values()].filter((input) => !conflicting.has(input.provider));
}
