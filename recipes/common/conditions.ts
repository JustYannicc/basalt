import { emptyCheckpoint, type Checkpoint, type Observation } from "./types.ts";
export interface ConnectionFact {
  id: string;
  at: number;
  current: boolean;
  status: string;
  canManage: boolean;
  canReconnect: boolean;
  checkable: boolean;
}
export function connectionObservation(fact: ConnectionFact): Observation {
  const definitive = fact.current && fact.checkable;
  const code =
    definitive && fact.canReconnect && fact.status === "credentials_rejected"
      ? "reconnect-required"
      : definitive && fact.canManage && fact.status === "forbidden"
        ? "permission-required"
        : definitive && fact.status === "healthy"
          ? "connection-healthy"
          : "connection-unknown";
  return {
    cursor: `${fact.id}:${fact.at}:${fact.status}`,
    at: fact.at,
    verdict:
      code === "connection-healthy"
        ? "healthy"
        : code === "connection-unknown"
          ? "unknown"
          : "action",
    code,
    failures: 0,
    successes: 0,
    since: fact.at,
  };
}
export interface PoolFact {
  at: number;
  owner: boolean;
  provider: string;
  removals?: { since: number | null; items: Array<{ id: string; at: number }> };
  accounts: Array<{
    id: string;
    state: string;
    fresh: boolean;
    failed: boolean;
    observedAt?: number;
    collection?: { status: string; errorCode: string | null; attemptedAt: number };
    windows: Array<{
      id: string;
      remaining: number | null;
      observedAt: number | null;
      resetAt: number | null;
    }>;
  }>;
}
export function poolObservation(fact: PoolFact, previous = emptyCheckpoint()): Observation {
  const accounts = fact.accounts.filter((account) => account.state !== "disabled");
  const valid =
    fact.owner &&
    accounts.length > 0 &&
    accounts.every(
      (account) =>
        account.state === "active" &&
        account.fresh &&
        !account.failed &&
        account.windows.length > 0 &&
        account.windows.every(
          (window) =>
            window.remaining !== null &&
            window.remaining >= 0 &&
            window.remaining <= 1 &&
            window.observedAt !== null &&
            window.observedAt <= fact.at &&
            fact.at - window.observedAt <= 30 * 60000 &&
            window.resetAt !== null &&
            window.resetAt > fact.at,
        ),
    );
  // An unchanged account reading never confirms another scan, even if another account refreshed.
  const readings = accounts
    .flatMap((account) =>
      account.windows.map((window) => `${account.id}:${window.id}:${window.observedAt}`),
    )
    .sort();
  const prior = previous.observation;
  const cursor = readings.join("|");
  const allLow =
    valid &&
    accounts.every((account) => account.windows.some((window) => window.remaining! <= 0.1));
  const allHigh =
    valid &&
    accounts.every((account) => account.windows.every((window) => window.remaining! > 0.2));
  const priorReadings = new Set((prior.confirmationCursor ?? "").split("|"));
  const independentlyFresh =
    readings.length > 0 && readings.every((reading) => !priorReadings.has(reading));
  const failure =
    allLow && independentlyFresh ? prior.failures + 1 : !valid || allLow ? prior.failures : 0;
  const success =
    allHigh && independentlyFresh ? prior.successes + 1 : !valid || allHigh ? prior.successes : 0;
  const opening = valid && allLow && failure >= 2;
  const closing = valid && allHigh && success >= 2;
  const exhausted =
    allLow && accounts.every((account) => account.windows.some((window) => window.remaining === 0));
  return {
    cursor: cursor || `unknown:${fact.at}`,
    readComplete: valid,
    at: fact.at,
    verdict: opening ? "action" : closing ? "healthy" : "unknown",
    code: !valid
      ? "quota-unknown"
      : opening
        ? exhausted
          ? "pool-exhausted"
          : "pool-low"
        : "confirming-quota",
    failures: failure,
    successes: success,
    since: prior.since || fact.at,
    ...(valid && independentlyFresh && (allLow || allHigh)
      ? { confirmationCursor: cursor }
      : prior.confirmationCursor === undefined
        ? {}
        : { confirmationCursor: prior.confirmationCursor }),
  };
}
export function quietAt(
  at: number,
  hours: null | { timezone: string; startHour: number; endHour: number },
) {
  if (hours === null) return false;
  const hour = Number(
    new Intl.DateTimeFormat("en", {
      timeZone: hours.timezone,
      hourCycle: "h23",
      hour: "numeric",
    }).format(at),
  );
  return hours.startHour <= hours.endHour
    ? hour >= hours.startHour && hour < hours.endHour
    : hour >= hours.startHour || hour < hours.endHour;
}
