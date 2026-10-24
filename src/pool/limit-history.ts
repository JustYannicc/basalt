import type { Account, AccountsAdvice, AccountsNeeded } from "../../apps/pool/contract.ts";
import { digest } from "./backend-users.ts";
import { ChunkStorage, UsageQueue, type UsageStorage } from "./usage-storage.ts";
export { ChunkStorage, UsageQueue, type UsageStorage } from "./usage-storage.ts";

type ReadingAccount = Pick<Account, "id" | "provider" | "state" | "windows">;
interface Sample { at: number; accounts: number; limited: number; hits: number; spare: boolean }
// Twelve five-minute slots per hour. Masks retain exact rolling-window edges and gaps.
type Hour = [at: number, readings: number, exhausted: number, removable: number, hits: [number, number][], accounts: [number, number][]];
interface ProviderHistory { hours: Hour[]; previous: Record<string, boolean>; lastAt: number }
interface LegacyProvider { samples: Sample[]; previous: Record<string, boolean>; lastAt: number }
interface PoolHistory { providers: Record<string, ProviderHistory | LegacyProvider> }
const step = 5 * 60_000;
const hourMs = 3_600_000;
const week = 7 * 24 * hourMs;
const key = (pool: string) => `limit-v1:${pool}`;
const bits = (mask: number): number => { let count = 0; for (; mask; mask &= mask - 1) count++; return count; };
function append(hours: Hour[], sample: Sample): void {
  const at = Math.floor(sample.at / hourMs) * hourMs;
  let hour = hours.at(-1);
  if (!hour || hour[0] !== at) { hour = [at, 0, 0, 0, [], []]; hours.push(hour); }
  const slot = (sample.at - at) / step, bit = 1 << slot;
  hour[1] |= bit;
  if (sample.accounts > 0 && sample.limited === sample.accounts) hour[2] |= bit;
  if (sample.limited === 0 && sample.spare) hour[3] |= bit;
  if (sample.hits) hour[4].push([slot, sample.hits]);
  if (hour[5].at(-1)?.[1] !== sample.accounts) hour[5].push([slot, sample.accounts]);
}
function compact(value: ProviderHistory | LegacyProvider): ProviderHistory {
  if ("hours" in value) return value;
  const hours: Hour[] = [];
  for (const sample of value.samples) append(hours, sample);
  return { hours, previous: value.previous, lastAt: value.lastAt };
}

export class LimitHistory {
  private storage: ChunkStorage;
  private now: () => Date;
  readonly queue = new UsageQueue();
  constructor(storage: UsageStorage, now: () => Date = () => new Date()) {
    this.storage = new ChunkStorage(storage);
    this.now = now;
  }
  sample(pool: string, accounts: readonly ReadingAccount[], now = this.now()): Promise<void> {
    return this.queue.run(async () => {
      const at = Math.floor(now.getTime() / step) * step;
      await this.storage.recover(`${key(pool)}:pending`);
      const history = await this.storage.get<PoolHistory>(key(pool)) ?? { providers: {} };
      const groups = new Map<string, ReadingAccount[]>();
      for (const account of accounts) groups.set(account.provider, [...(groups.get(account.provider) ?? []), account]);
      for (const name of Object.keys(history.providers)) {
        const provider: string = JSON.parse(name);
        if (!groups.has(provider)) groups.set(provider, []);
      }
      let changed = false;
      for (const [provider, rows] of groups) {
        const name = JSON.stringify(provider);
        const old = compact(history.providers[name] ?? { hours: [], previous: {}, lastAt: -Infinity });
        if (at <= old.lastAt) continue;
        const previous: Record<string, boolean> = {};
        let limited = 0, hits = 0, known = true;
        const capacity = new Map<number, { remaining: number; accounts: number }>();
        for (const account of rows) {
          const id = await digest(account.id);
          // Home v1.1.6 cliproxy/auth/manager.go:1849-1895 also marks refresh failures unavailable.
          const hit = account.windows.some((window) => window.remainingRatio !== null && window.remainingRatio <= 0.01);
          previous[id] = hit;
          if (hit) { limited++; if (!old.previous[id]) hits++; }
          if (account.state !== "active" || !account.windows.length) known = false;
          const windows = new Set<number>();
          for (const window of account.windows) {
            const { windowSeconds: seconds, remainingRatio: ratio } = window;
            if (seconds === null || ratio === null || windows.has(seconds)) { known = false; continue; }
            windows.add(seconds);
            const value = capacity.get(seconds) ?? { remaining: 0, accounts: 0 };
            value.remaining += ratio; value.accounts++;
            capacity.set(seconds, value);
          }
        }
        const hours = old.hours.filter((hour) => hour[0] + hourMs > at - week);
        const first = hours[0];
        if (first) {
          const expired = Math.max(0, Math.ceil((at - week - first[0]) / step));
          const mask = 4095 & ~((1 << expired) - 1);
          first[1] &= mask; first[2] &= mask; first[3] &= mask;
          first[4] = first[4].filter(([slot]) => (mask & (1 << slot)) !== 0);
        }
        append(hours, { at, accounts: rows.length, limited, hits, spare: known && rows.length >= 2 && capacity.size > 0
          && [...capacity.values()].every((window) => window.accounts === rows.length && window.remaining >= 1) });
        history.providers[name] = { hours, previous, lastAt: at };
        changed = true;
      }
      if (changed) await this.storage.commit(new Map([[key(pool), history]]), [], `${key(pool)}:pending`);
    });
  }
  advice(pool: string, now = this.now()): Promise<AccountsNeeded[]> {
    return this.queue.run(async () => {
      await this.storage.recover(`${key(pool)}:pending`);
      const history = await this.storage.get<PoolHistory>(key(pool));
      return Object.entries(history?.providers ?? {}).sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, value]) => {
        const provider: string = JSON.parse(name);
        let readings = 0, limitHits = 0, exhaustedCount = 0, removable = true, accounts = 0;
        for (const hour of compact(value).hours) {
          let mask = 0;
          for (let slot = 0; slot < 12; slot++) {
            const at = hour[0] + slot * step;
            if (at >= now.getTime() - week && at <= now.getTime()) mask |= (1 << slot) & hour[1];
          }
          if (!mask) continue;
          readings += bits(mask);
          exhaustedCount += bits(mask & hour[2]);
          removable &&= (mask & hour[3]) === mask;
          limitHits += hour[4].reduce((sum, [slot, hits]) => sum + ((mask & (1 << slot)) ? hits : 0), 0);
          const last = 31 - Math.clz32(mask);
          accounts = hour[5].filter(([slot]) => slot <= last).at(-1)![1];
        }
        if (!readings) return [];
        const exhausted = exhaustedCount / readings;
        // Count actual readings. A day-long outage isn't a day of evidence.
        const hoursRead = Math.min(168, (readings - 1) * step / hourMs);
        const advice: AccountsAdvice = hoursRead < 24 ? "unknown" : exhausted > 0 ? "add"
          : limitHits === 0 && removable ? "remove" : "enough";
        return [{ provider, advice, accounts, limitHits, exhausted, hoursRead }];
      });
    });
  }
}
