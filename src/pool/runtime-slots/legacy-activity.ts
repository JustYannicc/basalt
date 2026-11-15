import { Schema } from "effect";
import type { TransactionStorage } from "./storage.ts";

const key = "runtime-legacy-activity-v1";
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/** Pre-adoption requests count before warming or dispatch, including after reconstruction. */
export class LegacyActivity {
  private storage: TransactionStorage;
  constructor(storage: TransactionStorage) {
    this.storage = storage;
  }
  async acquire() {
    await this.storage.transaction(async (transaction) => {
      const count = Schema.decodeUnknownSync(Count)((await transaction.get(key)) ?? 0);
      if (!Number.isSafeInteger(count + 1)) throw new Error("Legacy activity overflow");
      await transaction.put(key, count + 1);
    });
    let released: Promise<void> | undefined;
    return () =>
      (released ??= this.storage.transaction(async (transaction) => {
        const count = Schema.decodeUnknownSync(Count)(await transaction.get(key));
        if (count < 1) throw new Error("Legacy activity underflow");
        await transaction.put(key, count - 1);
      }));
  }
  async active() {
    return this.storage.transaction(async (transaction) =>
      Schema.decodeUnknownSync(Count)((await transaction.get(key)) ?? 0),
    );
  }
}
