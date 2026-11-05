import type { ReactNode } from "react";
import type { PoolView, Provider } from "../contract.ts";
import type { Result } from "../index.ts";
import type { PoolPersonalOverviewResult } from "../overview-contract.ts";
import { capacityLabs, gaps, hourMs, planChips } from "./capacity-model.ts";
import {
  CapacitySection,
  labSummaries,
  toneText,
  type LabSummary,
  type Tone,
} from "./capacity-view.tsx";
import { StateIcon } from "./controls.tsx";
import { LabMark } from "./lab.tsx";
import { seriesRead, type Overview, type RangeDays } from "./overview-data.ts";
import { rows, total } from "./series-model.ts";
import { Money, WhoUses } from "./usage-groups.tsx";
import { accountProblems, bankedResetCount } from "./overview-attention.ts";

// The manager's App tab: four answers first, each linking down to its evidence. Per-account health,
// resets and actions stay on the host's Accounts tab; this page only aggregates.

const usd = (value: string) =>
  new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Number(value));

// Names come from the pool view. Until it lands, a neutral mark holds their place: never a raw
// ID, never a guess.
const namer = (providers: readonly Provider[] | undefined) => (id: string) =>
  providers?.find((provider) => provider.id === id)?.name ?? "…";

const accountsHandoff =
  "Each account's health, sign-ins, resets and details are on this app's Accounts tab.";

export function ManagerOverview({
  data,
  days,
  providers,
  view,
  accountsHref,
  onRetry,
}: {
  data: Overview;
  days: RangeDays;
  providers: readonly Provider[] | undefined;
  view: PoolView | undefined;
  accountsHref?: string;
  onRetry: () => void;
}) {
  const name = namer(providers);
  const labs =
    data.coherent === true && data.capacity?.ok ? labSummaries(data.capacity.value, days) : [];
  return (
    <>
      {data.coherent === false && data.capacity !== undefined && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          This read is incomplete. Totals below keep their coverage notes; no complete capacity
          verdict is claimed.{" "}
          <button type="button" onClick={onRetry} className="underline underline-offset-2">
            Read again
          </button>
        </p>
      )}
      <Answers data={data} labs={labs} days={days} name={name} view={view} />
      <CapacitySection
        result={data.capacity?.ok && !providers ? undefined : data.capacity}
        providers={providers ?? []}
        days={days}
        coherent={data.coherent === true}
        onRetry={onRetry}
      />
      <WhoUses
        overview={data.usage?.ok ? data.usage.value : undefined}
        people={data.people}
        models={data.models}
        days={days}
        name={name}
        onRetry={onRetry}
      />
      <Money
        overview={data.usage?.ok ? data.usage.value : undefined}
        people={data.people}
        days={days}
        name={name}
      />
      <Attention data={data} name={name} days={days} view={view} accountsHref={accountsHref} />
    </>
  );
}

export function PersonalOverview({
  data,
  days,
  providers,
  onRetry,
}: {
  data: Result<PoolPersonalOverviewResult> | undefined;
  days: RangeDays;
  providers: readonly Provider[] | undefined;
  onRetry: () => void;
}) {
  const name = namer(providers);
  if (!data?.ok)
    return (
      <section className="grid gap-4 pt-12">
        {data ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3">
            <span className="text-sm text-destructive">{data.message}</span>
            <button
              type="button"
              onClick={onRetry}
              className="text-sm underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        ) : (
          <div aria-hidden="true" className="h-40 animate-pulse rounded-md bg-accent" />
        )}
      </section>
    );
  const read = {
    ok: true as const,
    value: seriesRead(data.value.series, data.value.partial || data.value.series.next !== null),
  };
  return (
    <>
      {data.value.partial && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          This read is incomplete. Your request totals keep their coverage notes; retry for a
          complete range.
        </p>
      )}
      <WhoUses
        overview={undefined}
        personal={data.value}
        people={read}
        models={read}
        days={days}
        name={name}
        onRetry={onRetry}
      />
      <Money overview={undefined} personal={data.value} people={read} days={days} name={name} />
    </>
  );
}

function Answer({
  href,
  question,
  tone,
  answer,
  children,
}: {
  href: string;
  question: string;
  tone?: Tone;
  answer: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className="grid content-start gap-1 border-border px-4 pt-3.5 pb-4 text-inherit no-underline transition-colors duration-150 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset [&:not(:first-child)]:border-l max-[740px]:[&:nth-child(3)]:border-l-0 max-[740px]:[&:nth-child(n+3)]:border-t max-[540px]:border-l-0! max-[540px]:[&:not(:first-child)]:border-t"
    >
      <span className="text-[13px] text-muted-foreground">{question}</span>
      <span
        className={`flex items-start gap-1.5 text-[15px] leading-snug font-semibold tracking-[-0.015em] text-balance ${tone ? toneText[tone] : ""}`}
      >
        {tone && <StateIcon tone={tone} />}
        <span className={tone ? "text-foreground" : undefined}>{answer}</span>
      </span>
      {children}
    </a>
  );
}

function Answers({
  data,
  labs,
  days,
  name,
  view,
}: {
  data: Overview;
  labs: readonly LabSummary[];
  days: number;
  name: (id: string) => string;
  view: PoolView | undefined;
}) {
  const worst = labs.find((entry) => entry.verdict.tone === "warn" || entry.verdict.tone === "bad");
  const learning = labs.find((entry) => entry.verdict.tone === "learn");
  const enough: { tone: Tone; text: string } = !data.capacity
    ? { tone: "learn", text: "Reading…" }
    : !data.capacity.ok
      ? { tone: "learn", text: "Capacity unavailable" }
      : data.coherent === false
        ? { tone: "learn", text: "Read incomplete" }
        : labs.length === 0
          ? { tone: "learn", text: "No readings yet" }
          : worst
            ? {
                tone: worst.verdict.tone,
                text: `${name(worst.lab.provider)}: ${worst.verdict.short.toLowerCase()}`,
              }
            : learning
              ? {
                  tone: "learn",
                  text:
                    learning.verdict.short === "Unavailable"
                      ? "Forecast unavailable"
                      : "Learning the weekly pattern",
                }
              : { tone: "ok", text: "Enough for the next 72 hours" };
  const usage = data.usage?.ok ? data.usage.value : null;
  const read = data.people?.ok ? data.people.value : null;
  const people = read
    ? rows(
        read.groups,
        "person",
        name,
        usage?.directory.members ?? [],
        usage?.metrics.requestTokens,
      ).filter((row) => row.id.startsWith("person:") && row.totals.tokens > 0n)
    : [];
  const sum = read ? total(read.groups) : null;
  const all = people.reduce((acc, row) => acc + row.totals.tokens, 0n);
  const top = people.slice(0, 2);
  const share =
    all > 0n
      ? Math.round(
          (Number(top.reduce((acc, row) => acc + row.totals.tokens, 0n)) / Number(all)) * 100,
        )
      : 0;
  const failedShare = sum && sum.requests ? (sum.failed / sum.requests) * 100 : null;
  const problems = view ? accountProblems(view) : [];
  return (
    <nav
      aria-label="At a glance"
      className="grid grid-cols-4 overflow-hidden rounded-lg border border-border max-[740px]:grid-cols-2 max-[540px]:grid-cols-1"
    >
      <Answer href="#capacity" question="Enough accounts?" tone={enough.tone} answer={enough.text}>
        <span className="grid gap-0.5 text-[13px]">
          {labs.map(({ lab, verdict }) => (
            <span key={lab.provider} className="flex min-w-0 items-center gap-1.5">
              <LabMark provider={lab.provider} name={name(lab.provider)} small />
              <span className={toneText[verdict.tone]}>
                {name(lab.provider)}: {verdict.short.toLowerCase()}
              </span>
            </span>
          ))}
        </span>
      </Answer>
      <Answer
        href="#who"
        question="Who uses what?"
        answer={
          !read
            ? "Reading…"
            : top.length
              ? `${top.map((row) => row.label).join(" and ")}: ${share}% of tokens`
              : "Not split by person yet"
        }
      >
        {sum && (
          <span className="text-[13px] text-muted-foreground tabular-nums">
            {usage?.directory.activeCount ?? people.length} of{" "}
            {usage?.directory.totalCount ?? people.length} people active ·{" "}
            {sum.requests.toLocaleString()} requests in {days} days
          </span>
        )}
      </Answer>
      <Answer
        href="#cost"
        question="API cost"
        answer={
          !usage
            ? "Reading…"
            : usage.metrics.apiBilled.status === "available" &&
                usage.metrics.apiBilled.amount !== null
              ? usd(usage.metrics.apiBilled.amount) + " estimated billed"
              : "Estimate unavailable"
        }
      >
        {sum && (
          <span className="text-[13px] text-muted-foreground text-pretty tabular-nums">
            {usage?.metrics.subscriptionValue.status === "available" &&
            usage.metrics.subscriptionValue.amount !== null
              ? `${usd(usage.metrics.subscriptionValue.amount)} subscription value at API prices`
              : "Subscription value unavailable"}
            . Unknown-kind and unpriced requests are excluded.
          </span>
        )}
      </Answer>
      <Answer
        href="#attention"
        question="Anything broken?"
        tone={
          problems.length
            ? "warn"
            : failedShare === null
              ? undefined
              : sum!.failed > 0
                ? "warn"
                : view
                  ? "ok"
                  : undefined
        }
        answer={
          problems.length
            ? `${problems.length} types of account issues`
            : failedShare === null
              ? read
                ? "No requests yet"
                : "Reading…"
              : sum!.failed > 0
                ? `${failedShare.toFixed(1)}% of requests failed`
                : "No failed requests"
        }
      >
        <span className="text-[13px] text-muted-foreground text-pretty">
          {usage?.metrics.failureShareWorstHourP95.status === "available" &&
          usage.metrics.failureShareWorstHourP95.p95 !== null
            ? `Worst-hour failure share p95: ${usage.metrics.failureShareWorstHourP95.p95.toFixed(1)}%. `
            : ""}
          Account health is on the Accounts tab.
        </span>
      </Answer>
    </nav>
  );
}

interface Item {
  readonly tone: Tone;
  readonly text: string;
  readonly sub: string;
}

function Attention({
  data,
  name,
  days,
  view,
  accountsHref,
}: {
  data: Overview;
  name: (id: string) => string;
  days: number;
  view: PoolView | undefined;
  accountsHref?: string;
}) {
  const items: Item[] = (view ? accountProblems(view) : []).map((problem) => ({
    tone: "warn",
    text: `${problem.count} ${problem.text}`,
    sub: problem.since
      ? `Earliest source observation or check: ${new Date(problem.since).toUTCString()}. Review in Accounts.`
      : "Review in Accounts.",
  }));
  const banked = view ? bankedResetCount(view) : 0;
  if (data.usage?.ok) {
    const unknown = data.usage.value.metrics.apiBilled.excluded.unknownKind;
    if (unknown > 0)
      items.push({
        tone: "warn",
        text: `${unknown.toLocaleString()} requests have an unknown billing kind`,
        sub: "Excluded from API billed estimates and subscription value. Review account kinds in Accounts.",
      });
    const unpriced =
      data.usage.value.metrics.apiBilled.excluded.unpriced +
      data.usage.value.metrics.subscriptionValue.excluded.unpriced;
    if (unpriced > 0)
      items.push({
        tone: "info",
        text: `${unpriced.toLocaleString()} requests have no current API price`,
        sub: "Excluded from both money figures. No Home charge or imported price is substituted.",
      });
  }
  // Lab notes wait for the view that names their labs.
  if (view && data.capacity?.ok) {
    const history = data.capacity.value;
    for (const lab of capacityLabs(history)) {
      const flagged = new Set(
        lab.lines.flatMap((line) =>
          planChips(line.points.at(-1) ?? null)
            .filter((chip) => chip.flagged)
            .map((chip) => chip.plan),
        ),
      );
      if (flagged.size)
        items.push({
          tone: "warn",
          text: `${name(lab.provider)}: ${[...flagged].join(", ")} counts at a flagged 1x`,
          sub: "Its plan isn't recognised, so capacity treats each account as one reference plan.",
        });
      const missing = Math.max(
        0,
        ...lab.lines.map((line) =>
          gaps(line.points, history.to).reduce(
            (hours, span) => hours + (span.to - span.from) / hourMs,
            0,
          ),
        ),
      );
      if (missing)
        items.push({
          tone: "info",
          text: `${name(lab.provider)} had ${missing}h without readings in ${days} days`,
          sub: "Shown as gaps in its chart. Nothing is filled in.",
        });
    }
  }
  const sum = data.people?.ok ? total(data.people.value.groups) : null;
  if (sum?.failed)
    items.push({
      tone: "warn",
      text: `${sum.failed.toLocaleString()} of ${sum.requests.toLocaleString()} requests failed in ${days} days`,
      sub: sum.unassignedFailures
        ? `${sum.unassignedFailures.toLocaleString()} failed before reaching any account.`
        : "Which accounts they hit is on the Accounts tab.",
    });
  return (
    <section
      id="attention"
      aria-labelledby="attention-heading"
      className="grid scroll-mt-4 gap-4 pt-12"
    >
      <div className="grid gap-1">
        <h2 id="attention-heading" className="text-lg font-semibold tracking-[-0.02em]">
          Needs attention
        </h2>
        <p className="max-w-[38rem] text-sm text-muted-foreground text-pretty">
          Pool-level problems only. {accountsHandoff}
        </p>
      </div>
      {banked > 0 && (
        <p className="m-0 text-sm text-pretty">
          {accountsHref ? (
            <a
              href={accountsHref}
              target="_blank"
              rel="noopener"
              className="underline underline-offset-2"
            >
              {banked} banked resets available
            </a>
          ) : (
            `${banked} banked resets available`
          )}
          . Nothing is spent automatically; forecasts leave them unspent.
        </p>
      )}
      {items.length === 0 && view === undefined ? (
        <p className="text-sm text-muted-foreground">Reading…</p>
      ) : items.length === 0 ? (
        <p className="flex items-start gap-1.5 text-sm">
          <StateIcon tone="ok" />
          Nothing at pool level.
        </p>
      ) : (
        <ul className="m-0 list-none border-t border-border p-0">
          {items.map((item) => (
            <li
              key={item.text}
              className="grid grid-cols-[auto_1fr] items-start gap-x-2.5 border-b border-border py-3 text-sm"
            >
              <span className={toneText[item.tone]}>
                <StateIcon tone={item.tone} />
              </span>
              <span className="text-pretty">
                {accountsHref ? (
                  <a
                    href={accountsHref}
                    target="_blank"
                    rel="noopener"
                    className="underline underline-offset-2"
                  >
                    {item.text}
                  </a>
                ) : (
                  item.text
                )}
                <span className="block text-xs text-muted-foreground">{item.sub}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
