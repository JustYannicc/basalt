import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { PoolPersonalOverviewResult } from "../overview-contract.ts";
import type { PoolUsageSummaryResult } from "../usage-overview-contract.ts";
import type { Result } from "../index.ts";
import type { PoolApi } from "./api.ts";
import { managersOnly } from "./overview-data.ts";
import {
  personalRange,
  rangeKey,
  summaryRange,
  type Breakdown,
  type RangeChoice,
  type SummaryBounds,
} from "./summary-model.ts";

const refresh = 5 * 60_000;

export interface SummaryState {
  readonly summary?: Result<PoolUsageSummaryResult>;
  readonly capacity?: Result<PoolCapacityHistory>;
  /** Only someone the summary refuses as a non-manager gets their own usage instead. */
  readonly personal?: Result<PoolPersonalOverviewResult>;
  /** Capacity and usage end at the same instant, so one verdict can rest on both. */
  readonly coherent: boolean;
  /** The exact bounds this answer was asked for; account reads pin to them. */
  readonly bounds?: SummaryBounds;
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
 * labs and models reads only the summary, for the exact bounds that capacity was paired with, and
 * the pair stays coherent only when the new answer returns those same bounds. A refresh or a range
 * change reads a new pair. A refused summary makes this a member's page, which then reads only that
 * person's usage.
 */
export function useSummary(api: PoolApi, range: RangeChoice, by: Breakdown) {
  const key = rangeKey(range);
  const query = useMemo(() => ({ api, key, by }), [api, key, by]);
  const choice = useRef(range);
  choice.current = range;
  const [snapshot, setSnapshot] = useState<{ query: typeof query; value: SummaryState }>();
  const latest = useRef({ id: 0 });
  const kept = useRef<{
    key: string;
    bounds: SummaryBounds;
    capacity: SummaryState["capacity"];
    coherent: boolean;
  }>(undefined);
  const load = useCallback(
    async (fresh = true) => {
      const pending = latest.current;
      const id = ++pending.id;
      const now = Date.now();
      const reuse = !fresh && kept.current?.key === key ? kept.current : undefined;
      const bounds = reuse?.bounds ?? summaryRange(choice.current, now);
      let pieces: Omit<SummaryState, "coherent" | "bounds"> = {};
      const take = (next: Omit<SummaryState, "coherent" | "bounds">) => {
        if (id !== pending.id) return false;
        pieces = { ...pieces, ...next };
        const { summary, capacity } = pieces;
        const answered =
          summary?.ok === true &&
          summary.value.from === bounds.from &&
          summary.value.to === bounds.to;
        const value: SummaryState =
          reuse !== undefined
            ? {
                ...pieces,
                bounds,
                capacity: reuse.capacity,
                // The kept capacity was paired with these bounds; a different answer is not.
                coherent: reuse.coherent && answered,
              }
            : {
                ...pieces,
                bounds,
                capacity:
                  capacity?.ok && summary?.ok
                    ? { ok: true, value: withRequests(capacity.value, summary.value) }
                    : capacity,
                coherent:
                  answered && capacity?.ok === true && capacity.value.to === Date.parse(bounds.to),
              };
        if (reuse === undefined && capacity !== undefined && summary !== undefined)
          kept.current = { key, bounds, capacity: value.capacity, coherent: value.coherent };
        // Keep the last answer until this refresh's usage arrives, then show only this refresh.
        setSnapshot((previous) =>
          summary === undefined && previous !== undefined ? previous : { query, value },
        );
        return true;
      };
      const input = { from: bounds.from, to: bounds.to, by };
      await Promise.all([
        reuse === undefined
          ? api.capacity(bounds.days, now).then((capacity) => void take({ capacity }))
          : undefined,
        api.summary(input).then(async (summary) => {
          if (!take({ summary }) || !managersOnly(summary)) return;
          // The member route keeps its fixed windows; a since-start range is managers' only.
          take({
            personal: await api.personalOverview(personalRange(choice.current, bounds, now)),
          });
        }),
      ]);
    },
    [api, key, by, query],
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
