import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PoolView } from "../contract.ts";
import type { PoolApi } from "./api.ts";
import { poolOrigin, productName } from "../deployment.ts";
import { Button, buttonClass, ExternalIcon, Problem, Segmented } from "./controls.tsx";
import { Freshness } from "./freshness.tsx";
import { ManagerOverview, PersonalOverview } from "./overview.tsx";
import { useOverview, type RangeDays } from "./overview-data.ts";
import { usePool } from "./pool-view.ts";

function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

export function App({ api }: { api: PoolApi }) {
  const { view, error, updating, reload, measurable } = usePool(api);
  const accountsReady = useRef(false);
  useLayoutEffect(() => {
    if (!measurable || view === undefined || accountsReady.current) return;
    accountsReady.current = true;
    // Document load does not prove the account list or empty result has committed.
    const name = "basalt:pool-accounts-ready";
    const source = view.reading?.source ?? "live";
    performance.mark(name, { detail: { source } });
    if (window.parent !== window)
      window.parent.postMessage({ name, version: 2, snapshot: source === "snapshot" }, new URL(poolOrigin).origin);
  }, [view, measurable]);
  const now = useNow();
  const [days, setDays] = useState<RangeDays>(7);
  const overview = useOverview(api, days);
  const [accountsHref, setAccountsHref] = useState<string>();
  const [shareHref, setShareHref] = useState<string>();
  // Only the owner's context carries the share page; computers live on Connect. Its signed
  // intent lasts five minutes, so it is renewed well before that.
  useEffect(() => {
    let live = true;
    const read = () =>
      void api.computerContext().then((result) => {
        if (live && result.ok) {
          setShareHref(result.value.shareHref);
          setAccountsHref(result.value.accountsHref);
        }
      });
    read();
    const timer = setInterval(read, 4 * 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [api]);

  const count = view?.accounts.length ?? 0;
  const labs = new Set(view?.accounts.map((account) => account.provider)).size;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[56rem] flex-col px-6 max-[540px]:px-4">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border py-2 max-[540px]:items-start">
        <span className="min-w-0 text-sm font-semibold tracking-[-0.01em]">
          {productName} <span className="font-normal text-muted-foreground">/ Pool</span>
        </span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 max-[540px]:w-full">
          <Segmented label="Range" value={days} onChange={setDays} options={[{ id: 7, label: "7 days" }, { id: 30, label: "30 days" }]} />
          {accountsHref && (
            <a href={accountsHref} target="_blank" rel="noopener" className={buttonClass("outline", "sm")}>
              Accounts <ExternalIcon />
            </a>
          )}
          {shareHref && (
            <a href={shareHref} target="_blank" rel="noopener" className={buttonClass("outline", "sm")}>
              Share <ExternalIcon />
            </a>
          )}
        </div>
      </header>

      <main className="flex-1 pb-16">
        <section className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pt-10 pb-6">
          <div className="grid gap-1">
            <h1 className="text-2xl font-semibold tracking-[-0.025em]">Overview</h1>
            <p className="text-sm text-muted-foreground text-pretty">
              {view === undefined
                ? "Loading this pool…"
                : count === 0
                  ? "No accounts yet."
                  : `${count} subscription ${count === 1 ? "account" : "accounts"} across ${labs} ${labs === 1 ? "lab" : "labs"}. Conversations stay on one account; new ones spread across them.`}
            </p>
          </div>
          {view !== undefined && (
            <Freshness view={view} updating={updating} now={now} onRetry={error ? undefined : () => void reload()} />
          )}
        </section>

        {error && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3">
            <Problem>{error}</Problem>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        )}
        {view === undefined ? (
          !error && <Skeleton />
        ) : (
          <>
            {view.accounts.length === 0 && <Empty view={view} />}
            {overview.member ? (
              <>
                <p className="text-sm text-muted-foreground text-pretty">
                  Shared with you. You use its accounts without seeing their credentials; only the pool's owner can add or remove them.
                </p>
                <PersonalOverview data={overview.personal} days={days} providers={view.providers} onRetry={() => void overview.reload()} />
              </>
            ) : (
              <ManagerOverview data={overview} days={days} providers={view.providers} view={view} accountsHref={accountsHref} onRetry={() => void overview.reload()} />
            )}
          </>
        )}
      </main>

    </div>
  );
}

function Empty({ view }: { view: PoolView }) {
  const names = view.providers.map((provider) => provider.name);
  const offered =
    names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
  return (
    <div className="grid justify-items-start gap-4 rounded-lg border border-dashed border-input px-6 py-10 sm:px-10">
      <div className="grid max-w-[34rem] gap-1.5">
        <h2 className="text-base font-semibold tracking-[-0.015em]">
          {view.isOwner ? "Connect your first subscription" : "This pool has no accounts yet"}
        </h2>
        <p className="text-sm text-muted-foreground text-pretty">
          {view.isOwner
            ? `Requests through this pool use the subscriptions you connect, and their capacity and usage show on this page.${offered ? ` You can connect ${offered}.` : ""} Manage saved accounts in this app's Accounts tab.`
            : "Its owner hasn't connected a subscription. Accounts show up here once they do."}
        </p>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true" className="grid">
      {[0, 1, 2].map((row) => (
        <div key={row} className="grid gap-3 border-b border-border px-1 py-4 sm:grid-cols-[15rem_1fr] sm:gap-8">
          <div className="grid gap-1.5">
            <div className="h-4 w-40 animate-pulse rounded-sm bg-accent" />
            <div className="h-3 w-24 animate-pulse rounded-sm bg-accent" />
          </div>
          <div className="grid content-center gap-2.5">
            <div className="h-1.5 animate-pulse rounded-full bg-accent" />
            <div className="h-1.5 animate-pulse rounded-full bg-accent" />
          </div>
        </div>
      ))}
    </div>
  );
}
