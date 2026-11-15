interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string | string[]): Promise<void>;
}

/** Native batch overloads and transactions keep the existing fixture Map observable. */
export class RuntimeMap implements Transaction {
  private values: Map<string, unknown>;
  private queue: Promise<unknown> = Promise.resolve();
  private onRead?: (key: string) => void;
  constructor(values: Map<string, unknown>, onRead?: (key: string) => void) {
    this.values = values;
    this.onRead = onRead;
  }
  private read(values: Map<string, unknown>, input: string | string[]) {
    const one = (key: string) => {
      this.onRead?.(key);
      return structuredClone(values.get(key));
    };
    if (typeof input === "string") return one(input);
    return new Map(
      input.flatMap((key) => {
        const value = one(key);
        return value === undefined ? [] : [[key, value] as const];
      }),
    );
  }
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  async get(input: string | string[]) {
    await this.queue;
    return this.read(this.values, input);
  }
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  async put(input: string | Record<string, unknown>, value?: unknown) {
    await this.transaction(async (transaction) => {
      if (typeof input === "string") await transaction.put(input, value);
      else await transaction.put(input);
    });
  }
  async delete(input: string | string[]) {
    await this.transaction((transaction) => transaction.delete(input));
  }
  transaction<T>(work: (transaction: Transaction) => Promise<T>) {
    const pending = this.queue.then(async () => {
      const draft = structuredClone(this.values);
      const changed = new Set<string>();
      const read = this.read.bind(this, draft);
      function get<T>(key: string): Promise<T | undefined>;
      function get<T>(keys: string[]): Promise<Map<string, T>>;
      async function get(input: string | string[]) {
        return read(input);
      }
      function put(key: string, value: unknown): Promise<void>;
      function put(entries: Record<string, unknown>): Promise<void>;
      async function put(input: string | Record<string, unknown>, value?: unknown) {
        const entries =
          typeof input === "string" ? [[input, value] as const] : Object.entries(input);
        for (const [key, entry] of entries) {
          changed.add(key);
          draft.set(key, structuredClone(entry));
        }
      }
      const remove = async (input: string | string[]) => {
        for (const key of typeof input === "string" ? [input] : input) {
          changed.add(key);
          draft.delete(key);
        }
      };
      const result = await work({ get, put, delete: remove });
      for (const key of changed) {
        if (draft.has(key)) this.values.set(key, draft.get(key));
        else this.values.delete(key);
      }
      return result;
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
}
