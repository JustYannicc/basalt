import { useCallback, useEffect, useMemo, useState } from "react";
import type { Account, PoolView } from "../contract.ts";
import type { PoolApi } from "./api.ts";
import { AccountList } from "./accounts.tsx";
import { ConnectDialog } from "./connect.tsx";
import { productName } from "../deployment.ts";
import { Button, buttonClass, ExternalIcon, Problem } from "./controls.tsx";
import { duration, lastReading } from "./usage.ts";
import { Computers } from "./computers.tsx";
import { Usage } from "./usage-view.tsx";
import type { ComputersApi } from "./computer-types.ts";

const refresh = 60_000;

function usePool(api: PoolApi) {
  const [view, setView] = useState<PoolView>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    const result = await api.view();
    if (result.ok) {
      setView(result.value);
      setError(undefined);
    } else {
      // Keep the last good view on screen; say the refresh failed.
      setError(result.message);
    }
  }, [api]);
  useEffect(() => {
    let last = 0;
    const refreshNow = () => {
      last = Date.now();
      void load();
    };
    refreshNow();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshNow();
    }, refresh);
    // Coming back to the tab refreshes, unless it just did.
    const onVisible = () => document.visibilityState === "visible" && Date.now() - last > 15_000 && refreshNow();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);
  return { view, error, load };
}

function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

export function App({ api }: { api: PoolApi }) {
  const { view, error, load } = usePool(api);
  const now = useNow();
  const [connecting, setConnecting] = useState(false);
  const [removeError, setRemoveError] = useState<string>();
  const [setupHref, setSetupHref] = useState<string>();
  const [shareHref, setShareHref] = useState<string>();
  const computers = useMemo<ComputersApi>(() => ({
    computers: async () => {
      const result = await api.computerContext();
      if (result.ok) {
        setSetupHref(result.value.href);
        setShareHref(result.value.shareHref);
      }
      return result;
    },
    revoke: async () => ({ ok: false, error: "unauthorized", message: "Open the computer's setup page to revoke it." }),
  }), [api]);

  const remove = async (account: Account) => {
    setRemoveError(undefined);
    const result = await api.remove(account.id);
    if (!result.ok) {
      setRemoveError(result.message);
      return false;
    }
    await load();
    return true;
  };

  const reading = view ? lastReading(view.accounts) : null;
  const count = view?.accounts.length ?? 0;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[56rem] flex-col px-6 max-[540px]:px-4">
      <header className="flex h-14 items-center justify-between border-b border-border">
        <span className="text-sm font-semibold tracking-[-0.01em]">
          {productName} <span className="font-normal text-muted-foreground">/ Pool</span>
        </span>
        <div className="flex items-center gap-2">
          {view?.isOwner && shareHref && (
            <a href={shareHref} target="_blank" rel="noopener" className={buttonClass("outline", "sm")}>
              Share <ExternalIcon />
            </a>
          )}
          {view?.isOwner && view.accounts.length > 0 && (
            <Button size="sm" onClick={() => setConnecting(true)}>
              Connect
            </Button>
          )}
        </div>
      </header>

      <main className="flex-1 pb-16">
        <section className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pt-10 pb-6">
          <div className="grid gap-1">
            <h1 className="text-2xl font-semibold tracking-[-0.025em]">Accounts</h1>
            <p className="text-sm text-muted-foreground">
              {view === undefined
                ? "Loading this pool…"
                : count === 0
                  ? "No accounts yet."
                  : `${count} ${count === 1 ? "account" : "accounts"} in this pool. Conversations stay on one account; new ones spread across them.`}
            </p>
          </div>
          {reading !== null && (
            <p className="text-xs text-muted-foreground tabular-nums" title={new Date(reading).toLocaleString()}>
              Usage read {now - reading < 60_000 ? "just now" : `${duration(now - reading)} ago`}
            </p>
          )}
        </section>

        {error && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3">
            <Problem>{error}</Problem>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}
        {removeError && (
          <div className="mb-4">
            <Problem>{removeError}</Problem>
          </div>
        )}

        {view === undefined ? (
          !error && <Skeleton />
        ) : view.accounts.length === 0 ? (
          <Empty view={view} onConnect={() => setConnecting(true)} />
        ) : (
          <>
            {!view.isOwner && (
              <p className="mb-2 text-sm text-muted-foreground">
                Shared with you. You use its accounts without seeing their credentials; only the pool's owner can add or remove
                them.
              </p>
            )}
            <AccountList
              accounts={view.accounts}
              providers={view.providers}
              now={now}
              canChange={view.isOwner}
              onRemove={remove}
            />
          </>
        )}
        {view !== undefined && <Usage load={api.usage} providers={view.providers} now={now} shareHref={shareHref} />}
        <Computers api={computers} setup={{ kind: "link", href: () => setupHref ?? "#", manageHref: () => setupHref ?? "#" }} />
      </main>

      {view?.isOwner && (
        <ConnectDialog
          open={connecting}
          providers={view.providers}
          api={api}
          onClose={() => setConnecting(false)}
          onConnected={load}
        />
      )}
    </div>
  );
}

function Empty({ view, onConnect }: { view: PoolView; onConnect: () => void }) {
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
            ? `Requests through this pool use the subscriptions you connect here, and each one's limits and resets show on this page.${offered ? ` You can connect ${offered}.` : ""}`
            : "Its owner hasn't connected a subscription. Accounts show up here once they do."}
        </p>
      </div>
      {view.isOwner && <Button onClick={onConnect}>Connect a subscription</Button>}
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
