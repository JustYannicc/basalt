/** Cloudflare storage overloads for fixtures that run the real pool Worker in Node. */
export class MemoryNativeTransaction {
  readonly values: Map<string, unknown>;
  constructor(values = new Map<string, unknown>()) {
    this.values = values;
  }
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key))
      return new Map(
        key
          .filter((key) => this.values.has(key))
          .map((key) => [key, structuredClone(this.values.get(key)) as T]),
      );
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  async put<T>(key: string | Record<string, T>, value?: T) {
    for (const [name, saved] of typeof key === "string"
      ? ([[key, value]] as const)
      : Object.entries(key))
      this.values.set(name, structuredClone(saved));
  }
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  async delete(key: string | string[]) {
    return typeof key === "string"
      ? this.values.delete(key)
      : key.filter((key) => this.values.delete(key)).length;
  }
}
export class MemoryNativeStorage extends MemoryNativeTransaction {
  async transaction<T>(work: (tx: MemoryNativeTransaction) => Promise<T>) {
    const candidate = new MemoryNativeTransaction(structuredClone(this.values));
    const result = await work(candidate);
    this.values.clear();
    for (const [key, value] of candidate.values) this.values.set(key, value);
    return result;
  }
}
