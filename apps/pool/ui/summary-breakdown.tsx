import { AccountName, Badge, Button, ProviderMark, Spinner } from "apps/ui";
import { useState } from "react";
import type { PoolView } from "../contract.ts";
import type { PoolUsageSummaryResult } from "../usage-overview-contract.ts";
import type { SeriesGroup } from "../usage-series-contract.ts";
import type { Result } from "../index.ts";
import type { PoolApi } from "./api.ts";
import { overviewAccounts } from "./overview-accounts.ts";
import { formatCount, formatMetric, formatShare, plural } from "./summary-format.ts";
import { breakdown, type Breakdown, type Metric } from "./summary-model.ts";

type Accounts = Result<readonly SeriesGroup[]>;

/**
 * Every account's usage in the same range, read once on the first lab someone opens and shared by
 * every lab after it. Pages are merged whole, so each group keeps its own account display.
 */
async function readAccounts(api: PoolApi, summary: PoolUsageSummaryResult): Promise<Accounts> {
  // One group can continue on the next page; its display rides on whichever page carried it.
  const groups = new Map<string, SeriesGroup>();
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const read = await api.series({
      from: summary.from,
      to: summary.to,
      bucket: "day",
      timezone: "Europe/Zurich",
      by: ["provider", "account"],
      ...(after === undefined ? {} : { after }),
    });
    if (!read.ok) return read;
    for (const group of read.value.groups) {
      const key = JSON.stringify([group.key.provider, group.key.account, group.key.currency]);
      const known = groups.get(key);
      const accountDisplay = known?.accountDisplay ?? group.accountDisplay;
      groups.set(key, {
        key: group.key,
        ...(accountDisplay === undefined ? {} : { accountDisplay }),
        buckets: [...(known?.buckets ?? []), ...group.buckets],
      });
    }
    if (read.value.next === null) break;
    after = read.value.next;
  }
  return { ok: true, value: [...groups.values()] };
}

function seriesValue(group: SeriesGroup, metric: Metric): number | null {
  let value: number | null = null;
  for (const bucket of group.buckets) {
    const known =
      metric === "requests"
        ? bucket.requests
        : !("tokens" in bucket)
          ? null
          : metric === "tokens"
            ? bucket.tokens.total.sum === null
              ? null
              : Number(bucket.tokens.total.sum)
            : bucket.cost.apiEstimate?.status === "available" &&
                bucket.cost.apiEstimate.amount !== null
              ? Number(bucket.cost.apiEstimate.amount)
              : null;
    if (known !== null) value = (value ?? 0) + known;
  }
  return value;
}

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
    .map((group) => {
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
      const health =
        account?.nativeView?.state === "available" ? account.nativeView.health : undefined;
      return {
        key: `${id ?? display?.kind ?? "none"}:${display?.kind === "imported-only" ? display.label : ""}`,
        title,
        where,
        health,
        value: seriesValue(group, metric),
        requests: group.buckets.reduce((sum, bucket) => sum + bucket.requests, 0),
      };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  return (
    <ul className="grid">
      {rows.map((row) => (
        <li
          key={row.key}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t px-3 py-2 text-sm"
        >
          <AccountName
            title={row.title}
            health={row.health}
            tags={<Badge className="text-muted-foreground">{row.where}</Badge>}
          />
          <span className="text-right tabular-nums">
            {formatMetric(metric, row.value)}
            <span className="block text-xs text-muted-foreground">
              {plural(row.requests, "request", "requests")}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SummaryBreakdown({
  api,
  summary,
  by,
  metric,
  view,
  name,
}: {
  api: PoolApi;
  summary: PoolUsageSummaryResult;
  by: Breakdown;
  metric: Metric;
  view: PoolView | undefined;
  name: (provider: string | null) => string;
}) {
  const groups = by === "model" ? (summary.models?.groups ?? []) : summary.daily;
  const rows = breakdown(groups, summary.usageSlices, by, metric);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Keyed by the summary's own bounds, so a refresh or range change reads accounts again.
  const [accounts, setAccounts] = useState<{ key: string; result?: Accounts }>();
  const range = `${summary.from} ${summary.to}`;
  const loaded = accounts?.key === range ? accounts : undefined;
  const pool = overviewAccounts(view);
  const toggle = (lab: string) => {
    const next = new Set(open);
    if (next.has(lab)) next.delete(lab);
    else {
      next.add(lab);
      if (loaded === undefined) {
        setAccounts({ key: range });
        void readAccounts(api, summary).then((result) =>
          setAccounts((current) => (current?.key === range ? { key: range, result } : current)),
        );
      }
    }
    setOpen(next);
  };
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
                  <div className="flex items-center gap-4 justify-self-end">
                    <span className="grid text-right tabular-nums">
                      <span className="text-sm font-medium">
                        {formatMetric(metric, row.total.value)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {row.share === null ? "share unknown" : `${formatShare(row.share)} of all`}
                        {metric !== "cost" && row.cost.amount !== null
                          ? ` · ${formatMetric("cost", row.cost.amount)}`
                          : ""}
                        {row.cost.unpriced > 0
                          ? ` · ${formatCount(row.cost.unpriced)} unpriced`
                          : ""}
                      </span>
                    </span>
                    {lab !== null && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={expanded}
                        aria-controls={`accounts-${lab}`}
                        onClick={() => toggle(lab)}
                      >
                        Accounts {expanded ? "▾" : "▸"}
                      </Button>
                    )}
                  </div>
                </div>
                {expanded && (
                  <div id={`accounts-${lab}`} className="bg-muted/40 pb-1">
                    {loaded?.result === undefined ? (
                      <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                        <Spinner /> Reading accounts…
                      </p>
                    ) : !loaded.result.ok ? (
                      <p className="px-3 py-2 text-xs text-destructive">{loaded.result.message}</p>
                    ) : (
                      <AccountRows
                        groups={loaded.result.value}
                        lab={lab}
                        metric={metric}
                        view={view}
                      />
                    )}
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
