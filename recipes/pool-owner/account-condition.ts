import type { PoolFact } from "../common/conditions.ts";
import {
  emptyCheckpoint,
  type Checkpoint,
  type Observation,
  type PoolCheck,
  type PoolMember,
} from "../common/types.ts";

const actionable = new Set([
  "UPSTREAM_AUTH_REJECTED",
  "AUTH_TOKEN_UNAVAILABLE",
  "PROVIDER_UNSUPPORTED",
]);
const transient = new Set([
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "PROVIDER_UNAVAILABLE",
]);
const freshAttempt = (account: PoolFact["accounts"][number], now: number) => {
  const at = account.collection?.attemptedAt ?? 0;
  return at > 0 && at <= now && now - at <= 30 * 60000;
};
const hasWindows = (account: PoolFact["accounts"][number], now: number) =>
  account.fresh &&
  !account.failed &&
  account.windows.length > 0 &&
  account.windows.every(
    (window) =>
      window.remaining !== null &&
      window.remaining >= 0 &&
      window.remaining <= 1 &&
      window.observedAt !== null &&
      window.observedAt <= now &&
      now - window.observedAt <= 30 * 60000 &&
      window.resetAt !== null &&
      window.resetAt > now,
  );
const canServe = (account: PoolFact["accounts"][number], now: number) =>
  account.state === "active" &&
  hasWindows(account, now) &&
  account.windows.every((window) => window.remaining! > 0);
const blocked = (account: PoolFact["accounts"][number], now: number) =>
  account.state === "disabled" ||
  (freshAttempt(account, now) &&
    account.collection?.status === "failed" &&
    actionable.has(account.collection.errorCode ?? "")) ||
  (hasWindows(account, now) && account.windows.some((window) => window.remaining === 0));

/** Inventory proves absence; only measured loss of usable capacity makes that absence actionable. */
export function poolAccountsObservation(
  fact: PoolFact,
  previous: Checkpoint = emptyCheckpoint(),
): Observation {
  const prior = previous.observation;
  const ids = new Set(fact.accounts.map((account) => account.id));
  const available = fact.accounts.some((account) => canServe(account, fact.at));
  const impaired = fact.accounts.every((account) => blocked(account, fact.at));
  const members = fact.accounts.map((account): PoolMember => {
    const seen = Math.max(account.observedAt ?? 0, account.collection?.attemptedAt ?? 0);
    const old = prior.poolMembers?.find((member) => member.id === account.id);
    return {
      id: account.id,
      seenAt: Math.max(old?.seenAt ?? 0, seen <= fact.at ? seen : 0),
      inUse: account.state !== "disabled" && ((seen > 0 && seen <= fact.at) || old?.inUse === true),
    };
  });
  const missing = [
    ...new Map(
      [...(prior.poolMembers ?? []).filter((member) => member.inUse), ...(prior.poolMissing ?? [])]
        .filter((member) => !ids.has(member.id))
        .map((member) => [member.id, member]),
    ).values(),
  ];
  const historyUnknown =
    missing.length > 0 &&
    !available &&
    (fact.removals === undefined ||
      missing.some(
        (member) => fact.removals!.since !== null && member.seenAt <= fact.removals!.since!,
      ));
  const unacknowledged = historyUnknown
    ? []
    : missing.filter(
        (member) =>
          !fact.removals?.items.some(
            (intent) =>
              intent.id === member.id && intent.at >= member.seenAt && intent.at <= fact.at,
          ),
      );
  const pending = available ? [] : unacknowledged;
  const overflow = pending.length > 100;
  const loss = impaired && !overflow ? pending.sort((a, b) => a.id.localeCompare(b.id)) : [];
  const checks: PoolCheck[] = [];
  const currentFailures = new Set<string>();
  let incomplete = historyUnknown || overflow;
  let uncertain = missing.length > 0 && !available && !impaired;
  for (const account of fact.accounts) {
    if (account.state === "disabled") continue;
    const old = prior.poolChecks?.find((value) => value.id === account.id);
    const lastSeen = prior.poolMembers?.find((value) => value.id === account.id)?.seenAt ?? 0;
    const collection = account.collection;
    if (
      !collection ||
      !freshAttempt(account, fact.at) ||
      collection.attemptedAt < (old?.attempt ?? 0) ||
      (collection.status === "failed" && collection.attemptedAt < lastSeen)
    ) {
      incomplete = true;
      if (old) checks.push(old);
      continue;
    }
    if (collection.status === "failed" && actionable.has(collection.errorCode ?? "")) {
      currentFailures.add(account.id);
      const newer = old === undefined || collection.attemptedAt > old.attempt;
      checks.push({
        id: account.id,
        attempt: newer ? collection.attemptedAt : old.attempt,
        since: old?.since ?? collection.attemptedAt,
        count: (old?.count ?? 0) + (newer ? 1 : 0),
      });
    } else if (transient.has(collection.errorCode ?? "")) {
      incomplete = true;
      uncertain = true;
      if (old) checks.push(old);
    } else if (!["success", "partial"].includes(collection.status)) {
      incomplete = true;
      if (old) checks.push(old);
    } else if (account.state !== "active" || !hasWindows(account, fact.at)) {
      incomplete = true;
    }
  }
  const failed = checks
    .filter(
      (check) =>
        currentFailures.has(check.id) &&
        check.count >= 3 &&
        check.attempt - check.since >= 30 * 60000,
    )
    .map((check) => check.id);
  const acknowledged =
    missing.length > 0 &&
    !historyUnknown &&
    !unacknowledged.length &&
    (prior.poolMissing?.length ?? 0) > 0;
  const code = loss.length
    ? "pool-account-no-longer-available"
    : failed.length
      ? "pool-account-checks-failed"
      : historyUnknown
        ? "pool-removal-history-unavailable"
        : incomplete
          ? "pool-account-checks-unknown"
          : acknowledged
            ? "pool-removal-acknowledged"
            : uncertain || checks.length
              ? "confirming-account-checks"
              : "pool-account-actions-clear";
  return {
    cursor: JSON.stringify([code, members, checks, pending]),
    at: fact.at,
    verdict:
      loss.length || failed.length
        ? "action"
        : incomplete || uncertain || checks.length
          ? "unknown"
          : acknowledged
            ? "withdraw"
            : "healthy",
    code,
    readComplete: !incomplete,
    failures: checks.reduce((sum, check) => sum + check.count, 0),
    successes: 0,
    since: Math.min(fact.at, ...checks.map((check) => check.since)),
    poolMembers: historyUnknown || overflow ? (prior.poolMembers ?? members) : members,
    poolChecks: checks,
    poolMissing: historyUnknown || overflow ? (prior.poolMissing ?? []) : pending,
  };
}
