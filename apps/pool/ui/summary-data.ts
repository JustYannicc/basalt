import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { PoolPersonalOverviewResult } from "../overview-contract.ts";
import type { PoolUsageSummaryResult } from "../usage-overview-contract.ts";
import type { Result } from "../index.ts";
import type { PoolApi } from "./api.ts";
import { managersOnly } from "./overview-data.ts";
import { summaryRange, type Breakdown, type RangeDays } from "./summary-model.ts";

const refresh = 5 * 60_000;

export interface SummaryState {
  readonly summary?: Result<PoolUsageSummaryResult>;
  readonly capacity?: Result<PoolCapacityHistory>;
  /** Only someone the summary refuses as a non-manager gets their own usage instead. */
  readonly personal?: Result<PoolPersonalOverviewResult>;
  /** Capacity and usage end at the same instant, so one verdict can rest on both. */
  readonly coherent: boolean;
}

/** Hourly requests ride along with the summary; an hour Home fully captured but empty is a zero. */
function withRequests(capacity: PoolCapacityHistory, summary: PoolUsageSummaryResult) {
  const complete = new Set(summary.homeCapture.completeHours.map((at) => Date.parse(at)));
  const captured = summary.homeCapture.capturedAt
    ? Date.parse(summary.homeCapture.capturedAt)
    : null;
  const hourly = new Map(
    summary.requestsByHour.map((point) => [`${point.provider} ${Date.parse(point.at)}`, point]),
  );
  return {
    ...capacity,
    points: capacity.points.map((point) => {
      const read = hourly.get(`${point.provider} ${point.hour}`);
      const whole = complete.has(point.hour);
      return {
        ...point,
        requests: read?.requests ?? (whole ? 0 : null),
        coverage: read?.coverage ?? (whole ? 1 : null),
        sourceAt: read !== undefined || whole ? captured : null,
      };
    }),
  };
}

/**
 * One refresh is one summary read and the existing capacity read, side by side. The legacy
 * overview read is never issued. Capacity doesn't depend on the breakdown, so switching between
 * labs and models reads only the summary and keeps capacity paired with the answer it was read
 * with. A refused summary makes this a member's page, which then reads only that person's usage.
 */
export function useSummary(api: PoolApi, days: RangeDays, by: Breakdown) {
  const query = useMemo(() => ({ api, days, by }), [api, days, by]);
  const [snapshot, setSnapshot] = useState<{ query: typeof query; value: SummaryState }>();
  const latest = useRef({ id: 0 });
  const kept = useRef<{ days: RangeDays; capacity: SummaryState["capacity"]; coherent: boolean }>(
    undefined,
  );
  const load = useCallback(
    async (fresh = true) => {
      const pending = latest.current;
      const id = ++pending.id;
      const now = Date.now();
      const range = summaryRange(days, now);
      const reuse = !fresh && kept.current?.days === days ? kept.current : undefined;
      let pieces: Omit<SummaryState, "coherent"> = {};
      const take = (next: Omit<SummaryState, "coherent">) => {
        if (id !== pending.id) return false;
        pieces = { ...pieces, ...next };
        const { summary, capacity } = pieces;
        const value: SummaryState =
          reuse !== undefined
            ? { ...pieces, capacity: reuse.capacity, coherent: reuse.coherent }
            : {
                ...pieces,
                capacity:
                  capacity?.ok && summary?.ok
                    ? { ok: true, value: withRequests(capacity.value, summary.value) }
                    : capacity,
                coherent:
                  capacity?.ok === true &&
                  summary?.ok === true &&
                  capacity.value.to === Date.parse(summary.value.to),
              };
        if (reuse === undefined && capacity !== undefined && summary !== undefined)
          kept.current = { days, capacity: value.capacity, coherent: value.coherent };
        // Keep the last answer until this refresh's usage arrives, then show only this refresh.
        setSnapshot((previous) =>
          summary === undefined && previous !== undefined ? previous : { query, value },
        );
        return true;
      };
      await Promise.all([
        reuse === undefined
          ? api.capacity(days, now).then((capacity) => void take({ capacity }))
          : undefined,
        api.summary({ ...range, by }).then(async (summary) => {
          if (!take({ summary }) || !managersOnly(summary)) return;
          take({
            personal: await api.personalOverview({ from: range.from, to: range.to, days }),
          });
        }),
      ]);
    },
    [api, days, by, query],
  );
  useEffect(() => {
    const pending = latest.current;
    // A new breakdown of the same range keeps its capacity; a refresh reads both again.
    void load(false);
    const stop = api.poll(() => void load(), refresh);
    return () => {
      pending.id++;
      stop();
    };
  }, [api, load]);
  const state = snapshot?.query === query ? snapshot.value : undefined;
  // A switch keeps the previous answer on screen, marked as updating, instead of a blank page.
  const shown = state ?? snapshot?.value;
  return {
    state: shown,
    updating: state === undefined && shown !== undefined,
    /** The breakdown the shown answer was read with, which can trail the selected one. */
    by: snapshot?.query.by ?? by,
    reload: () => load(),
    member: managersOnly(shown?.summary),
  };
}
