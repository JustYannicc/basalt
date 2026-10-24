import type { Cap, DayUsage, ModelUsage, TokenCounts, UsageSlice, UsageSummary } from "../../apps/pool/contract.ts";
import { digest, parseBackendUserName } from "./backend-users.ts";
import { poolGroupPrefix, type HomeClient } from "./control.ts";
import { object, rows, text, unavailable, type Json } from "./json.ts";
import type { LimitHistory } from "./limit-history.ts";
import { ChunkStorage, UsageQueue, type UsageStorage } from "./usage-storage.ts";

const dayMs = 86_400_000;
const lookback = 2 * 60 * 60 * 1000;
const prefix = "usage-v1:";
const cursorKey = `${prefix}cursor`;
const daysKey = `${prefix}days`;
const pendingKey = `${prefix}pending`;
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
const poolKey = (pool: string, day: string) => `${prefix}pool:${encodeURIComponent(pool)}:${day}`;
const seenKey = (day: string) => `${prefix}seen:${day}`;
interface Bucket extends ModelUsage { person: string }
interface Receipts { ids: Record<string, number>; pools: string[] }
interface Scan { from: number; to: number; offset: number }
interface Cursor { version: 2 | 3; pools: string[]; readAt: string | null; recent?: Scan; scan?: Scan }
interface Options { now?: () => Date; maxPages?: number; history?: Pick<LimitHistory, "advice"> }
export interface SummaryOptions {
  owner: string; caller: string; members: readonly string[]; days: number; now: Date;
  cap: (member: string) => Cap | null;
}
const zero = (): UsageSlice => ({ requests: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }, cost: 0, unpriced: 0 });
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
function add(a: UsageSlice, b: UsageSlice): UsageSlice {
  const tokens = { ...a.tokens };
  for (const key of Object.keys(tokens) as (keyof TokenCounts)[]) tokens[key] += b.tokens[key];
  return { requests: a.requests + b.requests, cost: a.cost + b.cost, unpriced: a.unpriced + b.unpriced, tokens };
}

// Home v1.1.6 management/usage_observability.go:1611-1620,1699-1715;
// docs/management/api.md:3060-3062: never add the legacy counters together.
export function recordTokens(row: Json, canonical: boolean): TokenCounts {
  const breakdown = object(row.token_breakdown) ? row.token_breakdown : {};
  if (canonical && breakdown.quality === "complete" && object(breakdown.input) && object(breakdown.output)) {
    return {
      input: count(breakdown.input.uncached_tokens), cacheRead: count(breakdown.input.cache_read_tokens),
      cacheWrite: count(breakdown.input.cache_write_tokens), output: count(breakdown.output.total_tokens), total: count(breakdown.total_tokens),
    };
  }
  const tokens = object(row.tokens) ? row.tokens : {};
  const cacheRead = count(tokens.cache_read_tokens ?? tokens.cached_tokens);
  const cacheWrite = count(tokens.cache_creation_tokens);
  return { input: Math.max(0, count(tokens.input_tokens) - cacheRead - cacheWrite), cacheRead, cacheWrite,
    output: count(tokens.output_tokens), total: count(tokens.total_tokens) };
}
const rounded = <T extends UsageSlice>(value: T): T => ({ ...value, cost: Number(value.cost.toFixed(6)) });
function slices(buckets: readonly (Bucket & { day: string })[]) {
  let total = zero();
  const models = new Map<string, ModelUsage>();
  const days = new Map<string, DayUsage>();
  for (const bucket of buckets) {
    total = add(total, bucket);
    const id = JSON.stringify([bucket.provider, bucket.model]);
    const model = { provider: bucket.provider, model: bucket.model, ...add(models.get(id) ?? zero(), bucket) };
    models.set(id, model);
    const old = days.get(bucket.day);
    const dayModels = new Map((old?.models ?? []).map((item) => [JSON.stringify([item.provider, item.model]), item]));
    dayModels.set(id, { provider: bucket.provider, model: bucket.model, ...add(dayModels.get(id) ?? zero(), bucket) });
    days.set(bucket.day, { day: bucket.day, ...add(old ?? zero(), bucket), models: [...dayModels.values()] });
  }
  const sorted = (items: readonly ModelUsage[]) => [...items].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)).map(rounded);
  return { total: rounded(total), models: sorted([...models.values()]), days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((day) => ({ ...rounded(day), models: sorted(day.models) })) };
}

/** One instance for the singleton DO. Reads and alarms share its queue. */
export class UsageLedger {
  private storage: ChunkStorage;
  private home: Pick<HomeClient, "data" | "allMembership">;
  private options: Options;
  readonly queue = new UsageQueue();
  constructor(storage: UsageStorage, home: Pick<HomeClient, "data" | "allMembership">, options: Options = {}) {
    this.storage = new ChunkStorage(storage);
    this.home = home;
    this.options = options;
    if (options.maxPages !== undefined && (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 5)) throw new Error("Invalid usage page bound");
  }
  readAt(): Promise<string | null> {
    return this.queue.run(async () => (await this.storage.get<Cursor>(cursorKey))?.readAt ?? null);
  }
  sync(now = this.options.now?.() ?? new Date()): Promise<{ complete: boolean; pages: number }> {
    return this.queue.run(async () => {
      await this.storage.recover(pendingKey);
      const at = now.getTime();
      const cutoff = dayOf(at - 30 * dayMs);
      const state = await this.storage.getMany<unknown>([daysKey, cursorKey]);
      let days = state.get(daysKey) as string[] | undefined ?? [];
      let cursor = state.get(cursorKey) as Cursor | undefined;
      // Old cursors pruned dedupe ids after ten minutes. Rebuild that cache once,
      // atomically, rather than double count its buckets during reconciliation.
      const legacy = cursor && cursor.version !== 2 && cursor.version !== 3;
      const expired = days.filter((day) => legacy || day < cutoff);
      const receipts = await this.storage.getMany<Receipts>(expired.map(seenKey));
      const deletes = expired.flatMap((day) => [seenKey(day), ...(receipts.get(seenKey(day))?.pools ?? []).map((pool) => poolKey(pool, day))]);
      days = days.filter((day) => !expired.includes(day));
      cursor = legacy || !cursor ? { version: 3, pools: [...new Set([...receipts.values()].flatMap((value) => value.pools))], readAt: null } : cursor;
      if (expired.length || legacy) await this.storage.commit(new Map<string, unknown>([[daysKey, days], [cursorKey, cursor]]), deletes, pendingKey);
      const retained = days;
      let savedCursor = JSON.stringify(cursor);
      let savedDays = JSON.stringify(retained);
      // v2 receipts are durable, but its readAt also advanced on partial sweeps.
      if (cursor.version === 2) { cursor.version = 3; cursor.readAt = null; }
      if (cursor.scan && cursor.scan.to <= Date.parse(cutoff)) delete cursor.scan;
      if (cursor.recent && cursor.recent.to <= Date.parse(cutoff)) delete cursor.recent;
      // Node v8.0.40 runtime/executor/helps/usage_helpers.go:133,688 stamps request start.
      // Two hours bounds the fast read for long requests landing late; it cannot
      // guarantee catching every duration. Leftover pages sweep all retained days.
      cursor.recent ??= { from: Math.max(Date.parse(cutoff), (cursor.readAt ? Date.parse(cursor.readAt) : at) - lookback), to: at, offset: 0 };
      const membership = await this.home.allMembership();
      const groups = new Map(membership.groups.filter((group) => group.channel_name.startsWith(poolGroupPrefix))
        .map((group) => [group.id, group.channel_name.slice(poolGroupPrefix.length)]));
      const pools = new Map<string, string>();
      for (const member of membership.members) {
        const pool = groups.get(member.channel_group_id);
        if (pool === undefined) continue;
        if (pools.has(member.auth_id) && pools.get(member.auth_id) !== pool) return unavailable();
        pools.set(member.auth_id, pool);
      }
      const tags = new Map<string, string>();
      for (const pool of new Set([...groups.values(), ...cursor.pools])) {
        const tag = (await digest(pool)).slice(0, 16);
        if (tags.has(tag) && tags.get(tag) !== pool) return unavailable();
        tags.set(tag, pool);
      }
      // Home v1.1.6 management/usage_observability.go:28-48; api.md:3060.
      const capabilities = await this.home.data("/capabilities");
      const canonical = object(capabilities.capabilities) && capabilities.capabilities.usage_token_breakdown_v2 === true;
      let pages = 0;
      let sweepComplete = false;
      while ((cursor.recent || !sweepComplete) && pages < (this.options.maxPages ?? 5)) {
        const kind = cursor.recent ? "recent" : "scan";
        const scan = cursor[kind] ??= { from: Date.parse(cutoff), to: at, offset: 0 };
        // Home v1.1.6 management/usage_observability.go:129-135,575-597;
        // cluster/usage_observability.go:2927-2928 orders ties by id.
        const params = new URLSearchParams({ sort: "timestamp_asc", from: new Date(scan.from).toISOString(), to: new Date(scan.to).toISOString(), limit: "200", offset: String(scan.offset) });
        const page = await this.home.data(`/usage/records?${params}`);
        const items = rows(page.items);
        if (items.length > 200 || typeof page.total !== "number" || !Number.isSafeInteger(page.total) || page.total < 0
          || (!items.length && scan.offset < page.total)) return unavailable();
        pages++;
        const writes = new Map<string, unknown>();
        const before = new Map<string, string>();
        const prepared = await Promise.all(items.map(async (row) => {
          const id = text(row.id), timestamp = text(row.timestamp);
          const time = timestamp ? Date.parse(timestamp) : NaN;
          if (!id || !Number.isFinite(time) || time < scan.from || time >= scan.to) return unavailable();
          return { row, time, day: dayOf(time), hash: await digest(id) };
        }));
        const stored = await this.storage.getMany<unknown>([...new Set(prepared.map(({ day }) => seenKey(day)))]);
        const bucketKeys = new Set<string>();
        // Home v1.1.6 cluster/usage_observability.go:2408-2409,2430-2435:
        // charge user wins; without a charge the username follows the current key.
        const attributed = prepared.map((item) => {
          const { row, day, hash } = item;
          const credential = object(row.credential) ? text(row.credential.credential_id) : null;
          const user = parseBackendUserName(object(row.client) ? row.client.username : undefined);
          const pool = (credential ? pools.get(credential) : undefined) ?? (user ? tags.get(user.pool) : undefined);
          const seen = stored.get(seenKey(day)) as Receipts | undefined;
          if (pool !== undefined && day >= cutoff && !Object.hasOwn(seen?.ids ?? {}, hash)) bucketKeys.add(poolKey(pool, day));
          return { ...item, pool, user };
        });
        for (const [key, value] of await this.storage.getMany<unknown>([...bucketKeys])) stored.set(key, value);
        const load = <T>(key: string, fallback: T): T => {
          if (!writes.has(key)) {
            const value = stored.get(key) ?? fallback;
            before.set(key, JSON.stringify(value)); writes.set(key, value);
          }
          return writes.get(key) as T;
        };
        for (const { row, time, day, hash, pool, user } of attributed) {
          if (day < cutoff || pool === undefined) continue;
          const receipts = load<Receipts>(seenKey(day), { ids: {}, pools: [] });
          if (Object.hasOwn(receipts.ids, hash)) continue;
          receipts.ids[hash] = time;
          if (!retained.includes(day)) retained.push(day);
          if (!cursor.pools.includes(pool)) cursor.pools.push(pool);
          if (!receipts.pools.includes(pool)) receipts.pools.push(pool);
          const buckets: Bucket[] = load<Bucket[]>(poolKey(pool, day), []);
          const person = user?.person ?? "other";
          const model = text(row.model) ?? "", provider = text(row.provider) ?? "";
          const index = buckets.findIndex((bucket) => bucket.person === person && bucket.model === model && bucket.provider === provider);
          const amount = object(row.billing) ? row.billing.amount : null;
          // api.md:3103 calls this credits. The public contract currently calls it USD.
          // Home v1.1.6 cluster/billing.go:1452-1456; management/usage_observability.go:1644-1650.
          const priced = typeof amount === "number" && Number.isFinite(amount)
            && (!object(row.billing) || row.billing.matched_price_rule !== "default:zero");
          const value = { person, model, provider, ...add(buckets[index] ?? zero(), { requests: 1, tokens: recordTokens(row, canonical), cost: priced ? amount : 0, unpriced: priced ? 0 : 1 }) };
          if (index < 0) buckets.push(value); else buckets[index] = value;
        }
        scan.offset += items.length;
        const complete = scan.offset >= page.total;
        // An insertion before the saved offset is caught on the next full sweep.
        if (complete) {
          if (kind === "recent") cursor.readAt = new Date(scan.to).toISOString();
          else sweepComplete = true;
          delete cursor[kind];
        }
        for (const [key, value] of writes) if (JSON.stringify(value) === before.get(key)) writes.delete(key);
        const nextCursor = JSON.stringify(cursor), nextDays = JSON.stringify(retained.sort());
        if (nextCursor !== savedCursor) writes.set(cursorKey, cursor);
        if (nextDays !== savedDays) writes.set(daysKey, retained);
        await this.storage.commit(writes, [], pendingKey);
        savedCursor = nextCursor; savedDays = nextDays;
      }
      return { complete: !cursor.recent && sweepComplete, pages };
    });
  }
  summary(pool: string, options: SummaryOptions): Promise<UsageSummary> {
    return this.queue.run(async () => {
      await this.storage.recover(pendingKey);
      const { owner, caller, days, now, cap } = options;
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("Invalid usage days");
      const end = Date.parse(dayOf(now.getTime())) + dayMs;
      const start = end - days * dayMs;
      const person = await digest(caller);
      const buckets: (Bucket & { day: string })[] = [];
      const dayKeys = Array.from({ length: days }, (_, i) => dayOf(start + i * dayMs));
      const stored = await this.storage.getMany<unknown>([cursorKey, ...dayKeys.map((day) => poolKey(pool, day))]);
      for (const day of dayKeys) {
        for (const bucket of stored.get(poolKey(pool, day)) as Bucket[] | undefined ?? []) {
          if (caller === owner || bucket.person === person) buckets.push({ ...bucket, day });
        }
      }
      const result: UsageSummary = { scope: caller === owner ? "pool" : "you", from: new Date(start).toISOString(), to: new Date(end).toISOString(),
        ...slices(buckets), cap: cap(caller), readAt: (stored.get(cursorKey) as Cursor | undefined)?.readAt ?? null };
      if (caller !== owner) return result;
      const members = await Promise.all([...new Set(options.members)].map(async (member) => {
        const person = await digest(member);
        const own = slices(buckets.filter((bucket) => bucket.person === person));
        return { member, ...own.total, models: own.models, days: own.days, cap: cap(member) };
      }));
      return { ...result, members, accountsNeeded: await this.options.history?.advice(pool, now) ?? [] };
    });
  }
}
