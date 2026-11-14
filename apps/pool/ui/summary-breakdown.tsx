import { AccountHealth, AccountName, Badge, Button, ProviderMark, Spinner } from "apps/ui";
import { useEffect, useRef, useState } from "react";
import type { PoolView } from "../contract.ts";
import type { PoolUsageSummaryResult } from "../usage-overview-contract.ts";
import type { SeriesGroup } from "../usage-series-contract.ts";
import type { Result } from "../index.ts";
import type { PoolApi } from "./api.ts";
import { overviewAccounts } from "./overview-accounts.ts";
import { readSeries, type SeriesRead } from "./series-model.ts";
import { formatCount, formatMetric, formatShare, plural } from "./summary-format.ts";
import { breakdown, type Breakdown, type Metric } from "./summary-model.ts";

/** Account pages read for one drilldown; past this the drilldown says it is partial. */
const accountPages = 20;

interface AccountRead {
  readonly key: string;
  readonly attempt: number;
  readonly result?: Result<SeriesRead>;
}

/**
 * One account read per answered summary range, shared by every open lab and kept across metric and
 * breakdown switches of that range. Nothing is read while every lab is collapsed; a late answer for
 * an older range is dropped.
 */
function useAccounts(api: PoolApi, summary: PoolUsageSummaryResult, wanted: boolean) {
  const key = `${summary.from} ${summary.to}`;
  const [read, setRead] = useState<AccountRead>();
  const current = read?.key === key ? read : undefined;
  const latest = useRef(key);
  latest.current = key;
  const attempt = current?.attempt ?? 0;
  const settled = current?.result !== undefined;
  const inflight = useRef<string>(undefined);
  useEffect(() => {
    const id = `${key} ${attempt}`;
    if (!wanted || settled || inflight.current === id) return;
    inflight.current = id;
    const asked = { key, attempt };
    void readSeries(
      (input) => api.series(input),
      {
        from: summary.from,
        to: summary.to,
        bucket: "day",
        timezone: "Europe/Zurich",
        by: ["provider", "account"],
      },
      accountPages,
    ).then((result) =>
      setRead((now) => {
        // Only the newest attempt for the range still shown may settle.
        if (latest.current !== asked.key) return now;
        const newest = now?.key === asked.key ? now.attempt : 0;
        return newest === asked.attempt ? { ...asked, result } : now;
      }),
    );
    // A new range or a retry starts its own read; the previous one can no longer settle.
  }, [api, key, attempt, wanted, settled, summary.from, summary.to]);
  return {
    result: current?.result,
    retry: () => setRead({ key, attempt: attempt + 1 }),
  };
}

interface Value {
  readonly value: number | null;
  readonly missing: number;
}

/** The metric over one account's buckets, counting requests the metric doesn't cover. */
function seriesValue(group: SeriesGroup, metric: Metric): Value {
  let value: number | null = null;
  let missing = 0;
  for (const bucket of group.buckets) {
    if (metric === "requests") {
      value = (value ?? 0) + bucket.requests;
      continue;
    }
    if (!("tokens" in bucket)) {
      missing += bucket.requests;
      continue;
    }
    if (metric === "tokens") {
      if (bucket.tokens.total.sum !== null) value = (value ?? 0) + Number(bucket.tokens.total.sum);
      missing += bucket.tokens.total.missing;
      continue;
    }
    const estimate = bucket.cost.apiEstimate;
    if (estimate?.status === "available" && estimate.amount !== null) {
      value = (value ?? 0) + Number(estimate.amount);
      missing += bucket.requests - estimate.pricedRequests;
    } else missing += bucket.requests;
  }
  return { value, missing };
}

/** "≥ $3.10 · 2 without a price": a known sum never reads as the whole when some is missing. */
function Amount({ metric, value }: { metric: Metric; value: Value }) {
  return (
    <>
      {value.missing > 0 && value.value !== null ? "≥ " : ""}
      {formatMetric(metric, value.value)}
    </>
  );
}

const missingText = (metric: Metric, missing: number) =>
  missing === 0 || metric === "requests"
    ? ""
    : ` · ${formatCount(missing)} without ${metric === "tokens" ? "token counts" : "a price"}`;

function AccountRows({
  groups,
  lab,
  metric,
  view,
}: {
  groups: readonly SeriesGroup[];
  lab: string;
  metric: Metric;
  view: PoolView | undefined;
}) {
  const mine = groups.filter((group) => group.key.provider === lab);
  if (mine.length === 0)
    return <p className="px-3 py-2 text-xs text-muted-foreground">No account used this lab.</p>;
  const rows = mine
    .map((group, index) => {
      const id = group.key.account ?? null;
      const account = view?.accounts.find(
        (entry) => id !== null && (entry.id === id || entry.nativeAccountId === id),
      );
      const display = group.accountDisplay;
      const where =
        display?.kind === "imported-only"
          ? "Imported only"
          : display?.kind === "no-account-recorded" || id === null
            ? "Unattributed"
            : "In pool";
      const title =
        account?.label ??
        (display?.kind === "imported-only"
          ? (display.label ?? "Imported account")
          : display?.kind === "no-account-recorded"
            ? "No account recorded"
            : id === null
              ? "An account you can't inspect"
              : "Former pool account");
      // Only the provider's own view of a pool account says how healthy it is; a withheld or denied
      // source shows none rather than an older reading.
      const health =
        account?.nativeView?.state === "available" && account.nativeView.canInspect
          ? account.nativeView.health
          : undefined;
      return {
        key: `${where} ${index}`,
        title,
        where,
        health,
        // A current pool account whose provider returned no health says so; imported and
        // unattributed usage has no live account to be healthy or not.
        healthUnknown: account !== undefined && health === undefined,
        value: seriesValue(group, metric),
        requests: group.buckets.reduce((sum, bucket) => sum + bucket.requests, 0),
      };
    })
    .sort((a, b) => (b.value.value ?? -1) - (a.value.value ?? -1));
  return (
    <ul className="grid">
      {rows.map((row) => (
        <li
          key={row.key}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t px-3 py-2 text-sm"
        >
          <div className="grid min-w-0 gap-0.5">
            <AccountName
              title={row.title}
              health={row.health}
              tags={<Badge className="text-muted-foreground">{row.where}</Badge>}
            />
            {row.health ? (
              <AccountHealth health={row.health} />
            ) : (
              row.healthUnknown && (
                <span className="text-xs text-muted-foreground">Health unavailable</span>
              )
            )}
          </div>
          <span className="text-right tabular-nums">
            <Amount metric={metric} value={row.value} />
            <span className="block text-xs text-muted-foreground">
              {plural(row.requests, "request", "requests")}
              {missingText(metric, row.value.missing)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Drilldown({
  read,
  lab,
  metric,
  view,
  onRetry,
}: {
  read: Result<SeriesRead> | undefined;
  lab: string;
  metric: Metric;
  view: PoolView | undefined;
  onRetry: () => void;
}) {
  if (read === undefined)
    return (
      <p role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Spinner /> Reading accounts…
      </p>
    );
  if (!read.ok)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
        <span className="text-destructive">{read.message}</span>
        <Button size="xs" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  return (
    <>
      {(read.value.truncated || read.value.asOfChanged) && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground text-pretty">
          {read.value.truncated
            ? `Accounts are partial: more than ${accountPages} pages for this range. Choose a shorter range for every account.`
            : "Usage changed while accounts were read. Refresh for one consistent read."}
        </p>
      )}
      <AccountRows groups={read.value.groups} lab={lab} metric={metric} view={view} />
    </>
  );
}

export function SummaryBreakdown({
  api,
  summary,
  by,
  metric,
  view,
  name,
  onHistory,
}: {
  api: PoolApi;
  summary: PoolUsageSummaryResult;
  by: Breakdown;
  metric: Metric;
  view: PoolView | undefined;
  name: (provider: string | null) => string;
  onHistory: (search: Record<string, string>) => void;
}) {
  const groups = by === "model" ? (summary.models?.groups ?? []) : summary.daily;
  const rows = breakdown(groups, summary.usageSlices, by, metric);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const accounts = useAccounts(api, summary, by === "provider" && open.size > 0);
  const pool = overviewAccounts(view);
  const toggle = (lab: string) => {
    const next = new Set(open);
    if (next.has(lab)) next.delete(lab);
    else next.add(lab);
    setOpen(next);
  };
  const days = { from: summary.from.slice(0, 10), to: summary.to.slice(0, 10) };
  const heading = by === "model" ? "By model" : "By lab";
  return (
    <section aria-labelledby="usage-breakdown-heading" className="mb-10 grid gap-3">
      <h2 id="usage-breakdown-heading" className="text-base font-semibold tracking-[-0.015em]">
        {heading}
      </h2>
      {by === "model" && summary.models?.status !== "available" ? (
        <p className="text-sm text-muted-foreground">
          {summary.models?.reason ?? "Models aren't available for this range."}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No usage in this range.</p>
      ) : (
        <ul className="grid rounded-lg border">
          {rows.map((row, index) => {
            const lab = by === "provider" ? row.key : null;
            const inPool = lab === null ? 0 : pool.filter((a) => a.provider === lab).length;
            const expanded = lab !== null && open.has(lab);
            const title = by === "provider" ? name(row.key) : (row.key ?? "Unknown model");
            return (
              <li key={row.key ?? "none"} className={index === 0 ? "" : "border-t"}>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 max-[540px]:grid-cols-1">
                  <div className="flex min-w-0 items-center gap-2.5">
                    {by === "provider" && <ProviderMark name={title} size="medium" />}
                    <div className="grid min-w-0">
                      <span className="truncate text-sm font-medium">{title}</span>
                      <span className="text-xs text-muted-foreground">
                        {lab !== null
                          ? inPool === 0
                            ? "No account in pool"
                            : plural(inPool, "account in pool", "accounts in pool")
                          : plural(row.requests, "request", "requests")}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 justify-self-end">
                    <span className="grid text-right tabular-nums">
                      <span className="text-sm font-medium">
                        <Amount metric={metric} value={row.total} />
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {row.share === null ? "share unknown" : `${formatShare(row.share)} of all`}
                        {metric !== "cost" && row.cost.amount !== null
                          ? ` · ${formatMetric("cost", row.cost.amount)}`
                          : ""}
                        {missingText(metric, row.total.missing)}
                      </span>
                    </span>
                    {lab !== null && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onHistory({ lab, ...days })}
                        >
                          History
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-expanded={expanded}
                          aria-controls={`accounts-${lab}`}
                          onClick={() => toggle(lab)}
                        >
                          Accounts {expanded ? "▾" : "▸"}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {expanded && (
                  <div id={`accounts-${lab}`} className="bg-muted/40 pb-1">
                    <Drilldown
                      read={accounts.result}
                      lab={lab}
                      metric={metric}
                      view={view}
                      onRetry={accounts.retry}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
