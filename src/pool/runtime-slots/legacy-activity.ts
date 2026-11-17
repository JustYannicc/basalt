import { Schema } from "effect";
import type { SlotStorage, TransactionStorage } from "./storage.ts";

// v1 held a bare count that dead isolates left behind. It is ignored, not rewritten, so code
// rolled back to the v1 reader still decodes its own key.
const key = "runtime-legacy-activity-v2";
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Stored = Schema.Struct({ isolate: Schema.String, count: Count });

// Requests die with the isolate that holds them, so a count left by another isolate is not live.
// /proc established connections stay the drain's proof of real traffic (legacy-drain.ts).
// Workers refuse random generation at global scope, so mint it on first use.
let currentIsolate: string | undefined;

/** Pre-adoption requests count before warming or dispatch, including after reconstruction in this isolate. */
export class LegacyActivity {
  private storage: TransactionStorage;
  private scope?: string;
  constructor(storage: TransactionStorage, isolate?: string) {
    this.storage = storage;
    this.scope = isolate;
  }
  private get isolate() {
    return (this.scope ??= currentIsolate ??= crypto.randomUUID());
  }
  private async read(transaction: SlotStorage) {
    const stored = await transaction.get(key);
    if (stored === undefined) return 0;
    const { isolate, count } = Schema.decodeUnknownSync(Stored)(stored);
    return isolate === this.isolate ? count : 0;
  }
  async acquire() {
    await this.storage.transaction(async (transaction) => {
      const count = await this.read(transaction);
      if (!Number.isSafeInteger(count + 1)) throw new Error("Legacy activity overflow");
      await transaction.put(key, { isolate: this.isolate, count: count + 1 });
    });
    let released: Promise<void> | undefined;
    return () =>
      (released ??= this.storage.transaction(async (transaction) => {
        const count = await this.read(transaction);
        if (count < 1) throw new Error("Legacy activity underflow");
        await transaction.put(key, { isolate: this.isolate, count: count - 1 });
      }));
  }
  async active() {
    return this.storage.transaction((transaction) => this.read(transaction));
  }
}
