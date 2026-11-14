import { useCallback, useEffect, useRef, useState } from "react";
import { ChangeReadRetry, type ChangeWatch } from "apps/client";
import type { PoolView } from "../contract.ts";
import { productName } from "../deployment.ts";
import type { PoolApi } from "./api.ts";

/** The view's accounts, providers, ownership and Home readings change only through these. */
const topics = ["accounts", "apps", "membership", "session", "pool-readings"];
const unreachable = `${productName} couldn't reach your pool. Try again.`;
/** Newer data exists but no read of it could be confirmed; the last confirmed view stays. */
export const unconfirmed =
  "Couldn't confirm the latest changes. Showing the last confirmed version.";
export const revokedMessage = "You no longer have access to this pool.";

interface PoolState {
  readonly view?: PoolView;
  readonly error?: string;
  /** Outcome of the first result this mount applied; a failed one is never measured. */
  readonly first: "pending" | "success" | "failure";
  /** A live read is in flight over the view on screen. */
  readonly updating: boolean;
  readonly revoked?: boolean;
}

/**
 * Only the first read of a mount may take the pool's retained view, so the page paints a labelled
 * saved view before the change stream handshakes; any other answer to that read is dropped. Every
 * later read is live, runs through the change feed after a handshake, a hint, a server deadline
 * or a person's retry, and is applied only once the feed accepts it. Nothing reads on a timer.
 */
export function usePool(api: PoolApi) {
  const [state, setState] = useState<PoolState>({ first: "pending", updating: false });
  const latest = useRef(0);
  const mounted = useRef(false);
  const watch = useRef<ChangeWatch | undefined>(undefined);
  const load = useCallback(
    async (fresh: boolean) => {
      const current = watch.current;
      if (!mounted.current || (fresh && current === undefined)) return;
      const id = ++latest.current;
      if (fresh)
        setState((previous) => (previous.view ? { ...previous, updating: true } : previous));
      if (!fresh) {
        const retained = await api.view();
        if (!mounted.current || id !== latest.current) return;
        // Only a labelled saved view may show before an accepted read.
        if (retained.ok && retained.value.reading?.source === "snapshot")
          setState((previous) => ({
            ...previous,
            view: retained.value,
            first: previous.first === "pending" ? "success" : previous.first,
          }));
        return;
      }
      if (current === undefined) return;
      let result: Awaited<ReturnType<PoolApi["view"]>>;
      try {
        result = await current.read(() => api.view({ fresh: true }));
      } catch (error) {
        if (!mounted.current || id !== latest.current) return;
        // Keep the last accepted view, and say it may be behind.
        if (!(error instanceof ChangeReadRetry)) return;
        // A read parked by hiding resumes after the foreground handshake; nothing failed.
        if (error.reason === "hidden") {
          setState((previous) => ({ ...previous, updating: false }));
          return;
        }
        setState((previous) => ({
          ...previous,
          updating: false,
          error: error.reason === "unavailable" ? unreachable : unconfirmed,
        }));
        return;
      }
      // A newer request, revoked access, or leaving the page owns the state now.
      if (!mounted.current || id !== latest.current) return;
      setState((previous) => {
        const first =
          previous.first === "pending" ? (result.ok ? "success" : "failure") : previous.first;
        // Keep the last good view on screen; say the refresh failed.
        if (!result.ok) return { ...previous, first, error: result.message, updating: false };
        return { view: result.value, error: undefined, first, updating: false };
      });
    },
    [api],
  );
  useEffect(() => {
    mounted.current = true;
    // The same ref object for this effect's lifetime; bumping it drops any read still in flight.
    const requests = latest;
    const current = api.changes().watch({
      topics,
      refresh: () => load(true),
      revoked: () => {
        requests.current++;
        setState((previous) => ({
          first: previous.first === "pending" ? "failure" : previous.first,
          error: revokedMessage,
          updating: false,
          revoked: true,
        }));
      },
    });
    watch.current = current;
    // oxlint-disable-next-line react/set-state-in-effect -- the retained view is an external HTTP read; state changes only after it answers, never synchronously here
    void load(false);
    return () => {
      mounted.current = false;
      requests.current++;
      watch.current = undefined;
      current.stop();
    };
  }, [api, load]);
  const reload = useCallback(() => load(true), [load]);
  return {
    view: state.view,
    error: state.error,
    updating: state.updating,
    revoked: state.revoked === true,
    reload,
    measurable: state.first === "success",
  };
}
