import { Schema } from "effect";
import { SlotIdentity, SlotTarget, sameIdentity, sameTarget } from "../runtime-slots/contract.ts";
import type { SlotStorage, TransactionStorage } from "../runtime-slots/storage.ts";

const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Row = Schema.Struct({
  target: SlotTarget,
  identity: Schema.optional(SlotIdentity),
  phase: Schema.Literals([
    "reserved",
    "warming",
    "ready",
    "draining",
    "retiring",
    "uncertain",
    "retired",
  ]),
  active: Count,
  drainAcknowledged: Schema.optional(Schema.Boolean),
  lastUsedAt: Count,
});
type Row = typeof Row.Type;
const Ledger = Schema.Array(Row);
const key = "runtime-fleet-v1:resources";
const primaryKey = "runtime-fleet-v1:primary-active";
const retiredKey = (slot: string) => `runtime-fleet-v1:retired:${slot}`;
interface RuntimeReservation {
  kind: "runtime";
  identity: SlotIdentity;
  release(): Promise<void>;
}
interface PrimaryReservation {
  kind: "primary";
  release(): Promise<void>;
}
export class FleetRefused extends Error {
  readonly reason: "capacity" | "identity" | "uncertain" | "draining";
  constructor(reason: FleetRefused["reason"]) {
    super(`Pool runtime fleet refused: ${reason}`);
    this.reason = reason;
  }
}

/** A lost launch or release receipt consumes capacity until an explicit observation resolves it. */
export class RuntimeFleetState {
  private storage: TransactionStorage;
  private maximum: number;
  private now: () => number;
  private permission?: (target: SlotTarget, transaction: SlotStorage) => Promise<void>;
  constructor(
    storage: TransactionStorage,
    maximum: number,
    now = Date.now,
    permission?: RuntimeFleetState["permission"],
  ) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 4)
      throw new Error("Runtime fleet exceeds its approved resource bound");
    this.storage = storage;
    this.maximum = maximum;
    this.now = now;
    this.permission = permission;
  }
  private rows(value: unknown) {
    const rows = [...Schema.decodeUnknownSync(Ledger)(value ?? [])];
    const live = rows.filter((row) => row.phase !== "retired");
    if (
      live.length > this.maximum ||
      new Set(rows.map((row) => row.target.slotId)).size !== rows.length ||
      new Set(live.map((row) => row.target.instanceId)).size !== live.length ||
      new Set(live.map((row) => row.target.homePeerOrdinal)).size !== live.length ||
      live.some((row) => row.target.homePeerOrdinal === undefined) ||
      rows.some((row) => row.identity && !sameTarget(row.target, row.identity))
    )
      throw new FleetRefused("uncertain");
    return rows;
  }
  private change<T>(work: (rows: Row[], transaction: SlotStorage) => T | Promise<T>) {
    return this.storage.transaction(async (transaction) => {
      const rows = this.rows(await transaction.get(key));
      const value = await work(rows, transaction);
      this.rows(rows);
      await transaction.put(key, rows);
      return value;
    });
  }
  async inspect(storage: SlotStorage = this.storage) {
    return this.rows(await storage.get(key));
  }
  reserve(value: SlotTarget, retained?: (transaction: SlotStorage) => Promise<void>) {
    const target = Schema.decodeUnknownSync(SlotTarget)(value);
    return this.change(async (rows, transaction) => {
      await this.permission?.(target, transaction);
      const live = rows.filter((row) => row.phase !== "retired");
      if (live.length >= this.maximum) throw new FleetRefused("capacity");
      if (
        target.homePeerOrdinal === undefined ||
        rows.some((row) => row.target.slotId === target.slotId) ||
        (await transaction.get(retiredKey(target.slotId))) !== undefined ||
        live.some(
          (row) =>
            row.target.instanceId === target.instanceId ||
            row.target.homePeerOrdinal === target.homePeerOrdinal ||
            row.target.controllerId !== target.controllerId,
        )
      )
        throw new FleetRefused("identity");
      await retained?.(transaction);
      rows.push({ target, phase: "reserved", active: 0, lastUsedAt: this.now() });
    });
  }
  private row(rows: Row[], target: SlotTarget) {
    const row = rows.find((row) => row.target.slotId === target.slotId);
    if (!row || !sameTarget(row.target, target)) throw new FleetRefused("identity");
    return row;
  }
  dispatch(target: SlotTarget) {
    return this.change((rows) => {
      const row = this.row(rows, target);
      if (row.phase !== "reserved") throw new FleetRefused("uncertain");
      rows[rows.indexOf(row)] = { ...row, phase: "warming" };
    });
  }
  uncertain(target: SlotTarget) {
    return this.change((rows) => {
      const row = this.row(rows, target);
      if (!["reserved", "warming", "uncertain"].includes(row.phase))
        throw new FleetRefused("uncertain");
      rows[rows.indexOf(row)] = { ...row, phase: "uncertain" };
    });
  }
  ready(value: SlotIdentity) {
    const identity = Schema.decodeUnknownSync(SlotIdentity)(value);
    return this.change((rows) => {
      const row = this.row(rows, identity);
      if (
        !["warming", "uncertain", "ready"].includes(row.phase) ||
        (row.identity && !sameIdentity(row.identity, identity))
      )
        throw new FleetRefused("uncertain");
      rows[rows.indexOf(row)] = {
        ...row,
        phase: "ready",
        identity,
        lastUsedAt: row.phase === "ready" ? row.lastUsedAt : this.now(),
      };
    });
  }
  cancelReserved(target: SlotTarget) {
    return this.change(async (rows, transaction) => {
      const row = this.row(rows, target);
      if (row.phase !== "reserved" || row.identity || row.active !== 0)
        throw new FleetRefused("uncertain");
      await transaction.put(retiredKey(target.slotId), { ...row, phase: "retired" });
      rows.splice(rows.indexOf(row), 1);
    });
  }
  async primaryActive() {
    return Schema.decodeUnknownSync(Count)((await this.storage.get(primaryKey)) ?? 0);
  }
  acquire(capacity: number): Promise<RuntimeReservation>;
  acquire(capacity: number, includePrimary: true): Promise<RuntimeReservation | PrimaryReservation>;
  async acquire(
    capacity: number,
    includePrimary = false,
  ): Promise<RuntimeReservation | PrimaryReservation> {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error("Invalid measured runtime capacity");
    const selected = await this.change<
      { kind: "runtime"; identity: SlotIdentity } | { kind: "primary" }
    >(async (rows, transaction) => {
      const available = rows
        .filter((row) => row.phase === "ready" && row.active < capacity)
        .sort((left, right) => left.active - right.active || left.lastUsedAt - right.lastUsedAt);
      const row = available[0];
      if (includePrimary) {
        const primary = Schema.decodeUnknownSync(Count)((await transaction.get(primaryKey)) ?? 0);
        if (!row || primary <= row.active) {
          if (!Number.isSafeInteger(primary + 1)) throw new FleetRefused("uncertain");
          await transaction.put(primaryKey, primary + 1);
          return { kind: "primary" };
        }
      }
      if (!row?.identity) throw new FleetRefused("capacity");
      rows[rows.indexOf(row)] = { ...row, active: row.active + 1, lastUsedAt: this.now() };
      return { kind: "runtime", identity: row.identity };
    });
    let released: Promise<void> | undefined;
    const release = () =>
      (released ??= this.change(async (rows, transaction) => {
        if (selected.kind === "primary") {
          const count = Schema.decodeUnknownSync(Count)(await transaction.get(primaryKey));
          if (count < 1) throw new FleetRefused("uncertain");
          await transaction.put(primaryKey, count - 1);
          return;
        }
        const identity = selected.identity;
        const row = this.row(rows, identity);
        if (!sameIdentity(row.identity, identity) || row.active === 0)
          throw new FleetRefused("uncertain");
        rows[rows.indexOf(row)] = { ...row, active: row.active - 1, lastUsedAt: this.now() };
      }));
    return selected.kind === "primary"
      ? { kind: "primary", release }
      : { kind: "runtime", identity: selected.identity, release };
  }
  drain(identity: SlotIdentity) {
    return this.change((rows) => {
      const row = this.row(rows, identity);
      if (!sameIdentity(row.identity, identity) || !["ready", "draining"].includes(row.phase))
        throw new FleetRefused("uncertain");
      rows[rows.indexOf(row)] = { ...row, phase: "draining" };
      return row.active;
    });
  }
  acknowledgeDrain(identity: SlotIdentity) {
    return this.change((rows) => {
      const row = this.row(rows, identity);
      if (!sameIdentity(row.identity, identity) || row.phase !== "draining")
        throw new FleetRefused("uncertain");
      rows[rows.indexOf(row)] = { ...row, drainAcknowledged: true };
    });
  }
  beginRetirement(identity: SlotIdentity) {
    return this.change((rows) => {
      const row = this.row(rows, identity);
      if (!sameIdentity(row.identity, identity) || row.phase !== "draining" || row.active !== 0)
        throw new FleetRefused("draining");
      rows[rows.indexOf(row)] = { ...row, phase: "retiring" };
    });
  }
  retired(identity: SlotIdentity) {
    return this.change(async (rows, transaction) => {
      const row = this.row(rows, identity);
      if (!sameIdentity(row.identity, identity) || row.phase !== "retiring" || row.active !== 0)
        throw new FleetRefused("draining");
      await transaction.put(retiredKey(row.target.slotId), { ...row, phase: "retired" });
      rows.splice(rows.indexOf(row), 1);
    });
  }
}
