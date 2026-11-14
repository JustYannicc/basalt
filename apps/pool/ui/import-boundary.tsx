import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PoolApi } from "./api.ts";
import { Button, Problem } from "./controls.tsx";
import { ImportSession, type ImportProgress } from "./import-session.ts";
import { ImportView } from "./import-view.tsx";

function checkpointKey() {
  return `pool-usage-import:${location.pathname}`;
}
function retainProgress(progress: ImportProgress) {
  // Only acknowledged counts survive reload. Source data, approvals and selected File do not.
  try {
    if (progress.phase === "choose" || progress.phase === "complete")
      sessionStorage.removeItem(checkpointKey());
    else if (progress.phase === "importing" || progress.phase === "paused" || progress.added > 0)
      sessionStorage.setItem(
        checkpointKey(),
        JSON.stringify({ checked: progress.checked, added: progress.added }),
      );
  } catch {
    /* Storage may be disabled; the server still deduplicates a reimport. */
  }
}

/** Keep the job outside the routed page so returning to the pool doesn't interrupt a batch. */
export function ImportBoundary({
  api,
  children,
}: {
  api: PoolApi;
  children: (api: PoolApi) => ReactNode;
}) {
  const [session] = useState(() => new ImportSession(api.importUsage, retainProgress));
  const progress = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [hash, setHash] = useState(() => location.hash);
  const [manager, setManager] = useState<boolean>();
  const [accessError, setAccessError] = useState<string>();
  const [retryAccess, setRetryAccess] = useState<() => void>(() => () => {});
  const previousHash = useRef("");
  const [previous] = useState(() => {
    try {
      return sessionStorage.getItem(checkpointKey()) !== null;
    } catch {
      return false;
    }
  });
  // The existing usage read checks current management access; isOwner only names the original owner.
  const observedApi = useMemo(() => {
    const summary: PoolApi["summary"] = async (input) => {
      setRetryAccess(() => () => {
        void summary(input);
      });
      const result = await api.summary(input);
      if (result.ok) {
        setManager(true);
        setAccessError(undefined);
      } else if (result.error === "unauthorized" || result.error === "not_owner") {
        setManager(false);
        session.pause();
      } else setAccessError(result.message);
      return result;
    };
    return { ...api, summary };
  }, [api, session]);
  useEffect(() => {
    const navigate = () =>
      setHash((prior) => {
        if (location.hash === "#usage-import" && prior !== "#usage-import")
          previousHash.current = prior;
        return location.hash;
      });
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  useEffect(() => {
    if (progress.phase !== "importing" && progress.phase !== "previewing") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [progress.phase]);
  const back = () => {
    location.hash = previousHash.current;
  };
  const open = hash === "#usage-import";
  const active = ["previewing", "importing", "paused", "error"].includes(progress.phase);
  return (
    <>
      {open &&
        (manager === undefined ? (
          <div className="mx-auto grid max-w-[56rem] gap-4 p-6">
            {accessError ? (
              <>
                <Problem>{accessError}</Problem>
                <div>
                  <Button variant="outline" onClick={retryAccess}>
                    Check again
                  </Button>
                </div>
              </>
            ) : (
              <p role="status">Checking pool access…</p>
            )}
          </div>
        ) : manager ? (
          <ImportView session={session} progress={progress} previous={previous} back={back} />
        ) : (
          <div className="mx-auto grid max-w-[56rem] gap-4 p-6">
            <Problem>
              Importing usage requires permission to manage and use this pool. Ask a pool manager to
              check your access.
            </Problem>
            <div>
              <Button variant="outline" onClick={back}>
                Back to pool
              </Button>
            </div>
          </div>
        ))}
      <div hidden={open}>
        {manager && (
          <div className="mx-auto w-full max-w-[56rem] px-6 max-[540px]:px-4">
            <section
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4"
              aria-label="Import usage"
            >
              <div className="grid gap-1">
                <p className="text-sm font-medium">
                  {active
                    ? `${progress.phase === "previewing" ? "Checking usage" : progress.phase === "paused" ? "Import paused" : progress.phase === "error" ? "Import interrupted" : "Importing usage"} · ${progress.checked.toLocaleString()} records checked`
                    : "Bring your usage with you"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {active
                    ? "Keep this browser tab open. Added records are kept if you pause."
                    : "Add past request metadata to this pool's history."}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  location.hash = "usage-import";
                }}
              >
                {active ? "View import" : "Import usage"}
              </Button>
            </section>
          </div>
        )}
        {children(observedApi)}
      </div>
    </>
  );
}
