import { useState } from "react";
import { type PoolChoice, poolLabel } from "./computer-types.ts";
import { Spinner } from "./controls.tsx";

/**
 * Which pool a computer uses, picked in one click. Picking re-points the computer's existing key on
 * the server, so nothing changes on the computer itself. Same segmented look as the shell picker.
 */
export function PoolPicker({
  computerName,
  current,
  pools,
  onPick,
}: {
  computerName: string;
  current: string;
  pools: readonly PoolChoice[];
  onPick: (pool: PoolChoice) => Promise<boolean>;
}) {
  const [picking, setPicking] = useState<string>();
  const [switched, setSwitched] = useState<string>();
  const pick = async (pool: PoolChoice) => {
    if (pool.id === current || picking) return;
    setPicking(pool.id);
    setSwitched(undefined);
    if (await onPick(pool)) setSwitched(poolLabel(pool));
    setPicking(undefined);
  };
  return (
    <div className="grid">
      <div role="group" aria-label={`Pool for ${computerName}`} className="flex w-fit min-w-0 max-w-full flex-wrap gap-1 rounded-md bg-accent p-0.5">
        {pools.map((pool) => {
          const selected = pool.id === current;
          return (
            <button
              key={pool.id}
              type="button"
              aria-pressed={selected}
              aria-busy={picking === pool.id || undefined}
              disabled={picking !== undefined && picking !== pool.id}
              title={pool.name || undefined}
              onClick={() => void pick(pool)}
              className="inline-flex h-7 max-w-[14rem] min-w-0 items-center gap-1.5 rounded-[4px] px-2.5 text-xs font-medium text-muted-foreground outline-none transition-[background-color,color,box-shadow,opacity] duration-150 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs max-[740px]:h-9"
            >
              {picking === pool.id && <Spinner className="size-3" />}
              <span className="truncate">{poolLabel(pool)}</span>
            </button>
          );
        })}
      </div>
      <p aria-live="polite" className="mt-1 text-xs text-muted-foreground empty:mt-0">
        {switched ? `Its next request uses ${switched === "Your pool" ? "your pool" : switched}.` : ""}
      </p>
    </div>
  );
}
