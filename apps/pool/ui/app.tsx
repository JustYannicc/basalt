import { Button } from "apps/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PoolView } from "../contract.ts";
import type { PoolApi } from "./api.ts";
import { poolOrigin } from "../deployment.ts";
import { Problem } from "./controls.tsx";
import { Freshness } from "./freshness.tsx";
import { History } from "./history.tsx";
import type { PublicHistoryReader } from "./history-model.ts";
import { overviewAccounts } from "./overview-accounts.ts";
import { PersonalOverview } from "./personal-overview.tsx";
import { usePool } from "./pool-view.ts";
import { useSummary } from "./summary-data.ts";
import type { Breakdown, Metric, RangeChoice } from "./summary-model.ts";
import { SummaryOverview } from "./summary-view.tsx";

function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

/** Signals once that the account list, or its empty result, has committed. */
function useAccountsReady(view: PoolView | undefined, measurable: boolean) {
  const ready = useRef(false);
  useLayoutEffect(() => {
    if (!measurable || view === undefined || ready.current) return;
    ready.current = true;
    const name = "basalt:pool-accounts-ready";
    const source = view.reading?.source ?? "live";
    performance.mark(name, { detail: { source } });
    if (window.parent !== window)
      window.parent.postMessage(
        { name, version: 2, snapshot: source === "snapshot" },
        new URL(poolOrigin).origin,
      );
  }, [view, measurable]);
}

// The host draws the tabs, including History, and owns Back. Each declared page is its own
// document, so the path alone picks what this one shows.
export function App({
  api,
  publicHistory = api.publicHistory,
}: {
  api: PoolApi;
  publicHistory?: PublicHistoryReader;
}) {
  const { view, error, updating, reload, measurable } = usePool(api);
  useAccountsReady(view, measurable);
  if (window.location.pathname === "/history")
    return (
      <div className="mx-auto w-full max-w-[56rem] px-6 max-[540px]:px-4">
        <History
          series={api.series}
          publicHistory={publicHistory}
          providers={view?.providers ?? []}
        />
      </div>
    );
  return <Overview api={api} view={view} error={error} updating={updating} reload={reload} />;
}

function Overview({
  api,
  view,
  error,
  updating,
  reload,
}: {
  api: PoolApi;
  view: PoolView | undefined;
  error: string | undefined;
  updating: boolean;
  reload: () => Promise<unknown>;
}) {
  const now = useNow();
  const [range, setRange] = useState<RangeChoice>({ kind: "days", days: 7 });
  const [by, setBy] = useState<Breakdown>("provider");
  const [metric, setMetric] = useState<Metric>("cost");
  const usage = useSummary(api, range, by);
  const providers = view?.providers ?? [];
  const empty = view !== undefined && overviewAccounts(view).length === 0;
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[56rem] flex-col px-6 pb-16 max-[540px]:px-4">
      {view !== undefined && (
        <div className="flex justify-end pt-3">
          <Freshness
            view={view}
            updating={updating}
            now={now}
            onRetry={error ? undefined : () => void reload()}
          />
        </div>
      )}
      {error && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3">
          <Problem>{error}</Problem>
          <Button size="sm" variant="outline" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      )}
      {empty && view && (
        <Empty view={view} onAccounts={() => void api.navigate({ tab: "accounts" })} />
      )}
      {usage.member ? (
        <>
          <h1 className="pt-8 pb-2 text-2xl font-semibold tracking-[-0.025em]">Your usage</h1>
          <p className="pb-4 text-sm text-muted-foreground text-pretty">
            Shared with you. You use its accounts without seeing their credentials.
          </p>
          <PersonalOverview
            data={usage.state?.personal}
            days={range.kind === "days" ? range.days : 7}
            providers={providers}
            onRetry={() => void usage.reload()}
          />
        </>
      ) : (
        <SummaryOverview
          api={api}
          state={usage.state}
          shownBy={usage.by}
          updating={usage.updating}
          controls={{ range, by, metric, onRange: setRange, onBy: setBy, onMetric: setMetric }}
          onHistory={(search) => void api.navigate({ page: "history", search })}
          view={view}
          providers={providers}
          now={now}
          onRetry={() => void usage.reload()}
        />
      )}
    </div>
  );
}

function Empty({ view, onAccounts }: { view: PoolView; onAccounts: () => void }) {
  const names = view.providers.map((provider) => provider.name);
  const offered =
    names.length > 3
      ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`
      : names.join(", ");
  return (
    <div className="mt-6 grid justify-items-start gap-4 rounded-lg border border-dashed border-input px-6 py-10 sm:px-10">
      <div className="grid max-w-[34rem] gap-1.5">
        <h2 className="text-base font-semibold tracking-[-0.015em]">
          {view.isOwner ? "Pick your first account" : "This pool has no capacity yet"}
        </h2>
        <p className="text-sm text-muted-foreground text-pretty">
          {view.isOwner
            ? `Tick accounts in this pool's Accounts tab. They come from your provider apps${offered ? `, such as ${offered}` : ""}; connect one there first if you have none. Their combined capacity and usage show here.`
            : "Capacity appears here once accounts are available to this pool."}
        </p>
      </div>
      {view.isOwner && (
        <Button size="sm" variant="outline" onClick={onAccounts}>
          Pick accounts
        </Button>
      )}
    </div>
  );
}
