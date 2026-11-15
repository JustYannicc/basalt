import { Schema } from "effect";
import type { TransactionStorage } from "./runtime-slots/storage.ts";

const Time = Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
const Deadlines = Schema.Struct({ home: Time, fleet: Time });
const key = "pool-alarm-v1:deadlines";
interface Storage extends TransactionStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
}

/** Fleet drain deadlines share the one DO alarm without running Home collection at fleet cadence. */
export class PoolAlarms {
  private storage: Storage;
  private now: () => number;
  constructor(storage: Storage, now = Date.now) {
    this.storage = storage;
    this.now = now;
  }
  async schedule(owner: "home" | "fleet", at: number) {
    if (!Number.isSafeInteger(at) || at < 0) throw new Error("Invalid pool alarm deadline");
    const existing = await this.storage.getAlarm();
    await this.storage.transaction(async (transaction) => {
      const raw = await transaction.get(key);
      const value =
        raw === undefined
          ? { home: existing, fleet: null }
          : Schema.decodeUnknownSync(Deadlines)(raw);
      const previous = value[owner];
      await transaction.put(key, {
        ...value,
        [owner]: previous === null ? at : Math.min(at, previous),
      });
    });
    await this.rearm();
  }
  async take() {
    return this.storage.transaction(async (transaction) => {
      const raw = await transaction.get(key);
      const value =
        raw === undefined
          ? { home: this.now(), fleet: null }
          : Schema.decodeUnknownSync(Deadlines)(raw);
      const due = {
        home: value.home !== null && value.home <= this.now(),
        fleet: value.fleet !== null && value.fleet <= this.now(),
      };
      await transaction.put(key, {
        home: due.home ? null : value.home,
        fleet: due.fleet ? null : value.fleet,
      });
      return due;
    });
  }
  async inspect() {
    const raw = await this.storage.get(key);
    const value =
      raw === undefined ? { home: null, fleet: null } : Schema.decodeUnknownSync(Deadlines)(raw);
    return {
      homeDeadline: value.home,
      fleetDeadline: value.fleet,
      nativeDeadline: await this.storage.getAlarm(),
    };
  }
  async rearm() {
    const raw = await this.storage.get(key);
    if (raw === undefined) return;
    const value = Schema.decodeUnknownSync(Deadlines)(raw);
    const next = [value.home, value.fleet].filter((at) => at !== null).sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const previous = await this.storage.getAlarm();
    if (previous === null || previous > next) await this.storage.setAlarm(next);
  }
}
