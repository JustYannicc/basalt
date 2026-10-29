import { callerHeader, controlBasePath, usageDays, type UsageSummary } from "../../apps/pool/contract.ts";
import { readCap, readCaps, setCap } from "./caps.ts";
import { accountsView, HomeClient, poolGroupPrefix } from "./control.ts";
import { fail, failureResponse, json, rows, text } from "./json.ts";
import { LimitHistory } from "./limit-history.ts";
import { verifyPoolToken } from "./token.ts";
import type { UsageStorage } from "./usage-storage.ts";
import { UsageLedger } from "./usage-summary.ts";

// Usage, cost and caps per pool. The owner sees everyone on their pool; anyone else gets only their
// own numbers, filtered before anything is added up. Caps are the pool backend's spend limits.

export const summaryPath = `${controlBasePath}/usage/summary`;
export const maxMembers = 500;
export const isMemberId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
// The alarm reads every five minutes; a read only syncs when the alarm fell behind.
const stale = 6 * 60_000;

interface Dependencies {
  storage: UsageStorage;
  client: HomeClient;
  signingKey: string;
  previousSigningKey?: string;
  /** Everyone who can use the pool, from the pool directory. */
  audience: (pool: string) => Promise<readonly string[]>;
  /** Keeps a background sync alive after the response. */
  defer?: (work: Promise<void>) => void;
  now?: () => Date;
}

export class PoolUsage {
  private deps: Dependencies;
  private history: LimitHistory;
  private ledger: UsageLedger;
  private syncing?: Promise<void>;
  constructor(deps: Dependencies) {
    this.deps = deps;
    const now = () => deps.now?.() ?? new Date();
    this.history = new LimitHistory(deps.storage, now);
    this.ledger = new UsageLedger(deps.storage, deps.client, { now, history: this.history });
  }

  /** Alarm work: read new usage records, then sample every pool's limits from one read of Home. */
  async observe(): Promise<void> {
    await this.sync();
    const { client } = this.deps;
    const membership = await client.allMembership();
    const pools = new Map<string, Set<string>>();
    const byGroup = new Map(membership.groups.map((group) => [group.id, group.channel_name.slice(poolGroupPrefix.length)]));
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
    for (const [pool, accounts] of pools) {
      // Home v1.1.6 internal/cluster/quota_snapshots.go:129-150,195-214,
      // 812-828,1034-1091 retains windows after failed/partial probes. An account
      // timestamp alone cannot establish freshness of every primary window.
      const readings = accountsView(files, quota, accounts).map((account) => {
        const raw = byId.get(account.id), windows = rows(raw?.primary_windows);
        const times = [Date.parse(account.observedAt ?? ""), ...windows.map((window) => Date.parse(text(window.observed_at) ?? ""))];
        const valid = account.freshness === "fresh" && ["success", "partial"].includes(text(raw?.collection_status) ?? "")
          && windows.length > 0 && windows.every((window) => ["healthy", "low", "exhausted"].includes(text(window.status) ?? ""))
          && times.every((at) => Number.isFinite(at) && at <= now.getTime());
        return { ...account, observedAt: valid ? new Date(Math.min(...times)).toISOString() : null };
      });
      try { await this.history.sample(pool, readings, now); }
      catch (error) { console.error("Pool limit sampling failed", error); }
    }
  }

  /** One sync at a time; a failed one leaves what was already read. */
  private sync(): Promise<void> {
    this.syncing ??= this.ledger.sync().then(() => {}, (error: unknown) => {
      console.error("Pool usage sync failed", error);
    }).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  async summary(pool: string, owner: string, caller: string, days: number, members: readonly string[] = []): Promise<UsageSummary> {
    const now = this.deps.now?.() ?? new Date();
    const readAt = await this.ledger.readAt();
    // Serve what's stored; only catch up in the background when the alarm fell behind.
    if (!readAt || now.getTime() - Date.parse(readAt) > stale) {
      const work = this.sync();
      if (this.deps.defer) this.deps.defer(work);
      else await work;
    }
    if (caller !== owner) {
      const cap = await readCap(this.deps.client, caller, pool);
      return this.ledger.summary(pool, { owner, caller, members: [], days, now, cap: () => cap });
    }
    const people = [...new Set([owner, ...members])];
    const caps = await readCaps(this.deps.client, pool, people.filter((person) => person !== owner));
    return this.ledger.summary(pool, { owner, caller, members: people, days, now, cap: (member) => caps.get(member) ?? null });
  }

  /** Owner-only; the owner is never capped. */
  async setCap(pool: string, owner: string, member: string, weekly: number | null): Promise<void> {
    if (!isMemberId(member)) return fail(400, "invalid_query", "Choose a member of this pool.");
    if (member === owner) return fail(400, "invalid_query", "The pool's owner has no cap.");
    await setCap(this.deps.client, member, pool, weekly);
  }

  /** GET /pool/v1/usage/summary?days= for the pool app, with its pool token and caller. */
  async handle(request: Request): Promise<Response> {
    try {
      const token = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      const claims = token ? await verifyPoolToken(this.deps.signingKey, token, this.deps.previousSigningKey) : undefined;
      if (!claims) return fail(401, "unauthorized", "A valid pool token is required.");
      if (request.method !== "GET") return fail(404, "not_found", "This pool endpoint does not exist.");
      // Without a signed-in caller there is nobody whose usage to show.
      const caller = text(request.headers.get(callerHeader));
      if (!caller) return fail(403, "unauthorized", "Sign in to see your usage on this pool.");
      const raw = new URL(request.url).searchParams.get("days") ?? String(usageDays);
      if (!/^[1-9][0-9]?$/.test(raw) || Number(raw) > usageDays) return fail(400, "invalid_query", `Ask for 1 to ${usageDays} days.`);
      const members = caller === claims.owner ? (await this.deps.audience(claims.pool)).slice(0, maxMembers) : [];
      return json(await this.summary(claims.pool, claims.owner, caller, Number(raw), members));
    } catch (error) { return failureResponse(error); }
  }
}
