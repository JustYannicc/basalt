import { usageCredits, retainedUsageCredits } from "./usage-credits.ts";
import type { Account, BankedResets, UsageWindow } from "../../apps/pool/contract.ts";
import { quotaWindowSeconds } from "./quota-period.ts";
import { collectionDiagnostic } from "./collection-diagnostic.ts";
import { collectionRequest } from "./quota-collection-request.ts";
import { object, rows, text, type Json } from "./json.ts";

/** App and alarm reads preserve full details; retained list replies remain readable. */
export function accountsView(files: Json[], quota: Json[], ids: ReadonlySet<string>): Account[] {
  const byId = new Map(
    quota.map((row) => [
      object(row.credential) ? row.credential.credential_id : row.credential_id,
      row,
    ]),
  );
  return files
    .filter((row) => typeof row.id === "string" && ids.has(row.id))
    .map((row): Account => {
      const raw = byId.get(row.id);
      const reading = object(raw?.credential) ? raw.credential : raw;
      const collection = object(raw?.collection) ? raw.collection : undefined;
      const provider = text(row.provider) ?? text(row.type) ?? "";
      const diagnostic = collectionDiagnostic(collection?.diagnostic, provider);
      const request = provider === "xai" ? collectionRequest(collection?.request) : undefined;
      const freshness = collection?.freshness ?? reading?.freshness;
      const windows = Array.isArray(raw?.windows)
        ? detailWindows(rows(raw.windows), provider)
        : rows(reading?.primary_windows ?? []);
      return {
        id: row.id as string,
        provider,
        label: text(row.email) ?? text(row.label) ?? text(row.name) ?? (row.id as string),
        plan: object(reading?.plan) ? text(reading.plan.name) : null,
        state: row.disabled
          ? "disabled"
          : row.unavailable
            ? "unavailable"
            : row.status === "error"
              ? "error"
              : "active",
        message: text(row.status_message),
        // At equal lengths put Home's main account allowance last, so capacity uses it.
        windows: [...windows]
          .sort(
            (a, b) =>
              (quotaWindowSeconds(a) ?? Infinity) - (quotaWindowSeconds(b) ?? Infinity) ||
              Number(mainAllowance(a, provider)) - Number(mainAllowance(b, provider)),
          )
          .map(windowView)
          .filter((window) => window !== null),
        observedAt: text(collection?.observed_at ?? reading?.observed_at),
        freshness: freshness === "fresh" || freshness === "stale" ? freshness : "never",
        staleAt: readingDeadline([
          collection?.expires_at,
          reading?.expires_at,
          ...windows.map((window) => window.expires_at),
        ]),
        // Partial collections still have usable windows (profile or reset metadata may have failed).
        readingFailed: (collection?.status ?? reading?.collection_status) === "failed",
        collection: {
          status: text(collection?.status ?? reading?.collection_status),
          errorCode: collectionError(collection?.error ?? reading?.error),
          lastAttemptAt: text(collection?.last_attempt_at ?? reading?.last_attempt_at),
          ...(diagnostic === undefined ? {} : { diagnostic }),
          ...(request === undefined ? {} : { request }),
        },
        nextReadAt: text(collection?.next_probe_at ?? reading?.next_probe_at),
        earliestResetAt: text(reading?.earliest_reset_at),
        bankedResets: bankedResets(raw?.reset_credits),
        ...(usageCredits(raw?.usage_credits) === undefined
          ? {}
          : { usageCredits: usageCredits(raw?.usage_credits) }),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function readingDeadline(values: unknown[]): string | null {
  const deadlines = values.flatMap((value) => {
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(at) ? [at] : [];
  });
  return deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null;
}

export function retainedAccount(account: Account, now: number): Account {
  if (account.usageCredits)
    account = { ...account, usageCredits: retainedUsageCredits(account.usageCredits, now) };
  if (account.freshness !== "fresh") return account;
  const observed = Date.parse(account.observedAt ?? "");
  const expires = Date.parse(account.staleAt ?? "");
  return Number.isFinite(observed) && observed <= now && now < expires
    ? account
    : { ...account, freshness: "stale" };
}

function collectionError(value: unknown): string | null {
  if (!object(value) || !text(value.code)) return null;
  return [
    "UPSTREAM_AUTH_REJECTED",
    "AUTH_TOKEN_UNAVAILABLE",
    "UPSTREAM_RATE_LIMITED",
    "UPSTREAM_UNAVAILABLE",
    "PROVIDER_UNAVAILABLE",
    "AUTH_RESOLVE_FAILED",
    "UPSTREAM_RESPONSE_INVALID",
    "PROVIDER_UNSUPPORTED",
    "SNAPSHOT_PERSIST_FAILED",
  ].includes(String(value.code))
    ? String(value.code)
    : "UNKNOWN";
}

function mainAllowance(window: Json, provider: string): boolean {
  if (provider === "claude")
    return window.id === "claude-five-hour" || window.id === "claude-seven-day";
  return codexMainAllowance(window);
}
function codexMainAllowance(window: Json): boolean {
  const scope = text(window.scope_id)?.trim().toLowerCase();
  return window.scope === "account" && (!scope || scope === "codex");
}

function detailWindows(windows: Json[], provider: string): Json[] {
  if (provider !== "codex" && provider !== "claude") return windows;
  // Home v1.1.6 quota/codex.go:75-111,202-211 uses metered_feature for model scope_id.
  // Code Review is a separate model family, not the account's coding allowance.
  return windows.filter((window) => {
    if (
      window.is_unlimited === true ||
      (quotaWindowSeconds(window) !== 18_000 && quotaWindowSeconds(window) !== 604_800)
    )
      return false;
    if (provider !== "codex") return window.scope === "account" || window.scope === "model";
    const scope = text(window.scope_id)?.trim().toLowerCase();
    return (
      codexMainAllowance(window) ||
      (window.scope === "model" && !!scope?.startsWith("codex_") && scope !== "codex_code_review")
    );
  });
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function bankedResets(value: unknown): BankedResets | null {
  if (!object(value) || !finite(value.available_count) || value.available_count < 0) return null;
  const expires = rows(value.credits ?? [])
    .filter((credit) => credit.status === "available")
    .map((credit) => text(credit.expires_at))
    .filter((at): at is string => at !== null && Number.isFinite(Date.parse(at)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    available: value.available_count,
    nextExpiresAt: value.available_count > 0 ? (expires[0] ?? null) : null,
  };
}
function windowLabel(row: Json): string | null {
  const label = text(row.label)?.trim();
  if (label) return label;
  const seconds = quotaWindowSeconds(row);
  if (!finite(seconds) || seconds <= 0) return null;
  if (seconds === 604_800) return "Weekly";
  for (const [unit, suffix] of [
    [86_400, "d"],
    [3_600, "h"],
    [60, "m"],
    [1, "s"],
  ] as const) {
    if (seconds % unit === 0) return `${seconds / unit}${suffix}`;
  }
  return `${seconds}s`;
}
function windowView(row: Json): UsageWindow | null {
  const label = windowLabel(row);
  if (label === null) return null;
  const ratio = finite(row.remaining_ratio)
    ? row.remaining_ratio
    : finite(row.used_ratio)
      ? 1 - row.used_ratio
      : null;
  return {
    // Home labels only additional limits; a raw window id never reaches a screen.
    id: text(row.id) ?? "",
    label,
    remainingRatio:
      row.is_unlimited === true ? 1 : ratio === null ? null : Math.min(1, Math.max(0, ratio)),
    resetAt: row.is_unlimited === true ? null : text(row.reset_at),
    observedAt: text(row.observed_at),
    windowSeconds: quotaWindowSeconds(row),
  };
}
