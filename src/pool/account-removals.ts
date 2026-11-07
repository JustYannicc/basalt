import { poolDependency } from "./dependency-failure.ts";
import type { PoolView } from "../../apps/pool/contract.ts";
import type { ControlStorage } from "./attribution.ts";

type History = NonNullable<PoolView["removals"]>;
type Saved = History & { operations?: string[] };
const key = (pool: string) => `pool-account-removals:${pool}`;

/** Keep native removal intent so an owner need not explain the same deletion to a workflow. */
export class PoolAccountRemovals {
  private storage: Pick<ControlStorage, "get" | "put">;
  constructor(storage: Pick<ControlStorage, "get" | "put">) {
    this.storage = storage;
  }

  async read(pool: string): Promise<History> {
    const saved = await poolDependency("storage", this.storage.get<Saved>(key(pool)));
    return saved ? { since: saved.since, items: saved.items } : { since: null, items: [] };
  }

  async record(pool: string, account: string, actor: string, at: Date): Promise<void> {
    await this.recordMany(pool, [account], actor, at);
  }

  async recordMany(
    pool: string,
    accounts: readonly string[],
    actor: string,
    at: Date,
    operation?: string,
    issuedAt?: number,
  ): Promise<boolean> {
    const previous = (await poolDependency("storage", this.storage.get<Saved>(key(pool)))) ?? {
      since: null,
      items: [],
    };
    if (operation !== undefined && previous.operations?.includes(operation)) return false;
    // An evicted operation cannot refresh a receipt or cross the history's truncation watermark.
    if (issuedAt !== undefined) {
      if (previous.since !== null && issuedAt <= Date.parse(previous.since)) return false;
      accounts = accounts.filter(
        (account) =>
          !previous.items.some(
            (item) => item.account === account && Date.parse(item.at) >= issuedAt,
          ),
      );
      if (!accounts.length) return false;
    }
    const items = [
      ...previous.items.filter((item) => !accounts.includes(item.account)),
      ...accounts.map((account) => ({ account, actor, at: at.toISOString() })),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const removed = items.splice(0, Math.max(0, items.length - 100));
    const since = removed.length
      ? new Date(
          Math.max(
            Date.parse(previous.since ?? "") || 0,
            Date.parse(removed[removed.length - 1]!.at),
          ),
        ).toISOString()
      : previous.since;
    const operations =
      operation === undefined
        ? (previous.operations ?? [])
        : [...(previous.operations ?? []), operation].slice(-100);
    await poolDependency("storage", this.storage.put(key(pool), { since, items, operations }));
    return true;
  }
}
