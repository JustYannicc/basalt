export interface UsageStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  getMany?<T>(keys: string[]): Promise<Map<string, T>>;
  // Optional putMany must publish the entire batch atomically.
  putMany?(entries: Record<string, unknown>): Promise<unknown>;
  deleteMany?(keys: string[]): Promise<unknown>;
  transaction?<T>(work: (storage: UsageStorage) => Promise<T>): Promise<T>;
}
interface Parts { count: number; generation: number }
interface Inline { value: unknown }
interface Commit { writes: [string, unknown][]; deletes: string[] }
type Stored = Parts | Inline;
const partKey = (key: string, parts: Parts, i: number) => `${key}:${parts.generation}:${i}`;

// Native DO overloads are detected through transaction(); simple test stores need only single-key IO.
export class ChunkStorage {
  private storage: UsageStorage;
  private batched: boolean;
  constructor(storage: UsageStorage, batched = !!storage.transaction) { this.storage = storage; this.batched = batched; }
  private async read<T>(keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (let i = 0; i < keys.length; i += 128) {
      const batch = keys.slice(i, i + 128);
      const values = this.storage.getMany ? await this.storage.getMany<T>(batch)
        : this.batched ? await (this.storage.get as unknown as (keys: string[]) => Promise<Map<string, T>>).call(this.storage, batch)
        : new Map(await Promise.all(batch.map(async (key) => [key, await this.storage.get<T>(key)] as const)));
      for (const [key, value] of values) if (value !== undefined) result.set(key, value);
    }
    return result;
  }
  async getMany<T>(keys: string[]): Promise<Map<string, T>> {
    const stored = await this.read<Stored>(keys);
    const chunkKeys = [...stored].flatMap(([key, value]) => "value" in value ? []
      : Array.from({ length: value.count }, (_, i) => partKey(key, value, i)));
    const chunks = await this.read<string>(chunkKeys);
    const result = new Map<string, T>();
    for (const [key, value] of stored) {
      if ("value" in value) { result.set(key, value.value as T); continue; }
      const parts = Array.from({ length: value.count }, (_, i) => {
        const chunk = chunks.get(partKey(key, value, i));
        if (chunk === undefined) throw new Error("Missing stored usage chunk");
        return chunk;
      });
      result.set(key, JSON.parse(parts.join("")) as T);
    }
    return result;
  }
  async get<T>(key: string): Promise<T | undefined> { return (await this.getMany<T>([key])).get(key); }
  private async write(entries: Map<string, unknown>): Promise<void> {
    const pairs = [...entries];
    for (let i = 0; i < pairs.length; i += 128) {
      const batch = pairs.slice(i, i + 128);
      if (this.storage.putMany) await this.storage.putMany(Object.fromEntries(batch));
      else if (this.batched) await (this.storage.put as unknown as (entries: Record<string, unknown>) => Promise<unknown>).call(this.storage, Object.fromEntries(batch));
      else for (const [key, value] of batch) await this.storage.put(key, value);
    }
  }
  private async remove(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 128) {
      const batch = keys.slice(i, i + 128);
      if (this.storage.deleteMany) await this.storage.deleteMany(batch);
      else if (this.batched) await (this.storage.delete as unknown as (keys: string[]) => Promise<unknown>).call(this.storage, batch);
      else for (const key of batch) await this.storage.delete(key);
    }
  }
  private async plan(writes: Map<string, unknown>, deletes: string[]) {
    const old = await this.read<Stored>([...writes.keys(), ...deletes]);
    const entries = new Map<string, unknown>();
    const obsolete = [...deletes];
    for (const [key, value] of writes) {
      const previous = old.get(key);
      const json = JSON.stringify(value);
      if (json.length <= 16_000) entries.set(key, { value } satisfies Inline);
      else {
        const parts: Parts = { count: Math.ceil(json.length / 16_000), generation: previous && "generation" in previous && previous.generation === 0 ? 1 : 0 };
        for (let i = 0; i < parts.count; i++) entries.set(partKey(key, parts, i), json.slice(i * 16_000, (i + 1) * 16_000));
        entries.set(key, parts);
      }
    }
    for (const [key, value] of old) if (!("value" in value)) {
      for (let i = 0; i < value.count; i++) obsolete.push(partKey(key, value, i));
    }
    return { entries, obsolete };
  }
  private async apply(writes: Map<string, unknown>, deletes: string[]): Promise<void> {
    const { entries, obsolete } = await this.plan(writes, deletes);
    await this.write(entries);
    await this.remove(obsolete);
  }
  async put(key: string, value: unknown): Promise<void> { await this.apply(new Map([[key, value]]), []); }
  async delete(key: string): Promise<void> { await this.apply(new Map(), [key]); }
  async recover(journal: string): Promise<void> {
    const pending = await this.get<Commit>(journal);
    if (!pending) return;
    await this.apply(new Map(pending.writes), pending.deletes);
    await this.delete(journal);
  }
  async commit(writes: Map<string, unknown>, deletes: string[], journal: string): Promise<void> {
    if (!writes.size && !deletes.length) return;
    if (this.storage.transaction) {
      await this.storage.transaction((tx) => new ChunkStorage(tx, true).apply(writes, deletes));
      return;
    }
    const plan = this.storage.putMany && !deletes.length ? await this.plan(writes, deletes) : undefined;
    if (plan && plan.entries.size <= 128) {
      await this.write(plan.entries); // One atomic batch publishes chunks, buckets, receipts and cursor together.
      await this.remove(plan.obsolete);
      return;
    }
    // Minimal stores and oversized batches replay absolute replacements after a crash.
    await this.put(journal, { writes: [...writes], deletes } satisfies Commit);
    await this.recover(journal);
  }
}

export class UsageQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
}
