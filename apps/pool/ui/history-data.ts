import { useEffect, useMemo, useRef, useState } from "react";
import type { SeriesFetch } from "./series-model.ts";
import {
  historyDateBounds,
  readHistorySeries,
  type HistoryBounds,
  type HistoryCursor,
  type HistoryDateFilter,
  type HistorySeriesRead,
  type PublicHistoryReader,
  type PublicHistoryRecord,
} from "./history-model.ts";

interface LoadedHistory {
  readonly bounds: HistoryBounds;
  readonly firstAt: string | null;
  readonly series: HistorySeriesRead;
  readonly records: readonly PublicHistoryRecord[];
  readonly next: HistoryCursor | null;
}

interface HistoryState {
  readonly request: object;
  readonly loaded?: LoadedHistory;
  readonly loadError?: string;
  readonly pageError?: string;
  readonly loadingNext: boolean;
  readonly page: number;
}

/** A range owns its reads. Late pages cannot replace another range or a refreshed snapshot. */
export function useHistory(
  series: SeriesFetch,
  publicHistory: PublicHistoryReader | undefined,
  filter: HistoryDateFilter,
) {
  const [retry, setRetry] = useState(0);
  const request = useMemo(
    () => ({ series, publicHistory, filter, retry }),
    [series, publicHistory, filter, retry],
  );
  const [result, setResult] = useState<HistoryState>();
  const state = result?.request === request ? result : undefined;
  const loaded = state?.loaded;
  const page = state?.page ?? 0;
  const revision = useRef(0);
  const paging = useRef(false);

  useEffect(() => {
    const current = ++revision.current;
    const live = () => current === revision.current;
    paging.current = false;
    const settle = (value: { loaded: LoadedHistory } | { loadError: string }) => {
      if (live()) setResult({ request, loadingNext: false, page: 0, ...value });
    };
    const read = async () => {
      if (!publicHistory) {
        settle({ loadError: "Request history isn't available in this pool view." });
        return;
      }
      const now = Date.now();
      try {
        const discovered = await publicHistory({
          from: "1970-01-01T00:00:00.000Z",
          to: new Date(now).toISOString(),
        });
        if (!live()) return;
        if (!discovered.ok) {
          settle({ loadError: discovered.message });
          return;
        }
        // The public reader returns ascending timestamp/id keyset pages.
        const firstAt = discovered.value.records.reduce<string | null>(
          (first, row) => (first === null || row.timestamp < first ? row.timestamp : first),
          null,
        );
        const bounds = historyDateBounds(filter, firstAt, now);
        if (!bounds) {
          settle({ loadError: "From must be on or before To." });
          return;
        }
        const requestPage =
          filter.from === undefined && filter.to === undefined
            ? discovered
            : await publicHistory(bounds);
        if (!live()) return;
        if (!requestPage.ok) {
          settle({ loadError: requestPage.message });
          return;
        }
        const usage =
          requestPage.value.records.length === 0
            ? {
                ok: true as const,
                value: { groups: [], asOf: null, changed: false, partial: false },
              }
            : await readHistorySeries(
                (input) =>
                  live()
                    ? series(input)
                    : Promise.reject(new DOMException("History range changed.", "AbortError")),
                bounds,
              );
        if (!live()) return;
        if (!usage.ok) {
          settle({ loadError: usage.message });
          return;
        }
        settle({
          loaded: {
            bounds,
            firstAt,
            series: usage.value,
            records: requestPage.value.records,
            next: requestPage.value.next,
          },
        });
      } catch {
        settle({ loadError: "History could not be read. Try again." });
      }
    };
    void read();
    return () => {
      revision.current = current + 1;
    };
  }, [request, filter, publicHistory, series]);

  const nextPage = async () => {
    if (!state || !loaded || paging.current) return;
    if (page + 1 < Math.ceil(loaded.records.length / 10)) {
      setResult({ ...state, page: page + 1 });
      return;
    }
    if (!loaded.next || !publicHistory) return;
    const current = revision.current;
    paging.current = true;
    setResult({ ...state, loadingNext: true, pageError: undefined });
    try {
      const result = await publicHistory({ ...loaded.bounds, after: loaded.next });
      if (revision.current !== current) return;
      if (!result.ok) setResult({ ...state, loadingNext: false, pageError: result.message });
      else if (result.value.records.length === 0 && result.value.next !== null)
        setResult({
          ...state,
          loadingNext: false,
          pageError: "The next request page was empty. Reload history to continue.",
        });
      else {
        setResult({
          ...state,
          loadingNext: false,
          pageError: undefined,
          loaded: {
            ...loaded,
            records: [...loaded.records, ...result.value.records],
            next: result.value.next,
          },
          page: result.value.records.length > 0 ? page + 1 : page,
        });
      }
    } catch {
      if (revision.current === current)
        setResult({
          ...state,
          loadingNext: false,
          pageError: "The next request page could not be read. Try again.",
        });
    } finally {
      if (revision.current === current) {
        paging.current = false;
      }
    }
  };

  return {
    loaded,
    loading: state === undefined,
    loadError: state?.loadError,
    pageError: state?.pageError,
    loadingNext: state?.loadingNext ?? false,
    page,
    reload: () => setRetry((value) => value + 1),
    nextPage: () => void nextPage(),
    previousPage: () => {
      if (state && !paging.current) setResult({ ...state, page: Math.max(0, page - 1) });
    },
  };
}
