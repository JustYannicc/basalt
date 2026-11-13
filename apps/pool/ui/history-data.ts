import { useEffect, useMemo, useRef, useState } from "react";
import type { PoolApi } from "./api.ts";
import { managersOnly } from "./overview-data.ts";
import { revokedMessage, unconfirmed } from "./pool-view.ts";
import { settleRefresh } from "./history-refresh.ts";
import { syncHistory, type HistorySync } from "./history-sync.ts";
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

export interface LoadedHistory {
  readonly bounds: HistoryBounds;
  readonly firstAt: string | null;
  readonly series: HistorySeriesRead;
  readonly seriesUnavailable?: string;
  readonly records: readonly PublicHistoryRecord[];
  readonly next: HistoryCursor | null;
}

export interface HistoryState {
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

export type Settled = { readonly loaded: LoadedHistory } | { readonly loadError: string };

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
  const syncing = useRef<HistorySync | undefined>(undefined);

  useEffect(() => {
    const current = ++revision.current;
    const live = () => current === revision.current;
    paging.current = false;
    let marker: object | undefined;
    const sync = syncHistory(changes(), {
      read: () => readHistory(series, publicHistory, filter, live),
      reading: (active) => {
        if (!live()) return;
        if (active) {
          const own = {};
          marker = own;
          setRefreshing(own);
        } else {
          const own = marker;
          setRefreshing((value) => (value === own ? undefined : value));
        }
      },
      apply: (value, reset) => {
        if (!live()) return;
        const paged = paging.current;
        if (reset) paging.current = false;
        setResult((previous) =>
          settleRefresh(previous, value, { request, paged, reset, failed: unconfirmed }),
        );
      },
      // Synchronously on an authority hint: nothing from the old grant stays on screen while its
      // replacement loads, and pages requested under it are dropped by the generation check.
      clear: () => {
        if (!live()) return;
        paging.current = false;
        setResult(undefined);
      },
      // A rejected read keeps the confirmed history and says it may be behind, unless a reset is
      // owed: then nothing from the old grant may be kept.
      rejected: (_error, resetOwed) => {
        if (!live()) return;
        setResult((previous) =>
          !resetOwed && previous?.request === request && previous.loaded !== undefined
            ? { ...previous, failed: unconfirmed }
            : {
                request,
                loadingNext: false,
                page: 0,
                loadError: "History could not be read. Try again.",
              },
        );
      },
      revoked: () => {
        revision.current++;
        setResult({ request, loadingNext: false, page: 0, loadError: revokedMessage });
      },
    });
    syncing.current = sync;
    return () => {
      revision.current = current + 1;
      if (syncing.current === sync) syncing.current = undefined;
      sync.stop();
    };
  }, [request, filter, publicHistory, series, changes]);

  const nextPage = async () => {
    if (!state || !loaded || paging.current) return;
    if (page + 1 < Math.ceil(loaded.records.length / 10)) {
      setResult({ ...state, page: page + 1 });
      return;
    }
    const sync = syncing.current;
    if (!loaded.next || !publicHistory || sync === undefined) return;
    const current = revision.current;
    const scoped = sync.generation();
    const cursor = loaded.next;
    // A page lands only on the snapshot it continues, under the authority it was read with.
    const onSnapshot = (apply: (previous: HistoryState) => HistoryState) =>
      setResult((previous) =>
        previous === undefined || previous.loaded !== loaded || sync.generation() !== scoped
          ? previous
          : apply(previous),
      );
    const stale = () => revision.current !== current || sync.generation() !== scoped;
    paging.current = true;
    onSnapshot((previous) => ({ ...previous, loadingNext: true, pageError: undefined }));
    try {
      const result = await sync.pages.read(() =>
        publicHistory({ ...loaded.bounds, after: cursor }),
      );
      if (stale()) return;
      if (!result.ok)
        onSnapshot((previous) => ({ ...previous, loadingNext: false, pageError: result.message }));
      else if (result.value.records.length === 0 && result.value.next !== null)
        onSnapshot((previous) => ({
          ...previous,
          loadingNext: false,
          pageError: "The next request page was empty. Reload history to continue.",
        }));
      else
        onSnapshot((previous) => ({
          ...previous,
          loadingNext: false,
          pageError: undefined,
          loaded: {
            ...loaded,
            records: [...loaded.records, ...result.value.records],
            next: result.value.next,
          },
          page: result.value.records.length > 0 ? page + 1 : page,
        }));
    } catch {
      if (!stale())
        onSnapshot((previous) => ({
          ...previous,
          loadingNext: false,
          pageError: "The next request page could not be read. Try again.",
        }));
    } finally {
      if (!stale()) paging.current = false;
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
    retry: () => syncing.current?.request(),
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
