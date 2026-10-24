import { useCallback, useEffect, useState } from "react";
import { canRefresh, type Computer, type ComputersApi, type ComputersView, computerStatus, type PoolChoice, type SetupMode } from "./computer-types.ts";
import { ComputerRow } from "./computer-row.tsx";
import { Button, buttonClass, ExternalIcon, Problem } from "./controls.tsx";
import { SetupDialog, type SetupStart } from "./setup.tsx";
import { CopyBlock } from "./setup-controls.tsx";

// Fast while something is about to change (a dialog open, a computer waiting or revoking), slow otherwise.
const fast = 4_000;
const slow = 60_000;

// Working computers first, then ones removed from their pool, then revoked ones.
const rank = (computer: Computer) => ({ revoked: 2, removed: 1 } as Record<string, number>)[computerStatus(computer)] ?? 0;

const pending = (computer: Computer) => {
  const status = computerStatus(computer);
  return status !== "connected" && status !== "revoked" && status !== "removed";
};

function useComputers(api: ComputersApi, watching: boolean, refreshKey?: number) {
  const [view, setView] = useState<ComputersView>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    const result = await api.computers();
    if (result.ok) {
      setView(result.value);
      setError(undefined);
    } else {
      // Keep the last good list on screen; say the refresh failed.
      setError(result.message);
    }
  }, [api]);
  const eager = watching || (view?.computers.some(pending) ?? false);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, eager ? fast : slow);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, eager]);
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

/** The person's own computers in this pool, and setting up another. */
export function Computers({ api, setup: mode, refreshKey }: { api: ComputersApi; setup: SetupMode; refreshKey?: number }) {
  // The dialog stays mounted so closing it returns focus; its flow mounts fresh on each open.
  const [setup, setSetup] = useState<SetupStart>({ kind: "new" });
  const [open, setOpen] = useState(false);
  const { view, error, load } = useComputers(api, open, refreshKey);
  const openSetup = (start: SetupStart) => {
    setSetup(start);
    setOpen(true);
  };
  const now = useNow();
  const [actionError, setActionError] = useState<string>();
  const [opening, setOpening] = useState<string>();

  const newLink = async (computer: Computer) => {
    if (mode.kind !== "dialog") return;
    setActionError(undefined);
    setOpening(computer.id);
    const result = await mode.api.refreshSetup(computer.id);
    setOpening(undefined);
    if (!result.ok) return setActionError(result.message);
    openSetup({ kind: "link", name: computer.name, link: result.value });
  };

  const switchPool = async (computer: Computer, pool: PoolChoice) => {
    if (!api.switchPool) return false;
    setActionError(undefined);
    const result = await api.switchPool(computer.id, pool.id);
    if (!result.ok) {
      setActionError(result.message);
      return false;
    }
    await load();
    return true;
  };

  const revoke = async (computer: Computer) => {
    setActionError(undefined);
    const result = await api.revoke(computer.id);
    if (!result.ok) {
      setActionError(result.message);
      return false;
    }
    await load();
    return true;
  };

  const computers = view ? [...view.computers].sort((a, b) => rank(a) - rank(b)) : [];

  return (
    <section aria-labelledby="computers-heading" className="pt-12">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-4">
        <div className="grid gap-1">
          <h2 id="computers-heading" className="text-lg font-semibold tracking-[-0.02em]">
            Computers
          </h2>
          <p className="text-sm text-muted-foreground text-pretty">
            {(view?.pools?.length ?? 0) > 1
              ? "Your computers, and the pool each one uses. Switching takes effect on its next request; nothing changes on the computer."
              : "Your computers using this pool. Each turns green once its first model request and tool call arrive."}
          </p>
        </div>
        {computers.length > 0 && (
          <SetUp mode={mode} size="sm" variant="outline" onOpen={() => openSetup({ kind: "new" })} />
        )}
      </div>

      {error && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3">
          <Problem>{error}</Problem>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}
      {actionError && (
        <div className="mb-4">
          <Problem>{actionError}</Problem>
        </div>
      )}

      {view === undefined ? (
        !error && <Skeleton />
      ) : computers.length === 0 ? (
        <div className="grid justify-items-start gap-4 rounded-lg border border-dashed border-input px-6 py-10 sm:px-10">
          <div className="grid max-w-[34rem] gap-1.5">
            <h3 className="text-base font-semibold tracking-[-0.015em]">Set up this computer</h3>
            <p className="text-sm text-muted-foreground text-pretty">
              One paste into Claude Code or Codex points both at this pool and adds your tools. It shows up here, and turns
              green once it works.
            </p>
          </div>
          <SetUp mode={mode} onOpen={() => openSetup({ kind: "new" })} />
        </div>
      ) : (
        <>
          <ul aria-label="Computers" className="m-0 list-none border-t border-border p-0">
            {computers.map((computer) => (
              <ComputerRow
                key={computer.id}
                computer={computer}
                now={now}
                opening={opening === computer.id}
                setupHref={mode.kind === "link" && canRefresh(computer) ? mode.href(computer) : undefined}
                manageHref={mode.kind === "link" ? mode.manageHref?.(computer) : undefined}
                onNewLink={() => newLink(computer)}
                onRevoke={() => revoke(computer)}
                pools={view.pools}
                onSwitch={api.switchPool ? (pool) => switchPool(computer, pool) : undefined}
              />
            ))}
          </ul>
          <details className="group mt-4">
            <summary className="w-fit cursor-pointer list-none text-xs text-muted-foreground underline decoration-muted-foreground/50 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
              Undo setup on a computer
            </summary>
            <div className="mt-3 grid max-w-[34rem] gap-3">
              <p className="text-sm text-muted-foreground text-pretty">
                Paste this into the agent on that computer. It removes only what setup added and restores your backups.
                Revoking stops the computer right away. Undo cleans up its files.
              </p>
              <CopyBlock label="Undo prompt" text={view.undoPrompt} copyLabel="Copy undo prompt" />
            </div>
          </details>
        </>
      )}

      {mode.kind === "dialog" && (
        <SetupDialog
          open={open}
          start={setup}
          api={mode.api}
          computers={view?.computers ?? []}
          onClose={() => setOpen(false)}
          onChanged={() => void load()}
        />
      )}
    </section>
  );
}

/** Opens the dialog, or the page that can mint links, from the person's own click. */
function SetUp({
  mode,
  size = "default",
  variant = "default",
  onOpen,
}: {
  mode: SetupMode;
  size?: "default" | "sm";
  variant?: "default" | "outline";
  onOpen: () => void;
}) {
  if (mode.kind === "dialog") {
    return (
      <Button size={size} variant={variant} onClick={onOpen}>
        Set up this computer
      </Button>
    );
  }
  return (
    <a href={mode.href(undefined)} target="_blank" rel="noopener" className={`${buttonClass(variant, size)} w-fit`}>
      Set up this computer <ExternalIcon />
    </a>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true" className="grid border-t border-border">
      {[0, 1].map((row) => (
        <div key={row} className="grid gap-3 border-b border-border px-1 py-4 sm:grid-cols-[15rem_1fr] sm:gap-8">
          <div className="grid gap-1.5">
            <div className="h-4 w-32 animate-pulse rounded-sm bg-accent" />
            <div className="h-3 w-24 animate-pulse rounded-sm bg-accent" />
          </div>
          <div className="grid content-center gap-2">
            <div className="h-3 w-48 animate-pulse rounded-sm bg-accent" />
            <div className="h-3 w-40 animate-pulse rounded-sm bg-accent" />
          </div>
        </div>
      ))}
    </div>
  );
}
