import type { Account, Provider } from "../contract.ts";
import { capacity, duration, percent, type ProviderCapacity } from "./usage.ts";

export function providerName(providers: readonly Provider[], id: string): string {
  return providers.find((provider) => provider.id === id)?.name ?? id;
}

function Capacity({ group, providers, now }: { group: ProviderCapacity; providers: readonly Provider[]; now: number }) {
  const off = group.accounts - group.serving;
  const resetAt = group.nextReset ? Date.parse(group.nextReset) : Number.NaN;
  const reset = Number.isNaN(resetAt) ? null : resetAt <= now ? "a reset is due now" : `next reset in ${duration(resetAt - now)}`;
  return (
    <div className="grid gap-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <span className="font-medium">{providerName(providers, group.provider)}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {group.accounts} {group.accounts === 1 ? "account" : "accounts"}
          {off > 0 && <> · {off} off</>}
        </span>
      </div>
      <div className="flex h-1.5 gap-1" aria-hidden="true">
        {group.segments.map((segment, index) => (
          <div key={index} className={`flex-1 overflow-hidden rounded-full bg-accent ${segment === null ? "opacity-50" : ""}`}>
            {segment !== null && <div className="h-full rounded-full bg-foreground/80" style={{ width: percent(segment) }} />}
          </div>
        ))}
      </div>
      {group.serving === 0 ? (
        <p className="text-xs text-muted-foreground">No account is serving right now.</p>
      ) : group.measured === 0 || group.windowLabel === null ? (
        <p className="text-xs text-muted-foreground">No usage reading yet.</p>
      ) : (
        <p className="text-xs text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{group.left.toFixed(1)}</span> of {group.measured}{" "}
          {group.measured === 1 ? "account's" : "accounts'"} {group.windowLabel.toLowerCase()} limit left
          {group.serving > group.measured && <> · {group.serving - group.measured} not read yet</>}
          {reset && <> · {reset}</>}
        </p>
      )}
    </div>
  );
}

/** Home readings describe capacity; the host's Accounts tab owns saved-account rows. */
export function PoolCapacity({ accounts, providers, now }: {
  accounts: readonly Account[];
  providers: readonly Provider[];
  now: number;
}) {
  return (
    <section aria-label="Capacity" className="grid gap-x-8 border-b border-border sm:grid-cols-2">
      {capacity(accounts).map((group) => (
        <Capacity key={group.provider} group={group} providers={providers} now={now} />
      ))}
    </section>
  );
}
