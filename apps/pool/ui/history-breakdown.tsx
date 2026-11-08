import { Fragment, useState } from "react";
import type { SeriesGroup } from "../usage-series-contract.ts";
import { Segmented } from "./controls.tsx";
import {
  moneyList,
  rows,
  tokensShort,
  total,
  type Grouping,
  type MemberDirectoryEntry,
  type Row,
} from "./series-model.ts";

function historyDirectory(
  groups: readonly SeriesGroup[],
  directory: readonly MemberDirectoryEntry[],
) {
  const known = new Set(directory.map((member) => member.person));
  const previous = new Set(
    groups
      .map(({ key }) => key.person)
      .filter((person): person is string => typeof person === "string" && !known.has(person)),
  );
  return [
    ...directory,
    ...[...previous].map((person) => ({
      person,
      displayName: "Name unavailable",
      active: false,
    })),
  ];
}

function rowCost(row: Row): string {
  if (row.countsOnly) return "Not mapped";
  const costs = [
    row.totals.home.length ? `Home ${moneyList(row.totals.home)}` : null,
    row.totals.imported.length ? `Historical API ${moneyList(row.totals.imported)}` : null,
    row.totals.unpriced > 0n ? "Unpriced" : null,
  ].filter((value): value is string => value !== null);
  return costs.join(" · ") || "—";
}

function rowTokens(row: Row): string {
  if (row.totals.tokensKnown === 0) return "Tokens unavailable";
  return `${tokensShort(row.totals.tokens)}${row.totals.tokensMissing ? "+" : ""} tokens`;
}

export function HistoryBreakdown({
  groups,
  directory,
  providerName,
}: {
  groups: readonly SeriesGroup[];
  directory: readonly MemberDirectoryEntry[];
  providerName: (id: string) => string;
}) {
  const [by, setBy] = useState<Grouping>("person");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const safeDirectory = historyDirectory(groups, directory);
  const native = groups.filter(({ key }) => key.attribution !== "import-owner");
  const imported = new Map<string, SeriesGroup[]>();
  for (const group of groups) {
    if (group.key.attribution !== "import-owner") continue;
    const source = group.key.source ?? "unknown";
    imported.set(source, [...(imported.get(source) ?? []), group]);
  }
  const list = rows(native, by, providerName, safeDirectory);
  const sources = [...imported].sort(([a], [b]) => a.localeCompare(b));
  const importRows = sources.flatMap(([source, entries], index) =>
    rows(entries, "person", providerName).map((row) => ({
      ...row,
      id: `import:${source}`,
      label:
        sources.length === 1
          ? "Imported history · no person attributed"
          : `Imported source ${index + 1} · no person attributed`,
      children: rows(entries, by === "person" ? "model" : by, providerName),
    })),
  );
  const summary = total(groups);
  const label = by === "person" ? "Person" : by === "provider" ? "Lab" : "Model";

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const renderRows = (items: readonly Row[], parent: string, depth = 0) =>
    items.map((row) => {
      const key = `${parent}/${row.id}`;
      const expanded = open.has(key);
      return (
        <Fragment key={key}>
          <tr className="border-b border-border align-middle">
            <th scope="row" className="py-3 pr-3 text-left font-normal">
              <span
                className="flex min-w-0 items-center gap-2"
                style={{ paddingInlineStart: depth * 16 }}
              >
                {row.children.length > 0 ? (
                  <button
                    type="button"
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${row.label}`}
                    aria-expanded={expanded}
                    onClick={() => toggle(key)}
                    className="grid size-8 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 max-[740px]:size-11"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
                      fill="none"
                      aria-hidden="true"
                    >
                      <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </button>
                ) : (
                  <span aria-hidden="true" className="size-8 shrink-0 max-[740px]:size-11" />
                )}
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="block font-medium">{row.label}</span>
                  {row.provider && by !== "provider" && (
                    <span className="block text-xs text-muted-foreground">
                      {providerName(row.provider)}
                    </span>
                  )}
                  {row.countsOnly && (
                    <span className="block text-xs text-muted-foreground">
                      Counted, not attributed
                    </span>
                  )}
                  <span className="block text-xs text-muted-foreground min-[741px]:hidden">
                    {row.totals.requests.toLocaleString()} requests · {rowTokens(row)} ·{" "}
                    {rowCost(row)}
                  </span>
                </span>
              </span>
            </th>
            <td className="py-3 pr-3 text-right tabular-nums max-[540px]:hidden">
              {row.totals.requests.toLocaleString()}
            </td>
            <td className="py-3 pr-3 text-right tabular-nums max-[740px]:hidden">
              {row.totals.tokensKnown === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                `${tokensShort(row.totals.tokens)}${row.totals.tokensMissing ? "+" : ""}`
              )}
            </td>
            <td className="py-3 text-right text-xs text-muted-foreground max-[540px]:hidden">
              {rowCost(row)}
            </td>
          </tr>
          {expanded && renderRows(row.children, key, depth + 1)}
        </Fragment>
      );
    });

  return (
    <section aria-labelledby="history-breakdown-heading" className="grid gap-4 pt-10">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="grid gap-1">
          <h2 id="history-breakdown-heading" className="text-lg font-semibold tracking-[-0.02em]">
            Who uses what
          </h2>
          <p className="max-w-[38rem] text-sm text-muted-foreground text-pretty">
            Imports stay under their own source and never become a person's usage.
          </p>
        </div>
        <Segmented
          label="Group history by"
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
      </div>
      {summary.requests > 0 && (
        <p className="text-sm tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">
            {summary.requests.toLocaleString()} requests
          </span>
          {summary.tokensKnown > 0 && (
            <>
              {" "}
              · {tokensShort(summary.tokens)}
              {summary.tokensMissing || summary.countsOnly ? "+" : ""} tokens
            </>
          )}
          {summary.unpriced > 0n && <> · Unpriced records stay unpriced</>}
        </p>
      )}
      {list.length === 0 && importRows.length === 0 ? (
        <p className="border-b border-t border-dashed border-input py-6 text-sm text-muted-foreground">
          No usage in this range.
        </p>
      ) : (
        <div
          className="min-w-0 overflow-x-auto"
          role="region"
          aria-label="Usage history by group"
          tabIndex={0}
        >
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">
                  {label}
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium max-[540px]:hidden">
                  Requests
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium max-[740px]:hidden">
                  Tokens
                </th>
                <th scope="col" className="py-2 text-right font-medium max-[540px]:hidden">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {renderRows(list, "root")}
              {importRows.length > 0 && (
                <tr>
                  <th
                    colSpan={4}
                    scope="rowgroup"
                    className="pb-2 pt-6 text-left text-xs font-normal text-muted-foreground"
                  >
                    Imported sources
                  </th>
                </tr>
              )}
              {renderRows(importRows, "imports")}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
