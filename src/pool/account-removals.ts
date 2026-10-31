import type { PoolView } from "../../apps/pool/contract.ts";
import type { ControlStorage } from "./attribution.ts";

type History = NonNullable<PoolView["removals"]>;
const key = (pool: string) => `pool-account-removals:${pool}`;

/** Keep native removal intent so an owner need not explain the same deletion to a workflow. */
export class PoolAccountRemovals {
  private storage: ControlStorage;
  constructor(storage: ControlStorage) {
    this.storage = storage;
  }

  async read(pool: string): Promise<History> {
    return (await this.storage.get<History>(key(pool))) ?? { since: null, items: [] };
  }

  async record(pool: string, account: string, actor: string, at: Date): Promise<void> {
    const previous = await this.read(pool);
    const items = [
      ...previous.items.filter((item) => item.account !== account),
      {
        account,
        actor,
        at: at.toISOString(),
      },
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
    await this.storage.put(key(pool), { since, items });
  }
}
