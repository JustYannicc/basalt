import { useCallback, useEffect, useRef, useState } from "react";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { PoolOverviewResult } from "../overview-contract.ts";
import type { PoolUsageSeriesResult } from "../usage-series-contract.ts";
import type { Result } from "../index.ts";
import type { PoolApi } from "./api.ts";
import type { SeriesQuery, SeriesRead } from "./series-model.ts";
import { coherentOverview } from "./overview-snapshot.ts";

export type RangeDays = 7 | 30;

/** The same UTC hour boundary and end instant drive every answer in one refresh. */
export function seriesRange(days: RangeDays, now: number): Pick<SeriesQuery, "from" | "to" | "bucket"> {
  return { from: new Date(Math.floor((now - days * 86_400_000) / 3_600_000) * 3_600_000).toISOString(), to: new Date(now).toISOString(), bucket: "day" };
}

export const managersOnly = (result: Result<unknown> | undefined) =>
  result !== undefined && !result.ok && result.error === "unauthorized" && /managers only/i.test(result.message);

export interface Overview {
  readonly capacity?: Result<PoolCapacityHistory>;
  readonly usage?: Result<PoolOverviewResult>;
  readonly people?: Result<SeriesRead>;
  readonly models?: Result<SeriesRead>;
  readonly coherent?: boolean;
}

const refresh = 5 * 60_000;

export function seriesRead(result: PoolUsageSeriesResult, partial: boolean): SeriesRead {
  return { groups: result.groups, coverage: result.coverage, asOf: result.asOf,
    asOfChanged: false, truncated: partial || result.next !== null };
}

/** Commit one refresh together. Never combine a retained good part with a newer failed read. */
export function useOverview(api: PoolApi, days: RangeDays) {
  const [state, setState] = useState<Overview>({});
  const latest = useRef(0);
  const load = useCallback(async () => {
    const id = ++latest.current;
    const to = Date.now();
    const range = seriesRange(days, to);
    const [capacity, usage] = await Promise.all([
      api.capacity(days, to),
      api.overviewUsage({ from: range.from, to: range.to, days }),
    ]);
    if (id !== latest.current) return;
    if (!usage.ok) {
      setState({ capacity, usage, people: usage, models: usage, coherent: false });
      return;
    }
    const value = usage.value;
    const coherent = capacity.ok && coherentOverview(capacity.value, value, range);
    const completeHours = new Set(value.homeCapture.completeHours.map((at) => Date.parse(at)));
    const hourly = new Map(value.requestsByHour.map((point) => [JSON.stringify([point.provider, Date.parse(point.at)]), point]));
    const withRequests = !capacity.ok ? capacity : { ok: true as const, value: { ...capacity.value,
      points: capacity.value.points.map((point) => {
        const requests = hourly.get(JSON.stringify([point.provider, point.hour]));
        const complete = completeHours.has(point.hour);
        return { ...point, requests: requests?.requests ?? (complete ? 0 : null), coverage: requests?.coverage ?? (complete ? 1 : null),
          sourceAt: requests?.sourceAt ? Date.parse(requests.sourceAt) : complete && value.homeCapture.capturedAt ? Date.parse(value.homeCapture.capturedAt) : null };
      }),
    } };
    setState({ capacity: withRequests, usage, people: { ok: true, value: seriesRead(value.people, value.partial) },
      models: { ok: true, value: seriesRead(value.models, value.partial) }, coherent });
  }, [api, days]);
  useEffect(() => {
    setState({});
    void load();
    const stop = api.poll(() => void load(), refresh);
    return () => { latest.current++; stop(); };
  }, [api, load]);
  return { ...state, reload: load, member: managersOnly(state.usage) };
}
