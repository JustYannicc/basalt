import { useState } from "react";
import type { Account, Provider, UsageWindow } from "../contract.ts";
import { Badge, Button } from "./controls.tsx";
import { capacity, duration, exactTime, orderedWindows, percent, resetsIn, timeLeft, type ProviderCapacity } from "./usage.ts";

const stateBadge = {
  active: null,
  disabled: { tone: "muted", text: "Paused" },
  unavailable: { tone: "warning", text: "Unavailable" },
  error: { tone: "destructive", text: "Needs attention" },
} as const;

export function providerName(providers: readonly Provider[], id: string): string {
  return providers.find((provider) => provider.id === id)?.name ?? id;
}

/** Fill is what's left. The hairline is how much of the window's time is left: where even spending would put the fill. */
function WindowBar({ window, now }: { window: UsageWindow; now: number }) {
  const left = window.remainingRatio;
  const pace = timeLeft(window, now);
  const reset = resetsIn(window, now);
  const low = left !== null && left < 0.15;
  const tip = [
    left === null ? "No usage reading yet" : `${percent(left)} left`,
    pace === null ? null : `${percent(pace)} of the window left`,
    window.resetAt ? `Resets ${exactTime(window.resetAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="grid grid-cols-[4.5rem_1fr] items-center gap-x-3 gap-y-1 sm:grid-cols-[5.5rem_1fr_9.5rem]" title={tip}>
      <span className="truncate text-xs text-muted-foreground">{window.label}</span>
      <div
        role="meter"
        aria-label={`${window.label} left`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={left === null ? undefined : Math.round(left * 100)}
        aria-valuetext={tip}
        className="relative h-1.5 rounded-full bg-accent"
      >
        {left !== null && (
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${low ? "bg-destructive" : "bg-foreground/80"}`}
            style={{ width: percent(left) }}
          />
        )}
        {pace !== null && (
          <div
            className="absolute -top-1 -bottom-1 w-px -translate-x-1/2 rounded-full bg-muted-foreground"
            style={{ left: percent(pace) }}
            aria-hidden="true"
          />
        )}
      </div>
      <span className="col-start-2 text-xs tabular-nums text-muted-foreground sm:col-start-auto sm:text-right">
        <span className={low ? "font-medium text-destructive" : "font-medium text-foreground"}>
          {left === null ? "–" : `${percent(left)} left`}
        </span>
        {reset && <span> · {reset}</span>}
      </span>
    </div>
  );
}

function AccountRow({
  account,
  providers,
  now,
  canChange,
  onRemove,
}: {
  account: Account;
  providers: readonly Provider[];
  now: number;
  canChange: boolean;
  onRemove: (account: Account) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const badge = stateBadge[account.state];
  const windows = orderedWindows(account.windows);
  return (
    <li className="group grid gap-3 border-b border-border px-1 py-4 last:border-b-0 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-8">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium" title={account.label}>
            {account.label}
          </span>
          {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {providerName(providers, account.provider)}
          {account.plan && <> · {account.plan}</>}
        </div>
        {account.message && account.state !== "active" && (
          <p className="mt-1.5 text-xs text-muted-foreground">{account.message}</p>
        )}
        {canChange && account.inAccounts && (
          <p className="mt-2 text-xs text-muted-foreground">Remove it from this app's Accounts tab.</p>
        )}
        {canChange && !account.inAccounts && (
          <div
            className={`mt-2 flex items-center gap-2 text-xs transition-opacity duration-150 ${
              confirming ? "" : "[@media(pointer:fine)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            }`}
          >
            {confirming ? (
              <>
                <span className="text-muted-foreground">Remove from this pool?</span>
                <Button
                  size="xs"
                  variant="destructive"
                  busy={removing}
                  onClick={async () => {
                    setRemoving(true);
                    if (!(await onRemove(account))) setRemoving(false);
                  }}
                >
                  Remove
                </Button>
                <Button size="xs" variant="ghost" disabled={removing} onClick={() => setConfirming(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="inline" variant="link" className="text-xs text-muted-foreground" onClick={() => setConfirming(true)}>
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="grid content-center gap-2.5">
        {windows.length ? (
          windows.map((window) => <WindowBar key={window.id} window={window} now={now} />)
        ) : (
          <p className="text-xs text-muted-foreground">
            {account.state !== "active"
              ? "No usage while this account is off."
              : account.observedAt
                ? "The pool backend reports no limits for this account."
                : "Reading usage…"}
          </p>
        )}
      </div>
    </li>
  );
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

export function AccountList({
  accounts,
  providers,
  now,
  canChange,
  onRemove,
}: {
  accounts: readonly Account[];
  providers: readonly Provider[];
  now: number;
  canChange: boolean;
  onRemove: (account: Account) => Promise<boolean>;
}) {
  const groups = capacity(accounts);
  return (
    <>
      <section aria-label="Capacity" className="grid gap-x-8 border-b border-border sm:grid-cols-2">
        {groups.map((group) => (
          <Capacity key={group.provider} group={group} providers={providers} now={now} />
        ))}
      </section>
      <ul aria-label="Accounts" className="m-0 list-none p-0">
        {accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            providers={providers}
            now={now}
            canChange={canChange}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </>
  );
}
