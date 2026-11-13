import type {
  CapacityAggregate,
  CapacityHistoryPoint,
  CapacityPlanHistory,
  CapacityRawHistory,
} from "../../../apps/pool/capacity-contract.ts";
export type {
  CapacityAggregate,
  CapacityHistoryPoint,
  CapacityPlanHistory,
  CapacityRawHistory,
} from "../../../apps/pool/capacity-contract.ts";
import { digest } from "../backend-users.ts";
import { ChunkStorage, UsageQueue, type UsageStorage } from "../usage-storage.ts";
import type { CapacityReading } from "./normalize.ts";

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
const weekHours = 7 * 24;
const maxDemandSampleGap = 15 * 60_000;
// Fixed-window deltas span the 30-minute collector cadence plus one sampler tick.
const maxFixedSourceGap = 35 * 60_000;
const fixedDemandWindow = (reading: CapacityReading) =>
  reading.windowSeconds === 604_800 || reading.mode?.toLowerCase() === "fixed";
const retainedHours = 400 * 24;
const maxGroups = 64;
const maxPlansPerGroup = 32;
const maxWeightKindsPerGroup = 32;
const maxAccountsPerCohort = 5_000;
const maxIndexedDays = 401; // A rolling 400-day window can touch both partial boundary days.
const storageKey = (pool: string) => `capacity-v1:${pool}`;
const indexKey = (pool: string) => `${storageKey(pool)}:index`;
const pendingKey = (pool: string) => `${storageKey(pool)}:pending`;
const dayKey = (pool: string, day: string) => `${storageKey(pool)}:day:${day}`;
const dayOf = (at: number) => new Date(Math.floor(at / dayMs) * dayMs).toISOString().slice(0, 10);
const hourOf = (at: number) => Math.floor(at / hourMs) * hourMs;
const weekOf = (at: number) => {
  const value = new Date(at);
  const midnight = Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  return midnight - ((value.getUTCDay() + 6) % 7) * dayMs;
};
const windowKey = (provider: string, windowSeconds: number) =>
  JSON.stringify([provider, windowSeconds]);
const groupKey = (provider: string, windowSeconds: number, mode: string | null, unit: string) =>
  JSON.stringify([provider, windowSeconds, mode, unit]);
const readingKey = (reading: CapacityReading) =>
  JSON.stringify([
    reading.provider,
    reading.windowSeconds,
    reading.mode,
    reading.unit.id,
    reading.account,
  ]);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export interface CapacityExpectedCohort {
  readonly provider: string;
  readonly windowSeconds: number;
  /** Active accounts whose source reports this window, including accounts with stale readings. */
  readonly accounts: number;
}

export interface CapacitySnapshot {
  /** Sampler time used for ordering and hourly buckets; source times remain on each aggregate. */
  readonly at: number;
  readonly expected: readonly CapacityExpectedCohort[];
  readonly readings: readonly CapacityReading[];
  /** Current server-owned health and reset inventory for every active limited account. */
  readonly accountStates?: readonly CapacityAccountState[];
  /** Active accounts whose server view reports no quota-window inventory at all. */
  readonly unclassifiedAccounts?: readonly {
    readonly account: string;
    readonly provider: string;
  }[];
}

export interface CapacityAccountState {
  readonly account: string;
  readonly provider: string;
  readonly windowSeconds: number;
  readonly usable: boolean;
  /** Successful active source inventory may retain a historical cursor past its reading TTL. */
  readonly sourceContinuous?: boolean;
  readonly bankedAvailable: number | null;
  /** Redemption receipts only, already confirmed by the reset service. */
  readonly bankedUsed?: readonly { readonly id: string; readonly at: number }[];
}

export interface CapacityHistoryRange {
  /** Inclusive sampler time. Omit to read from the oldest retained hour. */
  readonly from?: number;
  /** Exclusive sampler time. Omit to read through the newest stored hour. */
  readonly to?: number;
}

export interface CapacityObserveResult {
  readonly accepted: boolean;
  readonly groups: number;
  readonly incomplete: number;
}

export interface CapacityDemandPoint {
  readonly provider: string;
  readonly windowSeconds: number;
  readonly mode: string | null;
  readonly unit: { readonly id: string; readonly label: string };
  readonly hour: number;
  readonly demand: number | null;
  readonly coverage: number;
  readonly censored: boolean;
  readonly membershipIncomplete: boolean;
  readonly sourceAt: { readonly from: number; readonly to: number };
}

export interface CapacityDemandData {
  readonly trackingSince: number | null;
  readonly cohortTrackingSince?: Readonly<Record<string, number>>;
  readonly readAt: number | null;
  readonly completedWeeks: number;
  readonly points: readonly CapacityDemandPoint[];
  readonly latestReadings: readonly CapacityReading[];
  readonly accountStates: readonly CapacityAccountState[];
  readonly unclassifiedProviders: readonly string[];
  readonly accountDemandTotals: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Known five-hour use, estimated for each source observation time while the empty-anchor chain is complete. */
  readonly rollingUse: Readonly<
    Record<
      string,
      Readonly<Record<string, readonly { readonly at: number; readonly amount: number }[]>>
    >
  >;
  readonly rollingComplete: Readonly<
    Record<string, Readonly<Record<string, { readonly at: number; readonly complete: boolean }>>>
  >;
  readonly refills: readonly StoredRefill[];
}

interface StoredPoint extends CapacityHistoryPoint {
  readonly key: string;
}
interface StoredDemand {
  provider: string;
  windowSeconds: number;
  mode: string | null;
  unit: { id: string; label: string };
  hour: number;
  /** Exposure-weighted quota consumption estimate for the complete hour. */
  demand: number;
  exposureSeconds: number;
  expectedSeconds: number;
  censored: boolean;
  membershipIncomplete: boolean;
  sourceFrom: number;
  sourceTo: number;
}
export interface StoredRefill {
  provider: string;
  windowSeconds: number;
  mode: string | null;
  unitId: string;
  at: number;
  amount: number;
  amountIsLowerBound: boolean;
  kind: "observed" | "banked";
}
interface DayHistory {
  version: 1;
  points: StoredPoint[];
  demand?: StoredDemand[];
  refills?: StoredRefill[];
}
interface GroupCursor {
  at: number;
  fingerprint: string;
}
interface RollingUseEvent {
  at: number;
  amount: number;
}
interface RollingChainEntry {
  at: number;
  full: number;
  remaining: number;
  resetAt: number | null;
  revision: string;
  complete: boolean;
}
interface HistoryIndex {
  version: 1;
  days: string[];
  lastAt: number | null;
  fromHour: number;
  groups: Record<string, GroupCursor>;
  trackingSince?: number;
  previous?: CapacityReading[];
  previousExpected?: CapacityExpectedCohort[];
  latest?: CapacityReading[];
  accountStates?: CapacityAccountState[];
  unclassifiedAccounts?: { account: string; provider: string }[];
  bankedReceipts?: Record<string, number>;
  demandFrom?: number;
  demandSinceByGroup?: Record<string, number>;
  demandRevisions?: Record<string, { revision: string; at: number }>;
  demandShares?: Record<string, Record<string, { week: number; amount: number }[]>>;
  rollingUse?: Record<string, Record<string, RollingUseEvent[]>>;
  rollingChain?: Record<string, Record<string, RollingChainEntry>>;
}
interface PreparedGroup {
  readonly provider: string;
  readonly windowSeconds: number;
  readonly mode: string | null;
  readonly unit: CapacityReading["unit"];
  readonly readings: Map<string, CapacityReading>;
  weeklyUsability?: ReadonlyMap<string, boolean | null>;
  invalid: boolean;
}
interface Cohort {
  readonly expected: number;
  readonly accounts: Set<string>;
  readonly groups: Map<string, PreparedGroup>;
  invalid: boolean;
}

function blankIndex(fromHour: number): HistoryIndex {
  return { version: 1, days: [], lastAt: null, fromHour, groups: {} };
}

function rollingJournalIsComplete(
  chain: RollingChainEntry | undefined,
  events: readonly RollingUseEvent[] | undefined,
  windowSeconds: number,
): boolean {
  if (
    !chain?.complete ||
    events === undefined ||
    !Number.isFinite(chain.at) ||
    !Number.isFinite(chain.full) ||
    chain.full <= 0 ||
    !Number.isFinite(chain.remaining) ||
    chain.remaining < 0 ||
    chain.remaining > chain.full
  )
    return false;
  const windowMs = windowSeconds * 1_000;
  let outstanding = 0;
  for (const event of events) {
    if (
      !Number.isFinite(event.at) ||
      event.at > chain.at ||
      !Number.isFinite(event.at + windowMs) ||
      event.at + windowMs <= chain.at ||
      !Number.isFinite(event.amount) ||
      event.amount <= 0 ||
      event.amount > chain.full
    )
      return false;
    outstanding += event.amount;
  }
  const rounding = Number.EPSILON * Math.max(1, chain.full) * (events.length + 2);
  return (
    Number.isFinite(outstanding) && Math.abs(chain.remaining + outstanding - chain.full) <= rounding
  );
}

function sameReading(a: CapacityReading, b: CapacityReading): boolean {
  return (
    a.provider === b.provider &&
    a.plan === b.plan &&
    a.windowSeconds === b.windowSeconds &&
    a.mode === b.mode &&
    a.observedAt === b.observedAt &&
    a.resetAt === b.resetAt &&
    a.staleAt === b.staleAt &&
    a.observationSource === b.observationSource &&
    a.full === b.full &&
    a.remaining === b.remaining &&
    a.unit.id === b.unit.id &&
    a.unit.label === b.unit.label &&
    a.source === b.source &&
    a.knownWeight === b.knownWeight &&
    a.revision === b.revision
  );
}

function validReading(reading: CapacityReading, at: number): boolean {
  return (
    text(reading.account, 512) &&
    text(reading.provider, 128) &&
    Number.isSafeInteger(reading.windowSeconds) &&
    reading.windowSeconds > 0 &&
    (reading.plan === null || text(reading.plan, 128)) &&
    Number.isFinite(reading.observedAt) &&
    reading.observedAt <= at &&
    (reading.staleAt === null || (Number.isFinite(reading.staleAt) && reading.staleAt > at)) &&
    Number.isFinite(reading.full) &&
    reading.full > 0 &&
    Number.isFinite(reading.remaining) &&
    reading.remaining >= 0 &&
    reading.remaining <= reading.full &&
    text(reading.unit.id, 256) &&
    text(reading.unit.label, 128) &&
    text(reading.source, 128) &&
    text(reading.revision, 128) &&
    typeof reading.knownWeight === "boolean"
  );
}

function validExpected(value: CapacityExpectedCohort): boolean {
  return (
    text(value.provider, 128) &&
    Number.isSafeInteger(value.windowSeconds) &&
    value.windowSeconds > 0 &&
    Number.isSafeInteger(value.accounts) &&
    value.accounts >= 0 &&
    value.accounts <= maxAccountsPerCohort
  );
}

function aggregate(readings: readonly CapacityReading[], at: number): CapacityAggregate {
  // A stable in-memory order avoids floating-point totals changing when source rows reorder.
  const ordered = [...readings].sort((a, b) => a.account.localeCompare(b.account));
  let remaining = 0,
    full = 0,
    observedFrom = Infinity,
    observedTo = -Infinity,
    knownWeightCount = 0;
  const weights = new Map<
    string,
    { source: CapacityReading["source"]; revision: string; accountCount: number }
  >();
  for (const reading of ordered) {
    remaining += reading.remaining;
    full += reading.full;
    observedFrom = Math.min(observedFrom, reading.observedAt);
    observedTo = Math.max(observedTo, reading.observedAt);
    if (reading.knownWeight) knownWeightCount++;
    const key = JSON.stringify([reading.source, reading.revision]),
      weight = weights.get(key);
    if (weight) weight.accountCount++;
    else weights.set(key, { source: reading.source, revision: reading.revision, accountCount: 1 });
  }
  const provenance = [...weights.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.revision.localeCompare(b.revision),
  );
  return {
    remaining,
    full,
    at,
    observedAt: { from: observedFrom, to: observedTo },
    accountCount: ordered.length,
    knownWeightCount,
    unknownWeightCount: ordered.length - knownWeightCount,
    weights: provenance,
  };
}

function plansFor(readings: readonly CapacityReading[], at: number): CapacityPlanHistory[] {
  const byPlan = new Map<string, CapacityReading[]>();
  for (const reading of readings) {
    const key = JSON.stringify(reading.plan);
    byPlan.set(key, [...(byPlan.get(key) ?? []), reading]);
  }
  return [...byPlan.values()]
    .map((rows) => ({
      plan: rows[0]!.plan,
      minimum: aggregate(rows, at),
      last: aggregate(rows, at),
    }))
    .sort((a, b) => (a.plan ?? "").localeCompare(b.plan ?? ""));
}

function pointFor(group: PreparedGroup, at: number, key: string): StoredPoint {
  const readings = [...group.readings.values()];
  const usableValues =
    group.windowSeconds === 18_000
      ? readings.map((reading) => group.weeklyUsability?.get(reading.account))
      : undefined;
  const weeklyGateComplete =
    usableValues?.every((value): value is boolean => value !== null && value !== undefined) ??
    false;
  const gatedReadings =
    group.windowSeconds === 18_000 && weeklyGateComplete
      ? readings.map((reading) =>
          group.weeklyUsability!.get(reading.account) ? reading : { ...reading, remaining: 0 },
        )
      : readings;
  const raw =
    group.windowSeconds === 18_000
      ? ({
          minimum: aggregate(readings, at),
          last: aggregate(readings, at),
          plans: plansFor(readings, at),
        } satisfies CapacityRawHistory)
      : undefined;
  const usable = weeklyGateComplete
    ? {
        ...aggregate(readings, at),
        remaining: readings.reduce(
          (total, reading) =>
            total + (group.weeklyUsability!.get(reading.account) ? reading.full : 0),
          0,
        ),
      }
    : undefined;
  return {
    key,
    provider: group.provider,
    windowSeconds: group.windowSeconds,
    mode: group.mode,
    unit: group.unit,
    hour: hourOf(at),
    minimum: aggregate(gatedReadings, at),
    last: aggregate(gatedReadings, at),
    plans: plansFor(gatedReadings, at),
    ...(raw ? { raw } : {}),
    ...(group.windowSeconds === 18_000 ? { usable: usable ?? null } : {}),
  };
}

function mergePlans(
  old: readonly CapacityPlanHistory[],
  current: readonly CapacityPlanHistory[],
  minimum: readonly CapacityPlanHistory[],
  minimumAggregate: CapacityAggregate,
): CapacityPlanHistory[] {
  const currentByPlan = new Map(current.map((entry) => [JSON.stringify(entry.plan), entry]));
  const minimumByPlan = new Map(minimum.map((entry) => [JSON.stringify(entry.plan), entry]));
  const plans = new Map<string, CapacityPlanHistory>();
  for (const entry of [...old, ...current]) {
    const key = JSON.stringify(entry.plan);
    plans.set(key, {
      plan: entry.plan,
      minimum: minimumByPlan.get(key)?.minimum ?? {
        ...minimumAggregate,
        remaining: 0,
        full: 0,
        accountCount: 0,
        knownWeightCount: 0,
        unknownWeightCount: 0,
        weights: [],
      },
      last: currentByPlan.get(key)?.last ?? null,
    });
  }
  return [...plans.values()].sort((a, b) => (a.plan ?? "").localeCompare(b.plan ?? ""));
}

function updatePoint(old: StoredPoint | undefined, current: StoredPoint): StoredPoint {
  if (!old) return current;
  if (current.windowSeconds === 18_000) {
    const oldRaw = old.raw ?? { minimum: old.minimum, last: old.last, plans: old.plans };
    const currentRaw = current.raw ?? {
      minimum: current.minimum,
      last: current.last,
      plans: current.plans,
    };
    const rawMinimumPoint =
      currentRaw.minimum.remaining < oldRaw.minimum.remaining ? currentRaw : oldRaw;
    const rawMinimum = rawMinimumPoint.minimum;
    const rawPlans = mergePlans(oldRaw.plans, currentRaw.plans, rawMinimumPoint.plans, rawMinimum);
    const oldGateComplete = old.raw !== undefined && old.usable !== null;
    const currentGateComplete = current.raw !== undefined && current.usable !== null;
    const gatesComparable = oldGateComplete && currentGateComplete;
    const minimumPoint =
      gatesComparable && old.minimum.remaining < current.minimum.remaining ? old : current;
    const minimum = gatesComparable ? minimumPoint.minimum : rawMinimum;
    const plans = gatesComparable
      ? mergePlans(old.plans, current.plans, minimumPoint.plans, minimum)
      : rawPlans;
    const usable = gatesComparable
      ? old.usable!.remaining < current.usable!.remaining
        ? old.usable
        : current.usable
      : null;
    return {
      ...current,
      minimum,
      last: gatesComparable ? current.last : currentRaw.last,
      plans,
      raw: { minimum: rawMinimum, last: currentRaw.last, plans: rawPlans },
      usable,
    };
  }
  const lowest = current.minimum.remaining < old.minimum.remaining ? current : old;
  const plans = mergePlans(old.plans, current.plans, lowest.plans, lowest.minimum);
  return { ...current, minimum: lowest.minimum, plans };
}

function fingerprint(point: StoredPoint): Promise<string> {
  const { key: _key, hour: _hour, minimum, last, plans, raw, ...derived } = point;
  const value = (aggregate: CapacityAggregate) => {
    const { at: _at, ...source } = aggregate;
    return source;
  };
  return digest(
    JSON.stringify({
      ...derived,
      minimum: value(minimum),
      last: value(last),
      plans: plans.map((plan) => ({
        plan: plan.plan,
        minimum: value(plan.minimum),
        last: plan.last && value(plan.last),
      })),
      ...(raw
        ? {
            raw: {
              minimum: value(raw.minimum),
              last: value(raw.last),
              plans: raw.plans.map((plan) => ({
                plan: plan.plan,
                minimum: value(plan.minimum),
                last: plan.last && value(plan.last),
              })),
            },
          }
        : {}),
    }),
  );
}

/** Stores hashed account slots with bounded history; product reads never return account identifiers. */
export class CapacityHistory {
  private storage: ChunkStorage;
  readonly queue = new UsageQueue();
  constructor(storage: UsageStorage) {
    this.storage = new ChunkStorage(storage);
  }

  observe(pool: string, snapshot: CapacitySnapshot): Promise<CapacityObserveResult> {
    return this.queue.run(async () => {
      const indexId = indexKey(pool),
        pending = pendingKey(pool);
      await this.storage.recover(pending);
      if (!Number.isFinite(snapshot.at) || snapshot.at < 0)
        throw new Error("Invalid capacity snapshot time");
      const firstRetainedHour = hourOf(snapshot.at) - (retainedHours - 1) * hourMs;
      const saved = await this.storage.get<HistoryIndex>(indexId);
      if (saved && saved.version !== 1) throw new Error("Unsupported capacity history version");
      const index = saved ?? blankIndex(firstRetainedHour);
      if (index.lastAt !== null && snapshot.at <= index.lastAt)
        return { accepted: false, groups: 0, incomplete: 0 };

      const expected = new Map<string, CapacityExpectedCohort>();
      const invalidCohorts = new Set<string>();
      for (const cohort of snapshot.expected) {
        if (!validExpected(cohort)) continue;
        const key = windowKey(cohort.provider, cohort.windowSeconds);
        if (expected.has(key)) invalidCohorts.add(key);
        else expected.set(key, cohort);
      }
      const cohorts = new Map<string, Cohort>();
      for (const [key, cohort] of expected)
        cohorts.set(key, {
          expected: cohort.accounts,
          accounts: new Set(),
          groups: new Map(),
          invalid: invalidCohorts.has(key),
        });

      for (const reading of snapshot.readings) {
        if (!validReading(reading, snapshot.at)) continue;
        const window = windowKey(reading.provider, reading.windowSeconds),
          cohort = cohorts.get(window);
        if (!cohort) continue;
        cohort.accounts.add(reading.account);
        const id = groupKey(reading.provider, reading.windowSeconds, reading.mode, reading.unit.id);
        let group = cohort.groups.get(id);
        if (!group) {
          group = {
            provider: reading.provider,
            windowSeconds: reading.windowSeconds,
            mode: reading.mode,
            unit: reading.unit,
            readings: new Map(),
            invalid: false,
          };
          cohort.groups.set(id, group);
        } else if (group.unit.label !== reading.unit.label) group.invalid = true;
        const duplicate = group.readings.get(reading.account);
        if (duplicate && !sameReading(duplicate, reading)) group.invalid = true;
        else if (!duplicate) group.readings.set(reading.account, reading);
      }

      const validCurrent = snapshot.readings.filter(
        (reading) =>
          validReading(reading, snapshot.at) &&
          cohorts.has(windowKey(reading.provider, reading.windowSeconds)),
      );

      let incomplete = 0;
      const ready: [string, PreparedGroup][] = [];
      for (const [window, cohort] of cohorts) {
        if (
          cohort.invalid ||
          cohort.expected === 0 ||
          cohort.accounts.size !== cohort.expected ||
          cohort.accounts.size > maxAccountsPerCohort
        ) {
          if (cohort.expected > 0) incomplete++;
          continue;
        }
        const groups = [...cohort.groups];
        if (
          groups.length > maxGroups ||
          groups.some(
            ([, group]) =>
              group.invalid ||
              group.readings.size > maxAccountsPerCohort ||
              new Set([...group.readings.values()].map((reading) => JSON.stringify(reading.plan)))
                .size > maxPlansPerGroup ||
              new Set(
                [...group.readings.values()].map((reading) =>
                  JSON.stringify([reading.source, reading.revision]),
                ),
              ).size > maxWeightKindsPerGroup,
          )
        ) {
          incomplete++;
          continue;
        }
        // Coverage counts distinct accounts across all incompatible unit groups.
        const groupAccounts = new Set(groups.flatMap(([, group]) => [...group.readings.keys()]));
        if (groupAccounts.size !== cohort.expected) {
          incomplete++;
          continue;
        }
        for (const entry of groups) ready.push(entry);
        if (!groups.length && expected.has(window) && cohort.expected > 0) incomplete++;
      }
      const weeklyRemaining = new Map(
        validCurrent
          .filter((reading) => reading.windowSeconds === 604_800)
          .map((reading) => [
            JSON.stringify([reading.provider, reading.account]),
            reading.remaining > 0,
          ]),
      );
      for (const [, group] of ready)
        if (group.windowSeconds === 18_000) {
          group.weeklyUsability = new Map(
            [...group.readings.values()].map((reading) => [
              reading.account,
              weeklyRemaining.get(JSON.stringify([reading.provider, reading.account])) ?? null,
            ]),
          );
        }

      const groups = { ...index.groups };
      for (const [key, cursor] of Object.entries(groups))
        if (cursor.at < firstRetainedHour) delete groups[key];
      const dayWrites = new Map<string, DayHistory>();
      const writes = new Map<string, unknown>();
      const deletes: string[] = [];
      const demandFrom = hourOf(snapshot.at) - (13 * weekHours - 1) * hourMs;
      const oldDemandFrom = index.demandFrom ?? index.fromHour;
      if (dayOf(demandFrom) > dayOf(oldDemandFrom)) {
        const expiredDays = index.days.filter(
          (day) => day >= dayOf(oldDemandFrom) && day < dayOf(demandFrom),
        );
        const expired = await this.storage.getMany<DayHistory>(
          expiredDays.map((day) => dayKey(pool, day)),
        );
        for (const day of expiredDays) {
          const history = expired.get(dayKey(pool, day));
          if (!history?.demand?.length) continue;
          history.demand = undefined;
          dayWrites.set(day, history);
        }
      }
      const previous =
        index.lastAt !== null && snapshot.at - index.lastAt <= maxDemandSampleGap
          ? (index.previous ?? [])
          : [];
      const priorLatestByKey = new Map(
        (index.latest ?? previous).map((reading) => [readingKey(reading), reading]),
      );
      const latestByKey = new Map(priorLatestByKey);
      const accountHash = async (account: string) => digest(`${pool}\u0000${account}`);
      const hashedCurrent = await Promise.all(
        validCurrent.map(async (reading) => ({
          ...reading,
          account: await accountHash(reading.account),
        })),
      );
      for (const reading of hashedCurrent) {
        for (const [key, old] of latestByKey)
          if (
            old.account === reading.account &&
            old.provider === reading.provider &&
            old.windowSeconds === reading.windowSeconds &&
            key !== readingKey(reading)
          )
            latestByKey.delete(key);
        latestByKey.set(readingKey(reading), reading);
      }
      const revisions = (readings: Iterable<CapacityReading>) => {
        const groups = new Map<string, Set<string>>();
        for (const reading of readings) {
          const key = groupKey(
            reading.provider,
            reading.windowSeconds,
            reading.mode,
            reading.unit.id,
          );
          const values = groups.get(key) ?? new Set<string>();
          values.add(reading.revision);
          groups.set(key, values);
        }
        return new Map(
          [...groups].map(([key, values]) => [key, JSON.stringify([...values].sort())]),
        );
      };
      const oldPolicies =
        index.demandRevisions ??
        Object.fromEntries(
          [...revisions(priorLatestByKey.values())].map(([key, revision]) => [
            key,
            { revision, at: index.lastAt ?? snapshot.at },
          ]),
        );
      const oldRevisions = new Map(
        Object.entries(oldPolicies).map(([key, policy]) => [key, policy.revision]),
      );
      const currentRevisions = revisions(latestByKey.values());
      const changedGroups = new Set(
        [...currentRevisions]
          .filter(([key, value]) => index.lastAt !== null && oldRevisions.get(key) !== value)
          .map(([key]) => key),
      );
      for (const reading of hashedCurrent) {
        const old = priorLatestByKey.get(readingKey(reading));
        if (old !== undefined && old.revision !== reading.revision)
          changedGroups.add(
            groupKey(reading.provider, reading.windowSeconds, reading.mode, reading.unit.id),
          );
      }
      // Hourly demand has no revision provenance. Only the changed cohort loses its
      // mixed hour and older training; its boundary survives empty membership.
      const demandSinceByGroup = { ...index.demandSinceByGroup };
      const demandShares = structuredClone(index.demandShares ?? {});
      const rollingUse = structuredClone(index.rollingUse ?? {});
      const rollingChain = structuredClone(index.rollingChain ?? {});
      for (const group of changedGroups) {
        demandSinceByGroup[group] = Math.ceil(snapshot.at / hourMs) * hourMs;
        delete demandShares[group];
        delete rollingUse[group];
        delete rollingChain[group];
      }
      const oldestShareWeek = weekOf(snapshot.at) - 13 * 7 * dayMs;
      const rollingCutoff = snapshot.at - 6 * 60 * 60_000;
      for (const accounts of Object.values(demandShares))
        for (const [account, weeks] of Object.entries(accounts)) {
          const kept = weeks.filter((entry) => entry.week >= oldestShareWeek);
          if (kept.length) accounts[account] = kept;
          else delete accounts[account];
        }
      for (const [group, accounts] of Object.entries(rollingUse))
        for (const [account, uses] of Object.entries(accounts)) {
          const kept = uses.filter((entry) => entry.at > rollingCutoff);
          if (kept.length) accounts[account] = kept;
          else if (rollingChain[group]?.[account]?.complete) accounts[account] = [];
          else delete accounts[account];
        }
      const previousByKey = new Map(previous.map((reading) => [readingKey(reading), reading]));
      const hashedCurrentBySource = new Map(
        validCurrent.map((reading, index) => [readingKey(reading), hashedCurrent[index]!]),
      );
      const nextAccountStates = snapshot.accountStates
        ? await Promise.all(
            snapshot.accountStates.map(async (state) => ({
              ...state,
              account: await accountHash(state.account),
            })),
          )
        : (index.accountStates ?? []);
      const unclassifiedAccounts = snapshot.unclassifiedAccounts
        ? await Promise.all(
            snapshot.unclassifiedAccounts.map(async (entry) => ({
              ...entry,
              account: await accountHash(entry.account),
            })),
          )
        : (index.unclassifiedAccounts ?? []);
      const activeRollingAccounts = new Set(
        nextAccountStates
          .filter((state) => state.windowSeconds === 18_000)
          .map((state) => JSON.stringify([state.provider, state.account])),
      );
      for (const [group, accounts] of Object.entries(rollingChain)) {
        const [provider, windowSeconds, mode] = JSON.parse(group) as [
          string,
          number,
          string | null,
          string,
        ];
        if (windowSeconds !== 18_000 || !mode?.toLowerCase().includes("rolling")) continue;
        for (const account of Object.keys(accounts))
          if (!activeRollingAccounts.has(JSON.stringify([provider, account])))
            delete accounts[account];
      }
      for (const [group, accounts] of Object.entries(rollingUse)) {
        const [provider, windowSeconds, mode] = JSON.parse(group) as [
          string,
          number,
          string | null,
          string,
        ];
        if (windowSeconds !== 18_000 || !mode?.toLowerCase().includes("rolling")) continue;
        for (const account of Object.keys(accounts))
          if (!activeRollingAccounts.has(JSON.stringify([provider, account])))
            delete accounts[account];
      }
      if (snapshot.accountStates) {
        const active = new Set(
          nextAccountStates.map((state) =>
            JSON.stringify([state.account, state.provider, state.windowSeconds]),
          ),
        );
        for (const [key, reading] of latestByKey)
          if (
            !active.has(JSON.stringify([reading.account, reading.provider, reading.windowSeconds]))
          )
            latestByKey.delete(key);
      }
      const bankedReceipts = new Map(
        Object.entries(index.bankedReceipts ?? {}).filter(([, at]) => at >= firstRetainedHour),
      );
      const currentGroupCounts = new Map<string, number>();
      const previousGroupCounts = new Map<string, number>();
      const cohortGroup = (reading: CapacityReading) =>
        groupKey(reading.provider, reading.windowSeconds, reading.mode, reading.unit.id);
      const latestGroupCounts = new Map<string, number>();
      const latestGroupWeights = new Map<string, number>();
      const latestWindowAccounts = new Map<string, Set<string>>();
      const expectedWindowAccounts = new Map<string, Set<string>>();
      for (const reading of validCurrent)
        currentGroupCounts.set(
          cohortGroup(reading),
          (currentGroupCounts.get(cohortGroup(reading)) ?? 0) + 1,
        );
      for (const reading of previous)
        previousGroupCounts.set(
          cohortGroup(reading),
          (previousGroupCounts.get(cohortGroup(reading)) ?? 0) + 1,
        );
      for (const reading of latestByKey.values()) {
        const group = cohortGroup(reading),
          window = windowKey(reading.provider, reading.windowSeconds);
        latestGroupCounts.set(group, (latestGroupCounts.get(group) ?? 0) + 1);
        latestGroupWeights.set(group, (latestGroupWeights.get(group) ?? 0) + reading.full);
        const accounts = latestWindowAccounts.get(window) ?? new Set<string>();
        accounts.add(reading.account);
        latestWindowAccounts.set(window, accounts);
      }
      for (const state of nextAccountStates) {
        const window = windowKey(state.provider, state.windowSeconds);
        const accounts = expectedWindowAccounts.get(window) ?? new Set<string>();
        accounts.add(state.account);
        expectedWindowAccounts.set(window, accounts);
      }
      const unmappedWindows = new Set<string>();
      for (const [window, accounts] of expectedWindowAccounts) {
        const mapped = latestWindowAccounts.get(window) ?? new Set<string>();
        if ([...accounts].some((account) => !mapped.has(account))) unmappedWindows.add(window);
      }
      for (const entry of unclassifiedAccounts)
        for (const cohort of expected.values())
          if (entry.provider === cohort.provider)
            unmappedWindows.add(windowKey(cohort.provider, cohort.windowSeconds));
      const intervals = new Map<
        string,
        {
          reading: CapacityReading;
          from: number;
          to: number;
          elapsed: number;
          delta: number;
          censored: boolean;
        }[]
      >();
      const observedRefills = new Map<string, StoredRefill>();
      const censoredGroups = new Set<string>();
      for (const reading of validCurrent) {
        const hashed = hashedCurrentBySource.get(readingKey(reading))!;
        const old = previousByKey.get(readingKey(hashed));
        const group = cohortGroup(reading);
        if (reading.windowSeconds === 18_000 && reading.mode?.toLowerCase().includes("rolling")) {
          const chainByAccount = (rollingChain[group] ??= {});
          const eventsByAccount = (rollingUse[group] ??= {});
          const knownEvents = eventsByAccount[hashed.account];
          const events = knownEvents ?? [];
          const prior = chainByAccount[hashed.account];
          let complete = false;
          let use = 0;
          const elapsed = old ? reading.observedAt - old.observedAt : 0;
          const sameSource = old?.observedAt === reading.observedAt;
          const windowMs = reading.windowSeconds * 1_000;
          const journalComplete = rollingJournalIsComplete(
            prior,
            knownEvents,
            reading.windowSeconds,
          );
          const unchangedSource =
            old &&
            prior &&
            sameSource &&
            prior.at === reading.observedAt &&
            prior.full === reading.full &&
            prior.remaining === reading.remaining &&
            prior.revision === reading.revision &&
            prior.resetAt === reading.resetAt &&
            sameReading(old, { ...reading, account: hashed.account });
          if (unchangedSource) {
            if (prior.complete && !journalComplete) {
              eventsByAccount[hashed.account] = [];
              chainByAccount[hashed.account] = { ...prior, complete: false };
            }
            continue;
          }
          if (!sameSource && reading.remaining === reading.full) {
            complete = true;
            eventsByAccount[hashed.account] = [];
          } else if (
            !sameSource &&
            prior?.complete &&
            journalComplete &&
            old &&
            old.revision === reading.revision &&
            old.full === reading.full &&
            prior.revision === reading.revision &&
            prior.full === reading.full &&
            prior.resetAt === reading.resetAt &&
            prior.at === old.observedAt &&
            elapsed > 0 &&
            elapsed <= 15 * 60_000
          ) {
            const expired = events.filter(
              (event) =>
                event.at + windowMs > old.observedAt && event.at + windowMs <= reading.observedAt,
            );
            use =
              prior.remaining +
              expired.reduce((total, event) => total + event.amount, 0) -
              reading.remaining;
            complete = Number.isFinite(use) && use >= 0 && use <= reading.full;
            if (complete) {
              eventsByAccount[hashed.account] = events.filter(
                (event) => event.at + windowMs > reading.observedAt,
              );
              if (use > 0)
                eventsByAccount[hashed.account]!.push({ at: reading.observedAt, amount: use });
              const items = intervals.get(group) ?? [];
              items.push({
                reading,
                from: old.observedAt,
                to: reading.observedAt,
                elapsed,
                delta: use,
                censored: old.remaining <= 1e-9 || reading.remaining <= 1e-9,
              });
              intervals.set(group, items);
              if (reading.remaining <= 1e-9) complete = false;
            }
          }
          if (!complete) {
            eventsByAccount[hashed.account] = [];
            if (
              prior?.complete &&
              old &&
              elapsed > 0 &&
              elapsed <= 15 * 60_000 &&
              prior.revision === reading.revision &&
              prior.full === reading.full &&
              prior.resetAt === reading.resetAt &&
              (old.remaining <= 1e-9 || reading.remaining <= 1e-9)
            ) {
              const items = intervals.get(group) ?? [];
              items.push({
                reading,
                from: old.observedAt,
                to: reading.observedAt,
                elapsed,
                delta: Math.max(0, old.remaining - reading.remaining),
                censored: true,
              });
              intervals.set(group, items);
              censoredGroups.add(group);
            }
          }
          chainByAccount[hashed.account] = {
            at: reading.observedAt,
            full: reading.full,
            remaining: reading.remaining,
            resetAt: reading.resetAt,
            revision: reading.revision,
            complete,
          };
          continue;
        }
        if (
          !old ||
          old.revision !== reading.revision ||
          old.full !== reading.full ||
          reading.observedAt <= old.observedAt
        )
          continue;
        if (old.resetAt !== reading.resetAt) {
          if (
            reading.windowSeconds === 604_800 &&
            old.resetAt !== null &&
            old.resetAt > old.observedAt &&
            old.resetAt <= reading.observedAt &&
            reading.resetAt !== null &&
            reading.resetAt > old.resetAt
          ) {
            const refillAt = old.resetAt;
            const id = JSON.stringify([
              reading.provider,
              reading.windowSeconds,
              reading.mode,
              reading.unit.id,
              old.resetAt,
            ]);
            const amount = Math.max(0, reading.full - old.remaining);
            const existing = observedRefills.get(id);
            if (existing) existing.amount += amount;
            else
              observedRefills.set(id, {
                provider: reading.provider,
                windowSeconds: reading.windowSeconds,
                mode: reading.mode,
                unitId: reading.unit.id,
                at: refillAt,
                amount,
                amountIsLowerBound: true,
                kind: "observed",
              });
            const elapsed = reading.observedAt - old.resetAt;
            if (elapsed > 0 && reading.observedAt - old.observedAt <= maxFixedSourceGap) {
              const items = intervals.get(group) ?? [];
              items.push({
                reading,
                from: old.resetAt,
                to: reading.observedAt,
                elapsed,
                delta: Math.max(0, reading.full - reading.remaining),
                censored: reading.remaining <= 1e-9,
              });
              intervals.set(group, items);
            }
          }
          if (old.remaining <= 1e-9 || reading.remaining <= 1e-9) censoredGroups.add(group);
          continue;
        }
        const elapsed = reading.observedAt - old.observedAt;
        if (
          elapsed < 1_000 ||
          elapsed > (fixedDemandWindow(reading) ? maxFixedSourceGap : maxDemandSampleGap)
        )
          continue;
        if (reading.remaining > old.remaining) {
          if (old.remaining <= 1e-9 || reading.remaining <= 1e-9) censoredGroups.add(group);
          continue;
        }
        const items = intervals.get(group) ?? [];
        items.push({
          reading,
          from: old.observedAt,
          to: reading.observedAt,
          elapsed,
          delta: old.remaining - reading.remaining,
          censored: old.remaining <= 1e-9 || reading.remaining <= 1e-9,
        });
        intervals.set(group, items);
      }
      for (const state of nextAccountStates) {
        if (state.windowSeconds !== 604_800) continue;
        for (const receipt of state.bankedUsed ?? []) {
          if (!receipt.id || !Number.isFinite(receipt.at) || bankedReceipts.has(receipt.id))
            continue;
          const priorReading = [...priorLatestByKey.values()].find(
            (entry) =>
              entry.account === state.account &&
              entry.provider === state.provider &&
              entry.windowSeconds === state.windowSeconds,
          );
          const reading = hashedCurrent.find(
            (entry) =>
              entry.account === state.account &&
              entry.provider === state.provider &&
              entry.windowSeconds === state.windowSeconds,
          );
          if (
            !priorReading ||
            !reading ||
            priorReading.full !== reading.full ||
            priorReading.revision !== reading.revision ||
            priorReading.observedAt > receipt.at ||
            reading.observedAt < receipt.at
          )
            continue;
          const amount = Math.max(0, reading.remaining - priorReading.remaining);
          observedRefills.set(`banked:${receipt.id}`, {
            provider: state.provider,
            windowSeconds: state.windowSeconds,
            mode: reading.mode,
            unitId: reading.unit.id,
            at: receipt.at,
            amount,
            amountIsLowerBound: true,
            kind: "banked",
          });
          bankedReceipts.set(receipt.id, receipt.at);
        }
      }
      const addDemand = async (entry: StoredDemand) => {
        const day = dayOf(entry.hour);
        let history = dayWrites.get(day);
        if (!history) {
          history = (await this.storage.get<DayHistory>(dayKey(pool, day))) ?? {
            version: 1,
            points: [],
          };
          dayWrites.set(day, history);
        }
        const existing = history.demand?.find(
          (value) =>
            value.provider === entry.provider &&
            value.windowSeconds === entry.windowSeconds &&
            value.mode === entry.mode &&
            value.unit.id === entry.unit.id &&
            value.hour === entry.hour,
        );
        if (existing) {
          existing.demand += entry.demand;
          existing.exposureSeconds += entry.exposureSeconds;
          existing.expectedSeconds += entry.expectedSeconds;
          existing.censored ||= entry.censored;
          existing.membershipIncomplete ||= entry.membershipIncomplete;
          existing.sourceFrom = Math.min(existing.sourceFrom, entry.sourceFrom);
          existing.sourceTo = Math.max(existing.sourceTo, entry.sourceTo);
        } else history.demand = [...(history.demand ?? []), entry];
      };
      const allDemandGroups = new Set([
        ...currentGroupCounts.keys(),
        ...previousGroupCounts.keys(),
      ]);
      for (const group of allDemandGroups) {
        const providerWindow = JSON.parse(group) as [string, number, string | null, string];
        const expectedAccounts = Math.max(
          currentGroupCounts.get(group) ?? 0,
          previousGroupCounts.get(group) ?? 0,
          latestGroupCounts.get(group) ?? 0,
        );
        const expectedWeight = latestGroupWeights.get(group) ?? 0;
        const currentSample = validCurrent.find((reading) => cohortGroup(reading) === group);
        const previousSample = previous.find((reading) => cohortGroup(reading) === group);
        const unit = currentSample?.unit ?? previousSample?.unit;
        if (!expectedAccounts || !unit || index.lastAt === null) continue;
        // A stale sampler gap has no measured exposure to add to the forecast history.
        const demandStart =
          snapshot.at - index.lastAt > maxDemandSampleGap ? snapshot.at : index.lastAt;
        const from = Math.max(demandStart, firstRetainedHour, demandFrom);
        for (let hour = hourOf(from); hour < snapshot.at; hour += hourMs) {
          const overlap = Math.max(0, Math.min(snapshot.at, hour + hourMs) - Math.max(from, hour));
          if (overlap)
            await addDemand({
              provider: providerWindow[0],
              windowSeconds: providerWindow[1],
              mode: providerWindow[2],
              unit,
              hour,
              demand: 0,
              exposureSeconds: 0,
              expectedSeconds: overlap * expectedWeight,
              censored: censoredGroups.has(group),
              membershipIncomplete: unmappedWindows.has(
                windowKey(providerWindow[0], providerWindow[1]),
              ),
              sourceFrom: from,
              sourceTo: snapshot.at,
            });
        }
      }
      for (const [group, samples] of intervals) {
        const first = samples[0]!.reading;
        const expectedAccounts = Math.max(
          currentGroupCounts.get(group) ?? 0,
          previousGroupCounts.get(group) ?? 0,
          latestGroupCounts.get(group) ?? 0,
        );
        const observedAccounts = new Set(samples.map((sample) => sample.reading.account)).size;
        if (!expectedAccounts || !observedAccounts) continue;
        const expectedWeight =
          latestGroupWeights.get(group) ??
          samples.reduce((total, sample) => total + sample.reading.full, 0);
        const observedWeight = samples.reduce((total, sample) => total + sample.reading.full, 0);
        if (expectedWeight <= 0 || observedWeight <= 0) continue;
        for (const sample of samples) {
          const sampleFrom = Math.max(sample.from, demandSinceByGroup[group] ?? sample.from);
          if (sampleFrom >= sample.to) continue;
          const contributionId = await accountHash(sample.reading.account);
          const accounts = (demandShares[group] ??= {});
          const weeks = (accounts[contributionId] ??= []);
          const week = weekOf(sample.to);
          const current = weeks.find((entry) => entry.week === week);
          const contribution = sample.delta * ((sample.to - sampleFrom) / sample.elapsed);
          if (current) current.amount += contribution;
          else weeks.push({ week, amount: contribution });
          const firstHour = hourOf(sampleFrom);
          for (let hour = firstHour; hour < sample.to; hour += hourMs) {
            const overlap = Math.max(
              0,
              Math.min(sample.to, hour + hourMs) - Math.max(sampleFrom, hour),
            );
            if (!overlap) continue;
            const demand = (sample.delta * overlap) / sample.elapsed;
            await addDemand({
              provider: first.provider,
              windowSeconds: first.windowSeconds,
              mode: first.mode,
              unit: first.unit,
              hour,
              demand,
              exposureSeconds: overlap * sample.reading.full,
              expectedSeconds: 0,
              censored: sample.censored,
              membershipIncomplete: unmappedWindows.has(
                windowKey(first.provider, first.windowSeconds),
              ),
              sourceFrom: sample.from,
              sourceTo: sample.to,
            });
          }
        }
      }
      for (const refill of observedRefills.values()) {
        const day = dayOf(refill.at);
        let history = dayWrites.get(day);
        if (!history) {
          history = (await this.storage.get<DayHistory>(dayKey(pool, day))) ?? {
            version: 1,
            points: [],
          };
          dayWrites.set(day, history);
        }
        const id = JSON.stringify([
          refill.provider,
          refill.windowSeconds,
          refill.mode,
          refill.unitId,
          refill.at,
          refill.kind,
        ]);
        const existing = history.refills?.find(
          (event) =>
            JSON.stringify([
              event.provider,
              event.windowSeconds,
              event.mode,
              event.unitId,
              event.at,
              event.kind,
            ]) === id,
        );
        if (existing) existing.amount += refill.amount;
        else history.refills = [...(history.refills ?? []), refill];
      }
      let updated = 0;
      for (const [key, group] of ready) {
        const point = pointFor(group, snapshot.at, key);
        const source = await fingerprint(point);
        if (groups[key]?.fingerprint === source) continue;
        if (!groups[key] && Object.keys(groups).length >= maxGroups) {
          incomplete++;
          continue;
        }
        const day = dayOf(snapshot.at);
        let history = dayWrites.get(day);
        if (!history) {
          history = (await this.storage.get<DayHistory>(dayKey(pool, day))) ?? {
            version: 1,
            points: [],
          };
          dayWrites.set(day, history);
        }
        const existing = history.points.findIndex(
          (entry) => entry.key === key && entry.hour === point.hour,
        );
        if (existing < 0) history.points.push(point);
        else history.points[existing] = updatePoint(history.points[existing], point);
        groups[key] = { at: snapshot.at, fingerprint: source };
        updated++;
      }

      // Each UTC day is a separate value. The index is bounded by the rolling 400-day range.
      const currentDay = dayOf(snapshot.at);
      const candidateDays = new Set(index.days);
      if (dayWrites.size) candidateDays.add(currentDay);
      const cutoffDay = dayOf(firstRetainedHour);
      for (const day of candidateDays)
        if (day < cutoffDay || day > currentDay) candidateDays.delete(day);
      if (firstRetainedHour > index.fromHour && candidateDays.has(cutoffDay)) {
        let boundary = dayWrites.get(cutoffDay);
        if (!boundary) {
          boundary = (await this.storage.get<DayHistory>(dayKey(pool, cutoffDay))) ?? {
            version: 1,
            points: [],
          };
          dayWrites.set(cutoffDay, boundary);
        }
        boundary.points = boundary.points.filter((point) => point.hour >= firstRetainedHour);
        if (boundary.demand)
          boundary.demand = boundary.demand.filter((point) => point.hour >= firstRetainedHour);
        if (boundary.refills)
          boundary.refills = boundary.refills.filter((event) => event.at >= firstRetainedHour);
      }
      for (const [day, history] of dayWrites) {
        history.points = history.points.filter(
          (point) => point.hour >= firstRetainedHour && point.hour <= hourOf(snapshot.at),
        );
        history.demand = history.demand?.filter(
          (point) => point.hour >= firstRetainedHour && point.hour <= hourOf(snapshot.at),
        );
        history.refills = history.refills?.filter(
          (event) => event.at >= firstRetainedHour && event.at <= snapshot.at,
        );
        history.points.sort(
          (a, b) =>
            a.hour - b.hour ||
            a.provider.localeCompare(b.provider) ||
            a.windowSeconds - b.windowSeconds ||
            (a.mode ?? "").localeCompare(b.mode ?? "") ||
            a.unit.id.localeCompare(b.unit.id),
        );
        history.demand?.sort(
          (a, b) =>
            a.hour - b.hour ||
            a.provider.localeCompare(b.provider) ||
            a.windowSeconds - b.windowSeconds ||
            a.unit.id.localeCompare(b.unit.id),
        );
        history.refills?.sort((a, b) => a.at - b.at || a.provider.localeCompare(b.provider));
        if (!history.points.length && !history.demand?.length && !history.refills?.length) {
          candidateDays.delete(day);
          deletes.push(dayKey(pool, day));
        } else {
          candidateDays.add(day);
          writes.set(dayKey(pool, day), history);
        }
      }
      for (const day of index.days) if (!candidateDays.has(day)) deletes.push(dayKey(pool, day));

      const days = [...candidateDays].sort();
      if (days.length > maxIndexedDays)
        throw new Error("Capacity history day index exceeded its bound");
      writes.set(indexId, {
        version: 1,
        days,
        lastAt: snapshot.at,
        fromHour: firstRetainedHour,
        groups,
        trackingSince: index.trackingSince ?? snapshot.at,
        // This cursor only compares historical fixed-window sources. Expired readings
        // never enter current capacity or rolling reconstruction through this path.
        previous: [
          ...previous
            .filter((reading) => fixedDemandWindow(reading))
            .filter(
              (reading) =>
                snapshot.at - reading.observedAt <= maxFixedSourceGap &&
                !hashedCurrent.some(
                  (current) =>
                    current.account === reading.account &&
                    current.provider === reading.provider &&
                    current.windowSeconds === reading.windowSeconds,
                ) &&
                nextAccountStates.some(
                  (state) =>
                    state.account === reading.account &&
                    state.provider === reading.provider &&
                    state.windowSeconds === reading.windowSeconds &&
                    state.sourceContinuous === true,
                ),
            ),
          ...hashedCurrent,
        ],
        previousExpected: [...expected.values()],
        latest: [...latestByKey.values()],
        accountStates: nextAccountStates,
        bankedReceipts: Object.fromEntries(bankedReceipts),
        unclassifiedAccounts,
        demandFrom,
        demandSinceByGroup: Object.fromEntries(
          Object.entries(demandSinceByGroup).filter(([, since]) => since >= demandFrom),
        ),
        demandRevisions: Object.fromEntries(
          [
            ...new Map([
              ...Object.entries(oldPolicies),
              ...[...currentRevisions].map(
                ([key, revision]) => [key, { revision, at: snapshot.at }] as const,
              ),
            ]),
          ].filter(([, policy]) => policy.at >= demandFrom),
        ),
        demandShares,
        rollingUse,
        rollingChain,
      } satisfies HistoryIndex);
      await this.storage.commit(writes, [...new Set(deletes)], pending);
      return { accepted: true, groups: updated, incomplete };
    });
  }

  read(pool: string, range: CapacityHistoryRange = {}): Promise<CapacityHistoryPoint[]> {
    return this.queue.run(async () => {
      await this.storage.recover(pendingKey(pool));
      const index = await this.storage.get<HistoryIndex>(indexKey(pool));
      if (!index || index.version !== 1 || index.lastAt === null) return [];
      const from = range.from ?? index.fromHour;
      const to = range.to ?? index.lastAt + 1;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from)
        throw new Error("Invalid capacity history range");
      if (to === from) return [];
      const startDay = dayOf(Math.max(from, index.fromHour));
      const endDay = dayOf(to - 1);
      const days = index.days.filter((day) => day >= startDay && day <= endDay);
      const stored = await this.storage.getMany<DayHistory>(days.map((day) => dayKey(pool, day)));
      return days
        .flatMap((day) => stored.get(dayKey(pool, day))?.points ?? [])
        .filter(
          (point) =>
            point.hour >= index.fromHour &&
            point.hour >= from &&
            point.hour < to &&
            point.last.at <= to,
        )
        .map(({ key: _key, ...point }) => point)
        .sort(
          (a, b) =>
            a.hour - b.hour ||
            a.provider.localeCompare(b.provider) ||
            a.windowSeconds - b.windowSeconds ||
            (a.mode ?? "").localeCompare(b.mode ?? "") ||
            a.unit.id.localeCompare(b.unit.id),
        );
    });
  }

  /** Server-only demand input for seasonal forecasts; account keys are one-way digests. */
  demandData(pool: string, from?: number): Promise<CapacityDemandData> {
    return this.queue.run(async () => {
      await this.storage.recover(pendingKey(pool));
      const index = await this.storage.get<HistoryIndex>(indexKey(pool));
      if (!index || index.version !== 1 || index.lastAt === null)
        return {
          trackingSince: null,
          readAt: null,
          completedWeeks: 0,
          points: [],
          latestReadings: [],
          accountStates: [],
          unclassifiedProviders: [],
          accountDemandTotals: {},
          rollingUse: {},
          rollingComplete: {},
          refills: [],
        };
      const first = Math.max(
        index.fromHour,
        index.demandFrom ?? index.fromHour,
        from ?? index.demandFrom ?? index.fromHour,
      );
      const startDay = dayOf(first),
        endDay = dayOf(index.lastAt);
      const days = index.days.filter((day) => day >= startDay && day <= endDay);
      const stored = await this.storage.getMany<DayHistory>(days.map((day) => dayKey(pool, day)));
      const histories = days.flatMap((day) =>
        stored.get(dayKey(pool, day)) ? [stored.get(dayKey(pool, day))!] : [],
      );
      const points = histories
        .flatMap((history) => history.demand ?? [])
        .filter(
          (point) =>
            point.hour >=
              Math.max(
                first,
                index.demandSinceByGroup?.[
                  groupKey(point.provider, point.windowSeconds, point.mode, point.unit.id)
                ] ?? first,
              ) && point.hour <= hourOf(index.lastAt!),
        )
        .map((point): CapacityDemandPoint => ({
          provider: point.provider,
          windowSeconds: point.windowSeconds,
          mode: point.mode,
          unit: point.unit,
          hour: point.hour,
          demand: point.exposureSeconds > 0 ? point.demand : null,
          coverage: point.membershipIncomplete
            ? 0
            : point.expectedSeconds > 0
              ? Math.max(0, Math.min(1, point.exposureSeconds / point.expectedSeconds))
              : 0,
          censored: point.censored,
          membershipIncomplete: point.membershipIncomplete,
          sourceAt: { from: point.sourceFrom, to: point.sourceTo },
        }))
        .sort(
          (a, b) =>
            a.hour - b.hour ||
            a.provider.localeCompare(b.provider) ||
            a.windowSeconds - b.windowSeconds ||
            a.unit.id.localeCompare(b.unit.id),
        );
      const trackingSince = index.trackingSince ?? null;
      const currentWeek = weekOf(index.lastAt);
      const firstWeek =
        trackingSince === null
          ? currentWeek
          : weekOf(trackingSince) + (trackingSince > weekOf(trackingSince) ? 7 * dayMs : 0);
      const completedWeeks = Math.max(0, Math.floor((currentWeek - firstWeek) / (7 * dayMs)));
      const refills = histories
        .flatMap((history) => history.refills ?? [])
        .filter(
          (refill) =>
            refill.at >=
            Math.max(
              first,
              index.demandSinceByGroup?.[
                groupKey(refill.provider, refill.windowSeconds, refill.mode, refill.unitId)
              ] ?? first,
            ),
        );
      const oldestShareWeek = weekOf(index.lastAt) - 13 * 7 * dayMs;
      const accountDemandTotals: Record<string, Record<string, number>> = {};
      for (const [group, accounts] of Object.entries(index.demandShares ?? {})) {
        accountDemandTotals[group] = Object.fromEntries(
          Object.entries(accounts).map(([account, weeks]) => [
            account,
            weeks
              .filter((entry) => entry.week >= oldestShareWeek)
              .reduce((total, entry) => total + entry.amount, 0),
          ]),
        );
      }
      const rollingCutoff = index.lastAt - 6 * 60 * 60_000;
      const rollingUse: Record<string, Record<string, { at: number; amount: number }[]>> = {};
      for (const [group, accounts] of Object.entries(index.rollingUse ?? {})) {
        rollingUse[group] = Object.fromEntries(
          Object.entries(accounts)
            .map(([account, uses]) => [account, uses.filter((entry) => entry.at > rollingCutoff)])
            .filter(([, uses]) => uses.length > 0),
        );
      }
      const rollingComplete: Record<string, Record<string, { at: number; complete: boolean }>> = {};
      for (const [group, accounts] of Object.entries(index.rollingChain ?? {}))
        rollingComplete[group] = Object.fromEntries(
          Object.entries(accounts).map(([account, chain]) => [
            account,
            { at: chain.at, complete: chain.complete },
          ]),
        );
      return {
        trackingSince,
        cohortTrackingSince: index.demandSinceByGroup ?? {},
        readAt: index.lastAt,
        completedWeeks,
        points,
        latestReadings: index.latest ?? [],
        accountStates: index.accountStates ?? [],
        unclassifiedProviders: [
          ...new Set((index.unclassifiedAccounts ?? []).map((entry) => entry.provider)),
        ],
        accountDemandTotals,
        rollingUse,
        rollingComplete,
        refills,
      };
    });
  }
}
