import type { CapacityAggregate, CapacityPlanHistory, CapacityHistoryPoint } from "../../../apps/pool/capacity-contract.ts";
export type { CapacityAggregate, CapacityPlanHistory, CapacityHistoryPoint } from "../../../apps/pool/capacity-contract.ts";
import { digest } from "../backend-users.ts";
import { ChunkStorage, UsageQueue, type UsageStorage } from "../usage-storage.ts";
import type { CapacityReading } from "./normalize.ts";

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
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
const windowKey = (provider: string, windowSeconds: number) => JSON.stringify([provider, windowSeconds]);
const groupKey = (provider: string, windowSeconds: number, mode: string | null, unit: string) => JSON.stringify([provider, windowSeconds, mode, unit]);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

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

interface StoredPoint extends CapacityHistoryPoint { readonly key: string }
interface DayHistory { version: 1; points: StoredPoint[] }
interface GroupCursor { at: number; fingerprint: string }
interface HistoryIndex {
  version: 1;
  days: string[];
  lastAt: number | null;
  fromHour: number;
  groups: Record<string, GroupCursor>;
}
interface PreparedGroup {
  readonly provider: string;
  readonly windowSeconds: number;
  readonly mode: string | null;
  readonly unit: CapacityReading["unit"];
  readonly readings: Map<string, CapacityReading>;
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

function sameReading(a: CapacityReading, b: CapacityReading): boolean {
  return a.provider === b.provider && a.plan === b.plan && a.windowSeconds === b.windowSeconds
    && a.mode === b.mode && a.observedAt === b.observedAt && a.resetAt === b.resetAt && a.staleAt === b.staleAt
    && a.observationSource === b.observationSource && a.full === b.full && a.remaining === b.remaining
    && a.unit.id === b.unit.id && a.unit.label === b.unit.label && a.source === b.source
    && a.knownWeight === b.knownWeight && a.revision === b.revision;
}

function validReading(reading: CapacityReading, at: number): boolean {
  return text(reading.account, 512) && text(reading.provider, 128)
    && Number.isSafeInteger(reading.windowSeconds) && reading.windowSeconds > 0
    && (reading.plan === null || text(reading.plan, 128))
    && Number.isFinite(reading.observedAt) && reading.observedAt <= at
    && (reading.staleAt === null || Number.isFinite(reading.staleAt) && reading.staleAt > at)
    && Number.isFinite(reading.full) && reading.full > 0
    && Number.isFinite(reading.remaining) && reading.remaining >= 0 && reading.remaining <= reading.full
    && text(reading.unit.id, 256) && text(reading.unit.label, 128)
    && text(reading.source, 128) && text(reading.revision, 128)
    && typeof reading.knownWeight === "boolean";
}

function validExpected(value: CapacityExpectedCohort): boolean {
  return text(value.provider, 128) && Number.isSafeInteger(value.windowSeconds) && value.windowSeconds > 0
    && Number.isSafeInteger(value.accounts) && value.accounts >= 0 && value.accounts <= maxAccountsPerCohort;
}

function aggregate(readings: readonly CapacityReading[], at: number): CapacityAggregate {
  // A stable in-memory order avoids floating-point totals changing when source rows reorder.
  const ordered = [...readings].sort((a, b) => a.account.localeCompare(b.account));
  let remaining = 0, full = 0, observedFrom = Infinity, observedTo = -Infinity, knownWeightCount = 0;
  const weights = new Map<string, { source: CapacityReading["source"]; revision: string; accountCount: number }>();
  for (const reading of ordered) {
    remaining += reading.remaining;
    full += reading.full;
    observedFrom = Math.min(observedFrom, reading.observedAt);
    observedTo = Math.max(observedTo, reading.observedAt);
    if (reading.knownWeight) knownWeightCount++;
    const key = JSON.stringify([reading.source, reading.revision]), weight = weights.get(key);
    if (weight) weight.accountCount++;
    else weights.set(key, { source: reading.source, revision: reading.revision, accountCount: 1 });
  }
  const provenance = [...weights.values()].sort((a, b) => a.source.localeCompare(b.source) || a.revision.localeCompare(b.revision));
  return {
    remaining, full, at, observedAt: { from: observedFrom, to: observedTo }, accountCount: ordered.length,
    knownWeightCount, unknownWeightCount: ordered.length - knownWeightCount, weights: provenance,
  };
}

function pointFor(group: PreparedGroup, at: number, key: string): StoredPoint {
  const readings = [...group.readings.values()];
  const byPlan = new Map<string, CapacityReading[]>();
  for (const reading of readings) {
    const key = JSON.stringify(reading.plan);
    byPlan.set(key, [...(byPlan.get(key) ?? []), reading]);
  }
  const plans = [...byPlan.values()].map((rows) => ({
    plan: rows[0]!.plan, minimum: aggregate(rows, at), last: aggregate(rows, at),
  })).sort((a, b) => (a.plan ?? "").localeCompare(b.plan ?? ""));
  return {
    key, provider: group.provider, windowSeconds: group.windowSeconds, mode: group.mode, unit: group.unit, hour: hourOf(at),
    minimum: aggregate(readings, at), last: aggregate(readings, at), plans,
  };
}

function updatePoint(old: StoredPoint | undefined, current: StoredPoint): StoredPoint {
  if (!old) return current;
  const currentPlans = new Map(current.plans.map((plan) => [JSON.stringify(plan.plan), plan.last]));
  const oldPlans = new Map(old.plans.map((plan) => [JSON.stringify(plan.plan), plan]));
  const plans = new Map<string, CapacityPlanHistory>();
  for (const key of new Set([...oldPlans.keys(), ...currentPlans.keys()])) {
    const previous = oldPlans.get(key), last = currentPlans.get(key) ?? null;
    const candidate = last ?? previous?.minimum;
    if (candidate === undefined) continue;
    plans.set(key, {
      plan: previous?.plan ?? current.plans.find((plan) => JSON.stringify(plan.plan) === key)!.plan,
      minimum: !previous || candidate.remaining < previous.minimum.remaining ? candidate : previous.minimum,
      last,
    });
  }
  return {
    ...current,
    minimum: current.minimum.remaining < old.minimum.remaining ? current.minimum : old.minimum,
    plans: [...plans.values()].sort((a, b) => (a.plan ?? "").localeCompare(b.plan ?? "")),
  };
}

function fingerprint(point: StoredPoint): Promise<string> {
  const { key: _key, hour: _hour, minimum, last, plans, ...derived } = point;
  const value = (aggregate: CapacityAggregate) => { const { at: _at, ...source } = aggregate; return source; };
  return digest(JSON.stringify({ ...derived, minimum: value(minimum), last: value(last),
    plans: plans.map((plan) => ({ plan: plan.plan, minimum: value(plan.minimum), last: plan.last && value(plan.last) })) }));
}

/** Bounded, derived hourly history. Source account identifiers are never persisted or returned. */
export class CapacityHistory {
  private storage: ChunkStorage;
  readonly queue = new UsageQueue();
  constructor(storage: UsageStorage) { this.storage = new ChunkStorage(storage); }

  observe(pool: string, snapshot: CapacitySnapshot): Promise<CapacityObserveResult> {
    return this.queue.run(async () => {
      const indexId = indexKey(pool), pending = pendingKey(pool);
      await this.storage.recover(pending);
      if (!Number.isFinite(snapshot.at) || snapshot.at < 0) throw new Error("Invalid capacity snapshot time");
      const firstRetainedHour = hourOf(snapshot.at) - (retainedHours - 1) * hourMs;
      const saved = await this.storage.get<HistoryIndex>(indexId);
      if (saved && saved.version !== 1) throw new Error("Unsupported capacity history version");
      const index = saved ?? blankIndex(firstRetainedHour);
      if (index.lastAt !== null && snapshot.at <= index.lastAt) return { accepted: false, groups: 0, incomplete: 0 };

      const expected = new Map<string, CapacityExpectedCohort>();
      const invalidCohorts = new Set<string>();
      for (const cohort of snapshot.expected) {
        if (!validExpected(cohort)) continue;
        const key = windowKey(cohort.provider, cohort.windowSeconds);
        if (expected.has(key)) invalidCohorts.add(key);
        else expected.set(key, cohort);
      }
      const cohorts = new Map<string, Cohort>();
      for (const [key, cohort] of expected) cohorts.set(key, {
        expected: cohort.accounts, accounts: new Set(), groups: new Map(), invalid: invalidCohorts.has(key),
      });

      for (const reading of snapshot.readings) {
        if (!validReading(reading, snapshot.at)) continue;
        const window = windowKey(reading.provider, reading.windowSeconds), cohort = cohorts.get(window);
        if (!cohort) continue;
        cohort.accounts.add(reading.account);
        const id = groupKey(reading.provider, reading.windowSeconds, reading.mode, reading.unit.id);
        let group = cohort.groups.get(id);
        if (!group) {
          group = { provider: reading.provider, windowSeconds: reading.windowSeconds, mode: reading.mode, unit: reading.unit, readings: new Map(), invalid: false };
          cohort.groups.set(id, group);
        } else if (group.unit.label !== reading.unit.label) group.invalid = true;
        const duplicate = group.readings.get(reading.account);
        if (duplicate && !sameReading(duplicate, reading)) group.invalid = true;
        else if (!duplicate) group.readings.set(reading.account, reading);
      }

      let incomplete = 0;
      const ready: [string, PreparedGroup][] = [];
      for (const [window, cohort] of cohorts) {
        if (cohort.invalid || cohort.expected === 0 || cohort.accounts.size !== cohort.expected || cohort.accounts.size > maxAccountsPerCohort) {
          if (cohort.expected > 0) incomplete++;
          continue;
        }
        const groups = [...cohort.groups];
        if (groups.length > maxGroups || groups.some(([, group]) => group.invalid || group.readings.size > maxAccountsPerCohort
          || new Set([...group.readings.values()].map((reading) => JSON.stringify(reading.plan))).size > maxPlansPerGroup
          || new Set([...group.readings.values()].map((reading) => JSON.stringify([reading.source, reading.revision]))).size > maxWeightKindsPerGroup)) {
          incomplete++;
          continue;
        }
        // Coverage counts distinct accounts across all incompatible unit groups.
        const groupAccounts = new Set(groups.flatMap(([, group]) => [...group.readings.keys()]));
        if (groupAccounts.size !== cohort.expected) { incomplete++; continue; }
        for (const entry of groups) ready.push(entry);
        if (!groups.length && expected.has(window) && cohort.expected > 0) incomplete++;
      }

      const groups = { ...index.groups };
      for (const [key, cursor] of Object.entries(groups)) if (cursor.at < firstRetainedHour) delete groups[key];
      const dayWrites = new Map<string, DayHistory>();
      const writes = new Map<string, unknown>();
      const deletes: string[] = [];
      let updated = 0;
      for (const [key, group] of ready) {
        const point = pointFor(group, snapshot.at, key);
        const source = await fingerprint(point);
        if (groups[key]?.fingerprint === source) continue;
        if (!groups[key] && Object.keys(groups).length >= maxGroups) { incomplete++; continue; }
        const day = dayOf(snapshot.at);
        let history = dayWrites.get(day);
        if (!history) {
          history = await this.storage.get<DayHistory>(dayKey(pool, day)) ?? { version: 1, points: [] };
          dayWrites.set(day, history);
        }
        const existing = history.points.findIndex((entry) => entry.key === key && entry.hour === point.hour);
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
      for (const day of candidateDays) if (day < cutoffDay || day > currentDay) candidateDays.delete(day);
      if (firstRetainedHour > index.fromHour && candidateDays.has(cutoffDay)) {
        let boundary = dayWrites.get(cutoffDay);
        if (!boundary) {
          boundary = await this.storage.get<DayHistory>(dayKey(pool, cutoffDay)) ?? { version: 1, points: [] };
          dayWrites.set(cutoffDay, boundary);
        }
        boundary.points = boundary.points.filter((point) => point.hour >= firstRetainedHour);
      }
      for (const [day, history] of dayWrites) {
        history.points = history.points.filter((point) => point.hour >= firstRetainedHour && point.hour <= hourOf(snapshot.at));
        history.points.sort((a, b) => a.hour - b.hour || a.provider.localeCompare(b.provider)
          || a.windowSeconds - b.windowSeconds || (a.mode ?? "").localeCompare(b.mode ?? "") || a.unit.id.localeCompare(b.unit.id));
        if (!history.points.length) { candidateDays.delete(day); deletes.push(dayKey(pool, day)); }
        else { candidateDays.add(day); writes.set(dayKey(pool, day), history); }
      }
      for (const day of index.days) if (!candidateDays.has(day)) deletes.push(dayKey(pool, day));

      const days = [...candidateDays].sort();
      if (days.length > maxIndexedDays) throw new Error("Capacity history day index exceeded its bound");
      writes.set(indexId, { version: 1, days, lastAt: snapshot.at, fromHour: firstRetainedHour, groups } satisfies HistoryIndex);
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
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error("Invalid capacity history range");
      if (to === from) return [];
      const startDay = dayOf(Math.max(from, index.fromHour));
      const endDay = dayOf(to - 1);
      const days = index.days.filter((day) => day >= startDay && day <= endDay);
      const stored = await this.storage.getMany<DayHistory>(days.map((day) => dayKey(pool, day)));
      return days.flatMap((day) => stored.get(dayKey(pool, day))?.points ?? [])
        .filter((point) => point.hour >= index.fromHour && point.hour >= from && point.hour < to)
        .map(({ key: _key, ...point }) => point)
        .sort((a, b) => a.hour - b.hour || a.provider.localeCompare(b.provider)
          || a.windowSeconds - b.windowSeconds || (a.mode ?? "").localeCompare(b.mode ?? "") || a.unit.id.localeCompare(b.unit.id));
    });
  }
}
