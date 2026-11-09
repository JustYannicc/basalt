import type {
  CapacityForecast as PublicForecast,
  CapacityRefillEvent,
  CapacityShortfallStretch as PublicStretch,
  PoolCapacityHistory,
} from "../../../apps/pool/capacity-contract.ts";
import {
  forecastCapacity,
  MIN_PATTERN_WEEKS,
  type CapacityForecast as CoreForecast,
  type ForecastAccount,
} from "./forecast.ts";
import { CapacityHistory, type CapacityDemandData, type CapacityDemandPoint } from "./history.ts";
import type { CapacityReading } from "./normalize.ts";

const hourMs = 3_600_000;
const weekMs = 7 * 24 * hourMs;
const maxAccountReadingAge = 15 * 60_000;
const groupId = (provider: string, windowSeconds: number, mode: string | null, unitId: string) =>
  JSON.stringify([provider, windowSeconds, mode, unitId]);
const weekStart = (at: number) => {
  const date = new Date(at);
  return (
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
    ((date.getUTCDay() + 6) % 7) * 86_400_000
  );
};
const completedWeeksAt = (since: number | null, at: number) =>
  since === null
    ? 0
    : Math.max(
        0,
        Math.floor(
          (weekStart(at) - weekStart(since) - (since > weekStart(since) ? 7 * 86_400_000 : 0)) /
            weekMs,
        ),
      );
const reasonText: Record<string, string> = {
  "insufficient-history": "Forecasts start after two completed weeks of comparable readings.",
  "history-gap": "Some hours have too little comparable coverage to train the forecast.",
  "partial-account-coverage": "Some account readings are missing from the demand history.",
  "partial-exposure-estimate":
    "Small missing sample intervals are estimated from the observed exposure in the same hour.",
  "incomplete-current-week": "The current week is still in progress.",
  "missing-account-reading": "A current account balance is missing or older than 15 minutes.",
  "unknown-account-weight": "An account has no verified weight in this unit.",
  "missing-reset-time": "A usable account has no observed reset time.",
  "unhealthy-account": "An account cannot currently serve requests.",
  "backtest-insufficient": "There are not enough held-out weeks to check the forecast yet.",
  "backtest-not-better": "The seasonal forecast did not beat the previous-week baseline.",
  "censored-demand": "Demand reached an account limit, so observed use understates demand.",
  "candidate-weight-unavailable": "No verified plan weight is available for an account count.",
  "invalid-input": "The forecast inputs do not form a comparable cohort.",
  "rolling-expiry-history-unavailable":
    "The rolling five-hour expiry history is incomplete, so this window has no projection.",
  "five-hour-mode-unknown":
    "The provider did not identify this five-hour window as fixed or rolling.",
  "weekly-capacity-forecast-unavailable":
    "The weekly forecast needed to gate five-hour allowance is unavailable.",
  "unobserved-account-window": "An active account has no observed quota-window inventory.",
  "sticky-routing-unavailable":
    "Historical account traffic shares are not available for this cohort.",
};

function matches(
  point: CapacityDemandPoint,
  provider: string,
  windowSeconds: number,
  mode: string | null,
  unitId: string,
): boolean {
  return (
    point.provider === provider &&
    point.windowSeconds === windowSeconds &&
    point.mode === mode &&
    point.unit.id === unitId
  );
}

function readMatches(
  reading: CapacityReading,
  provider: string,
  windowSeconds: number,
  mode: string | null,
  unitId: string,
): boolean {
  return (
    reading.provider === provider &&
    reading.windowSeconds === windowSeconds &&
    reading.mode === mode &&
    reading.unit.id === unitId
  );
}

function accountSlots(data: CapacityDemandData, provider: string): ReadonlyMap<string, number> {
  return new Map(
    [
      ...new Set(
        data.latestReadings
          .filter((reading) => reading.provider === provider)
          .map((reading) => reading.account),
      ),
    ]
      .sort()
      .map((account, index) => [account, index]),
  );
}

function candidateFor(accounts: readonly CapacityReading[]) {
  const reading = accounts.find((item) => item.knownWeight);
  if (!reading) return null;
  return {
    label:
      reading.plan ??
      (reading.source === "reported-absolute" ? "Reported limit" : "Reference plan"),
    capacity: reading.full,
    source:
      reading.source === "reported-absolute" ||
      reading.source === "published-session-multiplier" ||
      reading.source === "published-weekly-multiplier"
        ? ("reported" as const)
        : reading.source === "reference-plan"
          ? ("unit" as const)
          : ("table" as const),
  };
}

function accountInputs(
  data: CapacityDemandData,
  provider: string,
  windowSeconds: number,
  mode: string | null,
  unitId: string,
  now: number,
  weeklyTimelines: ReadonlyMap<string, readonly { at: number; usable: boolean }[]> = new Map(),
): ForecastAccount[] {
  const slots = accountSlots(data, provider);
  const stateById = new Map(
    data.accountStates
      .filter((state) => state.provider === provider && state.windowSeconds === windowSeconds)
      .map((state) => [state.account, state]),
  );
  const weekly = new Map(
    data.latestReadings
      .filter((reading) => reading.provider === provider && reading.windowSeconds === 604_800)
      .map((reading) => [reading.account, reading]),
  );
  const totals = new Map<string, number>();
  const cohort = groupId(provider, windowSeconds, mode, unitId);
  for (const [account, demand] of Object.entries(data.accountDemandTotals[cohort] ?? {}))
    totals.set(account, demand);
  const readings = data.latestReadings.filter((reading) =>
    readMatches(reading, provider, windowSeconds, mode, unitId),
  );
  const totalDemand = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const inputs: ForecastAccount[] = readings.map((reading) => {
    const state = stateById.get(reading.account);
    const recent = now - reading.observedAt <= maxAccountReadingAge && now >= reading.observedAt;
    const weeklyReading = weekly.get(reading.account);
    const chain = data.rollingComplete[cohort]?.[reading.account];
    const rollingHistoryComplete =
      windowSeconds !== 18_000 ||
      (chain?.complete === true && now - chain.at <= maxAccountReadingAge);
    const rollingUse = rollingHistoryComplete
      ? (data.rollingUse[cohort]?.[reading.account] ?? []).filter(
          (use) => use.at > reading.observedAt - 18_000_000 && use.at <= reading.observedAt,
        )
      : [];
    const weeklyTimeline = weeklyTimelines.get(reading.account);
    const rollingMode = mode?.toLowerCase().includes("rolling") ?? false;
    return {
      id: reading.account,
      slot: slots.get(reading.account),
      label: reading.plan ?? "Unknown plan",
      capacity: reading.full,
      knownWeight: reading.knownWeight,
      remaining: recent ? reading.remaining : null,
      resetAt: reading.resetAt,
      windowSeconds,
      usable: recent && state?.usable === true,
      share: totalDemand > 0 ? (totals.get(reading.account) ?? 0) / totalDemand : 0,
      shareKnown: totalDemand > 0,
      ...(rollingMode
        ? { rollingUse, rollingHistoryComplete: windowSeconds === 18_000 && rollingHistoryComplete }
        : {}),
      ...(windowSeconds === 18_000
        ? {
            weeklyUsable:
              weeklyTimeline ??
              (weeklyReading ? [{ at: now, usable: weeklyReading.remaining > 0 }] : []),
            weeklyUsabilityComplete: weeklyTimeline !== undefined && weeklyReading !== undefined,
          }
        : {}),
    };
  });
  const unmapped = data.accountStates.filter(
    (state) =>
      state.provider === provider &&
      state.windowSeconds === windowSeconds &&
      !data.latestReadings.some(
        (reading) =>
          reading.account === state.account &&
          reading.provider === provider &&
          reading.windowSeconds === windowSeconds,
      ),
  );
  for (const [index] of unmapped.entries())
    inputs.push({
      id: `unmapped-account-${index}`,
      slot: slots.size + index,
      label: "Unobserved account",
      capacity: 1,
      knownWeight: false,
      remaining: null,
      resetAt: null,
      windowSeconds,
      usable: false,
      share: 0,
    });
  if (data.unclassifiedProviders.includes(provider))
    inputs.push({
      id: "unobserved-window-inventory",
      slot: slots.size + unmapped.length,
      label: "Unobserved account window",
      capacity: 1,
      knownWeight: false,
      remaining: null,
      resetAt: null,
      windowSeconds,
      usable: false,
      share: 0,
      windowKnown: false,
    });
  return inputs;
}

function normalizedDemand(
  data: CapacityDemandData,
  provider: string,
  windowSeconds: number,
  mode: string | null,
  unitId: string,
  now: number,
) {
  const from = Math.max(
    Math.ceil((now - 12 * weekMs) / hourMs) * hourMs,
    data.trackingSince === null
      ? Math.floor(now / hourMs) * hourMs - hourMs
      : Math.floor(data.trackingSince / hourMs) * hourMs,
  );
  const byHour = new Map(
    data.points
      .filter((point) => matches(point, provider, windowSeconds, mode, unitId))
      .map((point) => [point.hour, point]),
  );
  const through = Math.floor(now / hourMs) * hourMs;
  const demand = [];
  for (let at = from; at < through; at += hourMs) {
    const point = byHour.get(at);
    const coverage = point?.coverage ?? 0;
    demand.push({
      at,
      demand: point && point.demand !== null && coverage >= 0.9 ? point.demand / coverage : null,
      coverage,
      censored: point?.censored ?? false,
    });
  }
  return { from, demand };
}

function shortfall(
  core: CoreForecast,
  busy: boolean,
  candidate: ReturnType<typeof candidateFor>,
  exclusions: readonly string[],
): PublicForecast["ordinary"] {
  const projection = core.projection;
  if (!projection) return null;
  const source = busy ? core.busyShortfalls : projection.shortfalls;
  const stretches = source.map((stretch): PublicStretch => ({
    from: stretch.from,
    to: stretch.to,
    depth: core.windowSeconds === 18_000 ? (stretch.worstHour ?? stretch.amount) : stretch.amount,
  }));
  const amount =
    core.windowSeconds === 18_000
      ? Math.max(0, ...stretches.map((stretch) => stretch.depth))
      : stretches.reduce((total, stretch) => total + stretch.depth, 0);
  const count = core.accountAdvice
    ? busy
      ? (core.accountAdvice.busyAccounts ?? core.accountAdvice.additionalAccounts)
      : core.accountAdvice.additionalAccounts
    : null;
  return {
    amount,
    stretches,
    candidate,
    accounts: count,
    exclusions,
    accountBasis: core.accountAdvice?.basis ?? null,
  };
}

export function publicForecastStatus(
  core: Pick<CoreForecast, "estimate" | "projection" | "reasons">,
): PublicForecast["status"] {
  return core.estimate === null
    ? "learning"
    : core.reasons.includes("missing-account-reading") || core.projection === null
      ? "unavailable"
      : "estimated";
}

function publicForecast(
  core: CoreForecast,
  data: CapacityDemandData,
  candidate: ReturnType<typeof candidateFor>,
): PublicForecast {
  const status = publicForecastStatus(core);
  const bankedStates = new Map(
    data.accountStates
      .filter((state) => state.provider === core.provider && state.windowSeconds === 604_800)
      .map((state) => [state.account, state.bankedAvailable]),
  );
  const bankedAvailable =
    bankedStates.size && [...bankedStates.values()].every((count) => count !== null)
      ? [...bankedStates.values()].reduce<number>((total, count) => total + (count ?? 0), 0)
      : null;
  const points =
    core.projection?.points.map((point) => ({
      at: point.at,
      median: point.balance,
      low: point.low ?? point.balance,
      high: point.high ?? point.balance,
      busy: point.busy ?? point.balance,
      ...(point.usable === undefined ? {} : { usable: point.usable }),
    })) ?? [];
  const exclusions = [
    ...new Set(
      data.latestReadings
        .filter(
          (reading) =>
            reading.provider === core.provider &&
            reading.windowSeconds === core.windowSeconds &&
            reading.mode === core.mode &&
            reading.unit.id === core.unit.id &&
            !reading.knownWeight,
        )
        .map((reading) => reading.plan ?? "Unknown plan"),
    ),
  ];
  const reasons = core.reasons.map((reason) => reasonText[reason] ?? reason);
  if (
    core.windowSeconds === 18_000 &&
    core.mode?.toLowerCase().includes("rolling") &&
    status === "estimated"
  )
    reasons.push(
      "Rolling expiry timing is estimated at source observation samples, not exact request times.",
    );
  return {
    provider: core.provider,
    windowSeconds: core.windowSeconds,
    mode: core.mode,
    unit: core.unit,
    status,
    reasons,
    history: {
      expectedHours: core.history.expectedHours,
      observedHours: core.history.observedHours,
      coverage: core.history.coverage,
      completedWeeks: core.history.completeWeeks,
    },
    backtest: core.backtest,
    residualCalibration: core.estimate
      ? {
          heldOutWeeks: core.estimate.residualBand.heldOutWeeks,
          residualHours: core.estimate.residualBand.residualHours,
        }
      : null,
    classification: core.estimate?.classification ?? null,
    streak: core.estimate?.streak ?? 0,
    recurringPeak: core.estimate?.recurringPeak ?? null,
    points,
    runsOutAt: core.projection?.runsOutAt ?? null,
    busyRunsOutAt: core.busyRunsOutAt,
    ordinary: shortfall(core, false, candidate, exclusions),
    busy: shortfall(core, true, candidate, exclusions),
    bankedAvailable,
  };
}

function forecastGroup(
  data: CapacityDemandData,
  provider: string,
  windowSeconds: number,
  mode: string | null,
  unitId: string,
  unit: { id: string; label: string },
  now: number,
  weeklyTimelines: ReadonlyMap<string, readonly { at: number; usable: boolean }[]> = new Map(),
) {
  const { from, demand } = normalizedDemand(data, provider, windowSeconds, mode, unitId, now);
  const accounts = accountInputs(data, provider, windowSeconds, mode, unitId, now, weeklyTimelines);
  const candidate = candidateFor(
    data.latestReadings.filter((reading) =>
      readMatches(reading, provider, windowSeconds, mode, unitId),
    ),
  );
  const core = forecastCapacity({
    provider,
    mode,
    unit,
    windowSeconds,
    historyFrom: from,
    now,
    demand,
    accounts,
    candidateAccount: candidate,
  });
  return { forecast: publicForecast(core, data, candidate), core };
}

function weeklyUsability(
  data: CapacityDemandData,
  weekly: readonly CoreForecast[],
  provider: string,
  now: number,
) {
  const result = new Map<string, { at: number; usable: boolean }[]>();
  const slots = accountSlots(data, provider);
  const readings = data.latestReadings.filter(
    (reading) => reading.provider === provider && reading.windowSeconds === 604_800,
  );
  for (const reading of readings) {
    const slot = slots.get(reading.account);
    const cohorts = readings.filter((entry) => entry.account === reading.account);
    const timelines = cohorts.map((entry) => {
      const candidate = weekly.find(
        (item) =>
          item.provider === entry.provider &&
          item.windowSeconds === entry.windowSeconds &&
          item.mode === entry.mode &&
          item.unit.id === entry.unit.id,
      );
      return (
        candidate?.projection?.accountBalances.filter((point) => point.accountIndex === slot) ?? []
      );
    });
    if (timelines.length === 0 || timelines.some((entries) => entries.length === 0)) continue;
    const times = [
      ...new Set(timelines.flatMap((entries) => entries.map((entry) => entry.at))),
    ].sort((a, b) => a - b);
    const entries: { at: number; usable: boolean }[] = [
      {
        at: now,
        usable: readings
          .filter((entry) => entry.account === reading.account)
          .every((entry) => entry.remaining > 0),
      },
    ];
    for (const at of times) {
      const usable = timelines.every((timeline) => {
        const latest = timeline.filter((entry) => entry.at <= at).at(-1);
        return latest !== undefined && latest.remaining > 0;
      });
      entries.push({ at, usable });
    }
    result.set(
      reading.account,
      entries.sort((a, b) => a.at - b.at),
    );
  }
  return result;
}

/** Build one bounded usage/capacity snapshot with demand histories independent of the visible range. */
export async function capacityOverview(
  history: CapacityHistory,
  pool: string,
  from: number,
  to: number,
): Promise<PoolCapacityHistory> {
  const now = to;
  const demandFrom = Math.floor((now - 12 * weekMs) / hourMs) * hourMs;
  // CapacityHistory enqueues both calls synchronously on one UsageQueue, so an observe cannot split this read.
  const [points, loaded] = await Promise.all([
    history.read(pool, { from, to }),
    history.demandData(pool, demandFrom),
  ]);
  const data: CapacityDemandData =
    loaded.readAt !== null && loaded.readAt > to
      ? {
          ...loaded,
          latestReadings: [],
          accountStates: [],
          points: loaded.points.filter((point) => point.sourceAt.to <= to),
        }
      : loaded;
  const groups = new Map<
    string,
    {
      provider: string;
      windowSeconds: number;
      mode: string | null;
      unit: { id: string; label: string };
    }
  >();
  for (const entry of [...data.latestReadings, ...points]) {
    const key = groupId(
      entry.provider,
      entry.windowSeconds,
      "mode" in entry ? entry.mode : null,
      entry.unit.id,
    );
    if (!groups.has(key))
      groups.set(key, {
        provider: entry.provider,
        windowSeconds: entry.windowSeconds,
        mode: "mode" in entry ? entry.mode : null,
        unit: entry.unit,
      });
  }
  const orderedGroups = [...groups.values()].sort(
    (a, b) => b.windowSeconds - a.windowSeconds || a.provider.localeCompare(b.provider),
  );
  const built: ReturnType<typeof forecastGroup>[] = [];
  for (const group of orderedGroups) {
    const weekly = built
      .filter(
        (entry) =>
          entry.forecast.provider === group.provider && entry.forecast.windowSeconds === 604_800,
      )
      .map((entry) => entry.core);
    const usable =
      group.windowSeconds === 18_000
        ? weeklyUsability(data, weekly, group.provider, now)
        : new Map();
    built.push(
      forecastGroup(
        data,
        group.provider,
        group.windowSeconds,
        group.mode,
        group.unit.id,
        group.unit,
        now,
        usable,
      ),
    );
  }
  const forecasts = built.map((entry) => entry.forecast);
  const observed: CapacityRefillEvent[] = data.refills
    .filter((event) => event.at >= from - 12 * weekMs && event.at <= to)
    .map((event) => ({
      provider: event.provider,
      windowSeconds: event.windowSeconds,
      mode: event.mode,
      unitId: event.unitId,
      at: event.at,
      amount: event.amount,
      amountIsLowerBound: event.amountIsLowerBound,
      kind: event.kind,
    }));
  const expected = built.flatMap(
    ({ forecast, core }) =>
      core.projection?.refills.map((event): CapacityRefillEvent => ({
        provider: forecast.provider,
        windowSeconds: forecast.windowSeconds,
        mode: forecast.mode,
        unitId: forecast.unit.id,
        at: event.at,
        amount: event.amount,
        amountIsLowerBound: false,
        kind: "expected",
      })) ?? [],
  );
  const coverage = forecasts.length
    ? Math.min(...forecasts.map((forecast) => forecast.history.completedWeeks))
    : data.completedWeeks;
  const allEstimated =
    forecasts.length > 0 && forecasts.every((forecast) => forecast.status === "estimated");
  const anyEstimated = forecasts.some((forecast) => forecast.status === "estimated");
  const anyUnavailable = forecasts.some((forecast) => forecast.status === "unavailable");
  const reason =
    coverage < MIN_PATTERN_WEEKS
      ? "Forecasts start after two completed weeks; account advice after four."
      : (forecasts.flatMap((forecast) => forecast.reasons)[0] ??
        "No comparable capacity cohorts are available.");
  return {
    from,
    to,
    readAt: data.readAt !== null && data.readAt > to ? null : data.readAt,
    trackingSince: data.trackingSince,
    completedWeeks:
      data.readAt !== null && data.readAt > to
        ? completedWeeksAt(data.trackingSince, to)
        : data.completedWeeks,
    points,
    forecasts,
    refillEvents: [...observed, ...expected].sort(
      (a, b) => a.at - b.at || a.provider.localeCompare(b.provider),
    ),
    estimate: allEstimated
      ? {
          status: "estimated",
          reason: "Seasonal forecasts are available for every comparable cohort.",
        }
      : anyEstimated || anyUnavailable
        ? { status: "unavailable", reason: "Some comparable cohorts are missing required inputs." }
        : { status: "learning", reason },
  };
}
