import { useState } from "react";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { Provider } from "../contract.ts";
import type { Result } from "../index.ts";
import { providerName } from "./accounts.tsx";
import { CapacityChart } from "./capacity-chart.tsx";
import {
  amount, capacityLabs, dailyRows, dayLong, lineFacts, planChips, pressing, whenLabel,
  type CapacityLab, type CapacityLine, type LineFacts,
} from "./capacity-model.ts";
import { Button, Problem, Segmented, StateIcon } from "./controls.tsx";
import { LabMark, labColor } from "./lab.tsx";

export type Tone = "ok" | "warn" | "bad" | "learn" | "info";
export const toneText: Record<Tone, string> = { ok: "", warn: "text-warning", bad: "text-destructive", learn: "text-muted-foreground", info: "text-muted-foreground" };

export interface Verdict {
  readonly tone: Tone;
  readonly short: string;
  readonly text: string;
  readonly detail: string | null;
}

/** Measured facts only: no projection is shown until the backend provides one. */
export function verdict(line: CapacityLine | undefined, facts: LineFacts | undefined, days: number): Verdict {
  if (!line || !facts?.latest) return { tone: "learn", short: "No readings", text: `Nothing measured in the last ${days} days.`, detail: null };
  const unit = line.unit.label;
  const latest = facts.latest;
  const flagged = latest.last.unknownWeightCount;
  const detail = flagged
    ? `${flagged} of ${latest.last.accountCount} accounts count at a flagged 1x because their plan is unknown, so real capacity may be higher than shown.`
    : null;
  const tracked = facts.measuredHours < days * 24 * 0.5 ? ` Only ${facts.measuredHours} hours of readings so far.` : "";
  if (facts.outHours > 0)
    return {
      tone: "warn",
      short: "Ran out",
      text: `Every account was out ${facts.episodes}× for ${facts.outHours}h in ${days} days, longest ${facts.longestHours}h.${tracked}`,
      detail,
    };
  const low = facts.lowest ?? latest;
  return {
    tone: "ok",
    short: "Never ran out",
    text: `Lowest ${amount(low.minimum.remaining)} of ${amount(low.minimum.full)} ${unit} in ${days} days, ${whenLabel(low.hour)} UTC.${tracked}`,
    detail,
  };
}

export interface LabSummary {
  readonly lab: CapacityLab;
  readonly verdict: Verdict;
}

/** Each lab's verdict across all its windows: running out on any window counts. */
export function labSummaries(history: PoolCapacityHistory, days: number): LabSummary[] {
  return capacityLabs(history).map((lab) => {
    const verdicts = lab.lines.map((line) => verdict(line, lineFacts(line, history.to), days));
    return { lab, verdict: verdicts.find((entry) => entry.tone === "warn") ?? verdicts[0] ?? verdict(undefined, undefined, days) };
  });
}

export function CapacitySection({ result, providers, days, onRetry }: {
  result: Result<PoolCapacityHistory> | undefined; providers: readonly Provider[]; days: number; onRetry: () => void;
}) {
  const labs = result?.ok ? capacityLabs(result.value) : [];
  return (
    <section id="capacity" aria-labelledby="capacity-heading" className="grid scroll-mt-4 gap-4 pt-12">
      <div className="grid gap-1">
        <h2 id="capacity-heading" className="text-lg font-semibold tracking-[-0.02em]">Do we have enough accounts?</h2>
        <p className="max-w-[38rem] text-sm text-muted-foreground text-pretty">
          Allowance left across each lab's accounts, measured over the last {days} days. Each lab has its own unit; they never add up across labs.
        </p>
      </div>
      {result === undefined ? (
        <div aria-hidden="true" className="h-60 animate-pulse rounded-md bg-accent" />
      ) : !result.ok ? (
        result.error === "unauthorized" ? (
          <p className="text-sm text-muted-foreground">Capacity history is available to this pool's managers.</p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3">
            <Problem>{result.message}</Problem>
            <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>
          </div>
        )
      ) : labs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-input px-6 py-8 text-sm text-muted-foreground text-pretty">
          No capacity readings in the last {days} days. Readings start once a connected subscription reports its limits.
        </p>
      ) : (
        <div>
          {labs.map((lab, index) => (
            <Panel key={lab.provider} lab={lab} history={result.value} name={providerName(providers, lab.provider)} days={days} first={index === 0} />
          ))}
        </div>
      )}
    </section>
  );
}

function Panel({ lab, history, name, days, first }: { lab: CapacityLab; history: PoolCapacityHistory; name: string; days: number; first: boolean }) {
  const press = pressing(lab);
  const [chosen, setChosen] = useState<string>();
  const line = lab.lines.find((entry) => entry.key === (chosen ?? press.key)) ?? lab.lines[0]!;
  const facts = lineFacts(line, history.to);
  const result = verdict(line, facts, days);
  const chips = planChips(facts.latest);
  const accounts = facts.latest?.last.accountCount ?? 0;
  const color = labColor(lab.provider);
  return (
    <article aria-labelledby={`lab-${lab.provider}`} className={first ? "pt-1 pb-6" : "border-t border-border pt-5 pb-6"}>
      <div className="grid grid-cols-[auto_1fr_auto] items-start gap-x-3 gap-y-1 max-[540px]:grid-cols-[auto_1fr]">
        <LabMark provider={lab.provider} name={name} />
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 id={`lab-${lab.provider}`} className="text-[15px] font-semibold tracking-[-0.015em]">{name}</h3>
          <span className="text-sm text-muted-foreground">{accounts} {accounts === 1 ? "account" : "accounts"} · in {line.unit.label}</span>
        </div>
        <div className="justify-self-end max-[540px]:col-span-full max-[540px]:justify-self-start">
          {lab.lines.length > 1 && (
            <div className="grid justify-items-end gap-1 max-[540px]:justify-items-start">
              <Segmented label={`${name} limit window`} value={line.key} options={lab.lines.map((entry) => ({ id: entry.key, label: entry.label }))} onChange={setChosen} />
              {press.text && <span className="max-w-[19rem] text-right text-xs text-muted-foreground text-pretty max-[540px]:text-left">{press.text}</span>}
            </div>
          )}
        </div>
        <div className={`col-start-2 col-end-[-1] flex items-start gap-1.5 text-sm text-pretty max-[540px]:col-span-full ${toneText[result.tone]}`}>
          <StateIcon tone={result.tone} />
          <span className="text-foreground"><b className="font-semibold">{result.short}</b> · {result.text}</span>
        </div>
        {result.detail && <div className="col-start-2 col-end-[-1] text-[13px] text-muted-foreground text-pretty max-[540px]:col-span-full">{result.detail}</div>}
        {chips.length > 0 && (
          <ul aria-label={`${name} plans`} className="col-start-2 col-end-[-1] m-0 mt-1 flex list-none flex-wrap gap-1.5 p-0 max-[540px]:col-span-full">
            {chips.map((chip) => (
              <li key={chip.plan} className={`inline-flex h-[22px] items-center gap-1 rounded-sm border px-[7px] text-xs whitespace-nowrap ${chip.flagged ? "border-dashed border-warning/45" : "border-border"}`}>
                {chip.plan} <span className="text-muted-foreground">×{chip.accounts}</span>
                {chip.note && <span className={chip.flagged ? "text-warning" : "text-muted-foreground"}>· {chip.note}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="col-start-2 col-end-[-1] mt-2.5 flex items-start gap-1.5 text-[13px] text-muted-foreground text-pretty max-[540px]:col-span-full">
          <StateIcon tone="learn" />
          <span><span className="font-medium text-foreground">Estimate unavailable.</span> {history.estimate.reason} No projection or shortfall is shown until there is one.</span>
        </div>
      </div>
      <CapacityChart line={line} from={history.from} to={history.to} color={color} facts={facts} lab={name} />
      <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
        <Legend color={color} facts={facts} line={line} />
        <Daily line={line} to={history.to} />
      </div>
    </article>
  );
}

function Legend({ color, facts, line }: { color: string; facts: LineFacts; line: CapacityLine }) {
  return (
    <div className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5"><i className="h-0.5 w-3.5 rounded-[1px]" style={{ background: color }} />Lowest left each hour, measured</span>
      <span className="inline-flex items-center gap-1.5"><i className="w-3.5 border-t border-dotted border-muted-foreground" />Full: every window fresh (reference, not available)</span>
      {facts.outHours > 0 && <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-3.5 rounded-[2px] bg-destructive/15 shadow-[inset_0_-2px_0_var(--destructive)]" />All accounts out</span>}
      {facts.gapHours > 0 && <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-3.5 rounded-[2px] bg-accent outline outline-1 outline-input" />No readings ({facts.gapHours}h)</span>}
      <span className="sr-only">Unit: {line.unit.label}.</span>
    </div>
  );
}

function Daily({ line, to }: { line: CapacityLine; to: number }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="group mt-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground group-open:text-foreground [&::-webkit-details-marker]:hidden">
        <svg className="size-3.5 transition-transform duration-150 group-open:rotate-90" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Daily table
      </summary>
      {open && (
        <table className="mt-2 w-full border-collapse text-[13px]">
          <caption className="sr-only">{line.label} capacity per UTC day, in {line.unit.label}</caption>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="border-b border-border py-2 pr-2 font-medium">Day (UTC)</th>
              <th scope="col" className="border-b border-border py-2 pr-2 text-right font-medium">Lowest left ({line.unit.label})</th>
              <th scope="col" className="border-b border-border py-2 pr-2 text-right font-medium">All out</th>
              <th scope="col" className="border-b border-border py-2 text-right font-medium">No readings</th>
            </tr>
          </thead>
          <tbody>
            {dailyRows(line.points, to).map((row) => (
              <tr key={row.day} className="tabular-nums">
                <th scope="row" className="border-b border-border py-2.5 pr-2 text-left font-normal">{dayLong(row.day)}</th>
                <td className="border-b border-border py-2.5 pr-2 text-right">{row.lowest ? `${amount(row.lowest.remaining)} of ${amount(row.lowest.full)}` : "—"}</td>
                <td className="border-b border-border py-2.5 pr-2 text-right">{row.outHours ? `${row.outHours}h` : "—"}</td>
                <td className="border-b border-border py-2.5 text-right">{row.missingHours ? `${row.missingHours}h` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
