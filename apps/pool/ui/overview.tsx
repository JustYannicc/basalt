import type { ReactNode } from "react";
import type { Provider } from "../contract.ts";
import { providerName } from "./accounts.tsx";
import { capacityLabs, gaps, hourMs, planChips } from "./capacity-model.ts";
import { CapacitySection, labSummaries, toneText, type LabSummary, type Tone } from "./capacity-view.tsx";
import { StateIcon } from "./controls.tsx";
import { LabMark } from "./lab.tsx";
import type { Overview, RangeDays } from "./overview-data.ts";
import { moneyList, rows, total } from "./series-model.ts";
import { Money, WhoUses } from "./usage-groups.tsx";

// The manager's App tab: four answers first, each linking down to its evidence. Per-account health,
// resets and actions stay on the host's Accounts tab; this page only aggregates.

const accountsHandoff = "Each account's health, sign-ins, resets and details are on this app's Accounts tab.";

export function ManagerOverview({ data, days, providers, onRetry }: {
  data: Overview; days: RangeDays; providers: readonly Provider[]; onRetry: () => void;
}) {
  const name = (id: string) => providerName(providers, id);
  const labs = data.capacity?.ok ? labSummaries(data.capacity.value, days) : [];
  return (
    <>
      <Answers data={data} labs={labs} days={days} name={name} />
      <CapacitySection result={data.capacity} providers={providers} days={days} onRetry={onRetry} />
      <WhoUses people={data.people} models={data.models} days={days} name={name} onRetry={onRetry} />
      <Money people={data.people} days={days} />
      <Attention data={data} name={name} days={days} />
    </>
  );
}

function Answer({ href, question, tone, answer, children }: { href: string; question: string; tone?: Tone; answer: string; children: ReactNode }) {
  return (
    <a href={href} className="grid content-start gap-1 border-border px-4 pt-3.5 pb-4 text-inherit no-underline transition-colors duration-150 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset [&:not(:first-child)]:border-l max-[740px]:[&:nth-child(3)]:border-l-0 max-[740px]:[&:nth-child(n+3)]:border-t max-[540px]:border-l-0! max-[540px]:[&:not(:first-child)]:border-t">
      <span className="text-[13px] text-muted-foreground">{question}</span>
      <span className={`flex items-start gap-1.5 text-[15px] leading-snug font-semibold tracking-[-0.015em] text-balance ${tone ? toneText[tone] : ""}`}>
        {tone && <StateIcon tone={tone} />}
        <span className={tone ? "text-foreground" : undefined}>{answer}</span>
      </span>
      {children}
    </a>
  );
}

function Answers({ data, labs, days, name }: { data: Overview; labs: readonly LabSummary[]; days: number; name: (id: string) => string }) {
  const worst = labs.find((entry) => entry.verdict.tone === "warn");
  const enough: { tone: Tone; text: string } = !data.capacity
    ? { tone: "learn", text: "Reading…" }
    : !data.capacity.ok
      ? { tone: "learn", text: "Capacity unavailable" }
      : labs.length === 0
        ? { tone: "learn", text: "No readings yet" }
        : worst
          ? { tone: "warn", text: `${name(worst.lab.provider)} ran out` }
          : { tone: "ok", text: "No lab ran out" };
  const read = data.people?.ok ? data.people.value : null;
  const people = read ? rows(read.groups, "person", name).filter((row) => row.id.startsWith("person:") && row.totals.tokens > 0n) : [];
  const sum = read ? total(read.groups) : null;
  const all = people.reduce((acc, row) => acc + row.totals.tokens, 0n);
  const top = people.slice(0, 2);
  const share = all > 0n ? Math.round((Number(top.reduce((acc, row) => acc + row.totals.tokens, 0n)) / Number(all)) * 100) : 0;
  const failedShare = sum && sum.requests ? (sum.failed / sum.requests) * 100 : null;
  return (
    <nav aria-label="At a glance" className="grid grid-cols-4 overflow-hidden rounded-lg border border-border max-[740px]:grid-cols-2 max-[540px]:grid-cols-1">
      <Answer href="#capacity" question="Enough accounts?" tone={enough.tone} answer={enough.text}>
        <span className="grid gap-0.5 text-[13px]">
          {labs.map(({ lab, verdict }) => (
            <span key={lab.provider} className="flex min-w-0 items-center gap-1.5">
              <LabMark provider={lab.provider} name={name(lab.provider)} small />
              <span className={toneText[verdict.tone]}>{name(lab.provider)}: {verdict.short.toLowerCase()}</span>
            </span>
          ))}
        </span>
      </Answer>
      <Answer href="#who" question="Who uses what?" answer={!read ? "Reading…" : top.length ? `${top.map((row) => row.label).join(" and ")}: ${share}% of tokens` : "Not split by person yet"}>
        {sum && <span className="text-[13px] text-muted-foreground tabular-nums">{people.length} {people.length === 1 ? "person" : "people"} active · {sum.requests.toLocaleString()} requests in {days} days</span>}
      </Answer>
      <Answer href="#cost" question="What it cost" answer={!sum ? "Reading…" : sum.home.length ? `${moneyList(sum.home)} Home charge` : "No Home charge recorded"}>
        {sum && (
          <span className="text-[13px] text-muted-foreground text-pretty tabular-nums">
            Separate: {sum.imported.length ? `${moneyList(sum.imported)} imported API price` : "no imported API price"} · API-equivalent unavailable
          </span>
        )}
      </Answer>
      <Answer href="#attention" question="Anything broken?" tone={failedShare === null ? undefined : sum!.failed > 0 ? "warn" : "ok"}
        answer={failedShare === null ? (read ? "No requests yet" : "Reading…") : sum!.failed > 0 ? `${failedShare.toFixed(1)}% of requests failed` : "No failed requests"}>
        <span className="text-[13px] text-muted-foreground text-pretty">Account health is on the Accounts tab.</span>
      </Answer>
    </nav>
  );
}

interface Item {
  readonly tone: Tone;
  readonly text: string;
  readonly sub: string;
}

function Attention({ data, name, days }: { data: Overview; name: (id: string) => string; days: number }) {
  const items: Item[] = [];
  if (data.capacity?.ok) {
    const history = data.capacity.value;
    for (const lab of capacityLabs(history)) {
      const flagged = new Set(lab.lines.flatMap((line) => planChips(line.points.at(-1) ?? null).filter((chip) => chip.flagged).map((chip) => chip.plan)));
      if (flagged.size)
        items.push({ tone: "warn", text: `${name(lab.provider)}: ${[...flagged].join(", ")} counts at a flagged 1x`, sub: "Its plan isn't recognised, so capacity treats each account as one reference plan." });
      const missing = Math.max(0, ...lab.lines.map((line) => gaps(line.points, history.to).reduce((hours, span) => hours + (span.to - span.from) / hourMs, 0)));
      if (missing) items.push({ tone: "info", text: `${name(lab.provider)} had ${missing}h without readings in ${days} days`, sub: "Shown as gaps in its chart. Nothing is filled in." });
    }
  }
  const sum = data.people?.ok ? total(data.people.value.groups) : null;
  if (sum?.failed)
    items.push({
      tone: "warn",
      text: `${sum.failed.toLocaleString()} of ${sum.requests.toLocaleString()} requests failed in ${days} days`,
      sub: sum.unassignedFailures ? `${sum.unassignedFailures.toLocaleString()} failed before reaching any account.` : "Which accounts they hit is on the Accounts tab.",
    });
  return (
    <section id="attention" aria-labelledby="attention-heading" className="grid scroll-mt-4 gap-4 pt-12">
      <div className="grid gap-1">
        <h2 id="attention-heading" className="text-lg font-semibold tracking-[-0.02em]">Needs attention</h2>
        <p className="max-w-[38rem] text-sm text-muted-foreground text-pretty">Pool-level problems only. {accountsHandoff}</p>
      </div>
      {items.length === 0 ? (
        <p className="flex items-start gap-1.5 text-sm"><StateIcon tone="ok" />Nothing at pool level.</p>
      ) : (
        <ul className="m-0 list-none border-t border-border p-0">
          {items.map((item) => (
            <li key={item.text} className="grid grid-cols-[auto_1fr] items-start gap-x-2.5 border-b border-border py-3 text-sm">
              <span className={toneText[item.tone]}><StateIcon tone={item.tone} /></span>
              <span className="text-pretty">{item.text}<span className="block text-xs text-muted-foreground">{item.sub}</span></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
