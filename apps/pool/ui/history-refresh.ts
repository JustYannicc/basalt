import type { HistoryState, Settled } from "./history-data.ts";

/**
 * How an accepted change-driven read lands on the history shown. New usage keeps a person's page
 * and only says newer usage arrived. A changed authority replaces every page, cursor and total,
 * paged or not, so data a narrower grant no longer covers never stays visible.
 */
export function settleRefresh(
  previous: HistoryState | undefined,
  value: Settled,
  input: {
    readonly request: object;
    readonly paged: boolean;
    readonly reset: boolean;
    /** Shown over the kept history when an accepted read failed. */
    readonly failed: string;
  },
): HistoryState {
  const next: HistoryState = { request: input.request, loadingNext: false, page: 0, ...value };
  if (previous?.request !== input.request || previous.loaded === undefined) return next;
  if (input.reset) return next;
  // The response itself shows visibility changed (manager totals now withheld, or granted): it
  // replaces every page even if the authority hint has not been seen yet.
  if (
    "loaded" in value &&
    (value.loaded.seriesUnavailable ?? null) !== (previous.loaded.seriesUnavailable ?? null)
  )
    return next;
  // An accepted failure keeps the history on screen, labelled; access loss arrives as `revoked`.
  if ("loadError" in value) return { ...previous, failed: input.failed };
  if (input.paged || previous.loadingNext || previous.page > 0)
    return { ...previous, newer: true, failed: undefined };
  return next;
}
