import { Fragment, useState } from "react";
import type { Result } from "../index.ts";
import type {
  PoolOverviewResult,
  PoolPersonalOverviewResult,
  OverviewMoneyMetric,
  OverviewUsageSlice,
} from "../overview-contract.ts";
import { Button, Problem, Segmented, StateIcon } from "./controls.tsx";
import { LabMark, labColor } from "./lab.tsx";
import { noRecordedUsage } from "./usage-outcome.ts";
import { PriceNote } from "./price-note.tsx";
import { priceSentence, samePrice, slicePrice } from "./price-text.ts";
import {
  addDecimal,
  coverageNotes,
  decimal,
  decimalText,
  money,
  moneyExact,
  moneyList,
  rows,
  total,
  tokensExact,
  tokensShort,
  personalDirectory,
  type Grouping,
  type Row,
  type SeriesRead,
  type Totals,
} from "./series-model.ts";

// Who uses what, and what it cost. Rows come straight from the usage series; a person is the
// series' own pseudonymous id until a member directory names them. Nothing missing reads as zero.

const dash = <span className="text-muted-foreground">—</span>;

function TokenCell({ totals }: { totals: Totals }) {
  if (totals.tokensKnown === 0) return dash;
  return (
    <span
      title={`${tokensExact(totals.tokens)} tokens${totals.tokensMissing ? ` · ${totals.tokensMissing.toLocaleString()} requests without token counts` : ""}`}
    >
      {tokensShort(totals.tokens)}
      {totals.tokensMissing > 0 && <span className="text-muted-foreground">+</span>}
    </span>
  );
}

const noModel = "Model not recorded; cost cannot be estimated";
const shownReasons = 2;

// Each unpriced slice explains itself; the backend's reason wins, and an unrecorded model is the one
// cause the row itself proves. Anything else stays unexplained rather than guessed.
function reasonsFor(slices: readonly OverviewUsageSlice[], field: "api" | "subscription") {
  const reasons = new Set<string>();
  for (const slice of slices) {
    const excluded =
      (field === "api" ? slice.apiUnpriced : slice.subscriptionUnpriced) + slice.unknownKind;
    if (excluded === 0) continue;
    const reason =
      (field === "api" ? slice.apiReason : slice.subscriptionReason) ??
      (slice.model === null ? noModel : undefined);
    if (reason) reasons.add(reason);
  }
  return [...reasons];
}

function Reasons({ reasons }: { reasons: readonly string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!reasons.length) return null;
  const rest = reasons.length - shownReasons;
  return (
    <span className="mt-0.5 ml-auto grid max-w-48 justify-items-end gap-0.5 text-xs leading-snug max-[540px]:max-w-32 font-normal text-muted-foreground text-pretty [overflow-wrap:anywhere]">
      {reasons.slice(0, expanded ? undefined : shownReasons).map((reason) => (
        <span key={reason}>{reason}</span>
      ))}
      {rest > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="min-h-11 min-w-11 cursor-pointer rounded-sm py-1 text-right outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? "Show less" : `+${rest} more`}
        </button>
      )}
    </span>
  );
}

function MoneyCell({
  list,
  priced,
  excluded,
  reasons,
  price = null,
  unavailable = false,
  noUsage = false,
}: {
  list: Totals["home"];
  priced: boolean;
  excluded: bigint;
  reasons: readonly string[];
  price?: ReturnType<typeof slicePrice>;
  unavailable?: boolean;
  noUsage?: boolean;
}) {
  if (noUsage) return <span className="text-muted-foreground">No usage recorded</span>;
  if (list.length)
    return (
      <>
        <span
          title={`${moneyExact(list)}${excluded ? ` · ${excluded.toLocaleString()} excluded` : ""}`}
        >
          {moneyList(list)}
          {excluded > 0n && (
            <sup
              aria-label={`${excluded.toLocaleString()} excluded`}
              className="ml-0.5 text-[10px] text-muted-foreground"
            >
              †
            </sup>
          )}
        </span>
        <PriceNote price={price} />
        <Reasons reasons={reasons} />
      </>
    );
  if (reasons.length) return <Reasons reasons={reasons} />;
  // The table's footnote carries the whole-range reason, so the cell never relies on a tooltip.
  if (unavailable) return <span className="text-muted-foreground">unavailable</span>;
  if (!priced && excluded > 0n) return <span className="text-muted-foreground">unpriced</span>;
  return dash;
}

function Stack({ row, max, name }: { row: Row; max: bigint; name: (id: string) => string }) {
  const parts = [...row.byProvider].filter(([, tokens]) => tokens > 0n);
  if (!parts.length || max === 0n) return <div className="h-2" />;
  const sum = parts.reduce((all, [, tokens]) => all + tokens, 0n);
  return (
    <div
      className="grid min-w-0 gap-1"
      title={parts.map(([id, tokens]) => `${name(id)} ${tokensShort(tokens)}`).join(" · ")}
    >
      <div
        className="flex h-2 min-w-0 gap-0.5"
        style={{ width: `${(Number(sum) / Number(max)) * 100}%` }}
      >
        {parts.map(([id, tokens]) => (
          <i
            key={id}
            className="block h-full rounded-[2px]"
            style={{ flex: Number(tokens), background: labColor(id) }}
          />
        ))}
      </div>
      <span className="block text-[10px] leading-tight text-muted-foreground">
        {parts
          .map(([id, tokens]) => `${name(id)} ${Number((tokens * 100n + sum / 2n) / sum)}%`)
          .join(" · ")}
      </span>
    </div>
  );
}

function Name({ row, by, name }: { row: Row; by: Grouping; name: (id: string) => string }) {
  const meta = row.countsOnly
    ? "Counted, not split until account mapping lands"
    : by === "person" && row.empty
      ? "No requests in this range"
      : by === "model" && row.provider
        ? name(row.provider)
        : null;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {by === "provider" && row.provider ? (
        <LabMark provider={row.provider} name={row.label} small />
      ) : by === "model" && !row.countsOnly ? (
        <span
          className="size-2 shrink-0 rounded-[2px]"
          style={{ background: labColor(row.provider) }}
        />
      ) : null}
      <span className="min-w-0">
        <span className="block font-medium [overflow-wrap:anywhere]">{row.label}</span>
        {meta && <span className="block text-xs font-normal text-muted-foreground">{meta}</span>}
      </span>
    </span>
  );
}

function rowMoney(row: Row, slices: readonly OverviewUsageSlice[]) {
  if (row.countsOnly || Object.keys(row.usageKey).length === 0)
    return {
      apiBilled: [],
      subscriptionValue: [],
      apiCount: false,
      subscriptionCount: false,
      apiExcluded: 0n,
      subscriptionExcluded: 0n,
      apiReasons: [],
      subscriptionReasons: [],
      apiPrice: null,
      subscriptionPrice: null,
    };
  const matches = slices.filter(
    (slice) =>
      (!Object.hasOwn(row.usageKey, "person") || row.usageKey.person === slice.person) &&
      (!Object.hasOwn(row.usageKey, "provider") || row.usageKey.provider === slice.provider) &&
      (!Object.hasOwn(row.usageKey, "model") || row.usageKey.model === slice.model),
  );
  const sum = (get: (slice: OverviewUsageSlice) => string | null) => {
    let value: ReturnType<typeof decimal> = null;
    for (const slice of matches) {
      const amount = get(slice);
      if (amount === null) continue;
      const parsed = decimal(amount);
      if (parsed === null) return [];
      value = value === null ? parsed : addDecimal(value, parsed);
    }
    return value === null ? [] : [{ currency: "USD", amount: value }];
  };
  return {
    apiBilled: sum((slice) => slice.apiBilled),
    subscriptionValue: sum((slice) => slice.subscriptionValue),
    apiCount: matches.some((slice) => slice.apiPricedRequests > 0),
    subscriptionCount: matches.some((slice) => slice.subscriptionPricedRequests > 0),
    apiExcluded: matches.reduce(
      (count, slice) => count + BigInt(slice.apiUnpriced) + BigInt(slice.unknownKind),
      0n,
    ),
    subscriptionExcluded: matches.reduce(
      (count, slice) => count + BigInt(slice.subscriptionUnpriced) + BigInt(slice.unknownKind),
      0n,
    ),
    apiReasons: reasonsFor(matches, "api"),
    subscriptionReasons: reasonsFor(matches, "subscription"),
    apiPrice: slicePrice(matches.filter((slice) => slice.apiBilled !== null)),
    subscriptionPrice: slicePrice(
      matches.filter((slice) => slice.subscriptionValue !== null),
      "subscriptionPrice",
    ),
  };
}

const requestSize = (row: Row) => {
  if (!row.requestTokens) return null;
  const show = (value: number | null) =>
    value === null || !Number.isSafeInteger(value) || value < 0 ? "—" : tokensShort(BigInt(value));
  return `p50 ${show(row.requestTokens.p50)} · p90 ${show(row.requestTokens.p90)} · p99 ${show(row.requestTokens.p99)} tokens`;
};

const percentileText = (values: {
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
}) =>
  `p50 ${tokensShort(BigInt(values.p50))} · p90 ${tokensShort(BigInt(values.p90))} · p99 ${tokensShort(BigInt(values.p99))}`;

const cells = (row: Row, slices: readonly OverviewUsageSlice[], unavailable: Unavailable) => {
  const totals = row.totals;
  const moneyRows = rowMoney(row, slices);
  const noUsage = noRecordedUsage(totals);
  const api = (
    <MoneyCell
      noUsage={noUsage}
      list={moneyRows.apiBilled}
      priced={moneyRows.apiCount}
      excluded={moneyRows.apiExcluded}
      reasons={moneyRows.apiReasons}
      price={moneyRows.apiPrice}
      unavailable={unavailable.api !== null}
    />
  );
  // Phones hide the API column, so its amount or reason stacks under subscription value instead.
  // A reason the subscription cell already shows is not repeated.
  const stackedApiReasons = moneyRows.apiReasons.filter(
    (reason) => !moneyRows.subscriptionReasons.includes(reason),
  );
  const stackApi =
    !noUsage &&
    (moneyRows.apiBilled.length > 0 ||
      stackedApiReasons.length > 0 ||
      (moneyRows.apiReasons.length === 0 &&
        (unavailable.api !== null || moneyRows.apiExcluded > 0n)));
  return (
    <>
      <td className="py-2.5 pr-2 text-right tabular-nums max-[540px]:hidden">
        {totals.requests ? totals.requests.toLocaleString() : dash}
      </td>
      <td className="py-2.5 pr-2 text-right tabular-nums max-[740px]:hidden">
        <TokenCell totals={totals} />
      </td>
      <td className="py-2.5 pr-2 text-right tabular-nums">
        <MoneyCell
          noUsage={noUsage}
          list={moneyRows.subscriptionValue}
          priced={moneyRows.subscriptionCount}
          excluded={moneyRows.subscriptionExcluded}
          reasons={moneyRows.subscriptionReasons}
          price={
            moneyRows.apiBilled.length > 0 &&
            samePrice(moneyRows.apiPrice, moneyRows.subscriptionPrice)
              ? null
              : moneyRows.subscriptionPrice
          }
          unavailable={unavailable.subscription !== null}
        />
        {stackApi && (
          <span className="mt-1 hidden text-xs text-muted-foreground max-[540px]:block">
            API{" "}
            <span className="text-foreground">
              <MoneyCell
                list={moneyRows.apiBilled}
                priced={moneyRows.apiCount}
                excluded={moneyRows.apiExcluded}
                reasons={stackedApiReasons}
                price={moneyRows.apiPrice}
                unavailable={unavailable.api !== null}
              />
            </span>
          </span>
        )}
      </td>
      <td className="py-2.5 text-right tabular-nums max-[540px]:hidden">{api}</td>
    </>
  );
};

interface Unavailable {
  readonly api: string | null;
  readonly subscription: string | null;
}

const unavailableReason = (metric: OverviewMoneyMetric | undefined) =>
  metric?.status === "unavailable" ? (metric.reason ?? "No reason was recorded.") : null;

export function WhoUses({
  people,
  models,
  days,
  name,
  onRetry,
  overview,
  personal,
  historyHref,
}: {
  people: Result<SeriesRead> | undefined;
  models: Result<SeriesRead> | undefined;
  days: number;
  name: (id: string) => string;
  onRetry: () => void;
  overview?: PoolOverviewResult;
  personal?: PoolPersonalOverviewResult;
  historyHref?: string;
}) {
  const [by, setBy] = useState<Grouping>("person");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const grouping = personal ? "person" : by;
  const source = grouping === "model" ? models : people;
  const personalMembers = personal
    ? personalDirectory(personal.person, personal.metrics.requestTokens.requests > 0)
    : [];
  const directory = personal ? personalMembers : (overview?.directory.members ?? []);
  const requestTokens = personal?.metrics.requestTokens ?? overview?.metrics.requestTokens;
  const list = source?.ok
    ? rows(source.value.groups, grouping, name, directory, requestTokens)
    : [];
  // The Tokens column hides on narrow screens, so the range total stays readable above the rows.
  const sum = source?.ok && list.length ? total(source.value.groups) : null;
  const slices = personal?.metrics.usageSlices ?? overview?.metrics.usageSlices ?? [];
  const metrics = personal?.metrics ?? overview?.metrics;
  const unavailable: Unavailable = {
    api: unavailableReason(metrics?.apiBilled),
    subscription: unavailableReason(metrics?.subscriptionValue),
  };
  const max = list.reduce((top, row) => (row.totals.tokens > top ? row.totals.tokens : top), 0n);
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <section id="who" aria-labelledby="who-heading" className="grid scroll-mt-4 gap-4 pt-12">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="grid gap-1">
          <h2 id="who-heading" className="text-lg font-semibold tracking-[-0.02em]">
            Who uses what
          </h2>
          <p className="max-w-[38rem] text-sm text-muted-foreground text-pretty">
            {personal
              ? `Your requests through this pool in the last ${days} days. Nobody else's show here.`
              : `Last ${days} days. Bars are tokens by lab. Open a row for its ${by === "person" ? "models" : "people"}.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {!personal && (
            <Segmented
              label="Group by"
              value={by}
              onChange={(value) => {
                setBy(value);
                setOpen(new Set());
              }}
              options={[
                { id: "person", label: "People" },
                { id: "provider", label: "Labs" },
                { id: "model", label: "Models" },
              ]}
            />
          )}
          {historyHref && !personal && (
            <a
              href={historyHref}
              className="inline-flex min-h-8 items-center gap-1 text-sm font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground max-[740px]:min-h-11"
            >
              View all history
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
                <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </a>
          )}
        </div>
      </div>
      {sum && (
        <p className="text-sm text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">
            <TokenCell totals={sum} />
          </span>{" "}
          tokens · {sum.requests.toLocaleString()} {sum.requests === 1 ? "request" : "requests"} in{" "}
          {days} days
        </p>
      )}
      {source === undefined ? (
        <div aria-hidden="true" className="h-40 animate-pulse rounded-md bg-accent" />
      ) : !source.ok ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3">
          <Problem>{source.message}</Problem>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="rounded-lg border border-dashed border-input px-6 py-8 text-sm text-muted-foreground">
          No requests through this pool in the last {days} days.
        </p>
      ) : (
        <div
          className="min-w-0 overflow-x-auto"
          role="region"
          aria-label="Usage by group"
          tabIndex={0}
        >
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-xs whitespace-nowrap text-muted-foreground [&>th]:border-b [&>th]:border-border [&>th]:py-2 [&>th]:pr-2 [&>th]:font-medium">
                <th scope="col">
                  {by === "person" ? "Person" : by === "provider" ? "Lab" : "Model"}
                </th>
                <th scope="col" className="w-[28%]">
                  Tokens by lab
                </th>
                <th scope="col" className="text-right max-[540px]:hidden">
                  Requests
                </th>
                <th scope="col" className="text-right max-[740px]:hidden">
                  Tokens
                </th>
                <th scope="col" className="text-right">
                  Subscription value
                </th>
                <th scope="col" className="text-right max-[540px]:hidden">
                  API cost
                </th>
              </tr>
            </thead>
            <tbody className="[&_td]:border-b [&_td]:border-border [&_th]:border-b [&_th]:border-border">
              {list.map((row) => {
                const expanded = open.has(row.id);
                const canOpen = row.children.length > 0;
                return (
                  <Fragment key={row.id}>
                    <tr
                      className={row.countsOnly || row.empty ? "text-muted-foreground" : undefined}
                    >
                      <th scope="row" className="py-2.5 pr-2 text-left font-normal">
                        {canOpen ? (
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => toggle(row.id)}
                            className="inline-flex min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 max-[740px]:min-h-11"
                          >
                            <svg
                              className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
                              viewBox="0 0 16 16"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="m6 3.5 4.5 4.5L6 12.5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                            <Name row={row} by={by} name={name} />
                          </button>
                        ) : (
                          <span className="block pl-[22px]">
                            <Name row={row} by={by} name={name} />
                          </span>
                        )}
                      </th>
                      <td className="py-2.5 pr-2">
                        <Stack row={row} max={max} name={name} />
                      </td>
                      {cells(row, slices, unavailable)}
                    </tr>
                    {expanded &&
                      row.children.map((child) => (
                        <tr key={child.id} className="bg-muted text-xs">
                          <th scope="row" className="py-[7px] pr-2 pl-[34px] text-left font-normal">
                            <span className="flex items-center gap-2">
                              {by === "person" && child.provider && (
                                <span
                                  className="size-2 shrink-0 rounded-[2px]"
                                  style={{ background: labColor(child.provider) }}
                                />
                              )}
                              <span>
                                {child.label}
                                {by === "person" && child.provider && (
                                  <span className="ml-1 text-muted-foreground">
                                    · {name(child.provider)}
                                  </span>
                                )}
                              </span>
                            </span>
                          </th>
                          <td className="py-[7px] pr-2">
                            <Stack row={child} max={max} name={name} />
                          </td>
                          {cells(child, slices, unavailable)}
                        </tr>
                      ))}
                    {expanded && requestSize(row) && (
                      <tr className="bg-muted text-xs">
                        <td colSpan={6} className="py-[7px] pr-2 pl-[34px] text-muted-foreground">
                          Request size for {row.label}: {requestSize(row)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {source?.ok && list.length > 0 && <UnavailableNote unavailable={unavailable} />}
      {requestTokens?.percentiles && (
        <p className="text-xs text-muted-foreground">
          Per request, everyone: {percentileText(requestTokens.percentiles)} tokens, across{" "}
          {requestTokens.requests.toLocaleString()} requests.
        </p>
      )}
      {requestTokens?.status === "unavailable" && (
        <p className="text-xs text-muted-foreground">
          Request token percentiles unavailable: {requestTokens.reason}
        </p>
      )}
      {!personal && by === "person" && overview?.directory && (
        <p className="text-xs text-muted-foreground">
          {overview.directory.activeCount} of {overview.directory.totalCount}{" "}
          {overview.directory.totalCount === 1 ? "person" : "people"} with pool access made a
          request in these {days} days.
        </p>
      )}
      {source?.ok && <Notes read={source.value} personal={personal !== undefined} />}
    </section>
  );
}

function UnavailableNote({ unavailable }: { unavailable: Unavailable }) {
  const lines =
    unavailable.api !== null && unavailable.api === unavailable.subscription
      ? [`API cost and subscription value unavailable: ${unavailable.api}`]
      : [
          unavailable.subscription !== null &&
            `Subscription value unavailable: ${unavailable.subscription}`,
          unavailable.api !== null && `API cost unavailable: ${unavailable.api}`,
        ].filter((line) => line !== false);
  return lines.map((line) => (
    <p key={line} className="text-xs text-muted-foreground text-pretty">
      {line}
    </p>
  ));
}

function Notes({ read, personal = false }: { read: SeriesRead; personal?: boolean }) {
  const notes = personal ? [] : coverageNotes(read);
  const asOf = read.asOf ? new Date(read.asOf) : null;
  return (
    <div className="grid gap-0.5 text-xs text-muted-foreground">
      {notes.map((note) => (
        <span key={note} className="flex items-start gap-1.5 text-pretty">
          <StateIcon tone="info" className="size-3.5" />
          {note}
        </span>
      ))}
      {asOf && !Number.isNaN(asOf.getTime()) && (
        <span>
          As of {asOf.toUTCString().replace(" GMT", " UTC")}.
          {personal
            ? " This view includes only your signed-in requests."
            : " Imported history keeps its source and is never attributed to a person."}
        </span>
      )}
    </div>
  );
}

/** Current API rates keep billed cost and subscription value in USD. */
export function Money({
  people,
  days,
  overview,
  name,
  personal,
}: {
  people: Result<SeriesRead> | undefined;
  days: number;
  overview?: PoolOverviewResult;
  name?: (id: string) => string;
  personal?: PoolPersonalOverviewResult;
}) {
  if (!people?.ok) return null;
  const api = personal?.metrics.apiBilled ?? overview?.metrics.apiBilled;
  const subscription = personal?.metrics.subscriptionValue ?? overview?.metrics.subscriptionValue;
  const slices = personal?.metrics.usageSlices ?? overview?.metrics.usageSlices ?? [];
  const providers = [...new Set(slices.map((slice) => slice.provider))].sort();
  const unknown = api?.excluded.unknownKind ?? 0;
  const unpriced = api?.excluded.unpriced ?? 0;
  const personDay = overview?.metrics.perActivePersonPerDay;
  return (
    <section id="cost" aria-labelledby="cost-heading" className="grid scroll-mt-4 gap-4 pt-12">
      <div className="grid gap-1">
        <h2 id="cost-heading" className="text-lg font-semibold tracking-[-0.02em]">
          API cost and subscription value
        </h2>
        <p className="max-w-[38rem] text-sm text-muted-foreground text-pretty">
          API cost estimates request tokens at current official USD prices. Subscription value
          separates flat-rate usage where the account type is known.
        </p>
      </div>
      <div className="grid grid-cols-2 rounded-lg border border-border max-[540px]:grid-cols-1">
        <Figure
          label={"API cost"}
          value={api?.status === "available" ? overviewAmount(api.amount) : "Unavailable"}
          days={days}
          body={metricBody(api, "Waiting for current USD provider prices.")}
        />
        <Figure
          label="Subscription value"
          value={
            subscription?.status === "available"
              ? overviewAmount(subscription.amount)
              : "Unavailable"
          }
          days={days}
          divided
          body={metricBody(subscription, "Waiting for current USD provider prices.")}
        />
      </div>
      <div className="grid gap-1.5 text-[13px]">
        {unknown + unpriced > 0 && (
          <span className="flex items-start gap-2 text-muted-foreground text-pretty">
            <StateIcon tone="info" />
            <span>
              <b className="font-medium text-foreground tabular-nums">{unknown.toLocaleString()}</b>{" "}
              requests with unknown kind and{" "}
              <b className="font-medium text-foreground tabular-nums">
                {unpriced.toLocaleString()}
              </b>{" "}
              unpriced requests are excluded from the API cost estimate.
            </span>
          </span>
        )}
        {personDay?.status === "available" && (
          <span className="text-muted-foreground">
            Subscription value per active person per day: p50 {overviewAmount(personDay.p50)}, p90{" "}
            {overviewAmount(personDay.p90)} across {personDay.activePeople}{" "}
            {personDay.activePeople === 1 ? "person" : "people"} and {personDay.completeDays}{" "}
            complete days.
          </span>
        )}
        {(personal?.consistency ?? overview?.consistency) === "changed" && (
          <span className="text-warning">
            Usage changed while this overview was read. Reload for a consistent range.
          </span>
        )}
      </div>
      {providers.length > 0 && (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="border-b border-border py-2 pr-2 font-medium">
                Lab
              </th>
              <th scope="col" className="border-b border-border py-2 pr-2 text-right font-medium">
                API cost
              </th>
              <th scope="col" className="border-b border-border py-2 text-right font-medium">
                Subscription value
              </th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => {
              const lab = slices.filter((slice) => slice.provider === provider);
              const api = sumOverviewAmounts(lab, "apiBilled");
              const subscription = sumOverviewAmounts(lab, "subscriptionValue");
              const apiPrice = slicePrice(lab.filter((slice) => slice.apiBilled !== null));
              const subscriptionPrice = slicePrice(
                lab.filter((slice) => slice.subscriptionValue !== null),
                "subscriptionPrice",
              );
              return (
                <tr key={provider ?? "unknown-provider"}>
                  <th
                    scope="row"
                    className="border-b border-border py-2.5 pr-2 text-left font-normal"
                  >
                    {provider ? (name?.(provider) ?? provider) : "Provider not recorded"}
                  </th>
                  <td className="border-b border-border py-2.5 pr-2 text-right tabular-nums">
                    <LabAmount sum={api} reasons={reasonsFor(lab, "api")} price={apiPrice} />
                  </td>
                  <td className="border-b border-border py-2.5 text-right tabular-nums">
                    <LabAmount
                      sum={subscription}
                      reasons={reasonsFor(lab, "subscription")}
                      price={
                        api.amount !== null && samePrice(apiPrice, subscriptionPrice)
                          ? null
                          : subscriptionPrice
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function LabAmount({
  sum,
  reasons,
  price,
}: {
  sum: ReturnType<typeof sumOverviewAmounts>;
  reasons: readonly string[];
  price: ReturnType<typeof slicePrice>;
}) {
  if (sum.amount === null && reasons.length) return <Reasons reasons={reasons} />;
  return (
    <>
      {sum.amount !== null ? overviewAmount(sum.amount) : sum.excluded ? "excluded" : "—"}
      {sum.amount !== null && <PriceNote price={price} />}
      {sum.amount !== null && <Reasons reasons={reasons} />}
    </>
  );
}

function overviewAmount(value: string | null) {
  if (value === null) return "—";
  const parsed = decimal(value);
  return parsed ? money({ currency: "USD", amount: parsed }) : "—";
}

function sumOverviewAmounts(
  slices: readonly OverviewUsageSlice[],
  field: "apiBilled" | "subscriptionValue",
) {
  let amount: ReturnType<typeof decimal> = null;
  let excluded = 0n;
  for (const slice of slices) {
    excluded +=
      BigInt(slice.unknownKind) +
      BigInt(field === "apiBilled" ? slice.apiUnpriced : slice.subscriptionUnpriced);
    const text = slice[field];
    if (text === null) continue;
    const parsed = decimal(text);
    if (parsed === null) return { amount: null, excluded };
    amount = amount === null ? parsed : addDecimal(amount, parsed);
  }
  return { amount: amount === null ? null : decimalText(amount), excluded };
}

function metricBody(metric: OverviewMoneyMetric | undefined, fallback: string) {
  if (!metric || metric.status === "unavailable")
    return { text: metric?.reason ?? fallback, failed: false };
  const price = priceSentence(metric.price ? slicePrice([metric]) : null);
  return {
    text: `${price.text} ${metric.pricedRequests.toLocaleString()} priced requests.`,
    failed: price.failed,
  };
}

function Figure({
  label,
  value,
  body,
  days,
  divided = false,
}: {
  label: string;
  value: string;
  body: { text: string; failed: boolean; detail?: string };
  days: number;
  divided?: boolean;
}) {
  return (
    <div
      className={`grid content-start gap-1 p-4 ${divided ? "border-l border-border max-[540px]:border-t max-[540px]:border-l-0" : ""}`}
    >
      <span className="text-[13px] font-medium">{label}</span>
      <span className="text-[26px] leading-tight font-semibold tracking-[-0.03em] tabular-nums">
        {value}
        <small className="ml-1.5 text-[13px] font-normal tracking-[-0.01em] text-muted-foreground">
          {days} days
        </small>
      </span>
      <p
        title={body.detail}
        className={`m-0 flex items-start gap-1.5 text-[13px] text-pretty [overflow-wrap:anywhere] ${body.failed ? "text-warning" : "text-muted-foreground"}`}
      >
        {body.failed && <StateIcon tone="warn" className="mt-0.5 size-3.5 shrink-0" />}
        <span>{body.text}</span>
      </p>
    </div>
  );
}
