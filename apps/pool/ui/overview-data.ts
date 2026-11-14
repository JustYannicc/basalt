import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChangeReadRetry, type ChangeWatch } from "apps/client";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { PoolOverviewResult, PoolPersonalOverviewResult } from "../overview-contract.ts";
import type { PoolUsageSeriesResult } from "../usage-series-contract.ts";
import type { Result } from "../index.ts";
import type { PoolApi } from "./api.ts";
import type { SeriesQuery, SeriesRead } from "./series-model.ts";
import { coherentOverview } from "./overview-snapshot.ts";
import { unconfirmed } from "./pool-view.ts";

export type RangeDays = 7 | 30 | 90;

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

/** Parts share one range; accepted head versions decide whether they form one verdict. */
interface OverviewPieces {
  readonly capacity?: Result<PoolCapacityHistory>;
  readonly usage?: Result<PoolOverviewResult>;
  readonly personal?: Result<PoolPersonalOverviewResult>;
}

/** Capacity, usage, people, models and their prices; the directory comes with membership. */
const topics = [
  "accounts",
  "apps",
  "membership",
  "session",
  "pool-readings",
  "pool-usage",
  "pool-samples",
  "pool-prices",
];
const unreachable = {
  ok: false,
  error: "backend_unavailable",
  message: "Overview could not be read. Try again.",
} as const;

export function seriesRead(result: PoolUsageSeriesResult): SeriesRead {
  return {
    groups: result.groups,
    coverage: result.coverage,
    asOf: result.asOf,
    asOfChanged: false,
    truncated: result.next !== null,
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
    people: { ok: true, value: seriesRead(value.people) },
    models: { ok: true, value: seriesRead(value.models) },
    coherent: capacity?.ok === true && coherentOverview(capacity.value, value, range),
  };
}

/** Each part publishes after its own revision fence; a slow part cannot hold the others. */
export function useOverview(api: PoolApi, days: RangeDays) {
  const query = useMemo(() => ({ api, days }), [api, days]);
  const [snapshot, setSnapshot] = useState<{
    query: typeof query;
    value: Overview;
  }>();
  const state = snapshot?.query === query ? snapshot.value : {};
  const latest = useRef({ id: 0 });
  const watch = useRef<ChangeWatch | undefined>(undefined);
  const capacityRead = useRef<
    | {
        query: typeof query;
        to: number;
        controller: AbortController;
        publish: (value: Result<PoolCapacityHistory>, version: string) => void;
        reject: (error: unknown) => void;
        finish: () => void;
      }
    | undefined
  >(undefined);
  /** This view's own read is in flight; the pool header says nothing about it. */
  const [reading, setReading] = useState<object>();
  /** The last read was rejected; the figures on screen are the last confirmed ones. */
  const [failed, setFailed] = useState<{ query: typeof query; message: string }>();
  const load = useCallback(async () => {
    const current = watch.current;
    if (current === undefined) return;
    const pending = latest.current;
    const id = ++pending.id;
    const marker = {};
    setReading(marker);
    const done = () => setReading((value) => (value === marker ? undefined : value));
    const ongoing = capacityRead.current?.query === query ? capacityRead.current : undefined;
    const to = ongoing?.to ?? Date.now();
    const range = seriesRange(days, to);
    const input = { from: range.from, to: range.to, days };
    let pieces: OverviewPieces = {};
    const versions = new Map<keyof OverviewPieces, string>();
    let remaining = 2;
    const finish = () => {
      if (--remaining !== 0) return;
      done();
      // A part may have retried across a revision while another already committed.
      if (id === pending.id && new Set(versions.values()).size > 1) current.request();
    };
    const publish = (part: OverviewPieces, version: string) => {
      if (id !== pending.id) return;
      pieces = { ...pieces, ...part };
      for (const key of Object.keys(part) as (keyof OverviewPieces)[]) versions.set(key, version);
      if (pieces.usage === undefined) return;
      const matching = new Set(versions.values()).size === 1;
      const value = overviewFrom(pieces, range);
      setFailed(undefined);
      setSnapshot({ query, value: { ...value, coherent: value.coherent === true && matching } });
    };
    const reject = (error: unknown) => {
      if (id !== pending.id || !(error instanceof ChangeReadRetry)) return;
      if (error.reason === "hidden") return;
      setFailed({ query, message: unconfirmed });
      setSnapshot((previous) =>
        previous?.query === query
          ? previous
          : { query, value: overviewFrom({ usage: unreachable }, range) },
      );
    };
    const callbacks = {
      publish: (capacity: Result<PoolCapacityHistory>, version: string) =>
        publish({ capacity }, version),
      reject,
      finish,
    };
    if (ongoing !== undefined) Object.assign(ongoing, callbacks);
    else {
      // A retry joins pending capacity instead of exhausting the connection slots with duplicates.
      const entry = { query, to, controller: new AbortController(), ...callbacks };
      capacityRead.current = entry;
      void current
        .read(
          () => api.capacity(days, to, entry.controller.signal),
          (value, version) => entry.publish(value, version),
        )
        .catch((error: unknown) => entry.reject(error))
        .finally(() => {
          if (capacityRead.current === entry) capacityRead.current = undefined;
          entry.finish();
        });
    }
    try {
      const usage = await current.read(
        () => api.overviewUsage(input),
        (usage, version) => publish({ usage }, version),
      );
      if (managersOnly(usage))
        await current.read(
          () => api.personalOverview(input),
          (personal, version) => publish({ personal }, version),
        );
    } catch (error) {
      reject(error);
    } finally {
      finish();
    }
  }, [api, days, query]);
  useEffect(() => {
    const pending = latest.current;
    const current = api.changes().watch({
      topics,
      refresh: load,
      revoked: () => {
        pending.id++;
        if (capacityRead.current?.query === query) capacityRead.current.controller.abort();
        setSnapshot(undefined);
      },
    });
    watch.current = current;
    return () => {
      pending.id++;
      if (capacityRead.current?.query === query) capacityRead.current.controller.abort();
      watch.current = undefined;
      current.stop();
    };
  }, [api, load, query]);
  return {
    ...state,
    reload: load,
    member: managersOnly(state.usage),
    // Only a read over data already on screen is an update.
    updating: reading !== undefined && snapshot?.query === query,
    // Only claim retained figures when confirmed ones are on screen.
    failed:
      failed?.query === query &&
      reading === undefined &&
      (state.usage?.ok === true || state.personal?.ok === true)
        ? failed.message
        : undefined,
  };
}
