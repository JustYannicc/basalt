import type { Account } from "./contract.ts";

/** A completed quota read can verify credentials even when routing is paused or the quota is empty. */
export function subscriptionFailure(account: Account, now = Date.now()) {
  if (account.credentialFailure) return account.credentialFailure;
  const code = account.collection?.errorCode;
  if (code === "UPSTREAM_AUTH_REJECTED" || code === "AUTH_TOKEN_UNAVAILABLE") return "unauthorized" as const;
  if (code === "UPSTREAM_RATE_LIMITED") return "rate_limited" as const;
  if (code || account.readingFailed || account.state === "error") return "unavailable" as const;
  const observed = Date.parse(account.observedAt ?? "");
  if (account.freshness !== "fresh" || !Number.isFinite(observed) || observed > now || now - observed >= 30 * 60_000
    || !["success", "partial"].includes(account.collection?.status ?? "")) return "unavailable" as const;
  return null;
}
