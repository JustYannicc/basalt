import type { Account } from "../../apps/pool/contract.ts";
import { ChunkStorage, type UsageStorage } from "./usage-storage.ts";

export interface HomeViewData {
  usageCreditPolicy?: import("../../apps/pool/usage-credits-contract.ts").UsageCreditPolicy;
  accounts: Account[];
  readAt: { membership: string; credentials?: string; quota?: string };
}
type Storage = Pick<UsageStorage, "get" | "put"> & Partial<Omit<UsageStorage, "get" | "put">>;
interface Revision {
  all: number;
  pools: Record<string, number>;
}
interface Saved {
  revision: string;
  data: HomeViewData;
}
const revisionsKey = "pool-view-revisions-v1";
const snapshotKey = (pool: string) => `pool-view-snapshot-v1:${pool}`;

/** Only complete public account data is retained. Caller authority stays outside this cache. */
export class PoolViewSnapshots {
  private queue: Promise<unknown> = Promise.resolve();
  private revalidations = new Map<string, Promise<HomeViewData>>();
  private storage: ChunkStorage;
  private defer: (work: Promise<void>) => void;
  constructor(storage: Storage, defer: (work: Promise<void>) => void) {
    this.storage = new ChunkStorage({
      get: storage.get.bind(storage),
      put: storage.put.bind(storage),
      delete: (key) => (storage.delete ? storage.delete(key) : storage.put(key, null)),
      ...(storage.transaction ? { transaction: storage.transaction.bind(storage) } : {}),
    });
    this.defer = defer;
  }

  private run<A>(work: () => Promise<A>): Promise<A> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  private async revision(pool: string): Promise<string> {
    const value = await this.storage.get<Revision>(revisionsKey);
    return `${value?.all ?? 0}:${value?.pools[pool] ?? 0}`;
  }
  private saved(pool: string): Promise<Saved | undefined> {
    return this.run(async () => {
      const saved = await this.storage.get<Saved>(snapshotKey(pool));
      return saved &&
        Array.isArray(saved.data.accounts) &&
        saved.revision === (await this.revision(pool))
        ? saved
        : undefined;
    });
  }
  async invalidate(pool?: string): Promise<void> {
    await this.run(async () => {
      const revision = (await this.storage.get<Revision>(revisionsKey)) ?? { all: 0, pools: {} };
      if (pool === undefined) revision.all++;
      else revision.pools[pool] = (revision.pools[pool] ?? 0) + 1;
      await this.storage.put(revisionsKey, revision);
    });
  }
  private revalidate(pool: string, read: () => Promise<HomeViewData>): Promise<HomeViewData> {
    const previous = this.revalidations.get(pool);
    if (previous) return previous;
    const work = (async () => {
      for (;;) {
        const revision = await this.run(() => this.revision(pool));
        const data = await read();
        const committed = await this.run(async () => {
          if (revision !== (await this.revision(pool))) return false;
          await this.storage.put(snapshotKey(pool), { revision, data } satisfies Saved);
          return true;
        });
        // A membership or account change during the read cannot republish the old view.
        if (committed) return data;
      }
    })().finally(() => {
      if (this.revalidations.get(pool) === work) this.revalidations.delete(pool);
    });
    this.revalidations.set(pool, work);
    this.defer(
      work.then(
        () => {},
        () => {},
      ),
    );
    return work;
  }
  async view(pool: string, fresh: boolean, read: () => Promise<HomeViewData>) {
    const saved = fresh ? undefined : await this.saved(pool);
    if (saved && !fresh) {
      this.revalidate(pool, read);
      return { data: saved.data, source: "snapshot" as const, revalidationFailed: false };
    }
    try {
      const data = await this.revalidate(pool, read);
      return { data, source: "live" as const, revalidationFailed: false };
    } catch (error) {
      const retained = await this.saved(pool);
      if (!retained) throw error;
      return { data: retained.data, source: "snapshot" as const, revalidationFailed: true };
    }
  }
}
