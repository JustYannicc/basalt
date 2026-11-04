const HOUR_MS = 60 * 60 * 1_000;
const DAY_HOURS = 24;
const WEEK_HOURS = 7 * DAY_HOURS;
const WEEK_MS = WEEK_HOURS * HOUR_MS;

export const MIN_PATTERN_WEEKS = 2;
export const MIN_ADVICE_WEEKS = 4;
export const MAX_PATTERN_WEEKS = 12;
export const MIN_BACKTEST_HELD_OUT_WEEKS = 2;
export const MIN_ADVICE_COVERAGE = 0.9;
export const RECURRING_PERCENTILE = 0.9;
export const RECURRING_MIN_WEEKS = 2;
export const ABOVE_USUAL_RATIO = 1.1;
export const TREND_WEEKS = 3;
export const CURRENT_JUDGED_AFTER_HOURS = 24;
export const CURRENT_COUNTS_AFTER_HOURS = 72;
export const MIN_CURRENT_PROFILE_SHARE = 0.15;
export const PROJECTION_HORIZON_HOURS = 72;
export const HOLD_UNHEALTHY_AT_LAST_READING = true;
export const MIN_FORECAST_WINDOW_SECONDS = 60 * 60;

export interface HourlyDemand {
  /** UTC hour start; every hour from `historyFrom` is expected. */
  readonly at: number;
  /** Demand in the supplied provider/window/unit. Null means the hour is unknown. */
  readonly demand: number | null;
  /** Share of expected accounts represented in this aggregate. Omit only for complete hours. */
  readonly coverage?: number | null;
  /** True when quota usage hit zero, making the observed demand a lower bound. */
  readonly censored?: boolean;
}

export interface ForecastAccount {
  /** Kept in the input only. It is never returned by this module. */
  readonly id: string;
  /** Server-assigned stable slot used to pair private accounts across windows. Never a user identifier. */
  readonly slot?: number;
  /** Safe plan name for explaining excluded weights. This is never an account identifier. */
  readonly label?: string;
  /** Full allowance in the forecast's weighted unit. */
  readonly capacity: number;
  /** False when the adapter supplied a fallback weight whose capacity is not established. */
  readonly knownWeight: boolean;
  /** Current allowance in the same weighted unit; null means the reading is unknown. */
  readonly remaining: number | null;
  /** Next scheduled reset, UTC epoch milliseconds. Null means no known refill time. */
  readonly resetAt: number | null;
  readonly windowSeconds: number;
  readonly usable: boolean;
  /** Historical traffic share used for sticky allocation. */
  readonly share: number;
  readonly shareKnown?: boolean;
  /** Estimated use assigned to each source sample time; it will age out of a rolling window. */
  readonly rollingUse?: readonly { readonly at: number; readonly amount: number }[];
  /** True only while use since a full, empty-window anchor has been reconciled at every fresh source sample. */
  readonly rollingHistoryComplete?: boolean;
  readonly weeklyUsable?: readonly { readonly at: number; readonly usable: boolean }[];
  readonly weeklyUsabilityComplete?: boolean;
  readonly windowKnown?: boolean;
}

export interface CandidateAccount {
  readonly label: string;
  /** Explicit, known full allowance in the forecast's weighted unit. */
  readonly capacity: number;
  readonly source: "reported" | "table" | "unit";
}

export interface CapacityForecastInput {
  readonly provider: string;
  readonly mode?: string | null;
  readonly unit: { readonly id: string; readonly label: string };
  /** One provider quota window per call. Different windows are forecast separately. */
  readonly windowSeconds: number;
  /** First expected UTC hour in `demand`; omitted timestamps inside the range are gaps. */
  readonly historyFrom: number;
  readonly now: number;
  readonly demand: readonly HourlyDemand[];
  readonly accounts: readonly ForecastAccount[];
  readonly candidateAccount?: CandidateAccount | null;
}

export type ForecastReason =
  | "invalid-input"
  | "insufficient-history"
  | "history-gap"
  | "partial-account-coverage"
  | "incomplete-current-week"
  | "missing-account-reading"
  | "unknown-account-weight"
  | "missing-reset-time"
  | "unhealthy-account"
  | "backtest-insufficient"
  | "backtest-not-better"
  | "candidate-weight-unavailable"
  | "censored-demand"
  | "partial-exposure-estimate"
  | "rolling-expiry-history-unavailable"
  | "five-hour-mode-unknown"
  | "weekly-capacity-forecast-unavailable"
  | "unobserved-account-window"
  | "sticky-routing-unavailable";

export interface MeasuredWeek {
  readonly startAt: number;
  readonly total: number;
  readonly censored?: boolean;
}

export interface Backtest {
  readonly heldOutWeeks: number;
  readonly seasonalMae: number | null;
  readonly naiveMae: number | null;
  readonly beatsSeasonalNaive: boolean;
}

export interface ProjectionPoint {
  readonly at: number;
  /** Allowance balance after demand; shortfalls remain below zero until a scheduled refill. */
  readonly balance: number;
  readonly demand: number;
  readonly low?: number;
  readonly high?: number;
  readonly busy?: number;
  readonly usable?: number | null;
}

export interface AggregateRefill {
  readonly at: number;
  readonly amount: number;
  readonly windows: number;
}

export interface ShortfallStretch {
  readonly from: number;
  readonly to: number;
  readonly amount: number;
  readonly worstHour?: number;
}

export interface CapacityForecast {
  readonly provider: string;
  readonly mode: string | null;
  readonly unit: { readonly id: string; readonly label: string };
  readonly windowSeconds: number;
  readonly status: "unavailable" | "estimated";
  readonly history: {
    readonly from: number;
    readonly through: number;
    readonly expectedHours: number;
    readonly observedHours: number;
    readonly coverage: number;
    readonly missingHours: number;
    readonly completeWeeks: number;
  };
  readonly measuredWeeks: readonly MeasuredWeek[];
  readonly estimate: null | {
    readonly label: "estimate";
    readonly basis: "seasonal-weekday-hour";
    readonly basedOnDays: number;
    readonly weeklyDemand: number | null;
    readonly profile: readonly number[] | null;
    readonly classification: "normal" | "above" | "trend" | null;
    readonly streak: number;
    readonly recurringPeak: number | null;
    readonly backtest: Backtest;
    readonly residualBand: { readonly low: number; readonly high: number; readonly heldOutWeeks: number; readonly residualHours: number };
  };
  readonly projection: null | {
    readonly points: readonly ProjectionPoint[];
    readonly refills: readonly AggregateRefill[];
    readonly shortfalls: readonly ShortfallStretch[];
    readonly runsOutAt: number | null;
    readonly accountBalances: readonly { readonly at: number; readonly accountIndex: number; readonly remaining: number }[];
    /** Aggregate remaining allowance held unchanged for unusable accounts. */
    readonly heldUnusableRemaining: number;
  };
  readonly busyShortfalls: readonly ShortfallStretch[];
  readonly busyRunsOutAt: number | null;
  readonly backtest: Backtest | null;
  /** Structured count only; null means evidence is not sufficient to make the estimate. */
  readonly accountAdvice: null | {
    readonly candidate: CandidateAccount;
    readonly additionalAccounts: number;
    readonly busyAccounts?: number;
    readonly exclusions?: readonly string[];
    readonly basis: "recurring-pattern" | "sustained-trend";
  };
  readonly reasons: readonly ForecastReason[];
}

interface Week {
  readonly startAt: number;
  readonly hours: readonly number[];
  readonly total: number;
  readonly censored: boolean;
}

interface PreparedHistory {
  readonly hours: readonly HourlyDemand[];
  readonly expectedHours: number;
  readonly observedHours: number;
  readonly coverage: number;
  readonly missingHours: number;
  readonly weeks: readonly Week[];
  readonly measuredWeeks: readonly MeasuredWeek[];
  readonly currentHours: readonly number[];
  readonly currentComplete: boolean;
  readonly currentMissingHours: number;
  readonly currentStart: number;
  readonly currentElapsedHours: number;
  readonly from: number;
  readonly through: number;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const hourStart = (at: number) => Math.floor(at / HOUR_MS) * HOUR_MS;
const weekStart = (at: number) => {
  const day = (new Date(at).getUTCDay() + 6) % 7;
  return Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate() - day);
};
const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b);

function median(values: readonly number[]): number {
  const ordered = sorted(values);
  if (ordered.length === 0) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function quantile(values: readonly number[], q: number): number {
  const ordered = sorted(values);
  if (!ordered.length) return 0;
  return ordered[Math.max(0, Math.min(ordered.length - 1, Math.ceil(q * ordered.length) - 1))]!;
}

/** Calibrate the likely range from leave-one-week-out residuals. */
function residualBand(weeks: readonly Week[]): { low: number; high: number; heldOutWeeks: number; residualHours: number } {
  const residuals: number[] = [];
  for (let held = 0; held < weeks.length; held++) {
    const training = weeks.filter((_, index) => index !== held);
    if (!training.length) continue;
    const shape = profile(training);
    const level = median(training.map((week) => week.total));
    for (let hour = 0; hour < WEEK_HOURS; hour++) residuals.push(weeks[held]!.hours[hour]! - shape[hour]! * level);
  }
  return { low: Math.min(0, quantile(residuals, 0.1)), high: Math.max(0, quantile(residuals, 0.9)),
    heldOutWeeks: weeks.length, residualHours: residuals.length };
}

/** A single exceptional week cannot determine the recurring peak. */
export function recurringPeak(values: readonly number[]): number {
  const ordered = sorted(values);
  if (ordered.length === 0) return 0;
  const p90 = ordered[Math.max(0, Math.ceil(RECURRING_PERCENTILE * ordered.length) - 1)]!;
  const secondHighest = ordered[Math.max(0, ordered.length - RECURRING_MIN_WEEKS)]!;
  return Math.min(p90, secondHighest);
}

function profile(weeks: readonly Week[]): number[] {
  const active = weeks.filter((week) => week.total > 0);
  if (active.length === 0) return Array(WEEK_HOURS).fill(1 / WEEK_HOURS) as number[];
  const shares = Array.from({ length: WEEK_HOURS }, (_, hour) => median(active.map((week) => week.hours[hour]! / week.total)));
  const total = sum(shares);
  return total > 0 ? shares.map((share) => share / total) : Array(WEEK_HOURS).fill(1 / WEEK_HOURS) as number[];
}

function validInput(input: CapacityForecastInput): boolean {
  if (!input.provider || !input.unit.id || !input.unit.label || !Number.isSafeInteger(input.windowSeconds)
    || input.windowSeconds < MIN_FORECAST_WINDOW_SECONDS)
    return false;
  if (!Number.isFinite(input.historyFrom) || !Number.isFinite(input.now) || input.historyFrom % HOUR_MS !== 0)
    return false;
  if (input.historyFrom >= hourStart(input.now)) return false;
  const ids = new Set<string>();
  for (const account of input.accounts) {
    if (!account.id || ids.has(account.id) || account.windowSeconds !== input.windowSeconds
      || !Number.isFinite(account.capacity) || account.capacity <= 0
      || typeof account.knownWeight !== "boolean"
      || account.remaining !== null && (!Number.isFinite(account.remaining) || account.remaining < 0 || account.remaining > account.capacity)
      || !Number.isFinite(account.share) || account.share < 0
      || account.resetAt !== null && !Number.isFinite(account.resetAt)) return false;
    ids.add(account.id);
  }
  if (input.candidateAccount && (!input.candidateAccount.label || !Number.isFinite(input.candidateAccount.capacity)
    || input.candidateAccount.capacity <= 0)) return false;
  return true;
}

function prepareHistory(input: CapacityForecastInput): PreparedHistory {
  const through = hourStart(input.now);
  const lookbackStart = Math.max(input.historyFrom, weekStart(through) - MAX_PATTERN_WEEKS * WEEK_MS);
  const firstExpected = Math.max(input.historyFrom, lookbackStart);
  const indexed = new Map<number, HourlyDemand>();
  const duplicateHours = new Set<number>();
  for (const point of input.demand) {
    if (!Number.isSafeInteger(point.at) || point.at % HOUR_MS !== 0 || point.at < input.historyFrom || point.at >= through
      || point.demand !== null && (!Number.isFinite(point.demand) || point.demand < 0)
      || point.coverage !== undefined && point.coverage !== null && (!Number.isFinite(point.coverage) || point.coverage < 0 || point.coverage > 1))
      continue;
    if (indexed.has(point.at)) duplicateHours.add(point.at);
    else indexed.set(point.at, point);
  }
  for (const at of duplicateHours) indexed.delete(at);

  const hours: HourlyDemand[] = [];
  for (let at = firstExpected; at < through; at += HOUR_MS) {
    const point = indexed.get(at);
    hours.push(point ?? { at, demand: null, coverage: 0 });
  }
  const coverageOf = (point: HourlyDemand) => point.demand === null ? 0 : point.coverage === undefined ? 1 : point.coverage ?? 0;
  const observedHours = hours.reduce((count, point) => count + (point.demand !== null ? 1 : 0), 0);
  const coverage = hours.length === 0 ? 0 : hours.reduce((total, point) => total + coverageOf(point), 0) / hours.length;
  const missingHours = hours.reduce((count, point) => count + (coverageOf(point) < 1 ? 1 : 0), 0);

  const currentStart = weekStart(through);
  const currentElapsedHours = Math.max(0, (through - currentStart) / HOUR_MS);
  const byAt = new Map(hours.map((point) => [point.at, point]));
  const current = Array.from({ length: currentElapsedHours }, (_, index) => byAt.get(currentStart + index * HOUR_MS));
  const currentMissingHours = current.reduce((count, point) => count + (point && coverageOf(point) === 1 ? 0 : 1), 0);
  const currentComplete = currentMissingHours === 0;
  const currentHours = current.map((point) => point?.demand ?? 0);

  const firstFullWeek = weekStart(firstExpected) === firstExpected ? firstExpected : weekStart(firstExpected) + WEEK_MS;
  const weeks: Week[] = [];
  for (let startAt = firstFullWeek; startAt + WEEK_MS <= currentStart; startAt += WEEK_MS) {
    const values = Array.from({ length: WEEK_HOURS }, (_, index) => byAt.get(startAt + index * HOUR_MS));
    if (values.some((point) => !point || point.demand === null || coverageOf(point) < 0.9)) continue;
    const weekHours = values.map((point) => point!.demand!);
    weeks.push({ startAt, hours: weekHours, total: sum(weekHours), censored: values.some((point) => point?.censored === true) });
  }
  const measuredWeeks = weeks.map(({ startAt, total, censored }) => ({ startAt, total, censored }));
  return {
    hours, expectedHours: hours.length, observedHours, coverage, missingHours, weeks, measuredWeeks,
    currentHours, currentComplete, currentMissingHours, currentStart, currentElapsedHours,
    from: firstExpected, through,
  };
}

function backtest(weeks: readonly Week[]): Backtest {
  const heldOutWeeks = Math.min(3, Math.max(0, weeks.length - 2));
  if (heldOutWeeks < MIN_BACKTEST_HELD_OUT_WEEKS)
    return { heldOutWeeks, seasonalMae: null, naiveMae: null, beatsSeasonalNaive: false };

  let seasonalError = 0;
  let naiveError = 0;
  let comparisons = 0;
  for (let index = weeks.length - heldOutWeeks; index < weeks.length; index++) {
    const training = weeks.slice(0, index);
    const shape = profile(training);
    const level = median(training.map((week) => week.total));
    const seasonal = shape.map((share) => share * level);
    const naive = weeks[index - 1]!.hours;
    for (let hour = 0; hour < WEEK_HOURS; hour++) {
      seasonalError += Math.abs(weeks[index]!.hours[hour]! - seasonal[hour]!);
      naiveError += Math.abs(weeks[index]!.hours[hour]! - naive[hour]!);
      comparisons++;
    }
  }
  const seasonalMae = seasonalError / comparisons;
  const naiveMae = naiveError / comparisons;
  return { heldOutWeeks, seasonalMae, naiveMae, beatsSeasonalNaive: seasonalMae < naiveMae - 1e-12 };
}

function nextReset(resetAt: number, now: number, windowMs: number): number {
  if (resetAt >= now) return resetAt;
  return resetAt + (Math.floor((now - resetAt) / windowMs) + 1) * windowMs;
}

function simulate(
  accounts: readonly ForecastAccount[],
  demandAt: (at: number) => number,
  from: number,
  now: number,
  windowSeconds: number,
  rolling: boolean,
): CapacityForecast["projection"] {
  if (accounts.length === 0 || accounts.some((account) => account.remaining === null)) return null;
  if (accounts.some((account) => account.shareKnown === false)) return null;
  if (accounts.some((account) => account.windowKnown === false)) return null;
  if (rolling && accounts.some((account) => account.rollingHistoryComplete !== true)) return null;
  if (windowSeconds === 18_000 && accounts.some((account) => account.weeklyUsabilityComplete === false)) return null;
  const windowMs = windowSeconds * 1_000;
  const state = accounts.map((account) => ({
    account,
    left: account.remaining!,
    nextReset: !rolling && account.usable && account.resetAt !== null
      ? nextReset(account.resetAt, now, windowMs) : null,
    rollingUse: [...(account.rollingUse ?? [])],
  }));
  const points: ProjectionPoint[] = [];
  const refillByAt = new Map<number, AggregateRefill>();
  const shortfalls: ShortfallStretch[] = [];
  const accountBalances: { at: number; accountIndex: number; remaining: number }[] = [];
  let dryFrom: number | null = null;
  let dryAmount = 0;
  let dryWorstHour = 0;
  let runsOutAt: number | null = null;

  for (let index = 0; index < PROJECTION_HORIZON_HOURS; index++) {
    const at = from + index * HOUR_MS;
    let refillAmount = 0;
    let refillWindows = 0;
    for (const entry of state) {
      if (!entry.account.usable) {
        if (!HOLD_UNHEALTHY_AT_LAST_READING) entry.left = 0;
        continue;
      }
      if (rolling) {
        const expired = entry.rollingUse.filter((use) => use.at + windowMs <= at);
        entry.rollingUse = entry.rollingUse.filter((use) => use.at + windowMs > at);
        entry.left = Math.min(entry.account.capacity, entry.left + sum(expired.map((use) => use.amount)));
      }
      if (entry.nextReset === null) continue;
      while (entry.nextReset <= at) {
        const restored = Math.max(0, entry.account.capacity - Math.max(0, entry.left));
        entry.left = entry.account.capacity;
        entry.nextReset += windowMs;
        refillAmount += restored;
        refillWindows++;
      }
    }
    if (refillAmount > 0) {
      refillByAt.set(at, { at, amount: refillAmount, windows: refillWindows });
    }

    const usableAtHour = (entry: typeof state[number]) => entry.account.usable
      && (!entry.account.weeklyUsable?.length || (entry.account.weeklyUsable.filter((point) => point.at <= at).at(-1)?.usable ?? true));
    const availableBeforeDemand = state.reduce((total, entry) => total + (usableAtHour(entry) ? entry.left : 0), 0);
    if (dryFrom !== null && availableBeforeDemand > 1e-12) {
      shortfalls.push({ from: dryFrom, to: at, amount: dryAmount, worstHour: dryWorstHour });
      dryFrom = null;
      dryAmount = 0;
      dryWorstHour = 0;
    }

    const hourDemand = demandAt(at);
    let need = hourDemand;
    for (let pass = 0; pass < state.length + 1 && need > 1e-12; pass++) {
      const open = state.filter((entry) => usableAtHour(entry) && entry.left > 1e-12);
      if (open.length === 0) break;
      const shareTotal = sum(open.map((entry) => entry.account.share)) || open.length;
      let served = 0;
      for (const entry of open) {
        const share = entry.account.share || (shareTotal === open.length ? 1 : 0);
        const take = Math.min(need * share / shareTotal, entry.left);
        entry.left -= take;
        if (rolling && take > 0) entry.rollingUse.push({ at, amount: take });
        served += take;
      }
      if (served <= 1e-12) break;
      need -= served;
    }
    if (need > 1e-9) {
      if (dryFrom === null) dryFrom = at;
      dryAmount += need;
      dryWorstHour = Math.max(dryWorstHour, need);
      if (runsOutAt === null) runsOutAt = at;
    }
    const available = state.reduce((total, entry) => total + (usableAtHour(entry) ? entry.left : 0), 0);
    for (const [accountIndex, entry] of state.entries())
      accountBalances.push({ at, accountIndex: entry.account.slot ?? accountIndex, remaining: entry.left });
    const usable = state.reduce((total, entry) => total + (usableAtHour(entry) ? entry.account.capacity : 0), 0);
    points.push({ at, balance: available - dryAmount, demand: hourDemand, usable });
  }
  if (dryFrom !== null) shortfalls.push({ from: dryFrom, to: from + PROJECTION_HORIZON_HOURS * HOUR_MS, amount: dryAmount, worstHour: dryWorstHour });
  const heldUnusableRemaining = HOLD_UNHEALTHY_AT_LAST_READING
    ? state.reduce((total, entry) => total + (entry.account.usable ? 0 : entry.left), 0)
    : 0;
  return { points, refills: [...refillByAt.values()], shortfalls, runsOutAt, accountBalances, heldUnusableRemaining };
}

function reasonsFor(
  history: PreparedHistory,
  backtestResult: Backtest,
  accounts: readonly ForecastAccount[],
  patternBasis: boolean,
  requireResetTime: boolean,
): ForecastReason[] {
  const reasons: ForecastReason[] = [];
  if (history.missingHours > 0) reasons.push("history-gap");
  if (history.hours.some((point) => point.demand !== null && coverageOfPoint(point) < 1)) reasons.push("partial-account-coverage");
  if (history.hours.some((point) => point.demand !== null && coverageOfPoint(point) < 1)) reasons.push("partial-exposure-estimate");
  if (history.weeks.some((week) => week.censored)) reasons.push("censored-demand");
  if (history.currentMissingHours > 0 && history.currentElapsedHours > 0) reasons.push("incomplete-current-week");
  if (accounts.some((account) => account.remaining === null)) reasons.push("missing-account-reading");
  if (accounts.length === 0) reasons.push("missing-account-reading");
  if (accounts.some((account) => !account.knownWeight)) reasons.push("unknown-account-weight");
  if (accounts.some((account) => account.shareKnown === false)) reasons.push("sticky-routing-unavailable");
  if (accounts.some((account) => !account.usable)) reasons.push("unhealthy-account");
  if (requireResetTime && accounts.some((account) => account.usable && account.resetAt === null)) reasons.push("missing-reset-time");
  if (accounts.some((account) => account.rollingHistoryComplete === false)) reasons.push("rolling-expiry-history-unavailable");
  if (accounts.some((account) => account.weeklyUsabilityComplete === false)) reasons.push("weekly-capacity-forecast-unavailable");
  if (accounts.some((account) => account.windowKnown === false)) reasons.push("unobserved-account-window");
  if (patternBasis && backtestResult.heldOutWeeks < MIN_BACKTEST_HELD_OUT_WEEKS) reasons.push("backtest-insufficient");
  else if (patternBasis && !backtestResult.beatsSeasonalNaive) reasons.push("backtest-not-better");
  return reasons;
}

function coverageOfPoint(point: HourlyDemand): number {
  return point.demand === null ? 0 : point.coverage === undefined ? 1 : point.coverage ?? 0;
}

function unavailable(
  input: CapacityForecastInput,
  history: PreparedHistory,
  reason: ForecastReason,
): CapacityForecast {
  return {
    provider: input.provider, mode: input.mode ?? null, unit: input.unit, windowSeconds: input.windowSeconds, status: "unavailable",
    history: {
      from: history.from, through: history.through, expectedHours: history.expectedHours,
      observedHours: history.observedHours, coverage: history.coverage, missingHours: history.missingHours,
      completeWeeks: history.weeks.length,
    },
    measuredWeeks: history.measuredWeeks, estimate: null, projection: null, busyShortfalls: [], busyRunsOutAt: null, backtest: null,
    accountAdvice: null, reasons: [reason],
  };
}

/** Pure hourly-demand estimate and scheduled-refill simulation for one provider window. */
export function forecastCapacity(input: CapacityForecastInput): CapacityForecast {
  if (!validInput(input)) {
    const empty: PreparedHistory = {
      hours: [], expectedHours: 0, observedHours: 0, coverage: 0, missingHours: 0, weeks: [], measuredWeeks: [],
      currentHours: [], currentComplete: false, currentMissingHours: 0, currentStart: hourStart(input.now),
      currentElapsedHours: 0, from: input.historyFrom, through: hourStart(input.now),
    };
    return unavailable(input, empty, "invalid-input");
  }

  const history = prepareHistory(input);
  const historyMeta = {
    from: history.from, through: history.through, expectedHours: history.expectedHours,
    observedHours: history.observedHours, coverage: history.coverage, missingHours: history.missingHours,
    completeWeeks: history.weeks.length,
  };
  if (history.weeks.length < MIN_PATTERN_WEEKS) {
    return {
      provider: input.provider, mode: input.mode ?? null, unit: input.unit, windowSeconds: input.windowSeconds, status: "unavailable",
      history: historyMeta, measuredWeeks: history.measuredWeeks, estimate: null, projection: null,
      busyShortfalls: [], busyRunsOutAt: null, backtest: null, accountAdvice: null,
      reasons: ["insufficient-history", ...(history.missingHours > 0 ? ["history-gap" as const] : [])],
    };
  }

  const patternBasis = true;
  const backtestResult = patternBasis ? backtest(history.weeks) : {
    heldOutWeeks: 0, seasonalMae: null, naiveMae: null, beatsSeasonalNaive: false,
  };
  const reasons = reasonsFor(history, backtestResult, input.accounts, patternBasis,
    input.windowSeconds !== 18_000 || input.mode?.trim().toLowerCase() === "fixed");
  let demandAt: (at: number) => number;
  let lowDemandAt: (at: number) => number;
  let busyDemandAt: (at: number) => number;
  let sizingDemandAt: (at: number) => number;
  let sizingBusyDemandAt: (at: number) => number;
  let estimate: NonNullable<CapacityForecast["estimate"]>;

  {
    const weeks = history.weeks;
    const shape = profile(weeks);
    const totals = weeks.map((week) => week.total);
    const medianLevel = median(totals);
    const peak = recurringPeak(totals);
    const baseline = weeks.slice(0, Math.max(1, weeks.length - TREND_WEEKS));
    const basePeak = recurringPeak(baseline.map((week) => week.total));
    const elapsedHours = Math.min(WEEK_HOURS, history.currentElapsedHours);
    const currentDemand = sum(history.currentHours);
    const cumulativeShare = sum(shape.slice(0, elapsedHours));
    const basePeakCumulative = recurringPeak(baseline.map((week) => sum(week.hours.slice(0, elapsedHours))));
    const currentJudged = history.currentComplete && elapsedHours >= CURRENT_JUDGED_AFTER_HOURS
      && cumulativeShare >= MIN_CURRENT_PROFILE_SHARE;
    const currentAbove = currentJudged && currentDemand > ABOVE_USUAL_RATIO * basePeakCumulative;
    const projectedCurrentWeek = history.currentComplete && cumulativeShare >= MIN_CURRENT_PROFILE_SHARE
      ? currentDemand / cumulativeShare : null;

    const lastThree = weeks.slice(-TREND_WEEKS).reverse();
    let streak = 0;
    for (let index = 0; index < lastThree.length; index++) {
      const previous = lastThree[index - 1];
      if (previous && previous.startAt - lastThree[index]!.startAt !== WEEK_MS) break;
      if (lastThree[index]!.total <= ABOVE_USUAL_RATIO * basePeak) break;
      streak++;
    }
    const currentCounts = history.currentComplete && elapsedHours >= CURRENT_COUNTS_AFTER_HOURS && currentJudged;
    if (currentCounts) streak = currentAbove ? streak + 1 : 0;
    const classification = streak >= TREND_WEEKS ? "trend" : !currentJudged ? null : currentAbove ? "above" : "normal";
    const streakWeeks = lastThree.slice(0, Math.max(0, streak - (currentCounts ? 1 : 0)));
    const streakLevels = [...(currentCounts && projectedCurrentWeek !== null ? [projectedCurrentWeek] : []), ...streakWeeks.map((week) => week.total)];
    const sizingLevel = classification === "trend" && streakLevels.length > 0
      ? Math.max(peak, Math.min(...streakLevels)) : peak;
    const forecastLevel = medianLevel;
    const residuals = residualBand(weeks);
    demandAt = (at) => shape[Math.floor((at - weekStart(at)) / HOUR_MS)]! * forecastLevel;
    sizingDemandAt = (at) => shape[Math.floor((at - weekStart(at)) / HOUR_MS)]! * sizingLevel;
    sizingBusyDemandAt = (at) => Math.max(0, sizingDemandAt(at) + residuals.high);
    lowDemandAt = (at) => Math.max(0, demandAt(at) + residuals.low);
    busyDemandAt = (at) => Math.max(0, demandAt(at) + residuals.high);
    estimate = {
      label: "estimate", basis: "seasonal-weekday-hour", basedOnDays: Math.floor(history.observedHours / DAY_HOURS),
      weeklyDemand: sizingLevel, profile: shape, classification, streak, recurringPeak: peak, backtest: backtestResult,
      residualBand: residuals,
    };
  }

  const from = Math.ceil(input.now / HOUR_MS) * HOUR_MS;
  const mode = input.mode?.trim().toLowerCase();
  const rollingMode = mode?.includes("rolling") ?? false;
  const fiveHourModeKnown = input.windowSeconds !== 18_000 || mode === "fixed" || rollingMode;
  if (!fiveHourModeKnown) reasons.push("five-hour-mode-unknown");
  const rolling = rollingMode;
  const rollingSupported = !rolling || input.windowSeconds === 18_000;
  if (!rollingSupported) reasons.push("rolling-expiry-history-unavailable");
  const canSimulate = fiveHourModeKnown && rollingSupported && !reasons.includes("missing-reset-time");
  const projection = canSimulate ? simulate(input.accounts, demandAt, from, input.now, input.windowSeconds, rolling) : null;
  const lowerDemandProjection = canSimulate ? simulate(input.accounts, lowDemandAt!, from, input.now, input.windowSeconds, rolling) : null;
  const busyProjection = canSimulate ? simulate(input.accounts, busyDemandAt!, from, input.now, input.windowSeconds, rolling) : null;
  const sizingProjection = canSimulate ? simulate(input.accounts, sizingDemandAt!, from, input.now, input.windowSeconds, rolling) : null;
  const sizingBusyProjection = canSimulate ? simulate(input.accounts, sizingBusyDemandAt!, from, input.now, input.windowSeconds, rolling) : null;
  if (projection && lowerDemandProjection && busyProjection) {
    const points = projection.points.map((point, index) => ({
      ...point,
      low: busyProjection.points[index]!.balance,
      high: lowerDemandProjection.points[index]!.balance,
      busy: busyProjection.points[index]!.balance,
      usable: point.usable,
    }));
    Object.assign(projection, { points });
  }
  const candidate = input.candidateAccount;
  const adviceAllowed = patternBasis && candidate !== null && candidate !== undefined
    && history.coverage >= MIN_ADVICE_COVERAGE
    && backtestResult.beatsSeasonalNaive && history.weeks.length >= MIN_ADVICE_WEEKS
    && history.hours.every((point) => point.demand !== null)
    && !history.weeks.some((week) => week.censored)
    && input.accounts.every((account) => account.capacity > 0 && account.knownWeight && account.usable
      && account.remaining !== null && account.shareKnown !== false && (rolling || account.resetAt !== null));
  const shortfallAmount = (value: NonNullable<typeof projection>) => input.windowSeconds === 18_000
    ? Math.max(0, ...value.shortfalls.map((stretch) => stretch.worstHour ?? 0))
    : value.shortfalls.reduce((total, stretch) => total + stretch.amount, 0);
  const ordinaryShortfall = projection ? shortfallAmount(projection) : 0;
  const sizingShortfall = sizingProjection ? shortfallAmount(sizingProjection) : ordinaryShortfall;
  const accountAdvice = adviceAllowed && sizingProjection && sizingBusyProjection
    ? {
      candidate,
      additionalAccounts: Math.ceil(Math.max(0, sizingShortfall - 1e-9) / candidate.capacity),
      busyAccounts: Math.ceil(Math.max(0, shortfallAmount(sizingBusyProjection) - 1e-9) / candidate.capacity),
      exclusions: [...new Set(input.accounts.filter((account) => !account.knownWeight).map((account) => account.label ?? "Unverified plan"))],
      basis: estimate.classification === "trend" ? "sustained-trend" as const : "recurring-pattern" as const,
    }
    : null;
  if (!candidate) reasons.push("candidate-weight-unavailable");
  return {
    provider: input.provider, mode: input.mode ?? null, unit: input.unit, windowSeconds: input.windowSeconds, status: "estimated",
    history: historyMeta, measuredWeeks: history.measuredWeeks, estimate, projection,
    busyShortfalls: busyProjection?.shortfalls ?? [], busyRunsOutAt: busyProjection?.runsOutAt ?? null,
    backtest: backtestResult, accountAdvice,
    reasons: [...new Set(reasons)],
  };
}
