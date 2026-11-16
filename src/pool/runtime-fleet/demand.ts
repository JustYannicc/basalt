import { Schema } from "effect";
import type { TransactionStorage } from "../runtime-slots/storage.ts";
const key = "runtime-fleet-v1:last-demand";
const Timestamp = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/** Recent demand survives controller reconstruction without turning idle alarms into traffic. */
export class FleetDemand {
  private storage: TransactionStorage;
  constructor(storage: TransactionStorage) {
    this.storage = storage;
  }
  async touch(at: number) {
    await this.storage.transaction(async (transaction) => {
      const previous = Schema.decodeUnknownSync(Timestamp)((await transaction.get(key)) ?? 0);
      await transaction.put(key, Math.max(previous, Schema.decodeUnknownSync(Timestamp)(at)));
    });
  }
  async until() {
    const at = Schema.decodeUnknownSync(Timestamp)((await this.storage.get(key)) ?? 0);
    return at ? at + 60_000 : 0;
  }
}
