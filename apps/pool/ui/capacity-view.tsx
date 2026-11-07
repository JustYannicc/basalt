import { useState, type ReactNode } from "react";
import type { PoolCapacityHistory } from "../capacity-contract.ts";
import type { Provider } from "../contract.ts";
import type { Result } from "../index.ts";
import { providerName } from "./accounts.tsx";
import { CapacityChart } from "./capacity-chart.tsx";
import {
  amount,
  candidateName,
  capacityLabs,
  dailyRows,
  dayLong,
  duration,
  forecastReasons,
  lineFacts,
  planChips,
  exclusionName,
  pressing,
  verdict,
  whenLabel,
  type CapacityLab,
  type CapacityLine,
  type LineFacts,
} from "./capacity-model.ts";
import { Button, Problem, Segmented, StateIcon } from "./controls.tsx";
import { LabMark, labColor } from "./lab.tsx";

export type Tone = "ok" | "warn" | "bad" | "learn" | "info";
export const toneText: Record<Tone, string> = {
  ok: "",
  warn: "text-warning",
  bad: "text-destructive",
  learn: "text-muted-foreground",
  info: "text-muted-foreground",
};

export interface Verdict {
  readonly tone: Tone;
  readonly short: string;
  readonly text: string;
  readonly detail: string | null;
}

export { verdict } from "./capacity-model.ts";

export interface LabSummary {
  readonly lab: CapacityLab;
  readonly verdict: Verdict;
}

/** Each lab's verdict across all its windows: running out on any window counts. */
export function labSummaries(history: PoolCapacityHistory, days: number): LabSummary[] {
  return capacityLabs(history).map((lab) => {
    const verdicts = lab.lines.map((line) => verdict(line, lineFacts(line, history.to), days));
    return {
      lab,
      verdict:
        verdicts.find((entry) => entry.tone === "warn") ??
        verdicts.find((entry) => entry.tone === "learn") ??
        verdicts[0] ??
        verdict(undefined, undefined, days),
    };
  });
}

export function CapacitySection({
  result,
  providers,
  days,
  coherent,
  empty = false,
  onRetry,
}: {
  result: Result<PoolCapacityHistory> | undefined;
  providers: readonly Provider[];
  days: number;
  coherent: boolean;
  /** The pool has no accounts now, so there is no capacity to show. */
  empty?: boolean;
  onRetry: () => void;
}) {
  const labs = result?.ok ? capacityLabs(result.value) : [];
  const [choices, setChoices] = useState<Readonly<Record<string, string>>>({});
  return (
    <section
      id="capacity"
      aria-labelledby="capacity-heading"
      className="grid scroll-mt-4 gap-4 pt-12"
    >
      <div className="grid gap-1">
        <h2 id="capacity-heading" className="text-lg font-semibold tracking-[-0.02em]">
          Do we have enough accounts?
        </h2>
        <p className="max-w-[38rem] text-sm text-muted-foreground text-pretty">
          Allowance left across each lab's accounts, last {days} days and the next 3. Where a lab
          reports a 5-hour window too, it gets its own chart. Each lab has its own unit; they never
          add up across labs.
        </p>
      </div>
      {empty ? (
        <p className="rounded-lg border border-dashed border-input px-6 py-8 text-sm text-muted-foreground text-pretty">
          No accounts in this pool, so there is no capacity to show. Each lab's chart appears once
          the pool has an account from it.
        </p>
      ) : result === undefined ? (
        <div aria-hidden="true" className="h-60 animate-pulse rounded-md bg-accent" />
      ) : !result.ok ? (
        result.error === "unauthorized" ? (
          <p className="text-sm text-muted-foreground">
            Capacity history is available to this pool's managers.
          </p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3">
            <Problem>{result.message}</Problem>
            <Button size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )
      ) : labs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-input px-6 py-8 text-sm text-muted-foreground text-pretty">
          No capacity readings in the last {days} days. Readings start once a connected subscription
          reports its limits.
        </p>
      ) : (
        <div>
          {labs.map((lab, index) => (
            <Panel
              key={lab.provider}
              lab={lab}
              history={result.value}
              name={providerName(providers, lab.provider)}
              days={days}
              coherent={coherent}
              first={index === 0}
              chosen={choices[lab.provider]}
              onChoose={(key) => setChoices((previous) => ({ ...previous, [lab.provider]: key }))}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Panel({
  lab,
  history,
  name,
  days,
  coherent,
  first,
  chosen,
  onChoose,
}: {
  lab: CapacityLab;
  history: PoolCapacityHistory;
  name: string;
  days: number;
  coherent: boolean;
  first: boolean;
  chosen?: string;
  onChoose: (key: string) => void;
}) {
  // An incomplete read keeps its measured readings, so the window choice still uses them.
  const press = pressing(lab, history.to, { withheld: !coherent });
  const line =
    lab.lines.find((entry) => entry.key === (chosen ?? press.key)) ??
    lab.lines.find((entry) => entry.key === press.key) ??
    lab.lines[0]!;
  const displayLine = coherent
    ? line
    : {
        ...line,
        forecast: null,
        refills: line.refills.filter((event) => event.kind !== "expected"),
      };
  const facts = lineFacts(displayLine, history.to);
  const result = coherent
    ? verdict(displayLine, facts, days)
    : {
        tone: "learn" as const,
        short: "Incomplete snapshot",
        text: "Capacity readings do not form a complete snapshot, so this panel has no forecast or verdict.",
        detail: null,
      };
  const chips = planChips(facts.latest);
  const accounts =
    facts.latest?.last.accountCount ??
    line.points.at(-1)?.raw?.last.accountCount ??
    line.points.at(-1)?.last.accountCount ??
    0;
  const color = labColor(lab.provider);
  const weekly = line.windowSeconds === 604_800;
  const onlyReporting = !weekly && lab.fiveHourAccounts < lab.weeklyAccounts;
  const accountLabel =
    !weekly && lab.weeklyAccounts > accounts
      ? `${accounts} of ${lab.weeklyAccounts} accounts report this window`
      : `${accounts} ${accounts === 1 ? "account" : "accounts"}`;
  const windowLines = lab.lines.filter(
    (entry) => entry.windowSeconds === 604_800 || entry.windowSeconds === 18_000,
  );
  const optionLabels = new Map<string, string>();
  for (const entry of windowLines) {
    const label = entry.windowSeconds === 18_000 ? "5-hour" : "Weekly";
    const sameWindow = windowLines.filter((other) => other.windowSeconds === entry.windowSeconds);
    optionLabels.set(
      entry.key,
      entry.mode
        ? sameWindow.length > 1
          ? `${entry.label} · ${entry.unit.label}`
          : entry.label
        : sameWindow.length > 1
          ? `${label} · ${entry.unit.label}`
          : label,
    );
  }
  for (const entry of windowLines) {
    const label = optionLabels.get(entry.key)!;
    if (
      windowLines.some((other) => other.key !== entry.key && optionLabels.get(other.key) === label)
    )
      optionLabels.set(entry.key, `${label} (${entry.unit.id})`);
  }
  return (
    <article
      aria-labelledby={`lab-${lab.provider}`}
      className={first ? "pt-1 pb-6" : "border-t border-border pt-5 pb-6"}
    >
      <div className="grid grid-cols-[auto_1fr_auto] items-start gap-x-3 gap-y-1 max-[540px]:grid-cols-[auto_1fr]">
        <LabMark provider={lab.provider} name={name} />
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 id={`lab-${lab.provider}`} className="text-[15px] font-semibold tracking-[-0.015em]">
            {name}
          </h3>
          <span className="text-sm text-muted-foreground">
            {accountLabel} · in {line.unit.label}
          </span>
        </div>
        <div className="justify-self-end max-[540px]:col-span-full max-[540px]:justify-self-start">
          {windowLines.length > 1 && (
            <div className="grid justify-items-end gap-1 max-[540px]:justify-items-start">
              <Segmented
                label={`${name} limit window`}
                value={line.key}
                options={lab.lines
                  .filter(
                    (entry) => entry.windowSeconds === 604_800 || entry.windowSeconds === 18_000,
                  )
                  .map((entry) => ({ id: entry.key, label: optionLabels.get(entry.key)! }))}
                onChange={onChoose}
              />
              {press.text && (
                <span className="max-w-[19rem] text-right text-xs text-muted-foreground text-pretty max-[540px]:text-left">
                  {press.text}
                </span>
              )}
            </div>
          )}
        </div>
        <div
          className={`col-start-2 col-end-[-1] flex items-start gap-1.5 text-sm text-pretty max-[540px]:col-span-full ${toneText[result.tone]}`}
        >
          <StateIcon tone={result.tone} />
          <span className="text-foreground">
            <b className="font-semibold">{result.short}</b> · {result.text}
          </span>
        </div>
        {result.detail && (
          <div className="col-start-2 col-end-[-1] text-[13px] text-muted-foreground text-pretty max-[540px]:col-span-full">
            {result.detail}
          </div>
        )}
        {chips.length > 0 && (
          <ul
            aria-label={`${name} plans`}
            className="col-start-2 col-end-[-1] m-0 mt-1 flex list-none flex-wrap gap-1.5 p-0 max-[540px]:col-span-full"
          >
            {chips.map((chip) => (
              <li
                key={chip.key}
                className={`inline-flex min-h-[22px] max-w-full flex-wrap items-center gap-1 rounded-sm border px-[7px] text-xs break-words [overflow-wrap:anywhere] ${chip.flagged ? "border-dashed border-warning/45" : "border-border"}`}
              >
                {chip.plan} <span className="text-muted-foreground">×{chip.accounts}</span>
                {chip.note && (
                  <span className={chip.flagged ? "text-warning" : "text-muted-foreground"}>
                    · {chip.note}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {!coherent && <IncompleteCaption />}
        {coherent && onlyReporting && (
          <p className="col-start-2 col-end-[-1] m-0 text-[13px] text-muted-foreground text-pretty max-[540px]:col-span-full">
            Only accounts reporting a five-hour window are in this chart.
          </p>
        )}
      </div>
      <CapacityChart
        line={displayLine}
        from={history.from}
        to={history.to}
        now={history.to}
        color={color}
        facts={facts}
        lab={name}
      />
      <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
        <Legend color={color} facts={facts} line={displayLine} />
        {/* The verdict above says what matters; how the forecast got there stays one click down. */}
        <Daily
          line={displayLine}
          from={history.from}
          to={history.to}
          forecast={coherent ? <ForecastCaption line={displayLine} /> : null}
        />
      </div>
    </article>
  );
}

function IncompleteCaption() {
  return (
    <p className="col-start-2 col-end-[-1] mt-2.5 text-[13px] text-muted-foreground text-pretty max-[540px]:col-span-full">
      Forecast and verdict withheld until the capacity readings agree. Measured readings remain
      available below.
    </p>
  );
}

function ForecastCaption({ line }: { line: CapacityLine }) {
  const forecast = line.forecast;
  const weekly = line.windowSeconds === 604_800;
  const ordinary = forecast?.ordinary;
  const busy = forecast?.busy;
  const candidate = ordinary?.candidate ?? busy?.candidate ?? null;
  const unit = line.unit.label;
  let body: string;
  if (!forecast || forecast.status === "learning") {
    const weeks = forecast?.history.completedWeeks ?? 0;
    const reasons = forecast ? forecastReasons(forecast.reasons) : [];
    body = `Learning from ${weeks} completed ${weeks === 1 ? "week" : "weeks"}${reasons.length ? `: ${reasons.join("; ")}` : ""}. Forecasts start after 2 weeks; account advice starts after 4.`;
  } else if (forecast.status === "unavailable") {
    body = `Forecast unavailable${forecast.reasons.length ? `: ${forecastReasons(forecast.reasons).join("; ")}` : ""}. No account count is available.`;
  } else if ((ordinary?.amount ?? 0) <= 0 && (busy?.amount ?? 0) <= 0) {
    const lowest = forecast.points.reduce(
      (best, point) => (!best || point.median < best.median ? point : best),
      undefined as (typeof forecast.points)[number] | undefined,
    );
    body = `No projected shortfall in the next 72 hours${lowest ? `. Lowest ${amount(lowest.median)} ${unit} near ${whenLabel(lowest.at)}` : ""}.`;
  } else {
    const medianShort = ordinary?.amount ?? 0;
    const busyShort = Math.max(medianShort, busy?.amount ?? 0);
    const stretches = medianShort > 0 ? (ordinary?.stretches ?? []) : (busy?.stretches ?? []);
    const worstStretch = stretches.reduce<(typeof stretches)[number] | undefined>(
      (worst, next) => (!worst || next.depth > worst.depth ? next : worst),
      undefined,
    );
    const where = weekly
      ? stretches.length > 1
        ? ` across ${stretches.length} dry stretches`
        : worstStretch
          ? ` from ~${whenLabel(worstStretch.from)}`
          : ""
      : worstStretch
        ? ` at ~${whenLabel(worstStretch.from)}`
        : "";
    const amountText =
      medianShort > 0
        ? `Projected short ≈${amount(medianShort)} ${unit}${where}`
        : `No shortfall on the median path`;
    const busyText = busyShort > medianShort ? `, ≈${amount(busyShort)} on the busy path` : "";
    body = `${amountText}${busyText}.`;
  }
  const ordinaryAccounts = ordinary?.accounts;
  const busyAccounts = busy?.accounts;
  const sizingBasis =
    ordinary?.accountBasis === "sustained-trend"
      ? "the sustained rise in demand"
      : "recurring demand peaks";
  const weight = candidate
    ? candidate.source === "unit"
      ? `1 ${candidateName(candidate, forecast?.provider ?? "")} = 1 ${unit}`
      : `${candidateName(candidate, forecast?.provider ?? "")}, ${candidate.source} weight ${amount(candidate.capacity)} ${unit}`
    : "";
  const advice =
    forecast?.status !== "estimated"
      ? null
      : candidate && ordinaryAccounts != null && busyAccounts != null
        ? `Sizing for ${sizingBasis}: ${ordinaryAccounts === 0 ? "no extra accounts" : `≈${ordinaryAccounts} more ${candidateName(candidate, forecast?.provider ?? "")} ${ordinaryAccounts === 1 ? "account" : "accounts"}`}, ${busyAccounts} on its busy path (${weight}).`
        : forecast.history.completedWeeks < 4
          ? "Account advice starts after 4 completed weeks."
          : candidate
            ? "Account count unavailable because the forecast evidence is insufficient."
            : "No verified candidate weight is available for an account count.";
  const exclusions = [
    ...new Set(
      [...(ordinary?.exclusions ?? []), ...(busy?.exclusions ?? [])].map((label) =>
        exclusionName(label, forecast?.provider ?? ""),
      ),
    ),
  ];
  const notes = [
    advice,
    forecast?.status === "estimated" && forecast.reasons.length
      ? `Forecast limits: ${forecastReasons(forecast.reasons).join("; ")}`
      : null,
    forecast?.classification === "above"
      ? "This week is above its usual pattern; one unusual week does not set the account count."
      : null,
    forecast?.classification === "trend"
      ? `Demand has remained above its baseline for ${forecast.streak} consecutive weeks.`
      : null,
    forecast?.status === "estimated"
      ? `Banked resets remain unspent${forecast.bankedAvailable === null ? "" : ` (${forecast.bankedAvailable} available)`}.${weekly ? " Recorded use appears as a refill." : ""}`
      : null,
    forecast?.status === "estimated"
      ? `Based on ${forecast.history.completedWeeks} completed weeks, ${Math.round(forecast.history.coverage * 100)}% observed exposure.`
      : null,
    forecast?.status === "estimated" && forecast.backtest
      ? `Backtest: ${forecast.backtest.heldOutWeeks} held-out weeks${forecast.backtest.seasonalMae === null ? "; calibration still learning" : `, mean absolute error ${amount(forecast.backtest.seasonalMae)} ${unit} per hour`}. ${forecast.backtest.beatsSeasonalNaive ? "Beats the previous-week baseline." : "Account advice waits for a passing backtest."}`
      : null,
    forecast?.status === "estimated" && forecast.residualCalibration
      ? `Likely range calibrated from ${forecast.residualCalibration.residualHours} held-out hours across ${forecast.residualCalibration.heldOutWeeks} weeks.`
      : null,
    forecast?.status === "estimated" && exclusions.length
      ? `${exclusions.join(", ")} not used to count accounts.`
      : null,
  ].filter((value): value is string => value !== null);
  return (
    <div className="mt-2 grid gap-1 text-[13px] text-muted-foreground text-pretty">
      <span className="flex items-start gap-1.5">
        <StateIcon
          tone={
            forecast?.status === "estimated" &&
            ((ordinary?.amount ?? 0) > 0 || (busy?.amount ?? 0) > 0)
              ? "warn"
              : "learn"
          }
        />
        {body}
      </span>
      {notes.map((note) => (
        <span key={note}>{note}</span>
      ))}
    </div>
  );
}

function Legend({ color, facts, line }: { color: string; facts: LineFacts; line: CapacityLine }) {
  const forecast = line.forecast;
  const weekly = line.windowSeconds === 604_800;
  return (
    <div className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <i className="h-0.5 w-3.5 rounded-[1px]" style={{ background: color }} />
        {weekly ? "Lowest left each hour, measured" : "Usable five-hour left after weekly gate"}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <i className="w-3.5 border-t border-dotted border-muted-foreground" />
        Nominal: every window fresh (reference, not available)
      </span>
      {forecast?.status === "estimated" && (
        <>
          <span className="inline-flex items-center gap-1.5">
            <i className="w-3.5 border-t border-dashed" style={{ borderColor: color }} />
            Projected median
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="h-2.5 w-3.5 rounded-[2px]" style={{ background: color, opacity: 0.22 }} />
            Likely range
          </span>
          {forecast.points.some((point) => point.low < 0 || point.median < 0 || point.busy < 0) && (
            <span className="inline-flex items-center gap-1.5">
              <i className="h-2.5 w-3.5 rounded-[2px] bg-destructive/20 outline outline-1 outline-destructive/40" />
              Below zero: unserved demand
            </span>
          )}
          {weekly && (
            <span className="inline-flex items-center gap-1.5">
              <i className="h-2.5 w-3.5 border border-dashed border-muted-foreground" />
              Refill, expected
            </span>
          )}
        </>
      )}
      {!weekly && (
        <span className="inline-flex items-center gap-1.5">
          <i className="w-3.5 border-t border-dashed border-foreground/50" />
          Potential 5-hour allowance under weekly limit
        </span>
      )}
      {weekly && line.refills.some((event) => event.kind === "observed") && (
        <span className="inline-flex items-center gap-1.5">
          <i className="h-2.5 w-3.5 border border-muted-foreground" />
          Refill, observed
        </span>
      )}
      {weekly && line.refills.some((event) => event.kind === "banked") && (
        <span className="inline-flex items-center gap-1.5">
          <i className="size-3 rounded-full border border-muted-foreground" />
          Banked reset used (recorded)
        </span>
      )}
      {facts.outHours > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <i className="h-2.5 w-3.5 rounded-[2px] bg-destructive/15 shadow-[inset_0_-2px_0_var(--destructive)]" />
          {weekly ? "All accounts out" : "All accounts out of usable allowance"}
        </span>
      )}
      {facts.gapHours > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <i className="h-2.5 w-3.5 rounded-[2px] bg-accent outline outline-1 outline-input" />
          {weekly ? "No readings" : "No weekly-gated readings"} ({duration(facts.gapHours)})
        </span>
      )}
      <span className="sr-only">Unit: {line.unit.label}.</span>
    </div>
  );
}

function Daily({
  line,
  from,
  to,
  forecast,
}: {
  line: CapacityLine;
  from: number;
  to: number;
  forecast: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const end = Math.max(to, ...(line.forecast?.points.map((point) => point.at + 3_600_000) ?? []));
  const refills = line.refills.filter((event) => event.at >= from && event.at <= end);
  return (
    <details
      className="group mt-2 w-full min-w-0 overflow-x-auto"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground group-open:text-foreground [&::-webkit-details-marker]:hidden">
        <svg
          className="size-3.5 transition-transform duration-150 group-open:rotate-90"
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
        Forecast details and daily table
      </summary>
      {open && forecast}
      {open && (
        <table className="mt-2 w-full border-collapse text-[13px]">
          <caption className="sr-only">
            {line.label} capacity per UTC day, in {line.unit.label}
          </caption>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="border-b border-border py-2 pr-2 font-medium">
                Day (UTC)
              </th>
              <th scope="col" className="border-b border-border py-2 pr-2 text-right font-medium">
                Lowest left ({line.unit.label})
              </th>
              <th scope="col" className="border-b border-border py-2 pr-2 text-right font-medium">
                All out
              </th>
              <th scope="col" className="border-b border-border py-2 text-right font-medium">
                No readings
              </th>
            </tr>
          </thead>
          <tbody>
            {dailyRows(line.points, to).map((row) => (
              <tr key={row.day} className="tabular-nums">
                <th
                  scope="row"
                  className="border-b border-border py-2.5 pr-2 text-left font-normal"
                >
                  {dayLong(row.day)}
                </th>
                <td className="border-b border-border py-2.5 pr-2 text-right">
                  {row.lowest
                    ? `${amount(row.lowest.remaining)} of ${amount(row.lowest.full)}`
                    : "—"}
                </td>
                <td className="border-b border-border py-2.5 pr-2 text-right">
                  {row.outHours ? duration(row.outHours) : "—"}
                </td>
                <td className="border-b border-border py-2.5 text-right">
                  {row.missingHours ? duration(row.missingHours) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && line.forecast?.status === "estimated" && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-xs tabular-nums">
            <caption className="text-left text-muted-foreground">
              Projected hourly balance in {line.unit.label}. Negative values are unserved demand.
            </caption>
            <thead>
              <tr>
                {["Hour (UTC)", "Median", "Likely range", "Busy", "Usable allowance"].map(
                  (label) => (
                    <th
                      key={label}
                      scope="col"
                      className="border-b border-border p-2 text-left font-medium"
                    >
                      {label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {line.forecast.points.map((point) => (
                <tr key={point.at}>
                  <th scope="row" className="border-b border-border p-2 text-left font-normal">
                    {new Date(point.at).toUTCString()}
                  </th>
                  <td className="border-b border-border p-2">{amount(point.median)}</td>
                  <td className="border-b border-border p-2">
                    {amount(point.low)} to {amount(point.high)}
                  </td>
                  <td className="border-b border-border p-2">{amount(point.busy)}</td>
                  <td className="border-b border-border p-2">
                    {point.usable == null ? "Unknown" : amount(point.usable)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && refills.length > 0 && (
        <ul className="mt-3 pl-4 text-xs text-muted-foreground" aria-label="Refill events">
          {refills.map((event, index) => (
            <li key={`${event.at}-${event.kind}-${index}`}>
              {new Date(event.at).toUTCString()}:{" "}
              {event.kind === "banked" ? "recorded banked reset" : `${event.kind} refill`},{" "}
              {event.amountIsLowerBound ? "at least " : ""}
              {amount(event.amount)} {line.unit.label} restored.
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
