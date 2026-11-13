import { useEffect, useMemo, useRef, useState } from "react";
import { ChangeReadRetry, type ChangeWatch } from "apps/client";
import type { PoolApi } from "./api.ts";
import { managersOnly } from "./overview-data.ts";
import { revokedMessage, unconfirmed } from "./pool-view.ts";
import { settleRefresh } from "./history-refresh.ts";
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
/**
 * New usage: history reads again but keeps a person's page. Authority topics are not here; only
 * the authority watch hears them, so a narrower grant always arrives as a reset, never as "newer".
 */
const topics = ["pool-usage", "pool-samples", "pool-prices"];
/** Who may see which requests and totals: a change here replaces everything on screen. */
const authorityTopics = ["apps", "membership", "session"];

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
  /** Fences next-page reads on authority without claiming the shown snapshot's usage heads. */
  const pager = useRef<ChangeWatch | undefined>(undefined);
  /** Bumped when authority changes; a page requested under an older scope is dropped. */
  const scope = useRef(0);

  useEffect(() => {
    const current = ++revision.current;
    const live = () => current === revision.current;
    paging.current = false;
    let resetPending = false;
    let primed = false;
    const feed = changes();
    const watch = feed.watch({
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
          // A rejected read keeps the confirmed history and says it may be behind, unless
          // authority changed: then nothing from the old grant may stay on screen.
          if (!live() || !(error instanceof ChangeReadRetry) || error.reason === "hidden") return;
          if (resetPending) {
            scope.current++;
            paging.current = false;
            setResult({
              request,
              loadingNext: false,
              page: 0,
              loadError: "History could not be read. Try again.",
            });
            return;
          }
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
        const reset = resetPending;
        resetPending = false;
        if (reset) {
          scope.current++;
          paging.current = false;
        }
        setResult((previous) =>
          settleRefresh(previous, value, { request, paged, reset, failed: unconfirmed }),
        );
      },
      revoked: () => {
        revision.current++;
        setResult({ request, loadingNext: false, page: 0, loadError: revokedMessage });
      },
    });
    // Who may see what changed. Before any await, the next history read becomes a reset and every
    // page requested under the old grant is dropped; that request is this hint's one data read.
    // Its own read only records authority heads (no data), so a reconnect at the same heads reads
    // nothing. The first refresh just primes those heads; the main watch's first read loads.
    const authority = feed.watch({
      topics: authorityTopics,
      refresh: async () => {
        if (primed) {
          resetPending = true;
          scope.current++;
          paging.current = false;
          watch.request();
        }
        primed = true;
        await authority.read(async () => undefined).catch(() => undefined);
      },
      revoked: () => undefined,
    });
    // Next-page reads are fenced on authority by their own watch, which never reads on its own.
    const pageFence = feed.watch({
      topics: authorityTopics,
      refresh: () => undefined,
      revoked: () => undefined,
    });
    watching.current = watch;
    pager.current = pageFence;
    return () => {
      revision.current = current + 1;
      if (watching.current === watch) watching.current = undefined;
      if (pager.current === pageFence) pager.current = undefined;
      watch.stop();
      authority.stop();
      pageFence.stop();
    };
  }, [request, filter, publicHistory, series, changes]);

  const nextPage = async () => {
    if (!state || !loaded || paging.current) return;
    if (page + 1 < Math.ceil(loaded.records.length / 10)) {
      setResult({ ...state, page: page + 1 });
      return;
    }
    const fence = pager.current;
    if (!loaded.next || !publicHistory || fence === undefined) return;
    const current = revision.current;
    const scoped = scope.current;
    const cursor = loaded.next;
    // A page lands only on the snapshot it continues, under the authority it was read with.
    const onSnapshot = (apply: (previous: HistoryState) => HistoryState) =>
      setResult((previous) =>
        previous === undefined || previous.loaded !== loaded || scope.current !== scoped
          ? previous
          : apply(previous),
      );
    const stale = () => revision.current !== current || scope.current !== scoped;
    paging.current = true;
    onSnapshot((previous) => ({ ...previous, loadingNext: true, pageError: undefined }));
    try {
      const result = await fence.read(() => publicHistory({ ...loaded.bounds, after: cursor }));
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
