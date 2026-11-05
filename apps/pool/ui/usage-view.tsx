import { useCallback, useEffect, useState } from "react";
import type { AccountsNeeded, Cap, Provider, UsageSummary } from "../contract.ts";
import type { Result } from "../index.ts";
import type { PoolApi } from "./api.ts";
import { providerName } from "./accounts.tsx";
import { Button, ExternalIcon, Problem } from "./controls.tsx";
import { exactTime, percent, resetsIn } from "./usage.ts";
import { advice, columns, modelKey, cost, dayLabel, dayRange, format, rankModels, series, share, tokens, value, type Metric } from "./usage-format.ts";

// Usage, the way the prototype splits it: tokens and API-equivalent cost as separate views, per model
// over time. The owner sees the whole pool; anyone else sees only their own requests on it.

type Poll = PoolApi["poll"];

// Series shades on the dashboard's monochrome scale; "Other" is the faintest.
const shades = ["bg-foreground/85", "bg-foreground/55", "bg-foreground/35", "bg-foreground/20"];
const otherShade = "bg-foreground/10";

function useUsage(load: () => Promise<Result<UsageSummary>>, poll: Poll) {
  const [summary, setSummary] = useState<UsageSummary>();
  const [error, setError] = useState<string>();
  const read = useCallback(async () => {
    const result = await load();
    if (result.ok) {
      setSummary(result.value);
      setError(undefined);
    } else setError(result.message);
  }, [load]);
  useEffect(() => {
    void read();
    return poll(() => void read(), 5 * 60_000);
  }, [read, poll]);
  return { summary, error, read };
}

export function Usage({
  load,
  poll,
  providers,
  now,
  shareHref,
}: {
  load: () => Promise<Result<UsageSummary>>;
  poll: Poll;
  providers: readonly Provider[];
  now: number;
  shareHref?: string;
}) {
  const { summary, error, read } = useUsage(load, poll);
  const [metric, setMetric] = useState<Metric>("tokens");
  const mine = summary?.scope === "you";
  return (
    <section aria-labelledby="usage-heading" className="grid gap-5 pt-12">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="grid gap-1">
          <h2 id="usage-heading" className="text-lg font-semibold tracking-[-0.02em]">
            {mine ? "Your usage" : "Usage"}
          </h2>
          <p className="max-w-[36rem] text-sm text-muted-foreground text-pretty">
            {mine
              ? "Your requests through this pool in the last 30 days. Nobody else's show here."
              : "Everyone's requests through this pool in the last 30 days."}{" "}
            Cost is what the same tokens would cost at API prices.
          </p>
        </div>
        <MetricSwitch metric={metric} onChange={setMetric} />
      </div>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3">
          <Problem>{error}</Problem>
          <Button size="sm" variant="outline" onClick={() => void read()}>
            Try again
          </Button>
        </div>
      )}

      {summary === undefined ? (
        !error && <div aria-hidden="true" className="h-40 animate-pulse rounded-md bg-accent" />
      ) : (
        <>
          {summary.cap && <CapLine cap={summary.cap} now={now} />}
          {summary.accountsNeeded && summary.accountsNeeded.length > 0 && (
            <Needed entries={summary.accountsNeeded} providers={providers} />
          )}
          <Headline summary={summary} metric={metric} />
          {summary.total.requests === 0 ? (
            <p className="rounded-lg border border-dashed border-input px-6 py-8 text-sm text-muted-foreground text-pretty">
              {mine ? "You haven't sent a request through this pool yet." : "No requests through this pool yet."} Set up a
              computer below and its requests show here within a few minutes.
            </p>
          ) : (
            <>
              <Chart summary={summary} metric={metric} />
              <Models summary={summary} metric={metric} providers={providers} />
            </>
          )}
          {summary.scope === "pool" && summary.members && (
            <p className="text-sm text-muted-foreground text-pretty">
              {summary.members.filter((member) => member.requests > 0).length} of {summary.members.length}{" "}
              {summary.members.length === 1 ? "person" : "people"} used it.{" "}
              {shareHref && (
                <a href={shareHref} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground">
                  Manage pool access <ExternalIcon />
                </a>
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function MetricSwitch({ metric, onChange }: { metric: Metric; onChange: (metric: Metric) => void }) {
  const options: { id: Metric; label: string }[] = [
    { id: "tokens", label: "Tokens" },
    { id: "cost", label: "Cost" },
  ];
  return (
    <div role="radiogroup" aria-label="Show" className="inline-flex h-8 w-fit rounded-md border border-border p-0.5 max-[740px]:h-11">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={metric === option.id}
          onClick={() => onChange(option.id)}
          className={`rounded-[4px] px-3 text-xs font-medium transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
            metric === option.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Headline({ summary, metric }: { summary: UsageSummary; metric: Metric }) {
  const { total } = summary;
  const other = metric === "tokens" ? `${cost(total.cost)} at API prices` : `${tokens(total.tokens.total)} tokens`;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-3xl font-semibold tracking-[-0.03em] tabular-nums">
        {metric === "tokens" ? tokens(total.tokens.total) : cost(total.cost)}
      </span>
      <span className="text-sm text-muted-foreground tabular-nums">
        {metric === "tokens" ? "tokens · " : ""}
        {other} · {total.requests.toLocaleString()} {total.requests === 1 ? "request" : "requests"}
        {total.unpriced > 0 && metric === "cost" && <> · {total.unpriced.toLocaleString()} without a price</>}
      </span>
      {metric === "tokens" && total.tokens.total > 0 && (
        <span className="basis-full text-xs text-muted-foreground tabular-nums">
          {tokens(total.tokens.input)} input · {tokens(total.tokens.cacheRead)} cached · {tokens(total.tokens.cacheWrite)} cache
          writes · {tokens(total.tokens.output)} output
        </span>
      )}
    </div>
  );
}

/** What a chart and model list need: one person's usage or the whole pool's. */
export type Breakdown = Pick<UsageSummary, "from" | "to" | "total" | "models" | "days">;

export function Chart({ summary, metric }: { summary: Breakdown; metric: Metric }) {
  const range = dayRange(summary.from, summary.to);
  const { keys, other } = series(summary.models, metric);
  const data = columns(summary.days, range, keys, metric);
  const peak = Math.max(...data.map((column) => column.total), 0);
  if (peak === 0) return <p className="text-sm text-muted-foreground">Nothing priced yet in these 30 days.</p>;
  return (
    <figure className="m-0 grid gap-3">
      <div aria-hidden="true" className="grid h-36 grid-flow-col items-end gap-[3px] border-b border-border" style={{ gridAutoColumns: "minmax(0, 1fr)" }}>
        {data.map((column) => (
          <div
            key={column.day}
            className="flex h-full flex-col-reverse rounded-t-[2px] [@media(pointer:fine)]:hover:bg-accent/60"
            title={`${dayLabel(column.day)}: ${format(column.total, metric)}`}
          >
            {column.parts.map((part) => (
              <div
                key={part.key}
                className={`w-full first:rounded-b-none last:rounded-t-[2px] ${part.key ? shades[keys.indexOf(part.key)] : otherShade}`}
                style={{ height: `${(part.amount / peak) * 100}%` }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums" aria-hidden="true">
        <span>{range[0] && dayLabel(range[0])}</span>
        <span>Today</span>
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="sr-only">Models:</span>
        {keys.map((key, index) => (
          <span key={key} className="inline-flex min-w-0 items-center gap-1.5">
            <span className={`size-2 shrink-0 rounded-[2px] ${shades[index]}`} aria-hidden="true" />
            <span className="truncate">{key.slice(key.indexOf(":") + 1)}</span>
          </span>
        ))}
        {other && (
          <span className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-[2px] ${otherShade}`} aria-hidden="true" />
            Other models
          </span>
        )}
      </figcaption>
      {/* The bars only show on hover; this reads every day out. */}
      <table className="sr-only">
        <caption>{metric === "tokens" ? "Tokens" : "Cost"} per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">{metric === "tokens" ? "Tokens" : "Cost"}</th>
          </tr>
        </thead>
        <tbody>
          {data.filter((column) => column.total > 0).map((column) => (
            <tr key={column.day}>
              <th scope="row">{dayLabel(column.day)}</th>
              <td>{format(column.total, metric)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function Models({ summary, metric, providers }: { summary: Breakdown; metric: Metric; providers: readonly Provider[] }) {
  const total = value(summary.total, metric);
  return (
    <div className="grid gap-1">
      <h3 className="text-sm font-medium">By model</h3>
      <ul aria-label="By model" className="m-0 list-none border-t border-border p-0">
        {rankModels(summary.models, metric).map((model) => {
          const amount = value(model, metric);
          return (
            <li
              key={modelKey(model)}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5 border-b border-border px-1 py-3 sm:grid-cols-[minmax(0,14rem)_1fr_10rem]"
            >
              <div className="min-w-0">
                <span className="block truncate font-medium" title={model.model}>
                  {model.model}
                </span>
                <span className="block text-xs text-muted-foreground">{providerName(providers, model.provider)}</span>
              </div>
              <div className="order-last col-span-2 h-1.5 rounded-full bg-accent sm:order-none sm:col-span-1" aria-hidden="true">
                <div className="h-full rounded-full bg-foreground/80" style={{ width: percent(share(amount, total)) }} />
              </div>
              <span className="text-right text-xs tabular-nums text-muted-foreground">
                <span className="font-medium text-foreground">{format(amount, metric)}</span>
                {" · "}
                {metric === "tokens" ? cost(model.cost) : `${tokens(model.tokens.total)} tokens`}
                {metric === "cost" && model.unpriced > 0 && model.cost === 0 && " · no price"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** What's left of the cap the owner set, and when it resets. Only ever the caller's own. */
function CapLine({ cap, now }: { cap: Cap; now: number }) {
  const left = share(cap.remaining, cap.weekly);
  const resetAt = Date.parse(cap.resetAt);
  const reset = resetsIn(cap, now);
  const out = cap.remaining <= 0;
  return (
    <div className="grid gap-2 rounded-md border border-border px-4 py-3" title={Number.isNaN(resetAt) ? undefined : `Resets ${exactTime(cap.resetAt)}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm">
        <span className="font-medium">Your weekly cap</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className={out ? "font-medium text-destructive" : "font-medium text-foreground"}>{cost(cap.remaining)}</span> of{" "}
          {cost(cap.weekly)} left{reset && <> · {reset}</>}
        </span>
      </div>
      <div role="meter" aria-label="Weekly cap left" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(left * 100)} className="h-1.5 rounded-full bg-accent">
        <div className={`h-full rounded-full ${left < 0.15 ? "bg-destructive" : "bg-foreground/80"}`} style={{ width: percent(left) }} />
      </div>
      {out && (
        <p className="text-xs text-muted-foreground text-pretty">
          This pool's owner set this cap. Your requests through it stop until it resets; ask them to raise it, or switch a
          computer to another pool.
        </p>
      )}
    </div>
  );
}

/** One line per provider: add an account, remove one, or leave it. */
function Needed({ entries, providers }: { entries: readonly AccountsNeeded[]; providers: readonly Provider[] }) {
  return (
    <ul aria-label="Accounts needed" className="m-0 grid list-none gap-1.5 p-0">
      {entries.map((entry) => (
        <li key={entry.provider} className="flex items-baseline gap-2.5 text-sm text-pretty">
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${
              entry.advice === "add" ? "bg-warning" : entry.advice === "unknown" ? "bg-input" : "bg-foreground/60"
            }`}
          />
          <span className={entry.advice === "add" ? "text-foreground" : "text-muted-foreground"}>
            {advice(entry, providerName(providers, entry.provider))}
          </span>
        </li>
      ))}
    </ul>
  );
}
