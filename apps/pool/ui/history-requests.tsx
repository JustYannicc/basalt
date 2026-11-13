import { Fragment, useState } from "react";
import { failedRecordWithoutUsage } from "./usage-outcome.ts";
import { Badge, Button } from "./controls.tsx";
import type { MemberDirectoryEntry } from "./series-model.ts";
import type { PublicHistoryRecord } from "./history-model.ts";

const visibleRows = 10;

function count(value: string | null): string {
  if (value === null || !/^\d+$/.test(value)) return "—";
  return BigInt(value).toLocaleString();
}

function timestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Time unavailable";
  return (
    new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: "UTC",
    }).format(parsed) + " UTC"
  );
}

function cost(record: PublicHistoryRecord): string {
  if (failedRecordWithoutUsage(record)) return "No usage recorded";
  if (record.cost_basis === "unpriced" || record.cost === null) return "Unpriced";
  const currency = ` ${record.currency ?? "currency not recorded"}`;
  return `${record.cost}${currency} · ${record.cost_basis === "home-charge" ? "Home charge" : "Historical API price"}`;
}

function personName(
  record: PublicHistoryRecord,
  directory: readonly MemberDirectoryEntry[],
): string {
  if (record.attribution === "import-owner" || record.person === null) return "Not attributed";
  return (
    directory.find((member) => member.person === record.person)?.displayName ?? "Name unavailable"
  );
}

export function HistoryRequests({
  records,
  directory,
  providerName,
  totalRecords,
  partial,
  page,
  hasNext,
  loadingNext,
  onPrevious,
  onNext,
}: {
  records: readonly PublicHistoryRecord[];
  directory: readonly MemberDirectoryEntry[];
  providerName: (id: string) => string;
  totalRecords: number | null;
  partial: boolean;
  page: number;
  hasNext: boolean;
  loadingNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const [open, setOpen] = useState<{ page: number; id: string } | null>(null);
  const start = page * visibleRows;
  const visible = records.slice(start, start + visibleRows);
  const end = start + visible.length;
  const totalLabel =
    totalRecords === null
      ? `${end.toLocaleString()} loaded`
      : `${partial ? "at least " : ""}${totalRecords.toLocaleString()}`;

  return (
    <section aria-labelledby="history-requests-heading" className="grid gap-3 pt-10">
      <div className="grid gap-1">
        <h2 id="history-requests-heading" className="text-lg font-semibold tracking-[-0.02em]">
          Requests
        </h2>
        <p className="max-w-[38rem] text-sm text-muted-foreground text-pretty">
          Metadata only. Request and response content is never shown.
        </p>
      </div>
      {visible.length === 0 ? (
        <p className="border-b border-t border-dashed border-input py-6 text-sm text-muted-foreground">
          No requests in this range.
        </p>
      ) : (
        <div
          className="min-w-0 overflow-x-auto"
          role="region"
          aria-label="Request history"
          tabIndex={0}
        >
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Request
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium max-[540px]:hidden">
                  Status
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Tokens
                </th>
                <th scope="col" className="py-2 text-right font-medium max-[540px]:hidden">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((record) => {
                const expanded = open?.page === page && open.id === record.id;
                const model = failedRecordWithoutUsage(record)
                  ? "Failed request"
                  : (record.model ?? "Model not recorded");
                const provider = record.provider
                  ? providerName(record.provider)
                  : "Provider not recorded";
                const completed = !record.failed;
                return (
                  <Fragment key={record.id}>
                    <tr className="border-b border-border align-middle">
                      <th scope="row" className="py-3 pr-3 text-left font-normal">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Hide" : "Show"} metadata for ${model} at ${timestamp(record.timestamp)}`}
                          onClick={() => setOpen(expanded ? null : { page, id: record.id })}
                          className="min-h-9 min-w-0 rounded-sm text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 max-[740px]:min-h-11"
                        >
                          <span className="block font-medium [overflow-wrap:anywhere]">
                            {model}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {provider} · {timestamp(record.timestamp)}
                          </span>
                          <span className="block text-xs text-muted-foreground min-[541px]:hidden">
                            {completed ? "Completed" : "Failed"} · {cost(record)}
                          </span>
                        </button>
                      </th>
                      <td className="py-3 pr-3 text-right max-[540px]:hidden">
                        <Badge tone={completed ? "muted" : "destructive"}>
                          {completed ? "Completed" : "Failed"}
                        </Badge>
                      </td>
                      <td className="py-3 pr-3 text-right tabular-nums">
                        {count(record.total_tokens)}
                      </td>
                      <td className="py-3 text-right text-xs text-muted-foreground max-[540px]:hidden">
                        {cost(record)}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-border bg-muted/35">
                        <td colSpan={4} className="px-3 py-4 sm:px-4">
                          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm max-[540px]:grid-cols-1">
                            <Detail label="Person" value={personName(record, directory)} />
                            <Detail
                              label="Source"
                              value={
                                record.attribution === "import-owner"
                                  ? "Imported history"
                                  : "Pool usage"
                              }
                            />
                            <Detail label="Input tokens" value={count(record.input_tokens)} />
                            <Detail label="Output tokens" value={count(record.output_tokens)} />
                            <Detail label="Cached input" value={count(record.cache_read_tokens)} />
                            <Detail label="Cache writes" value={count(record.cache_write_tokens)} />
                            <Detail
                              label="Reasoning tokens"
                              value={count(record.reasoning_tokens)}
                            />
                            <Detail
                              label="Latency"
                              value={
                                record.latency_ms === null ? "—" : `${count(record.latency_ms)} ms`
                              }
                            />
                            <Detail label="Endpoint" value={record.endpoint ?? "Not recorded"} />
                            <Detail label="API type" value={record.api_type ?? "Not recorded"} />
                            <Detail
                              label="Service tier"
                              value={record.service_tier ?? "Not recorded"}
                            />
                            <Detail
                              label="Status code"
                              value={record.status_code?.toString() ?? "—"}
                            />
                            <Detail label="Token quality" value={record.token_quality} />
                            <Detail label="Cost" value={cost(record)} />
                          </dl>
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
      <nav
        aria-label="Request pages"
        className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 text-xs text-muted-foreground"
      >
        <span className="tabular-nums">
          {visible.length === 0 ? "0" : `${(start + 1).toLocaleString()}–${end.toLocaleString()}`}{" "}
          of {totalLabel}
        </span>
        <span className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0 || loadingNext}
            onClick={onPrevious}
          >
            Previous
          </Button>
          <span>Page {page + 1}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasNext || loadingNext}
            busy={loadingNext}
            onClick={onNext}
          >
            Next
          </Button>
        </span>
      </nav>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="m-0 [overflow-wrap:anywhere] tabular-nums">{value}</dd>
    </div>
  );
}
