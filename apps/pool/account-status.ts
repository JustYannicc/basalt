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

function resetText(account: Account, now: Date): string | null {
  const resets = account.bankedResets;
  if (!resets) return null;
  const expiry = resets.nextExpiresAt === null ? null : instant(resets.nextExpiresAt);
  if (!expiry) return `${resets.available} banked reset${resets.available === 1 ? "" : "s"}`;
  const days = Math.max(0, Math.ceil((Date.parse(expiry) - now.getTime()) / 86_400_000));
  return `↻ ${resets.available} banked · next expires in ${days} day${days === 1 ? "" : "s"}`;
}

/** The account check result for one pool account, within the host's display limits. */
export function accountStatus(account: Account, sites: readonly { readonly id: string; readonly site?: string }[], now = new Date()) {
  const plan = account.plan === null ? "" : text(account.plan, 64);
  // Like the pool screen, a note shows only when something is wrong.
  const message = account.message === null || account.state === "active" ? "" : text(account.message, 128);
  const windows = orderedWindows(account.windows).slice(0, 4);
  const reset = resetText(account, now);
  const resetMeter = windows.findIndex((window) => window.windowSeconds === 18_000);
  // The plan names the subscription, so only editors and its holder see it; the rest is shared.
  const shared = { identity: false } as const;
  const badges = [
    ...(plan ? [{ label: plan, tone: "neutral" as const }] : []),
    { ...states[account.state], ...shared },
    ...(account.readingFailed ? [{ label: "Usage reading failed", tone: "warning" as const, ...shared }]
      : account.freshness === "stale" ? [{ label: "Usage reading stale", tone: "warning" as const, ...shared }] : []),
    ...(reset && resetMeter < 0 ? [{ label: text(reset, 96), tone: "neutral" as const, ...shared }] : []),
  ].slice(0, 8);
  const meters = windows.map((window, index) => ({
    ...meter(window),
    ...(reset && index === resetMeter ? { detail: text(reset, 256) } : {}),
  }));
  return {
    accountInfo: identityOf(account, sites),
    status: {
      badges,
      meters,
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
