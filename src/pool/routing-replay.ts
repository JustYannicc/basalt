import { quotaDeadlineTargets } from "./routing-targets.ts";
import type { RoutingDemandWindow } from "./routing-demand-contract.ts";
import type { RoutingReplayInput, RoutingReplayResult } from "./routing-replay-contract.ts";

const minute = 60_000;
const fractionTolerance = 1e-8;
const unavailable = (reason: string): RoutingReplayResult => ({
  status: "unavailable",
  basis: "fluid-fixed-model-mix",
  reasons: [reason],
  demanded: 0,
  served: 0,
  unserved: 0,
  expiredUnused: 0,
  firstShortfallAt: null,
  provenCapacityShortfall: 0,
  maximumBucketDemand: 0,
  firstDayByAccount: {},
});

function integrate(
  window: RoutingDemandWindow | undefined,
  from: number,
  through: number,
  scenario: "median" | "upper-80",
): number | null {
  if (!window || through <= from) return null;
  let at = from,
    amount = 0;
  for (const interval of window.intervals) {
    const start = Date.parse(interval.from),
      end = Date.parse(interval.to);
    if (end <= at) continue;
    const value = scenario === "median" ? interval.demand.median : interval.demand.upper80;
    if (start > at || end <= start || value === null || !Number.isFinite(value) || value < 0)
      return null;
    const to = Math.min(end, through);
    amount += (value * (to - at)) / (end - start);
    at = to;
    if (at >= through) return amount;
  }
  return null;
}

/** Pure replay for the forecast owner. No storage, account mutation, network, or inference calls. */
export function replayQuotaDeadline(input: RoutingReplayInput): RoutingReplayResult {
  if (
    !Number.isFinite(input.now) ||
    !Number.isFinite(input.through) ||
    input.through <= input.now ||
    input.through - input.now > 7 * 24 * 3_600_000 ||
    !input.accounts.length ||
    input.accounts.length > 500
  )
    return unavailable("invalid-replay-envelope");
  if (input.strategy === "weighted-round-robin")
    return unavailable("configured-shares-unavailable");
  const weekly = input.accounts.map((account) =>
    account.windows.some((window) => window.seconds === 604800),
  );
  if (weekly.some(Boolean) && !weekly.every(Boolean)) return unavailable("mixed-deadline-windows");
  const mainSeconds = weekly.every(Boolean) ? 604800 : 18000;
  const mainDemand = input.demand.windows.find((window) => window.seconds === mainSeconds);
  const shortDemand =
    mainSeconds === 604800
      ? input.demand.windows.find((window) => window.seconds === 18000)
      : undefined;
  if (!mainDemand || integrate(mainDemand, input.now, input.through, input.scenario) === null)
    return unavailable("demand-profile-incomplete");
  const state = input.accounts.map((account) => ({
    id: account.id,
    usable: account.usable,
    affinity: input.ignoreAffinity ? 0 : (account.affinityShare ?? 0),
    windows: account.windows.map((window) => ({
      ...window,
      remaining: window.remaining,
      resetAt: window.resetAt,
      releases: [...(window.rollingReleases ?? [])],
    })),
  }));
  if (
    new Set(state.map((account) => account.id)).size !== state.length ||
    state.reduce((sum, account) => sum + account.affinity, 0) > 1 + fractionTolerance ||
    state.some(
      (account) =>
        !Number.isFinite(account.affinity) ||
        account.affinity < 0 ||
        account.windows.length > 2 ||
        new Set(account.windows.map((window) => window.seconds)).size !== account.windows.length ||
        !account.windows.some((window) => window.seconds === mainSeconds) ||
        account.windows.some(
          (window) =>
            ![604800, 18000].includes(window.seconds) ||
            !["fixed", "rolling"].includes(window.mode) ||
            (window.resetAt !== null && !Number.isFinite(window.resetAt)) ||
            !Number.isFinite(window.full) ||
            window.full <= 0 ||
            !Number.isFinite(window.remaining) ||
            window.remaining < 0 ||
            window.remaining > window.full ||
            (window.mode === "fixed" && (window.resetAt === null || window.resetAt <= input.now)) ||
            (window.mode === "rolling" &&
              (window.rollingReleases === null ||
                window.releases.some(
                  (release) =>
                    !Number.isFinite(release.at) ||
                    release.at < input.now ||
                    !Number.isFinite(release.amount) ||
                    release.amount < 0,
                ) ||
                window.releases.reduce((sum, release) => sum + release.amount, window.remaining) >
                  window.full * (1 + fractionTolerance))),
        ),
    )
  )
    return unavailable("quota-state-incomplete");
  if (
    state.some((account) => account.windows.some((window) => window.seconds === 18000)) &&
    mainSeconds === 604800 &&
    !shortDemand
  )
    return unavailable("five-hour-demand-missing");
  const result: RoutingReplayResult = {
    status: "estimated",
    basis: "fluid-fixed-model-mix",
    reasons: [],
    demanded: 0,
    served: 0,
    unserved: 0,
    expiredUnused: 0,
    firstShortfallAt: null,
    provenCapacityShortfall: 0,
    maximumBucketDemand: 0,
    firstDayByAccount: {},
  };
  let demanded = 0,
    served = 0,
    unserved = 0,
    expiredUnused = 0,
    firstShortfallAt: number | null = null;
  let provenCapacityShortfall = 0,
    maximumBucketDemand = 0;
  const firstDayByAccount: Record<string, number> = {};
  const supply = new Map(
    state.map((account) => [
      account.id,
      account.windows.find((window) => window.seconds === mainSeconds)!.remaining,
    ]),
  );
  const consume = (
    account: (typeof state)[number],
    amount: number,
    shortRatio: number,
    at: number,
  ) => {
    for (const window of account.windows) {
      const take = window.seconds === mainSeconds ? amount : amount * shortRatio;
      window.remaining = Math.max(0, window.remaining - take);
      if (window.mode === "rolling" && take > 0)
        window.releases.push({ at: at + window.seconds * 1000, amount: take });
    }
    if (at < input.now + 24 * 3_600_000)
      firstDayByAccount[account.id] = (firstDayByAccount[account.id] ?? 0) + amount;
    served += amount;
  };
  const room = (account: (typeof state)[number], ratio: number) =>
    account.usable
      ? Math.min(
          ...account.windows.map((window) =>
            window.seconds === mainSeconds
              ? window.remaining
              : ratio > 0
                ? window.remaining / ratio
                : Infinity,
          ),
        )
      : 0;
  for (let from = input.now; from < input.through;) {
    let to = Math.min(from + minute, input.through);
    for (const account of state)
      for (const window of account.windows) {
        if (
          window.mode === "fixed" &&
          window.resetAt !== null &&
          window.resetAt > from &&
          window.resetAt < to
        )
          to = window.resetAt;
        for (const release of window.releases)
          if (release.at > from && release.at < to) to = release.at;
      }
    for (const account of state)
      for (const window of account.windows) {
        if (window.mode === "fixed" && window.resetAt !== null && window.resetAt <= from) {
          if (window.seconds === mainSeconds) {
            expiredUnused += account.usable ? window.remaining : 0;
            supply.set(account.id, supply.get(account.id)! + (account.usable ? window.full : 0));
          }
          window.remaining = window.full;
          window.resetAt += window.seconds * 1000;
        }
        if (window.mode === "rolling") {
          const released = window.releases
            .filter((release) => release.at <= from)
            .reduce((sum, release) => sum + release.amount, 0);
          window.releases = window.releases.filter((release) => release.at > from);
          window.remaining = Math.min(window.full, window.remaining + released);
          if (window.seconds === mainSeconds)
            supply.set(account.id, supply.get(account.id)! + (account.usable ? released : 0));
        }
      }
    const demand = integrate(mainDemand, from, to, input.scenario);
    const short = shortDemand ? integrate(shortDemand, from, to, input.scenario) : 0;
    if (demand === null || short === null || (demand === 0 && short > 0))
      return unavailable("incomparable-window-demand");
    const shortRatio = demand > 0 ? short / demand : 0;
    demanded += demand;
    maximumBucketDemand = Math.max(maximumBucketDemand, demand);
    let need = demand;
    const precision = demand * 1e-10;
    for (const account of state) {
      const take = Math.min(need, demand * account.affinity, room(account, shortRatio));
      if (take > 0) {
        consume(account, take, shortRatio, from);
        need -= take;
      }
    }
    for (let pass = 0; need > precision && pass <= state.length; pass++) {
      const open = state.filter((account) => room(account, shortRatio) > 0);
      if (!open.length) break;
      let weights: ReadonlyMap<string, number>;
      if (input.strategy === "quota-deadline") {
        weights = quotaDeadlineTargets({
          now: from,
          useDemand: true,
          shortFull: new Map(
            open.flatMap((account) =>
              account.windows
                .filter((window) => window.seconds === 18000)
                .map((window) => [account.id, window.full] as const),
            ),
          ),
          demandUntil: (start, end, window) =>
            integrate(window === "weekly" ? mainDemand : shortDemand, start, end, input.scenario),
          accounts: open.map((account) => {
            const main = account.windows.find((window) => window.seconds === mainSeconds)!;
            const gate =
              mainSeconds === 604800
                ? account.windows.find((window) => window.seconds === 18000)
                : undefined;
            return {
              id: account.id,
              remaining: main.remaining,
              full: main.full,
              resetAt: main.resetAt ?? to,
              ...(gate?.resetAt === null || gate === undefined
                ? {}
                : { short: { remaining: gate.remaining, resetAt: gate.resetAt, mode: gate.mode } }),
            };
          }),
        });
      } else if (input.strategy === "fill-first")
        weights = new Map(open.map((account, index) => [account.id, index === 0 ? 1 : 0]));
      else weights = new Map(open.map((account) => [account.id, 1 / open.length]));
      let consumed = 0;
      for (const account of open) {
        const take = Math.min(need * (weights.get(account.id) ?? 0), room(account, shortRatio));
        if (take > 0) {
          consume(account, take, shortRatio, from);
          consumed += take;
        }
      }
      if (consumed <= precision) break;
      need -= consumed;
    }
    if (need > precision) {
      unserved += need;
      firstShortfallAt ??= from;
    }
    const upperSupply = state
      .filter((account) => account.usable)
      .reduce((sum, account) => sum + supply.get(account.id)!, 0);
    if (mainDemand.mode === "fixed")
      provenCapacityShortfall = Math.max(provenCapacityShortfall, demanded - upperSupply);
    from = to;
  }
  return {
    ...result,
    demanded,
    served,
    unserved,
    expiredUnused,
    firstShortfallAt,
    provenCapacityShortfall,
    maximumBucketDemand,
    firstDayByAccount,
  };
}
