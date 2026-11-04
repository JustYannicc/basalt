import { Fragment, useState } from "react";
import type { Result } from "../index.ts";
import { Button, Problem, Segmented, StateIcon } from "./controls.tsx";
import { LabMark, labColor } from "./lab.tsx";
import {
  coverageNotes, moneyExact, moneyList, rows, tokensExact, tokensShort, total,
  type Grouping, type Row, type SeriesRead, type Totals,
} from "./series-model.ts";

// Who uses what, and what it cost. Rows come straight from the usage series; a person is the
// series' own pseudonymous id until a member directory names them. Nothing missing reads as zero.

const dash = <span className="text-muted-foreground">—</span>;

function TokenCell({ totals }: { totals: Totals }) {
  if (totals.tokensKnown === 0) return dash;
  return (
    <span title={`${tokensExact(totals.tokens)} tokens${totals.tokensMissing ? ` · ${totals.tokensMissing.toLocaleString()} requests without token counts` : ""}`}>
      {tokensShort(totals.tokens)}
      {totals.tokensMissing > 0 && <span className="text-muted-foreground">+</span>}
    </span>
  );
}

function MoneyCell({ list, priced, unpriced }: { list: Totals["home"]; priced: number; unpriced: number }) {
  if (list.length) return <span title={moneyExact(list)}>{moneyList(list)}</span>;
  if (priced === 0 && unpriced > 0) return <span className="text-muted-foreground">no price</span>;
  return dash;
}

function Stack({ row, max, name }: { row: Row; max: bigint; name: (id: string) => string }) {
  const parts = [...row.byProvider].filter(([, tokens]) => tokens > 0n);
  if (!parts.length || max === 0n) return <div className="h-2" />;
  const sum = parts.reduce((all, [, tokens]) => all + tokens, 0n);
  return (
    <div className="flex h-2 min-w-20 gap-0.5" style={{ width: `${(Number(sum) / Number(max)) * 100}%` }} title={parts.map(([id, tokens]) => `${name(id)} ${tokensShort(tokens)}`).join(" · ")}>
      {parts.map(([id, tokens]) => <i key={id} className="block h-full rounded-[2px]" style={{ flex: Number(tokens), background: labColor(id) }} />)}
    </div>
  );
}

function Name({ row, by, name }: { row: Row; by: Grouping; name: (id: string) => string }) {
  const meta = row.countsOnly ? "Counted, not split until account mapping lands" : by === "model" && row.provider ? name(row.provider) : null;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {by === "provider" && row.provider ? <LabMark provider={row.provider} name={row.label} small />
        : by === "model" && !row.countsOnly ? <span className="size-2 shrink-0 rounded-[2px]" style={{ background: labColor(row.provider) }} /> : null}
      <span className="min-w-0">
        <span className="block truncate font-medium">{row.label}</span>
        {meta && <span className="block text-xs font-normal text-muted-foreground">{meta}</span>}
      </span>
    </span>
  );
}

const cells = (totals: Totals) => (
  <>
    <td className="py-2.5 pr-2 text-right tabular-nums max-[540px]:hidden">{totals.requests ? totals.requests.toLocaleString() : dash}</td>
    <td className="py-2.5 pr-2 text-right tabular-nums max-[740px]:hidden"><TokenCell totals={totals} /></td>
    <td className="py-2.5 pr-2 text-right tabular-nums"><MoneyCell list={totals.home} priced={totals.homePriced} unpriced={totals.unpriced} /></td>
    <td className="py-2.5 text-right tabular-nums max-[540px]:hidden"><MoneyCell list={totals.imported} priced={totals.importedPriced} unpriced={0} /></td>
  </>
);

export function WhoUses({ people, models, days, name, onRetry }: {
  people: Result<SeriesRead> | undefined; models: Result<SeriesRead> | undefined; days: number; name: (id: string) => string; onRetry: () => void;
}) {
  const [by, setBy] = useState<Grouping>("person");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const source = by === "model" ? models : people;
  const list = source?.ok ? rows(source.value.groups, by, name) : [];
  const max = list.reduce((top, row) => (row.totals.tokens > top ? row.totals.tokens : top), 0n);
  const toggle = (id: string) => setOpen((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  return (
    <section id="who" aria-labelledby="who-heading" className="grid scroll-mt-4 gap-4 pt-12">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="grid gap-1">
          <h2 id="who-heading" className="text-lg font-semibold tracking-[-0.02em]">Who uses what</h2>
          <p className="max-w-[38rem] text-sm text-muted-foreground text-pretty">
            Last {days} days. Bars are tokens by lab.{by !== "model" && ` Open a row for its ${by === "person" ? "labs" : "people"}.`}
          </p>
        </div>
        <Segmented label="Group by" value={by} onChange={(value) => { setBy(value); setOpen(new Set()); }}
          options={[{ id: "person", label: "People" }, { id: "provider", label: "Labs" }, { id: "model", label: "Models" }]} />
      </div>
      {source === undefined ? (
        <div aria-hidden="true" className="h-40 animate-pulse rounded-md bg-accent" />
      ) : !source.ok ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3">
          <Problem>{source.message}</Problem>
          <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>
        </div>
      ) : list.length === 0 ? (
        <p className="rounded-lg border border-dashed border-input px-6 py-8 text-sm text-muted-foreground">No requests through this pool in the last {days} days.</p>
      ) : (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-xs whitespace-nowrap text-muted-foreground [&>th]:border-b [&>th]:border-border [&>th]:py-2 [&>th]:pr-2 [&>th]:font-medium">
              <th scope="col">{by === "person" ? "Person" : by === "provider" ? "Lab" : "Model"}</th>
              <th scope="col" className="w-[26%]">Tokens by lab</th>
              <th scope="col" className="text-right max-[540px]:hidden">Requests</th>
              <th scope="col" className="text-right max-[740px]:hidden">Tokens</th>
              <th scope="col" className="text-right">Home charge</th>
              <th scope="col" className="text-right max-[540px]:hidden">Imported API price</th>
            </tr>
          </thead>
          <tbody className="[&_td]:border-b [&_td]:border-border [&_th]:border-b [&_th]:border-border">
            {list.map((row) => {
              const expanded = open.has(row.id);
              const canOpen = row.children.length > 0;
              return (
                <Fragment key={row.id}>
                  <tr className={row.countsOnly ? "text-muted-foreground" : undefined}>
                    <th scope="row" className="py-2.5 pr-2 text-left font-normal">
                      {canOpen ? (
                        <button type="button" aria-expanded={expanded} onClick={() => toggle(row.id)}
                          className="inline-flex min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 max-[740px]:min-h-11">
                          <svg className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <Name row={row} by={by} name={name} />
                        </button>
                      ) : (
                        <span className="block pl-[22px]"><Name row={row} by={by} name={name} /></span>
                      )}
                    </th>
                    <td className="py-2.5 pr-2"><Stack row={row} max={max} name={name} /></td>
                    {cells(row.totals)}
                  </tr>
                  {expanded && row.children.map((child) => (
                    <tr key={child.id} className="bg-muted text-xs">
                      <th scope="row" className="py-[7px] pr-2 pl-[34px] text-left font-normal">
                        <span className="flex items-center gap-2">
                          {by === "person" && child.provider && <span className="size-2 shrink-0 rounded-[2px]" style={{ background: labColor(child.provider) }} />}
                          {child.label}
                        </span>
                      </th>
                      <td className="py-[7px] pr-2"><Stack row={child} max={max} name={name} /></td>
                      {cells(child.totals)}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {source?.ok && <Notes read={source.value} />}
    </section>
  );
}

function Notes({ read }: { read: SeriesRead }) {
  const notes = coverageNotes(read);
  const asOf = read.asOf ? new Date(read.asOf) : null;
  return (
    <div className="grid gap-0.5 text-xs text-muted-foreground">
      {notes.map((note) => <span key={note} className="flex items-start gap-1.5 text-pretty"><StateIcon tone="info" className="size-3.5" />{note}</span>)}
      {asOf && !Number.isNaN(asOf.getTime()) && <span>As of {asOf.toUTCString().replace(" GMT", " UTC")}. Imported history keeps its source and is never attributed to a person.</span>}
    </div>
  );
}

/** Two figures that never add up: what Home charged, and imported API prices in USD. */
export function Money({ people, days }: { people: Result<SeriesRead> | undefined; days: number }) {
  if (!people?.ok) return null;
  const sum = total(people.value.groups);
  const apiEquivalent = people.value.coverage.pricing.apiEquivalent;
  return (
    <section id="cost" aria-labelledby="cost-heading" className="grid scroll-mt-4 gap-4 pt-12">
      <div className="grid gap-1">
        <h2 id="cost-heading" className="text-lg font-semibold tracking-[-0.02em]">What it cost</h2>
        <p className="max-w-[38rem] text-sm text-muted-foreground text-pretty">Separate figures in their own units. They are never added together.</p>
      </div>
      <div className="grid grid-cols-2 rounded-lg border border-border max-[540px]:grid-cols-1">
        <Figure label="Home charge" value={sum.home.length ? moneyList(sum.home) : "None recorded"} exact={moneyExact(sum.home)} days={days}
          body={`What Home charged for ${sum.homePriced.toLocaleString()} requests, in Home's own units.`} />
        <Figure label="Imported API price" value={sum.imported.length ? moneyList(sum.imported) : "None recorded"} exact={moneyExact(sum.imported)} days={days} divided
          body={`Historical USD API prices carried on ${sum.importedPriced.toLocaleString()} imported requests. Not money this pool spent.`} />
      </div>
      <div className="grid gap-1.5 text-[13px]">
        <span className="flex items-start gap-2 text-muted-foreground text-pretty">
          <StateIcon tone="learn" /><span><span className="font-medium text-foreground">API-equivalent cost unavailable.</span> {apiEquivalent.reason}</span>
        </span>
        {sum.unpriced > 0 && (
          <span className="flex items-start gap-2 text-muted-foreground text-pretty">
            <StateIcon tone="info" /><span><b className="font-medium text-foreground tabular-nums">{sum.unpriced.toLocaleString()}</b> requests have no price, so they add to neither figure.</span>
          </span>
        )}
      </div>
    </section>
  );
}

function Figure({ label, value, exact, body, days, divided = false }: { label: string; value: string; exact: string; body: string; days: number; divided?: boolean }) {
  return (
    <div className={`grid content-start gap-1 p-4 ${divided ? "border-l border-border max-[540px]:border-t max-[540px]:border-l-0" : ""}`}>
      <span className="text-[13px] font-medium">{label}</span>
      <span className="text-[26px] leading-tight font-semibold tracking-[-0.03em] tabular-nums" title={exact || undefined}>
        {value}{exact && <small className="ml-1.5 text-[13px] font-normal tracking-[-0.01em] text-muted-foreground">{days} days</small>}
      </span>
      <p className="m-0 text-[13px] text-muted-foreground text-pretty">{body}</p>
    </div>
  );
}
