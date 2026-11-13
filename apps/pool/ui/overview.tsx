import { overviewAccounts } from "./overview-accounts.ts";
import { useState, type ReactNode } from "react";
import type { Account, PoolView, Provider } from "../contract.ts";
import { accountWindows } from "./account-limits.ts";
import { AccountLimitsDialog, ModelLimits } from "./account-limits-view.tsx";
import { capacityInputs } from "./account-view.ts";
import type { Result } from "../index.ts";
import type { PoolPersonalOverviewResult } from "../overview-contract.ts";
import { capacityLabs, duration, gaps, hourMs } from "./capacity-model.ts";
import {
  CapacitySection,
  labSummaries,
  toneText,
  type LabSummary,
  type Tone,
} from "./capacity-view.tsx";
import { StateIcon } from "./controls.tsx";
import { LabMark, labProvider } from "./lab.tsx";
import { seriesRead, type Overview, type RangeDays } from "./overview-data.ts";
import { rows, total } from "./series-model.ts";
import { Money, WhoUses } from "./usage-groups.tsx";
import {
  accountProblems,
  accountsNeedingSomeone,
  bankedResetLine,
  peopleOfText,
} from "./overview-attention.ts";
import { currentCapacity } from "./overview-snapshot.ts";
import { brokenAnswer, failureItems, legacyBrokenAnswer } from "./overview-reliability.ts";

// The manager's App tab: four answers first, each linking down to its evidence. Per-account health
// and actions, including spending a reset, stay on the host's Accounts tab. Here only read-only
// reset and model-limit details open per account.

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
  now,
  accountsHref,
  onRetry,
}: {
  data: Overview;
  days: RangeDays;
  providers: readonly Provider[] | undefined;
  view: PoolView | undefined;
  now: number;
  accountsHref?: string;
  onRetry: () => void;
}) {
  const name = namer(providers);
  const current = { ...data, capacity: currentCapacity(data.capacity, view) };
  // A model's own limit is inside its account's allowance, never extra lab capacity. A source that
  // withholds inspection lends no plan or window either.
  const capacityAccounts = capacityInputs(overviewAccounts(view)).map(accountWindows);
  const labs =
    providers && current.coherent === true && current.capacity?.ok
      ? labSummaries(current.capacity.value, days, capacityAccounts)
      : [];
  // Ids, not copies, so an open dialog follows each refresh of the view.
  const [details, setDetails] = useState<{ title: string; ids: readonly string[] } | null>(null);
  const openDetails = (title: string, accounts: readonly Account[]) =>
    setDetails({ title, ids: accounts.map((account) => account.id) });
  const detailAccounts = details
    ? (view?.accounts ?? []).filter((account) => details.ids.includes(account.id))
    : [];
  const mismatched = data.coherent === false && data.capacity !== undefined;
  // Partial usage is coverage of the same snapshot, so it gets its own note and keeps capacity.
  const usagePartial =
    !mismatched &&
    ((data.usage?.ok && data.usage.value.partial) ||
      [data.people, data.models].some((read) => read?.ok && read.value.truncated));
  return (
    <>
      {mismatched && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          This read is incomplete. Totals below keep their coverage notes; no complete capacity
          verdict is claimed.{" "}
          <button type="button" onClick={onRetry} className="underline underline-offset-2">
            Read again
          </button>
        </p>
      )}
      {usagePartial && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          Usage for this range is incomplete. Request and cost totals below keep their coverage
          notes. Capacity uses its own readings.{" "}
          <button type="button" onClick={onRetry} className="underline underline-offset-2">
            Read again
          </button>
        </p>
      )}
      <Answers
        data={current}
        labs={labs}
        days={days}
        name={name}
        lab={labProvider(providers)}
        view={view}
      />
      <CapacitySection
        result={current.capacity?.ok && !providers ? undefined : current.capacity}
        empty={view !== undefined && overviewAccounts(view).length === 0}
        providers={providers ?? []}
        accounts={capacityAccounts}
        days={days}
        coherent={data.coherent === true}
        onRetry={onRetry}
      />
      <ModelLimits
        accounts={overviewAccounts(view)}
        providers={providers ?? []}
        now={now}
        onOpen={(account) => openDetails("Account limits", [account])}
      />
      <WhoUses
        lab={labProvider(providers)}
        overview={data.usage?.ok ? data.usage.value : undefined}
        people={data.people}
        models={data.models}
        days={days}
        name={name}
        onRetry={onRetry}
        historyHref="#usage-history"
      />
      <Money
        overview={data.usage?.ok ? data.usage.value : undefined}
        people={data.people}
        days={days}
        name={name}
      />
      <Attention
        data={current}
        name={name}
        days={days}
        view={view}
        now={now}
        accountsHref={accountsHref}
        onResets={(accounts) => openDetails("Banked resets", accounts)}
      />
      <AccountLimitsDialog
        title={details?.title ?? ""}
        accounts={detailAccounts}
        providers={providers ?? []}
        now={now}
        onClose={() => setDetails(null)}
      />
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
    value: seriesRead(data.value.series),
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
        lab={labProvider(providers)}
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
  lab: provider,
  view,
}: {
  data: Overview;
  labs: readonly LabSummary[];
  days: number;
  name: (id: string) => string;
  lab: (id: string) => Provider | undefined;
  view: PoolView | undefined;
}) {
  const worst = labs.find((entry) => entry.verdict.tone === "warn" || entry.verdict.tone === "bad");
  const learning = labs.find((entry) => entry.verdict.tone === "learn");
  const allLearning = labs.length > 0 && labs.every((entry) => entry.verdict.tone === "learn");
  // "Every lab" means every lab the pool has accounts in, including ones with no readings yet.
  const unread = [...new Set(overviewAccounts(view).map((account) => account.provider))].filter(
    (provider) => !labs.some((entry) => entry.lab.provider === provider),
  );
  const enough: { tone: Tone; text: string } =
    view !== undefined && overviewAccounts(view).length === 0
      ? { tone: "learn", text: "No accounts yet" }
      : !data.capacity || (!view && data.capacity.ok)
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
                    text:
                      worst.verdict.short === "Runs short"
                        ? `${name(worst.lab.provider)} runs short`
                        : `${name(worst.lab.provider)}: ${worst.verdict.short.toLowerCase()}`,
                  }
                : unread.length
                  ? { tone: "learn", text: `${name(unread[0]!)}: no readings yet` }
                  : learning
                    ? {
                        tone: "learn",
                        text:
                          learning.verdict.short === "Unavailable"
                            ? "Forecast unavailable"
                            : allLearning
                              ? "Too early to say"
                              : "Learning the weekly pattern",
                      }
                    : { tone: "ok", text: "Yes, every lab" };
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
  const needYou = view ? accountsNeedingSomeone(view) : 0;
  const billed =
    usage?.metrics.apiBilled.status === "available" && usage.metrics.apiBilled.amount !== null
      ? usage.metrics.apiBilled.amount
      : null;
  const unpriced = usage ? usage.metrics.apiBilled.excluded.unpriced : 0;
  const p95 = usage?.metrics.failureShareWorstHourP95;
  const broken = usage?.reliability
    ? brokenAnswer({ needYou, reliability: usage.reliability, viewRead: view !== undefined })
    : legacyBrokenAnswer({
        needYou,
        sum,
        read: read !== null,
        usage: usage !== null,
        viewRead: view !== undefined,
        worstHourP95: p95?.status === "available" ? p95.p95 : null,
      });
  return (
    <nav
      aria-label="At a glance"
      className="grid grid-cols-4 overflow-hidden rounded-lg border border-border max-[740px]:grid-cols-2 max-[540px]:grid-cols-1"
    >
      <Answer href="#capacity" question="Enough accounts?" tone={enough.tone} answer={enough.text}>
        <span className="grid gap-0.5 text-[13px]">
          {labs.map(({ lab, verdict }) => (
            <span key={lab.provider} className="flex min-w-0 items-center gap-1.5">
              <LabMark provider={provider(lab.provider)} small />
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
            {peopleOfText(
              usage?.directory.activeCount ?? people.length,
              usage?.directory.totalCount ?? people.length,
            )}{" "}
            active · {sum.requests.toLocaleString()} requests · last {days} days
          </span>
        )}
      </Answer>
      <Answer
        href="#cost"
        question="API cost"
        answer={
          !usage ? "Reading…" : billed !== null ? `${usd(billed)} API price est.` : "Unpriced"
        }
      >
        {sum && (
          <span className="text-[13px] text-muted-foreground text-pretty tabular-nums">
            {billed === null
              ? (usage?.metrics.apiBilled.reason ?? "Official USD estimate unavailable.")
              : `Current official USD prices${usage?.metrics.apiBilled.price?.calculation === "token-counts" ? " · some priced from token counts" : ""}${unpriced ? ` · ${unpriced.toLocaleString()} requests unpriced` : ""}`}
          </span>
        )}
      </Answer>
      <Answer
        href="#attention"
        question="Anything broken?"
        tone={broken.tone}
        answer={broken.answer}
      >
        <span className="text-[13px] text-muted-foreground text-pretty tabular-nums">
          {broken.sub.join(" · ")}
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
  now,
  accountsHref,
  onResets,
}: {
  data: Overview;
  name: (id: string) => string;
  days: number;
  view: PoolView | undefined;
  now: number;
  accountsHref?: string;
  onResets: (accounts: readonly Account[]) => void;
}) {
  const items: Item[] = (view ? accountProblems(view) : []).map((problem) => ({
    tone: "warn",
    text: `${problem.count} ${problem.text}`,
    sub: problem.since
      ? `Earliest source observation or check: ${new Date(problem.since).toUTCString()}. Review in Accounts.`
      : "Review in Accounts.",
  }));
  const banked = view ? bankedResetLine(view, now) : null;
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
      // An unknown allowance is sized as one account and explained in the capacity details. It
      // is never an attention item: nobody can fix missing vendor documentation.
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
          text: `${name(lab.provider)} had ${duration(missing)} without readings in ${days} days`,
          sub: "Shown as gaps in its chart. Nothing is filled in.",
        });
    }
  }
  const reliability = data.usage?.ok ? data.usage.value.reliability : undefined;
  const sum = data.people?.ok ? total(data.people.value.groups) : null;
  if (reliability) items.push(...failureItems(reliability, days));
  else if (sum?.failed)
    items.push({
      tone: "warn",
      text: `${sum.failed.toLocaleString()} of ${sum.requests.toLocaleString()} requests failed in ${days} days`,
      sub: `${
        sum.unassignedFailures
          ? `${sum.unassignedFailures.toLocaleString()} failed before reaching any account.`
          : "Which accounts they hit is on the Accounts tab."
      } Includes proof checks; this read doesn't separate them.`,
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
      {banked && (
        <p className="m-0 text-sm text-pretty">
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => onResets(banked.accounts)}
            className="rounded-sm text-left underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {banked.text}
          </button>
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
