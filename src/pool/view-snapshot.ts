import type { Membership } from "./control.ts";
import type { Json } from "./json.ts";
import { ChunkStorage, type UsageStorage } from "./usage-storage.ts";

export interface HomeViewData {
  membership: Membership;
  credentials: Json[];
  quota: Json[];
  readAt: { membership: string; credentials: string; quota: string };
}
type Storage = Pick<UsageStorage, "get" | "put"> & Partial<Omit<UsageStorage, "get" | "put">>;
interface Revision { all: number; pools: Record<string, number> }
interface Saved { revision: string; data: HomeViewData }
interface Revalidation { work: Promise<HomeViewData>; running: boolean; consumed: boolean }
const revisionsKey = "pool-view-revisions-v1";
const snapshotKey = (pool: string) => `pool-view-snapshot-v1:${pool}`;

/** Only complete internal results are retained. Caller authority and shaping stay outside this cache. */
export class PoolViewSnapshots {
  private queue: Promise<unknown> = Promise.resolve();
  private revalidations = new Map<string, Revalidation>();
  private storage: ChunkStorage;
  private defer: (work: Promise<void>) => void;
  constructor(storage: Storage, defer: (work: Promise<void>) => void) {
    this.storage = new ChunkStorage({
      get: storage.get.bind(storage), put: storage.put.bind(storage),
      delete: (key) => storage.delete ? storage.delete(key) : storage.put(key, null),
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
      return saved?.revision === await this.revision(pool) ? saved : undefined;
    });
  }
  async invalidate(pool?: string): Promise<void> {
    await this.run(async () => {
      const revision = await this.storage.get<Revision>(revisionsKey) ?? { all: 0, pools: {} };
      if (pool === undefined) revision.all++;
      else revision.pools[pool] = (revision.pools[pool] ?? 0) + 1;
      await this.storage.put(revisionsKey, revision);
      for (const [id, entry] of this.revalidations)
        if (!entry.running && (pool === undefined || pool === id)) this.revalidations.delete(id);
    });
  }
  private revalidate(pool: string, read: () => Promise<HomeViewData>, consume: boolean): Revalidation {
    const previous = this.revalidations.get(pool);
    if (previous && (previous.running || consume && !previous.consumed)) {
      previous.consumed ||= consume;
      return previous;
    }
    const entry: Revalidation = { work: undefined!, running: true, consumed: consume };
    entry.work = (async () => {
      for (;;) {
        const revision = await this.run(() => this.revision(pool));
        const data = await read();
        const committed = await this.run(async () => {
          if (revision !== await this.revision(pool)) return false;
          await this.storage.put(snapshotKey(pool), { revision, data } satisfies Saved);
          return true;
        });
        // A membership or account change during the read cannot republish the old view.
        if (committed) return data;
      }
    })().finally(() => {
      entry.running = false;
      if (entry.consumed && this.revalidations.get(pool) === entry) this.revalidations.delete(pool);
    });
    this.revalidations.set(pool, entry);
    this.defer(entry.work.then(() => {}, () => {}));
    return entry;
  }
  async view(pool: string, fresh: boolean, read: () => Promise<HomeViewData>) {
    const saved = fresh ? undefined : await this.saved(pool);
    if (saved && !fresh) {
      this.revalidate(pool, read, false);
      return { data: saved.data, source: "snapshot" as const, revalidationFailed: false };
    }
    try {
      const data = await this.revalidate(pool, read, true).work;
      return { data, source: "live" as const, revalidationFailed: false };
    } catch (error) {
      const retained = await this.saved(pool);
      if (!retained) throw error;
      return { data: retained.data, source: "snapshot" as const, revalidationFailed: true };
    }
  }
}
