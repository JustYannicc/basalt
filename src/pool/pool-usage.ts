import {
  callerHeader,
  controlBasePath,
  usageDays,
  type AppUsage,
  type UsageSummary,
} from "../../apps/pool/contract.ts";
import { readCap, readCaps, setCap } from "./caps.ts";
import { accountsView, HomeClient, poolGroupPrefix } from "./control.ts";
import type { PoolPermissions } from "./authorization.ts";
import { fail, failureResponse, json, rows, text } from "./json.ts";
import { LimitHistory } from "./limit-history.ts";
import { CapacityHistory } from "./capacity/history.ts";
import { capacityOverview } from "./capacity/overview.ts";
import { capacityReadings, capacityWindows } from "./capacity/normalize.ts";
import { quotaObservation } from "./quota-observation.ts";
import { ResetRedemption } from "./reset-redemption.ts";
import { verifyPoolToken } from "./token.ts";
import type { UsageStorage } from "./usage-storage.ts";
import { UsageLedger } from "./usage-summary.ts";
import { mapBounded } from "./bounded.ts";
import { hasUsageLimits, needsQuotaCollection, type QuotaCollection } from "./quota-collection.ts";

// Personal summaries filter before aggregation. Pool managers can inspect the whole pool.

export const summaryPath = `${controlBasePath}/usage/summary`;
export const managedUsagePath = `${controlBasePath}/managed-usage`;
export const managedCapPath = `${controlBasePath}/managed-cap`;
export const maxMembers = 500;
export const isMemberId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
// The alarm reads every five minutes; a read only syncs when the alarm fell behind.
const stale = 6 * 60_000;

interface Dependencies {
  storage: UsageStorage;
  client: HomeClient;
  signingKey: string;
  previousSigningKey?: string;
  /** Everyone who can use the pool, from the pool directory. */
  audience: (pool: string) => Promise<readonly string[]>;
  permissions?: (pool: string, user: string) => Promise<PoolPermissions | undefined>;
  /** Keeps a background sync alive after the response. */
  defer?: (work: Promise<void>) => void;
  now?: () => Date;
  collection?: QuotaCollection;
  officialSummary?: (input: {
    pool: string;
    caller: string;
    canManage: boolean;
    summary: UsageSummary;
  }) => Promise<UsageSummary>;
  appUsage?: (input: {
    pool: string;
    members: readonly string[];
    from: string;
    to: string;
  }) => Promise<Map<string, AppUsage[]> | undefined>;
}

export class PoolUsage {
  private deps: Dependencies;
  private history: LimitHistory;
  private capacity: CapacityHistory;
  private ledger: UsageLedger;
  private resets: ResetRedemption;
  private syncing?: Promise<void>;
  constructor(deps: Dependencies) {
    this.deps = deps;
    const now = () => deps.now?.() ?? new Date();
    this.history = new LimitHistory(deps.storage, now);
    this.capacity = new CapacityHistory(deps.storage);
    this.ledger = new UsageLedger(deps.storage, deps.client, { now, history: this.history });
    this.resets = new ResetRedemption(
      {
        get: <T>(key: string) => deps.storage.get<T>(key),
        put: async (key, value) => {
          await deps.storage.put(key, value);
        },
      },
      deps.client,
      () => now().getTime(),
    );
  }

  /** Alarm work: read new usage records, then sample every pool's limits from one read of Home. */
  async observe(): Promise<void> {
    await this.sync();
    const { client } = this.deps;
    const membership = await client.allMembership();
    const pools = new Map<string, Set<string>>();
    const byGroup = new Map(
      membership.groups.map((group) => [
        group.id,
        group.channel_name.slice(poolGroupPrefix.length),
      ]),
    );
    for (const member of membership.members) {
      const pool = byGroup.get(member.channel_group_id);
      if (pool !== undefined) pools.set(pool, (pools.get(pool) ?? new Set()).add(member.auth_id));
    }
    if (!pools.size) return;
    const ids = new Set([...pools.values()].flatMap((set) => [...set]));
    const [files, quota] = await Promise.all([
      client.data("/credentials").then((value) => rows(value.files)),
      client.quota([...ids].sort()),
    ]);
    const now = this.deps.now?.() ?? new Date();
    const byId = new Map(quota.map((reading) => [reading.credential_id, reading]));
    if (this.deps.collection) {
      await mapBounded(
        [...ids].filter(
          (id) =>
            hasUsageLimits(files.find((file) => file.id === id) ?? {}, byId.get(id)) &&
            needsQuotaCollection(byId.get(id) ?? {}, now.getTime()),
        ),
        async (id) => {
          try {
            await this.deps.collection!.read(id, undefined, false);
          } catch {
            /* The next alarm retries within the persisted per-account cap. */
          }
        },
      );
    }
    for (const [pool, accounts] of pools) {
      // Home v1.1.6 internal/cluster/quota_snapshots.go:129-150,195-214,
      // 812-828,1034-1091 retains windows after failed/partial probes. An account
      // timestamp alone cannot establish freshness of every primary window.
      const readings = accountsView(files, quota, accounts).map((account) => {
        const raw = byId.get(account.id),
          windows = rows(raw?.primary_windows);
        const times = [
          Date.parse(account.observedAt ?? ""),
          ...windows.map((window) => Date.parse(text(window.observed_at) ?? "")),
        ];
        const valid =
          account.freshness === "fresh" &&
          ["success", "partial"].includes(text(raw?.collection_status) ?? "") &&
          windows.length > 0 &&
          windows.every((window) =>
            ["healthy", "low", "exhausted"].includes(text(window.status) ?? ""),
          ) &&
          times.every((at) => Number.isFinite(at) && at <= now.getTime());
        return {
          ...account,
          observedAt: valid ? new Date(Math.min(...times)).toISOString() : null,
        };
      });
      const capacityAccounts = readings
        .filter((account) => account.state === "active")
        .map((account) => ({
          account,
          quota: quotaObservation(byId.get(account.id) ?? {}),
        }));
      const expected = new Map<
        string,
        { provider: string; windowSeconds: number; accounts: number }
      >();
      for (const { account, quota } of capacityAccounts) {
        for (const seconds of new Set(
          capacityWindows(account.provider, quota.windows).map((window) => window.period.seconds!),
        )) {
          const key = JSON.stringify([account.provider, seconds]);
          const cohort = expected.get(key) ?? {
            provider: account.provider,
            windowSeconds: seconds,
            accounts: 0,
          };
          cohort.accounts++;
          expected.set(key, cohort);
        }
      }
      const resetReceipts = new Map(
        await mapBounded(
          readings.filter(
            (account) => account.provider === "codex" || account.provider === "claude",
          ),
          async (account) => {
            const attempt = await this.resets.read(account.id);
            const confirmed =
              attempt && ["reset", "already_redeemed", "already_used"].includes(attempt.outcome);
            return [
              account.id,
              confirmed ? [{ id: attempt.requestId, at: Date.parse(attempt.startedAt) }] : [],
            ] as const;
          },
        ),
      );
      try {
        await this.capacity.observe(pool, {
          at: now.getTime(),
          expected: [...expected.values()],
          unclassifiedAccounts: readings
            .filter((account) => account.state === "active" && account.windows.length === 0)
            .map((account) => ({ account: account.id, provider: account.provider })),
          accountStates: capacityAccounts.flatMap(({ account, quota }) =>
            capacityWindows(account.provider, quota.windows).map((window) => ({
              account: account.id,
              provider: account.provider,
              windowSeconds: window.period.seconds!,
              usable:
                account.state === "active" &&
                account.credentialFailure === undefined &&
                !account.readingFailed &&
                account.freshness === "fresh",
              bankedAvailable: account.bankedResets?.available ?? null,
              bankedUsed: resetReceipts.get(account.id) ?? [],
            })),
          ),
          readings: capacityAccounts.flatMap(({ account, quota }) =>
            capacityReadings(account.id, account.provider, quota, now.getTime()),
          ),
        });
      } catch (error) {
        console.error("Pool capacity sampling failed", error);
      }
      try {
        await this.history.sample(pool, readings, now);
      } catch (error) {
        console.error("Pool limit sampling failed", error);
      }
    }
  }

  /** One sync at a time; a failed one leaves what was already read. */
  private sync(): Promise<void> {
    this.syncing ??= this.ledger
      .sync()
      .then(
        () => {},
        (error: unknown) => {
          console.error("Pool usage sync failed", error);
        },
      )
      .finally(() => {
        this.syncing = undefined;
      });
    return this.syncing;
  }

  async summary(
    pool: string,
    owner: string,
    caller: string,
    days: number,
    members: readonly string[] = [],
    canManage = caller === owner,
  ): Promise<UsageSummary> {
    const now = this.deps.now?.() ?? new Date();
    const readAt = await this.ledger.readAt();
    // Serve what's stored; only catch up in the background when the alarm fell behind.
    if (!readAt || now.getTime() - Date.parse(readAt) > stale) {
      const work = this.sync();
      if (this.deps.defer) this.deps.defer(work);
      else await work;
    }
    const people = canManage ? [...new Set([owner, ...members])] : [caller];
    let summary: UsageSummary;
    if (!canManage) {
      const cap = await readCap(this.deps.client, caller, pool);
      summary = await this.ledger.summary(pool, {
        owner,
        caller,
        canManage,
        members: [],
        days,
        now,
        cap: () => cap,
      });
    } else {
      const capped = [...new Set([caller, ...people])].filter((person) => person !== owner);
      const caps = await readCaps(this.deps.client, pool, capped);
      summary = await this.ledger.summary(pool, {
        owner,
        caller,
        canManage,
        members: people,
        days,
        now,
        cap: (member) => caps.get(member) ?? null,
      });
    }
    const apps = await this.deps.appUsage?.({
      pool,
      members: people,
      from: summary.from,
      to: summary.to,
    });
    const result =
      apps === undefined
        ? summary
        : {
            ...summary,
            ...(summary.members === undefined
              ? { apps: apps.get(caller) ?? [] }
              : {
                  members: summary.members.map((member) => ({
                    ...member,
                    apps: apps.get(member.member) ?? [],
                  })),
                }),
          };
    return this.deps.officialSummary
      ? this.deps.officialSummary({ pool, caller, canManage, summary: result })
      : withoutUsdPrices(result);
  }

  /** The caller authorizes management; the recorded owner is never capped. */
  async setCap(pool: string, owner: string, member: string, weekly: number | null): Promise<void> {
    if (!isMemberId(member)) return fail(400, "invalid_query", "Choose a member of this pool.");
    if (member === owner) return fail(400, "invalid_query", "The pool's owner has no cap.");
    await setCap(this.deps.client, member, pool, weekly);
  }

  /** GET /pool/v1/usage/summary?days= for the pool app, with its pool token and caller. */
  async handle(request: Request): Promise<Response> {
    try {
      const token = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      const claims = token
        ? await verifyPoolToken(this.deps.signingKey, token, this.deps.previousSigningKey)
        : undefined;
      if (!claims) return fail(401, "unauthorized", "A valid pool token is required.");
      if (request.method !== "GET")
        return fail(404, "not_found", "This pool endpoint does not exist.");
      // Without a signed-in caller there is nobody whose usage to show.
      const caller = text(request.headers.get(callerHeader));
      if (!caller) return fail(403, "unauthorized", "Sign in to see your usage on this pool.");
      const raw = new URL(request.url).searchParams.get("days") ?? String(usageDays);
      if (!/^[1-9][0-9]?$/.test(raw) || Number(raw) > usageDays)
        return fail(400, "invalid_query", `Ask for 1 to ${usageDays} days.`);
      const permissions = await this.deps.permissions?.(claims.pool, caller);
      const canManage = permissions?.canManage ?? caller === claims.owner;
      if (new URL(request.url).pathname === `${controlBasePath}/usage/capacity`) {
        if (!canManage)
          return fail(403, "unauthorized", "Only a pool manager can read capacity history.");
        const now = (this.deps.now?.() ?? new Date()).getTime();
        const end = new URL(request.url).searchParams.get("to");
        const to = end === null ? now : Number(end);
        if (!Number.isSafeInteger(to) || to > now || to < now - 5 * 60_000)
          return fail(400, "invalid_query", "Use the current overview read time.");
        const from = Math.floor((to - Number(raw) * 86_400_000) / 3_600_000) * 3_600_000;
        return json(await capacityOverview(this.capacity, claims.pool, from, to));
      }
      if (permissions !== undefined && !permissions.canUse)
        return fail(403, "unauthorized", "This pool is not available to you.");
      const members = canManage ? (await this.deps.audience(claims.pool)).slice(0, maxMembers) : [];
      return json(
        await this.summary(claims.pool, claims.owner, caller, Number(raw), members, canManage),
      );
    } catch (error) {
      return failureResponse(error);
    }
  }
}

/** Old billing buckets are credits. Without the official-price read, every request stays unpriced. */
function withoutUsdPrices(summary: UsageSummary): UsageSummary {
  const clear = <T extends { requests: number; cost: number; unpriced: number }>(value: T): T => ({
    ...value,
    cost: 0,
    unpriced: value.requests,
  });
  return {
    ...summary,
    total: clear(summary.total),
    models: summary.models.map(clear),
    days: summary.days.map((day) => ({ ...clear(day), models: day.models.map(clear) })),
    accounts: summary.accounts.map(clear),
    ...(summary.apps ? { apps: summary.apps.map(clear) } : {}),
    ...(summary.members
      ? {
          members: summary.members.map((member) => ({
            ...clear(member),
            models: member.models.map(clear),
            days: member.days.map((day) => ({ ...clear(day), models: day.models.map(clear) })),
            ...(member.apps ? { apps: member.apps.map(clear) } : {}),
          })),
        }
      : {}),
  };
}
