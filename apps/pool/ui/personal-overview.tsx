import type { Provider } from "../contract.ts";
import type { Result } from "../index.ts";
import type { PoolPersonalOverviewResult } from "../overview-contract.ts";
import { seriesRead, type RangeDays } from "./overview-data.ts";
import { Money, WhoUses } from "./usage-groups.tsx";

// Names come from the pool view. Until it lands, a neutral mark holds their place: never a raw
// ID, never a guess.
const namer = (providers: readonly Provider[] | undefined) => (id: string) =>
  providers?.find((provider) => provider.id === id)?.name ?? "…";

/** A member's own usage of a pool they were shared, never anyone else's. */
export function PersonalOverview({
  data,
  days,
  providers,
  onRetry,
}: {
  data: Result<PoolPersonalOverviewResult> | undefined;
  days: RangeDays;
  providers: readonly Provider[] | undefined;
  onRetry: () => void;
}) {
  const name = namer(providers);
  if (!data?.ok)
    return (
      <section className="grid gap-4 pt-12">
        {data ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-4 py-3">
            <span className="text-sm text-destructive">{data.message}</span>
            <button
              type="button"
              onClick={onRetry}
              className="text-sm underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        ) : (
          <div aria-hidden="true" className="h-40 animate-pulse rounded-md bg-accent" />
        )}
      </section>
    );
  const read = {
    ok: true as const,
    value: seriesRead(data.value.series),
  };
  return (
    <>
      {data.value.partial && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          This read is incomplete. Your request totals keep their coverage notes; retry for a
          complete range.
        </p>
      )}
      <WhoUses
        overview={undefined}
        personal={data.value}
        people={read}
        models={read}
        days={days}
        name={name}
        onRetry={onRetry}
      />
      <Money overview={undefined} personal={data.value} people={read} days={days} name={name} />
    </>
  );
}
