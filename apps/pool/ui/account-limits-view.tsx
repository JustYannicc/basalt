import type { Account, Provider } from "../contract.ts";
import { providerName } from "./accounts.tsx";
import { accountReadings, latestReading, type AccountReading } from "./account-limits.ts";
import { Button, Dialog } from "./controls.tsx";
import { ObservationReadingsTable } from "./observation-readings.ts";
import { orderedWindows, windowView } from "./observation-text.ts";
import { duration, exactTime } from "./usage.ts";

// The reader's own locale and time zone, as the rest of the pool formats times.
const format = (() => {
  const options = new Intl.DateTimeFormat().resolvedOptions();
  return { locale: options.locale, timeZone: options.timeZone };
})();

const ago = (at: string, now: number) =>
  now - Date.parse(at) < 60_000 ? "just now" : `${duration(now - Date.parse(at))} ago`;

const readAge = (at: string | null, now: number) =>
  at === null || Number.isNaN(Date.parse(at)) ? "not read yet" : `read ${ago(at, now)}`;

const outcomes: Readonly<Record<string, string>> = {
  unavailable: "the source was unavailable",
  rate_limited: "the source was rate limited",
  invalid: "the source sent an invalid reply",
  timed_out: "the source timed out",
};

/** Why a reading is not current, or null when it is. */
function readingNote(reading: AccountReading, now: number) {
  if (reading.failure)
    return `Latest check failed ${ago(reading.failure.at, now)}: ${
      outcomes[reading.failure.outcome] ?? "the check did not finish"
    }. ${reading.observation ? "Showing the last reading." : "No reading yet."}`;
  if (reading.state === "current") return null;
  return reading.state === "none"
    ? "No current reading yet."
    : "Last known reading, not current. Counts and limits may have changed since.";
}

/** A reading's model limits, with the account limit each counts toward. */
const modelRows = (observation: AccountReading["observation"]) => {
  const rows = orderedWindows(observation?.windows ?? []);
  return rows.filter(
    (row) =>
      row.entry.scope?.kind === "model" || rows.some((other) => other.within === row.entry),
  );
};

/**
 * Read-only Details for a few accounts, inside the pool. Every row is the host's Details table:
 * the same readings, model limits and reset explanations the Accounts tab shows. Nothing here
 * spends a reset; that stays on each account's row in Accounts.
 */
export function AccountLimitsDialog({
  title,
  accounts,
  providers,
  now,
  onClose,
}: {
  title: string;
  /** Empty closes the dialog. */
  accounts: readonly Account[];
  providers: readonly Provider[];
  now: number;
  onClose: () => void;
}) {
  return (
    <Dialog open={accounts.length > 0} onClose={onClose} label={title} wide>
      <div className="grid gap-4 p-5 max-[540px]:p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1">
            <h2 className="text-base font-semibold tracking-[-0.015em]">{title}</h2>
            <p className="text-sm text-muted-foreground text-pretty">
              Nothing is spent from here. Forecasts leave banked resets unspent.
            </p>
          </div>
          <Button size="xs" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {accounts.map((account) => (
          <AccountDetails
            key={account.id}
            account={account}
            provider={providerName(providers, account.provider)}
            now={now}
          />
        ))}
      </div>
    </Dialog>
  );
}

function AccountDetails({
  account,
  provider,
  now,
}: {
  account: Account;
  provider: string;
  now: number;
}) {
  const readings = accountReadings(account);
  const latest = latestReading(readings);
  const id = `limits-${account.id}`;
  return (
    <section
      aria-labelledby={id}
      data-observation-details
      className="grid gap-2 border-t border-border pt-4 first-of-type:border-t-0 first-of-type:pt-0"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 id={id} className="min-w-0 text-sm font-medium wrap-anywhere">
          {account.label}
        </h3>
        <span
          className="text-xs text-muted-foreground tabular-nums"
          title={latest?.observedAt ? exactTime(latest.observedAt) : undefined}
        >
          {readings === null
            ? provider
            : `${provider} · ${readAge(latest?.observedAt ?? null, now)}`}
        </span>
      </div>
      {readings === null ? (
        <p className="m-0 text-xs text-muted-foreground text-pretty">
          Its provider app doesn't share this account's readings here.
        </p>
      ) : (
        readings.map((reading) => {
          const note = readingNote(reading, now);
          return (
            <div key={reading.key} className="grid gap-2">
              {note && <p className="m-0 text-xs text-warning text-pretty">{note}</p>}
              {reading.observation && (
                <ObservationReadingsTable
                  observation={reading.observation}
                  {...(readings.length > 1 && reading.source
                    ? { caption: `Readings from ${reading.source}` }
                    : {})}
                  stale={reading.state !== "current"}
                  now={now}
                  format={format}
                />
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

/**
 * Accounts that also limit one model on its own, with that limit beside the account limit it
 * counts toward. Never added into capacity: the model's use comes out of the same allowance.
 */
export function ModelLimits({
  accounts,
  providers,
  now,
  onOpen,
}: {
  accounts: readonly Account[];
  providers: readonly Provider[];
  now: number;
  onOpen: (account: Account) => void;
}) {
  const listed = accounts.flatMap((account) => {
    const reading = latestReading(accountReadings(account));
    const rows = reading ? modelRows(reading.observation) : [];
    return reading && rows.some((row) => row.entry.scope?.kind === "model")
      ? [{ account, reading, rows }]
      : [];
  });
  if (listed.length === 0) return null;
  return (
    <section aria-labelledby="model-limits-heading" className="grid gap-2 pt-6">
      <div className="grid gap-1">
        <h3 id="model-limits-heading" className="text-[15px] font-semibold tracking-[-0.015em]">
          Model limits
        </h3>
        <p className="max-w-[38rem] text-sm text-muted-foreground text-pretty">
          Some accounts also limit one model on its own. That use counts toward the same account's
          limit, so it adds no capacity.
        </p>
      </div>
      <ul className="m-0 list-none border-t border-border p-0">
        {listed.map(({ account, reading, rows }) => (
            <li key={account.id} className="border-b border-border">
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => onOpen(account)}
                className="grid w-full grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-1 px-1 py-3 text-left text-sm transition-colors duration-150 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset max-[540px]:grid-cols-[minmax(0,1fr)_auto]"
              >
                <span className="min-w-0">
                  <span className="block font-medium wrap-anywhere">{account.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {providerName(providers, account.provider)}
                    {reading.state !== "current" && " · last known"}
                  </span>
                </span>
                <span className="flex flex-wrap gap-x-4 gap-y-0.5 tabular-nums max-[540px]:col-span-full max-[540px]:row-start-2">
                  {rows.map(({ entry }) => (
                    <span key={entry.id} className="whitespace-nowrap">
                      <span className="text-muted-foreground">{entry.label}</span>{" "}
                      {windowView(entry, now, format).detail}
                    </span>
                  ))}
                </span>
                <span className="text-xs text-muted-foreground underline underline-offset-2 max-[540px]:col-start-2 max-[540px]:row-start-1">
                  Details
                </span>
              </button>
            </li>
          ))}
      </ul>
    </section>
  );
}
