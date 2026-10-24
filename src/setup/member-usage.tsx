import { useId, useState } from "react";
import { isWeeklyCap, type Cap, type UsageSlice } from "../../apps/pool/contract.ts";
import { Button } from "../../apps/pool/ui/controls.tsx";
import { cost, tokens } from "../../apps/pool/ui/usage-format.ts";

// The owner's per-person usage on the share page, and the one setting: an optional weekly cap.

/** GET /share/v1/usage: each person's last 30 days on this pool, by the share page's member id. */
export interface ShareUsage {
  readonly members: Readonly<Record<string, { readonly usage: UsageSlice; readonly cap: Cap | null }>>;
}

export function MemberUsage({ usage }: { usage: UsageSlice | undefined }) {
  if (!usage) return null;
  return (
    <span className="block text-xs text-muted-foreground tabular-nums">
      {usage.requests === 0
        ? "No requests in 30 days"
        : `${tokens(usage.tokens.total)} tokens · ${cost(usage.cost)} at API prices · 30 days`}
    </span>
  );
}

const amount = (value: string) => {
  const parsed = Math.round(Number(value.replace(/[$,\s]/g, "")) * 100) / 100;
  return isWeeklyCap(parsed) ? parsed : null;
};

/** Off by default. Setting one starts counting this calendar week, Monday 00:00 UTC. */
export function CapControl({
  title,
  cap,
  onChange,
}: {
  title: string;
  cap: Cap | null;
  onChange: (weekly: number | null) => Promise<string | undefined>;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const parsed = amount(draft);
  const save = async (weekly: number | null) => {
    setBusy(true);
    setError(undefined);
    const problem = await onChange(weekly);
    setBusy(false);
    if (problem) setError(problem);
    else setEditing(false);
  };
  if (editing)
    return (
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed !== null) void save(parsed);
        }}
      >
        <label htmlFor={id} className="sr-only">
          Weekly cap for {title}, in US dollars
        </label>
        <span className="relative">
          <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
          <input
            id={id}
            inputMode="decimal"
            autoFocus
            value={draft}
            disabled={busy}
            placeholder="50"
            aria-invalid={draft && parsed === null ? true : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setEditing(false)}
            className="h-6 w-20 rounded-md border border-input bg-transparent pr-2 pl-5 text-xs tabular-nums outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive max-[740px]:h-11"
          />
        </span>
        <span className="text-xs text-muted-foreground">a week</span>
        <Button type="submit" size="xs" busy={busy} disabled={parsed === null}>
          Save
        </Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </Button>
        {error && (
          <span role="alert" className="basis-full text-xs text-destructive text-pretty">
            {error}
          </span>
        )}
      </form>
    );
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {cap ? (
        <span className="text-muted-foreground tabular-nums" title="Weeks start Monday 00:00 UTC">
          <span className={cap.remaining <= 0 ? "font-medium text-destructive" : "font-medium text-foreground"}>
            {cost(cap.used)}
          </span>{" "}
          of {cost(cap.weekly)} cap this week
        </span>
      ) : (
        <span className="text-muted-foreground">No cap</span>
      )}
      <Button
        size="inline"
        variant="link"
        className="text-xs text-muted-foreground"
        aria-label={cap ? `Change the cap for ${title}` : `Set a cap for ${title}`}
        onClick={() => {
          setDraft(cap ? String(cap.weekly) : "");
          setError(undefined);
          setEditing(true);
        }}
      >
        {cap ? "Change" : "Set cap"}
      </Button>
      {cap && (
        <Button
          size="inline"
          variant="link"
          className="text-xs text-muted-foreground"
          busy={busy}
          aria-label={`Remove the cap for ${title}`}
          onClick={() => void save(null)}
        >
          Remove cap
        </Button>
      )}
      {error && (
        <span role="alert" className="basis-full text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
