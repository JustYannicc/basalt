import type { SlotStorage, TransactionStorage } from "../../src/pool/runtime-slots/storage.ts";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export class SlotMemory implements TransactionStorage {
  values = new Map<string, unknown>();
  queue: Promise<unknown> = Promise.resolve();
  afterCommit: (draft: Map<string, unknown>) => void = () => {};
  beforeCommit: (draft: Map<string, unknown>) => void = () => {};
  readsFailed = false;
  async get<T>(key: string) {
    if (this.readsFailed) throw new Error("storage read unavailable");
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    return this.transaction(async (transaction) => {
      await transaction.put(key, value);
    });
  }
  transaction<T>(work: (transaction: SlotStorage) => Promise<T>) {
    const result = this.queue.then(async () => {
      const draft = structuredClone(this.values);
      const result = await work({
        get: async <T>(key: string) => structuredClone(draft.get(key)) as T | undefined,
        put: async (key, value) => {
          draft.set(key, structuredClone(value));
        },
      });
      this.beforeCommit(draft);
      this.values = draft;
      this.afterCommit(draft);
      return result;
    });
    this.queue = result.catch(() => {});
    return result;
  }
}
