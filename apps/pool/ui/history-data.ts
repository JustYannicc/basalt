import { useEffect, useMemo, useRef, useState } from "react";
import { ChangeReadRetry, type ChangeWatch } from "apps/client";
import type { PoolApi } from "./api.ts";
import { managersOnly } from "./overview-data.ts";
import { revokedMessage, unconfirmed } from "./pool-view.ts";
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
  readonly seriesUnavailable?: string;
  readonly records: readonly PublicHistoryRecord[];
  readonly next: HistoryCursor | null;
}

interface HistoryState {
  readonly request: object;
  readonly loaded?: LoadedHistory;
  /** Usage changed while a person was paging; their place is kept until they reload. */
  readonly newer?: boolean;
  /** The last change-driven read was rejected; the history on screen is the last confirmed one. */
  readonly failed?: string;
  readonly loadError?: string;
  readonly pageError?: string;
  readonly loadingNext: boolean;
  readonly page: number;
}

type Settled = { readonly loaded: LoadedHistory } | { readonly loadError: string };
/** History and its requests depend on Home usage, derived samples, prices and the directory. */
const topics = ["membership", "session", "pool-usage", "pool-samples", "pool-prices"];
const changedRange = () => new DOMException("History range changed.", "AbortError");

/** One complete read of a range: its first request, bounds, first page and grouped totals. */
async function readHistory(
  series: SeriesFetch,
  publicHistory: PublicHistoryReader | undefined,
  filter: HistoryDateFilter,
  live: () => boolean,
): Promise<Settled> {
  if (!publicHistory) {
    return { loadError: "Request history isn't available in this pool view." };
  }
  const now = Date.now();
  try {
    const discovered = await publicHistory({
      from: "1970-01-01T00:00:00.000Z",
      to: new Date(now).toISOString(),
    });
    if (!live()) throw changedRange();
    if (!discovered.ok) {
      return { loadError: discovered.message };
    }
    // The public reader returns ascending timestamp/id keyset pages.
    const firstAt = discovered.value.records.reduce<string | null>(
      (first, row) => (first === null || row.timestamp < first ? row.timestamp : first),
      null,
    );
    const bounds = historyDateBounds(filter, firstAt, now);
    if (!bounds) {
      return { loadError: "From must be on or before To." };
    }
    const requestPage =
      filter.from === undefined && filter.to === undefined
        ? discovered
        : await publicHistory(bounds);
    if (!live()) throw changedRange();
    if (!requestPage.ok) {
      return { loadError: requestPage.message };
    }
    const usage =
      requestPage.value.records.length === 0
        ? {
            ok: true as const,
            value: { groups: [], asOf: null, changed: false, partial: false },
          }
        : await readHistorySeries(
            (input) => (live() ? series(input) : Promise.reject(changedRange())),
            bounds,
          );
    if (!live()) throw changedRange();
    if (!usage.ok && !managersOnly(usage)) {
      return { loadError: usage.message };
    }
    return {
      loaded: {
        bounds,
        firstAt,
        series: usage.ok ? usage.value : { groups: [], asOf: null, changed: false, partial: false },
        ...(!usage.ok
          ? {
              seriesUnavailable:
                "You can read your own requests. Grouped pool totals are available to managers only.",
            }
          : {}),
        records: requestPage.value.records,
        next: requestPage.value.next,
      },
    };
  } catch {
    return { loadError: "History could not be read. Try again." };
  }
}

/** A range owns its reads. Late pages cannot replace another range or a refreshed snapshot. */
export function useHistory(
  changes: PoolApi["changes"],
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
  /** A change-driven read is in flight over the history on screen. */
  const [refreshing, setRefreshing] = useState<object>();
  const watching = useRef<ChangeWatch | undefined>(undefined);

  useEffect(() => {
    const current = ++revision.current;
    const live = () => current === revision.current;
    paging.current = false;
    const watch = changes().watch({
      topics,
      refresh: async () => {
        let value: Settled;
        const marker = {};
        setRefreshing(marker);
        const done = () => setRefreshing((current) => (current === marker ? undefined : current));
        try {
          value = await watch.read(() => readHistory(series, publicHistory, filter, live));
          done();
        } catch (error) {
          done();
          // A rejected read keeps the confirmed history and says it may be behind.
          if (!live() || !(error instanceof ChangeReadRetry)) return;
          setResult((previous) =>
            previous?.request === request && previous.loaded !== undefined
              ? { ...previous, failed: unconfirmed }
              : {
                  request,
                  loadingNext: false,
                  page: 0,
                  loadError: "History could not be read. Try again.",
                },
          );
          return;
        }
        if (!live()) return;
        const paged = paging.current;
        setResult((previous) => {
          const next = { request, loadingNext: false, page: 0, ...value };
          if (previous?.request !== request || previous.loaded === undefined) return next;
          // An accepted failure keeps the history on screen, labelled; access loss arrives as `revoked`.
          if ("loadError" in value) return { ...previous, failed: unconfirmed };
          if (paged || previous.loadingNext || previous.page > 0)
            return { ...previous, newer: true, failed: undefined };
          return next;
        });
      },
      revoked: () => {
        revision.current++;
        setResult({ request, loadingNext: false, page: 0, loadError: revokedMessage });
      },
    });
    watching.current = watch;
    return () => {
      revision.current = current + 1;
      if (watching.current === watch) watching.current = undefined;
      watch.stop();
    };
  }, [request, filter, publicHistory, series, changes]);

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
    newer: state?.newer === true,
    updating: refreshing !== undefined && loaded !== undefined,
    failed: refreshing === undefined ? state?.failed : undefined,
    /** Read again through the feed, keeping the history on screen. */
    retry: () => watching.current?.request(),
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
