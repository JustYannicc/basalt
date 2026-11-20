import { Schema } from "effect";
import type { TransactionStorage } from "./runtime-slots/storage.ts";

const Time = Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
const Deadlines = Schema.Struct({ home: Time, fleet: Time });
const key = "pool-alarm-v1:deadlines";
// An isolate checks for a missing alarm at most this often, so the check costs a request nothing.
const ensureSpacingMs = 5_000;
interface Storage extends TransactionStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
}

/** Fleet drain deadlines share the one DO alarm without running Home collection at fleet cadence. */
export class PoolAlarms {
  private storage: Storage;
  private now: () => number;
  private ensuredAt = -Infinity;
  constructor(storage: Storage, now = Date.now) {
    this.storage = storage;
    this.now = now;
  }
  /**
   * With no alarm set, both owners run now. Each owner re-arms its own deadline, but nothing does
   * once a handler failed past the platform's retries or no owner ever armed one, and then
   * recovery and membership upkeep never run again: a code upload alone runs nothing. Returns
   * nothing, and starts no work, when this isolate already checked within the spacing.
   */
  ensure(): Promise<void> | undefined {
    const now = this.now();
    if (now - this.ensuredAt < ensureSpacingMs) return undefined;
    this.ensuredAt = now;
    return this.armMissing(now);
  }
  private async armMissing(now: number) {
    if ((await this.storage.getAlarm()) !== null) return;
    // One write for both owners: a `take()` between two writes would see only one of them due.
    await this.storage.transaction(async (transaction) => {
      const raw = await transaction.get(key);
      const value =
        raw === undefined ? { home: null, fleet: null } : Schema.decodeUnknownSync(Deadlines)(raw);
      await transaction.put(key, {
        home: value.home === null ? now : Math.min(now, value.home),
        fleet: value.fleet === null ? now : Math.min(now, value.fleet),
      });
    });
    await this.rearm();
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
