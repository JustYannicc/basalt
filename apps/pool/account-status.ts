// What the Accounts tab shows under a subscription: its plan, whether the pool can use it, and
// how much of each usage window is left. Read from the pool's own view, never from the provider.
// Wording and window order match the pool's own screen.
import type { Account, ControlErrorCode, UsageWindow } from "./contract.ts";
import { identityOf } from "./sign-in.ts";
import { clamp, orderedWindows } from "./ui/usage.ts";

type Tone = "neutral" | "good" | "warning" | "bad";

const states: Record<Account["state"], { readonly label: string; readonly tone: Tone }> = {
  active: { label: "Available", tone: "good" },
  disabled: { label: "Paused", tone: "warning" },
  unavailable: { label: "Unavailable", tone: "warning" },
  error: { label: "Needs attention", tone: "bad" },
};

const text = (value: string, max: number) => value.trim().slice(0, max);

/** The host accepts only a strict ISO instant; anything else is left out rather than failing the check. */
function instant(value: string | null): string | undefined {
  if (value === null) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  const iso = new Date(time).toISOString();
  // Years past 9999 print with a sign and six digits, which the host refuses.
  return /^\d{4}-/.test(iso) ? iso : undefined;
}

function meter(window: UsageWindow) {
  const resetsAt = instant(window.resetAt);
  const remaining = window.remainingRatio;
  return {
    label: text(window.label, 64) || "Usage",
    remaining: remaining === null || !Number.isFinite(remaining) ? null : clamp(remaining),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** The account check result for one pool account, within the host's display limits. */
export function accountStatus(account: Account, sites: readonly { readonly id: string; readonly site?: string }[]) {
  const plan = account.plan === null ? "" : text(account.plan, 64);
  // Like the pool screen, a note shows only when something is wrong.
  const message = account.message === null || account.state === "active" ? "" : text(account.message, 128);
  return {
    accountInfo: identityOf(account, sites),
    status: {
      badges: [...(plan ? [{ label: plan, tone: "neutral" as const }] : []), states[account.state]],
      meters: orderedWindows(account.windows).slice(0, 4).map(meter),
      stats: message ? [{ label: "Note", value: message }] : [],
    },
  };
}

/** How a pool refusal reads to the host's account check. */
export function checkFailure(error: ControlErrorCode | "missing") {
  switch (error) {
    case "unauthorized":
    case "not_found":
    case "missing":
      return "unauthorized" as const;
    case "not_owner":
      return "forbidden" as const;
    case "busy":
      return "rate_limited" as const;
    default:
      return "unavailable" as const;
  }
}
