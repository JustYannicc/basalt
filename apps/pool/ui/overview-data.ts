import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { PoolOverviewResult, PoolPersonalOverviewResult } from "../overview-contract.ts";
import type { PoolUsageSeriesResult } from "../usage-series-contract.ts";
import type { Result } from "../index.ts";
import type { PoolApi } from "./api.ts";
import type { SeriesQuery, SeriesRead } from "./series-model.ts";
import { coherentOverview } from "./overview-snapshot.ts";

export type RangeDays = 7 | 30;

/** The same UTC hour boundary and end instant drive every answer in one refresh. */
export function seriesRange(
  days: RangeDays,
  now: number,
): Pick<SeriesQuery, "from" | "to" | "bucket"> {
  return {
    from: new Date(Math.floor((now - days * 86_400_000) / 3_600_000) * 3_600_000).toISOString(),
    to: new Date(now).toISOString(),
    bucket: "day",
  };
}

export const managersOnly = (result: Result<unknown> | undefined) =>
  result !== undefined &&
  !result.ok &&
  result.error === "unauthorized" &&
  /managers only/i.test(result.message);

export interface Overview {
  readonly capacity?: Result<PoolCapacityHistory>;
  readonly usage?: Result<PoolOverviewResult>;
  readonly personal?: Result<PoolPersonalOverviewResult>;
  readonly people?: Result<SeriesRead>;
  readonly models?: Result<SeriesRead>;
  /** True only when this refresh has a matching capacity and usage pair. */
  readonly coherent?: boolean;
}

/** What one refresh has received so far. Pieces from different refreshes never share one. */
interface OverviewPieces {
  readonly capacity?: Result<PoolCapacityHistory>;
  readonly usage?: Result<PoolOverviewResult>;
  readonly personal?: Result<PoolPersonalOverviewResult>;
}

const refresh = 5 * 60_000;

export function seriesRead(result: PoolUsageSeriesResult, partial: boolean): SeriesRead {
  return {
    groups: result.groups,
    coverage: result.coverage,
    asOf: result.asOf,
    asOfChanged: false,
    truncated: partial || result.next !== null,
  };
}

function withRequests(capacity: PoolCapacityHistory, value: PoolOverviewResult) {
  const completeHours = new Set(value.homeCapture.completeHours.map((at) => Date.parse(at)));
  const hourly = new Map(
    value.requestsByHour.map((point) => [
      JSON.stringify([point.provider, Date.parse(point.at)]),
      point,
    ]),
  );
  return {
    ...capacity,
    points: capacity.points.map((point) => {
      const requests = hourly.get(JSON.stringify([point.provider, point.hour]));
      const complete = completeHours.has(point.hour);
      return {
        ...point,
        requests: requests?.requests ?? (complete ? 0 : null),
        coverage: requests?.coverage ?? (complete ? 1 : null),
        sourceAt: requests?.sourceAt
          ? Date.parse(requests.sourceAt)
          : complete && value.homeCapture.capturedAt
            ? Date.parse(value.homeCapture.capturedAt)
            : null,
      };
    }),
  };
}

/** The usage read decides manager or member; until it answers, nothing is shown as either. */
function overviewFrom(
  { capacity, usage, personal }: OverviewPieces,
  range: { from: string; to: string },
): Overview {
  if (usage === undefined) return {};
  if (managersOnly(usage)) return { usage, personal, coherent: false };
  if (!usage.ok) return { capacity, usage, people: usage, models: usage, coherent: false };
  const value = usage.value;
  return {
    capacity: capacity?.ok ? { ok: true, value: withRequests(capacity.value, value) } : capacity,
    usage,
    people: { ok: true, value: seriesRead(value.people, value.partial) },
    models: { ok: true, value: seriesRead(value.models, value.partial) },
    coherent: capacity?.ok === true && coherentOverview(capacity.value, value, range),
  };
}

/** Each refresh keeps its own parts; a completed usage read never waits on capacity. */
export function useOverview(api: PoolApi, days: RangeDays) {
  const query = useMemo(() => ({ api, days }), [api, days]);
  const [snapshot, setSnapshot] = useState<{
    query: typeof query;
    value: Overview;
  }>();
  const state = snapshot?.query === query ? snapshot.value : {};
  const latest = useRef({ id: 0 });
  const load = useCallback(async () => {
    const pending = latest.current;
    const id = ++pending.id;
    const to = Date.now();
    const range = seriesRange(days, to);
    const input = { from: range.from, to: range.to, days };
    let pieces: OverviewPieces = {};
    const take = (next: OverviewPieces) => {
      if (id !== pending.id) return false;
      pieces = { ...pieces, ...next };
      const value = overviewFrom(pieces, range);
      const usageArrived = pieces.usage !== undefined;
      // Retain the old pair until usage answers, then show only this refresh's parts.
      setSnapshot((previous) =>
        !usageArrived && previous?.query === query ? previous : { query, value },
      );
      return true;
    };
    await Promise.all([
      api.capacity(days, to).then((capacity) => void take({ capacity })),
      api.overviewUsage(input).then(async (usage) => {
        if (!take({ usage }) || !managersOnly(usage)) return;
        take({ personal: await api.personalOverview(input) });
      }),
    ]);
  }, [api, days, query]);
  useEffect(() => {
    const pending = latest.current;
    void load();
    const stop = api.poll(() => void load(), refresh);
    return () => {
      pending.id++;
      stop();
    };
  }, [api, load]);
  return { ...state, reload: load, member: managersOnly(state.usage) };
}
