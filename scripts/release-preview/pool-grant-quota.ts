const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const instant = (value: unknown) => (typeof value === "string" ? Date.parse(value) : NaN);
const current = (value: Record<string, unknown>, now: number) =>
  value.freshness === "fresh" && instant(value.observedAt) <= now && now < instant(value.staleAt);

/** Every selectable subscription must be safe because the pool chooses the serving account. */
export function previewPlanQuotaAvailable(value: unknown, now: number): boolean {
  if (
    !object(value) ||
    !object(value.reading) ||
    value.reading.source !== "live" ||
    value.reading.revalidationFailed !== false ||
    !object(value.reading.readAt) ||
    !(instant(value.reading.readAt.quota) <= now) ||
    !Array.isArray(value.accounts)
  )
    return false;
  const candidates = value.accounts.filter(
    (row) => object(row) && row.provider === "claude" && row.state !== "disabled",
  );
  return (
    candidates.length > 0 &&
    candidates.every((account) => {
      if (
        !object(account) ||
        account.state !== "active" ||
        account.readingFailed !== false ||
        account.credentialFailure !== undefined ||
        typeof account.plan !== "string" ||
        !account.plan.trim() ||
        !current(account, now) ||
        !Array.isArray(account.windows)
      )
        return false;
      const credit = account.usageCredits;
      if (
        !object(credit) ||
        !current(credit, now) ||
        !object(credit.extraUsage) ||
        credit.extraUsage.enabled !== false
      )
        return false;
      if (
        account.usageRouting !== undefined &&
        (!object(account.usageRouting) ||
          account.usageRouting.use !== "plan" ||
          account.usageRouting.eligible !== true)
      )
        return false;
      const windows = account.windows;
      if (
        !["claude-five-hour", "claude-seven-day"].every((id) =>
          windows.some((row) => object(row) && row.id === id),
        )
      )
        return false;
      return windows.every(
        (row) =>
          object(row) &&
          typeof row.remainingRatio === "number" &&
          Number.isFinite(row.remainingRatio) &&
          row.remainingRatio > 0 &&
          row.remainingRatio <= 1 &&
          instant(row.observedAt) <= now &&
          now < instant(row.resetAt),
      );
    })
  );
}
