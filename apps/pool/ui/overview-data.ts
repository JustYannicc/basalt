import { useCallback, useEffect, useRef, useState } from "react";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { Result } from "../index.ts";
import type { PoolApi } from "./api.ts";
import { readSeries, type SeriesQuery, type SeriesRead } from "./series-model.ts";

export type RangeDays = 7 | 30;

/** UTC days ending now: daily buckets from the first day's midnight, pinned once per read. */
export function seriesRange(days: RangeDays, now: number): Pick<SeriesQuery, "from" | "to" | "bucket"> {
  const today = Math.floor(now / 86_400_000) * 86_400_000;
  return { from: new Date(today - (days - 1) * 86_400_000).toISOString(), to: new Date(now).toISOString(), bucket: "day" };
}

/** The series endpoint answers 403 to anyone who can't manage the pool; they get their own usage instead. */
export const managersOnly = (result: Result<unknown> | undefined) =>
  result !== undefined && !result.ok && result.error === "unauthorized" && /managers only/i.test(result.message);

export interface Overview {
  readonly capacity?: Result<PoolCapacityHistory>;
  /** Person × provider: People and Labs. */
  readonly people?: Result<SeriesRead>;
  /** Model × provider: Models. */
  readonly models?: Result<SeriesRead>;
}

const refresh = 5 * 60_000;

/**
 * Everything the manager overview reads for one range. A failed refresh keeps the last good result
 * of that part on screen; a newer range or read owns the state as soon as it starts.
 */
export function useOverview(api: PoolApi, days: RangeDays) {
  const [state, setState] = useState<Overview>({});
  const latest = useRef(0);
  const load = useCallback(async () => {
    const id = ++latest.current;
    const range = seriesRange(days, Date.now());
    const keep = <T>(next: Result<T>, previous: Result<T> | undefined) => (!next.ok && previous?.ok && !managersOnly(next) ? previous : next);
    const apply = (part: Partial<Overview>) => {
      if (id !== latest.current) return;
      setState((previous) => ({
        capacity: part.capacity ? keep(part.capacity, previous.capacity) : previous.capacity,
        people: part.people ? keep(part.people, previous.people) : previous.people,
        models: part.models ? keep(part.models, previous.models) : previous.models,
      }));
    };
    const people = readSeries(api.series, { ...range, by: ["person", "provider"] });
    void api.capacity(days).then((capacity) => apply({ capacity }));
    const first = await people;
    apply({ people: first });
    // A member can't read the series at all, so don't ask a second time.
    if (managersOnly(first)) return;
    apply({ models: await readSeries(api.series, { ...range, by: ["model", "provider"] }) });
  }, [api, days]);
  useEffect(() => {
    setState({});
    void load();
    const stop = api.poll(() => void load(), refresh);
    return () => {
      latest.current++;
      stop();
    };
  }, [api, load]);
  return { ...state, reload: load, member: managersOnly(state.people) };
}
