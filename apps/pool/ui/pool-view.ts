import { useCallback, useEffect, useRef, useState } from "react";
import type { PoolView } from "../contract.ts";
import type { PoolApi } from "./api.ts";

const refresh = 60_000;

interface PoolState {
  readonly view?: PoolView;
  readonly error?: string;
  /** Outcome of the first result this mount applied; a failed one is never measured. */
  readonly first: "pending" | "success" | "failure";
  /** A retained view is on screen and its single fresh follow-up hasn't settled. */
  readonly updating: boolean;
  /** Bumped when a retained view commits, so its follow-up starts only after that commit. */
  readonly followUp: number;
}

/**
 * Only the first read of a mount may take the pool's retained view. Everything after it
 * (the follow-up, polls, retries and reloads after a change) waits for a live read, so a
 * retained view triggers exactly one follow-up and a follow-up never triggers another.
 */
export function usePool(api: PoolApi) {
  const [state, setState] = useState<PoolState>({ first: "pending", updating: false, followUp: 0 });
  const latest = useRef(0);
  const mounted = useRef(false);
  const load = useCallback(
    async (fresh: boolean) => {
      if (!mounted.current) return;
      const id = ++latest.current;
      const result = await api.view(fresh ? { fresh: true } : {});
      // A newer request, or leaving the page, owns the state now.
      if (!mounted.current || id !== latest.current) return;
      setState((previous) => {
        const first = previous.first === "pending" ? (result.ok ? "success" : "failure") : previous.first;
        // Keep the last good view on screen; say the refresh failed.
        if (!result.ok) return { ...previous, first, error: result.message, updating: false };
        const retained = !fresh && result.value.reading?.source === "snapshot" && !result.value.reading.revalidationFailed;
        return {
          view: result.value,
          error: undefined,
          first,
          updating: retained,
          followUp: retained ? previous.followUp + 1 : previous.followUp,
        };
      });
    },
    [api],
  );
  useEffect(() => {
    mounted.current = true;
    void load(false);
    const stop = api.poll(() => void load(true), refresh);
    return () => {
      mounted.current = false;
      latest.current++;
      stop();
    };
  }, [api, load]);
  useEffect(() => {
    if (state.followUp > 0) void load(true);
  }, [state.followUp, load]);
  const reload = useCallback(() => load(true), [load]);
  return {
    view: state.view,
    error: state.error,
    updating: state.updating,
    reload,
    measurable: state.first === "success",
  };
}
