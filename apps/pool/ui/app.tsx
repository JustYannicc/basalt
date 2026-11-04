import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PoolView } from "../contract.ts";
import type { PoolApi } from "./api.ts";
import { PoolCapacity } from "./accounts.tsx";
import { poolOrigin, productName } from "../deployment.ts";
import { Button, buttonClass, ExternalIcon, Problem } from "./controls.tsx";
import { Freshness } from "./freshness.tsx";
import { usePool } from "./pool-view.ts";
import { Usage } from "./usage-view.tsx";

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
    // Document load does not prove the pool readings or empty result have committed.
    const name = "basalt:pool-accounts-ready";
    const source = view.reading?.source ?? "live";
    performance.mark(name, { detail: { source } });
    if (window.parent !== window)
      window.parent.postMessage({ name, version: 2, snapshot: source === "snapshot" }, new URL(poolOrigin).origin);
  }, [view, measurable]);
  const now = useNow();
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

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[56rem] flex-col px-6 max-[540px]:px-4">
      <header className="flex h-14 items-center justify-between border-b border-border">
        <span className="text-sm font-semibold tracking-[-0.01em]">
          {productName} <span className="font-normal text-muted-foreground">/ Pool</span>
        </span>
        <div className="flex items-center gap-2">
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
            <h1 className="text-2xl font-semibold tracking-[-0.025em]">Capacity</h1>
            <p className="text-sm text-muted-foreground">
              {view === undefined
                ? "Loading this pool…"
                : "Conversations stay on one account; new ones spread across them. Manage saved accounts in this app's Accounts tab."}
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
        ) : view.accounts.length === 0 ? (
          <Empty view={view} />
        ) : (
          <PoolCapacity accounts={view.accounts} providers={view.providers} now={now} />
        )}
        <Usage load={api.usage} poll={api.poll} providers={view?.providers ?? []} now={now} shareHref={shareHref} />
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
          {view.isOwner ? "Connect your first account" : "This pool has no capacity yet"}
        </h2>
        <p className="text-sm text-muted-foreground text-pretty">
          {view.isOwner
            ? `Connect accounts from this app's Accounts tab. Their combined capacity and usage show here.${offered ? ` Supported subscriptions include ${offered}.` : ""}`
            : "Capacity appears here once accounts are available to this pool."}
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
