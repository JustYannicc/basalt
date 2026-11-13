import { useState, useSyncExternalStore, type FormEvent } from "react";
import type { Provider } from "../contract.ts";
import type { PoolApi } from "./api.ts";
import { providerName as displayProvider } from "./accounts.tsx";
import { Button, Problem, Segmented, Spinner } from "./controls.tsx";
import type { MemberDirectoryEntry } from "./series-model.ts";
import { total, tokensShort } from "./series-model.ts";
import {
  historyDateBounds,
  type HistoryDateFilter,
  type PublicHistoryReader,
} from "./history-model.ts";
import { HistoryBreakdown } from "./history-breakdown.tsx";
import { HistoryRequests } from "./history-requests.tsx";
import { useHistory } from "./history-data.ts";
import { HistoryChart } from "./history-chart.tsx";

type Mode = "all" | "dates";

function dateLabel(value: string | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

function requestTime(value: string): string {
  return (
    new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC"
  );
}

export function History({
  changes,
  series,
  publicHistory,
  directory,
  providers,
  onBack,
}: {
  changes: PoolApi["changes"];
  series: PoolApi["series"];
  publicHistory?: PublicHistoryReader;
  directory: readonly MemberDirectoryEntry[];
  providers: readonly Provider[];
  onBack: () => void;
}) {
  const [mode, setMode] = useState<Mode>("all");
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [filter, setFilter] = useState<HistoryDateFilter>({});
  const [filterError, setFilterError] = useState<string>();
  const {
    loaded,
    loading,
    loadError,
    newer,
    updating,
    failed,
    retry,
    pageError,
    loadingNext,
    page,
    reload,
    nextPage,
    previousPage,
  } = useHistory(changes, series, publicHistory, filter);
  const feed = changes();
  const stream = useSyncExternalStore(feed.onStatus, feed.status);

  const applyDates = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: HistoryDateFilter = {
      ...(draftFrom ? { from: draftFrom } : {}),
      ...(draftTo ? { to: draftTo } : {}),
    };
    if (!historyDateBounds(next, loaded?.firstAt ?? null, Date.now())) {
      setFilterError("From must be on or before To.");
      return;
    }
    setFilterError(undefined);
    setFilter(next);
    setMode("dates");
  };

  const selectMode = (next: Mode) => {
    setMode(next);
    setFilterError(undefined);
    if (next === "all") {
      setDraftFrom("");
      setDraftTo("");
      setFilter({});
    }
  };

  const name = (id: string) => displayProvider(providers, id);
  const summary = loaded && !loaded.seriesUnavailable ? total(loaded.series.groups) : undefined;
  const importSources =
    loaded?.series.coverage?.sources.filter((source) => source.kind === "import") ?? [];
  const importFrom = importSources.reduce<string | null>(
    (date, source) =>
      source.firstAt === null
        ? date
        : date === null || source.firstAt < date
          ? source.firstAt
          : date,
    null,
  );
  const importTo = importSources.reduce<string | null>(
    (date, source) =>
      source.lastAt === null ? date : date === null || source.lastAt > date ? source.lastAt : date,
    null,
  );
  const pagesLoaded = loaded ? Math.ceil(loaded.records.length / 10) : 0;
  const hasNext = loaded !== undefined && (page + 1 < pagesLoaded || loaded.next !== null);
  const currentRange = loaded
    ? filter.from || filter.to
      ? [
          filter.from ? `From ${filter.from}` : "Earlier",
          filter.to ? `through ${filter.to}` : "to now",
        ].join(" · ")
      : loaded.firstAt
        ? loaded.series.coverage?.lastAt
          ? `All retained · ${dateLabel(loaded.firstAt)} to ${dateLabel(loaded.series.coverage.lastAt)}`
          : `All retained · since ${dateLabel(loaded.firstAt)}`
        : "All retained · no records"
    : "All retained";

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[56rem] flex-col px-6 pb-16 max-[540px]:px-4">
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-border">
        <button
          type="button"
          onClick={onBack}
          className="min-h-11 rounded-sm text-sm text-muted-foreground underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          Back
        </button>
        <span className="min-w-0 text-right text-sm font-semibold">
          Pool <span className="font-normal text-muted-foreground">/ Usage history</span>
        </span>
      </header>

      <main className="flex-1">
        <section className="grid gap-5 border-b border-border py-8">
          <div className="grid gap-1">
            <h1 className="text-2xl font-semibold tracking-[-0.025em]">Usage history</h1>
            <p className="max-w-[42rem] text-sm text-muted-foreground text-pretty">
              Browse retained requests in this pool. Imported usage stays separate from people.
            </p>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="grid gap-1">
              <span className="text-xs text-muted-foreground">Range · UTC</span>
              <Segmented
                label="History range"
                value={mode}
                onChange={selectMode}
                options={[
                  { id: "all", label: "All retained" },
                  { id: "dates", label: "From / To" },
                ]}
              />
            </div>
            {mode === "dates" && (
              <form
                onSubmit={applyDates}
                className="grid min-w-0 flex-1 grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"
              >
                <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
                  From
                  <input
                    type="date"
                    value={draftFrom}
                    onChange={(event) => setDraftFrom(event.currentTarget.value)}
                    className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm max-[740px]:h-11 max-[740px]:text-base text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                </label>
                <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
                  To
                  <input
                    type="date"
                    value={draftTo}
                    onChange={(event) => setDraftTo(event.currentTarget.value)}
                    className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm max-[740px]:h-11 max-[740px]:text-base text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                </label>
                <Button type="submit" variant="outline" size="sm">
                  Apply
                </Button>
              </form>
            )}
          </div>
          {filterError && (
            <p role="alert" className="text-sm text-destructive">
              {filterError}
            </p>
          )}
          <div className="flex flex-wrap items-start justify-between gap-3 text-xs text-muted-foreground">
            <span>{currentRange}</span>
            {updating && <span role="status">Updating…</span>}
            {failed && (
              <span role="status">
                <span className="text-destructive">{failed}</span> ·{" "}
                <Button size="inline" variant="link" className="text-xs" onClick={retry}>
                  Try again
                </Button>
              </span>
            )}
            {stream === "paused" && (
              <span role="status">
                Live updates paused ·{" "}
                <Button size="inline" variant="link" className="text-xs" onClick={feed.reconnect}>
                  Try again
                </Button>
              </span>
            )}
            {loaded && (
              <Button size="sm" variant="ghost" onClick={reload}>
                Reload
              </Button>
            )}
            {loaded?.series.coverage?.lastAt && (
              <span>
                Last retained request ·{" "}
                <time dateTime={loaded.series.coverage.lastAt}>
                  {requestTime(loaded.series.coverage.lastAt)}
                </time>
              </span>
            )}
          </div>
        </section>

        {loading ? (
          <div role="status" className="grid gap-4 py-8 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <Spinner /> Reading retained history…
            </span>
            <div
              aria-hidden="true"
              className="h-28 animate-pulse rounded-sm bg-accent motion-reduce:animate-none"
            />
          </div>
        ) : loadError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-5">
            <Problem>{loadError}</Problem>
            <Button size="sm" variant="outline" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : (
          loaded && (
            <>
              {loaded.series.partial && (
                <p
                  role="status"
                  className="border-b border-border py-3 text-sm text-muted-foreground"
                >
                  Grouped totals are partial. Narrow the date range for complete totals; all request
                  pages remain available.
                </p>
              )}
              {newer && (
                <p
                  role="status"
                  className="border-b border-border py-3 text-sm text-muted-foreground"
                >
                  Newer usage arrived. Reload to include it.
                </p>
              )}
              {loaded.series.changed && (
                <p
                  role="status"
                  className="border-b border-border py-3 text-sm text-muted-foreground"
                >
                  Usage changed while this history was loading. Reload to refresh the totals.
                </p>
              )}
              {loaded.seriesUnavailable ? (
                <p
                  role="status"
                  className="border-b border-border py-3 text-sm text-muted-foreground"
                >
                  {loaded.seriesUnavailable}
                </p>
              ) : (
                <>
                  <section
                    className="grid gap-4 border-b border-border py-5"
                    aria-label="History totals"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="text-lg font-semibold tabular-nums">
                        {loaded.series.partial ? "At least " : ""}
                        {(summary?.requests ?? 0).toLocaleString()}{" "}
                        <span className="text-sm font-normal">retained records</span>
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {summary?.tokensKnown
                          ? `${tokensShort(summary.tokens)}${summary.tokensMissing || summary.countsOnly ? "+" : ""} tokens reported by source`
                          : "Token totals unavailable"}
                      </span>
                    </div>
                    <HistoryChart groups={loaded.series.groups} />
                    {importSources.length > 0 && (
                      <p className="text-sm text-muted-foreground text-pretty">
                        <span className="font-medium text-foreground">
                          Imported history · no person attributed.
                        </span>{" "}
                        {dateLabel(importFrom)}
                        {importTo ? ` to ${dateLabel(importTo)}` : ""}. Imported prices are kept
                        separate; Unpriced requests remain unpriced.
                      </p>
                    )}
                  </section>
                  <HistoryBreakdown
                    groups={loaded.series.groups}
                    directory={directory}
                    providerName={name}
                  />
                </>
              )}
              {pageError && (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
                >
                  <Problem>{pageError}</Problem>
                  <Button size="sm" variant="outline" onClick={reload}>
                    Reload
                  </Button>
                </div>
              )}
              <HistoryRequests
                records={loaded.records}
                directory={directory}
                providerName={name}
                totalRecords={summary?.requests ?? null}
                partial={loaded.series.partial}
                page={page}
                hasNext={hasNext}
                loadingNext={loadingNext}
                onPrevious={previousPage}
                onNext={nextPage}
              />
            </>
          )
        )}
      </main>
    </div>
  );
}
